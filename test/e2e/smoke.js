// Electron launch smoke test — the runtime gate for the Phase 1 modernization.
//
// A green webpack build does NOT prove the app runs (electron is a webpack
// external), so each Phase 1 slice must pass this: launch the app on a real
// display, open a fixture storyboard, and assert it renders boards with no fatal
// renderer errors (module-not-found, `require`/`remote` is-not-defined,
// contextIsolation breakage, uncaught exceptions).
//
// This drives the app *bare* (child_process + ELECTRON_ENABLE_LOGGING) rather
// than via Playwright: Playwright's renderer instrumentation is incompatible with
// this app's legacy inline-`require()` nodeIntegration windows. Once Phase 1 moves
// the windows to contextIsolation + preload, a Playwright harness that can also
// drive the UI becomes viable and can supersede this.
//
// Run: node test/e2e/smoke.js [path/to.storyboarder]   (requires a display)

const { spawn } = require('child_process')
const path = require('path')

const appDir = path.resolve(__dirname, '..', '..')
const electron = require('electron') // resolves to the electron binary path
const fixture =
  process.argv[2] || path.join('test', 'fixtures', 'example', 'example.storyboarder')

const SETTLE_MS = 12000

// Renderer/main failures that mean the app is broken.
const FATAL = [
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

const log = []
const child = spawn(electron, ['.', fixture], {
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' },
})
child.stdout.on('data', (d) => log.push(d.toString()))
child.stderr.on('data', (d) => log.push(d.toString()))

setTimeout(() => {
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(finish, 1500)
}, SETTLE_MS)

function finish() {
  try {
    child.kill('SIGKILL')
  } catch {}
  const text = log.join('')
  const lines = text.split('\n')

  const fatals = lines.filter(
    (l) => FATAL.some((re) => re.test(l)) && !BENIGN.some((re) => re.test(l))
  )
  const rendered = RENDERED.some((re) => re.test(text))

  console.log(`fixture: ${fixture}`)
  console.log(`rendered boards: ${rendered}`)
  console.log(`fatal errors: ${fatals.length}`)
  fatals.slice(0, 25).forEach((l) => console.log(`  [fatal] ${l.trim()}`))

  const ok = rendered && fatals.length === 0
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL')
  process.exit(ok ? 0 : 1)
}
