// Electron launch smoke test — the runtime gate for the Phase 1 modernization.
//
// A green webpack build does NOT prove the app runs (electron is a webpack
// external), so each Phase 1 slice must pass this: launch the app on a real
// display, open a fixture storyboard, and assert it renders boards with no fatal
// renderer errors (module-not-found, `require`/`remote` is-not-defined,
// contextIsolation breakage, uncaught exceptions).
//
// This drives the app *bare* (child_process + ELECTRON_ENABLE_LOGGING). Playwright's
// renderer instrumentation is incompatible with this app's legacy inline-`require()`
// nodeIntegration windows — but that does NOT mean the UI can't be driven: raw CDP
// over Electron's --remote-debugging-port works regardless of nodeIntegration, and
// `test/e2e/drive-breakdown.js` uses it to actually exercise clicks/typing. This
// smoke stays the fast launch+render gate; the drive tests are the interaction gate.
//
// Run: node test/e2e/smoke.js [path/to.storyboarder]   (requires a display)

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs-extra')

const appDir = path.resolve(__dirname, '..', '..')
const electron = require('electron') // resolves to the electron binary path
const origFixture =
  process.argv[2] || path.join('test', 'fixtures', 'example', 'example.storyboarder')

// Open a throwaway COPY of the fixture's project folder, never the committed one:
// the app autosaves (e.g. the Phase 2 shots migration marks the scene dirty on
// load), so pointing it at the real fixture would rewrite a checked-in file. The
// copy also lets us assert the migration round-trips to disk (see finish()).
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-smoke-'))
fs.copySync(path.dirname(path.resolve(appDir, origFixture)), workDir)
const fixture = path.join(workDir, path.basename(origFixture))

const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS) || 12000

// Renderer/main failures that mean the app is broken.
const FATAL = [
  /\bFATAL:/, // Chromium/Electron hard aborts (e.g. sandbox misconfigured — app never launches)
  /could not be cloned/i, // IPC send/invoke of a non-serialisable arg (e.g. a callback)
  /Cannot find module/i,
  /\b(require|remote|module|process|ipcRenderer|__dirname) is not defined/i,
  /Uncaught (Error|TypeError|ReferenceError)/,
  /\bReferenceError:/,
  /contextBridge|contextIsolation/i,
  /Unable to load preload script/i,
  /errorInWindow/,
]
// Known-benign noise on a clean first run — never fail on these.
const BENIGN = [
  /pref\.json/, // first-run: prefs file created on demand
  /Cr24|\[Extensions\] ERR/, // devtools-extension loader in dev
  /GPU|Autofill|Security Warning|Passthrough is not supported/i,
  /Tone\.js/,
  /wonderunit\.com/, // the (to-be-removed) welcome ad
]
// Evidence the main storyboard window actually rendered the fixture's boards.
const RENDERED = [/BOARD PATH:/, /loadSketchPaneLayers/, /load layer \d+ board-/]

// On Linux CI the Chromium SUID sandbox helper isn't set up (and can't be under
// xvfb), so Electron hard-aborts unless we disable it. macOS keeps its real sandbox.
const args = ['.', fixture]
if (process.platform === 'linux') args.push('--no-sandbox')

const log = []
const child = spawn(electron, args, {
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' },
})
child.stdout.on('data', (d) => log.push(d.toString()))
child.stderr.on('data', (d) => log.push(d.toString()))

let weKilledChild = false // set once our own SIGTERM/SIGKILL shutdown starts
let finished = false

// spawn() can fail asynchronously (e.g. the electron binary is missing); without
// this the 'error' event goes unhandled and crashes the process, leaking workDir.
child.on('error', (err) => {
  log.push(`\n[spawn error] ${err.message}\n`)
  finish()
})

const settleTimer = setTimeout(() => {
  weKilledChild = true
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(finish, 1500)
}, SETTLE_MS)

// An instant crash shouldn't burn the full SETTLE_MS before we notice and report.
child.on('exit', (code, signal) => {
  if (weKilledChild) return // expected exit from our own shutdown above — don't double-finish
  log.push(`\napp exited early: code=${code} signal=${signal}\n`)
  console.log(`app exited early: code=${code} signal=${signal}`)
  clearTimeout(settleTimer)
  finish()
})

function finish() {
  if (finished) return
  finished = true
  try {
    child.kill('SIGKILL')
  } catch {}
  const text = log.join('')
  const lines = text.split('\n')

  const fatals = lines.filter(
    (l) => FATAL.some((re) => re.test(l)) && !BENIGN.some((re) => re.test(l))
  )
  const rendered = RENDERED.some((re) => re.test(text))

  // Did the Phase 2 shots migration round-trip to disk? Informational (the
  // migration itself is unit-tested); confirms load→migrate→autosave doesn't
  // break, without gating on autosave timing.
  let shotsOnDisk = 'n/a'
  let sceneMeta = 'n/a'
  try {
    const saved = fs.readJsonSync(fixture)
    shotsOnDisk = Array.isArray(saved.shots)
      ? `yes (${saved.shots.length} shots, shotId on every board: ${saved.boards.every((b) => b.shotId)})`
      : 'no'
    sceneMeta = saved.id && saved.metadata ? `yes (id + metadata)` : 'no'
  } catch {}

  // Phase 3: was the project.json manifest created at the project root?
  let manifest = 'n/a'
  try {
    const p = fs.readJsonSync(path.join(path.dirname(fixture), 'project.json'))
    manifest = `yes (v${p.version}, breakdown: ${Object.keys(p.breakdown || {}).join('/')})`
  } catch {
    manifest = 'no'
  }

  console.log(`fixture: ${origFixture}`)
  console.log(`rendered boards: ${rendered}`)
  console.log(`fatal errors: ${fatals.length}`)
  console.log(`shots migrated to disk: ${shotsOnDisk}`)
  console.log(`scene metadata on disk: ${sceneMeta}`)
  console.log(`project manifest written: ${manifest}`)
  fatals.slice(0, 25).forEach((l) => console.log(`  [fatal] ${l.trim()}`))

  try {
    fs.removeSync(workDir)
  } catch (err) {
    console.log('warning: failed to remove temp workDir:', err.message)
  }

  const ok = rendered && fatals.length === 0
  if (!ok) {
    // Diagnostics for CI: which render markers were seen, and the tail of the app log.
    console.log('--- render markers ---')
    for (const re of RENDERED) console.log(`  ${re.test(text) ? 'seen' : 'MISSING'}: ${re}`)
    const tail = lines.filter((l) => l.trim()).slice(-40)
    console.log(`--- app log tail (${tail.length} lines) ---`)
    for (const l of tail) console.log(`  ${l.replace(/\[[0-9;]*m/g, '').trim().slice(0, 200)}`)
    console.log('--- end tail ---')
  }
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL')
  process.exit(ok ? 0 : 1)
}
