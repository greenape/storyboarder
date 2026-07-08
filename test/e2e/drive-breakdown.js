// Breakdown-panel drive test — the interaction gate the smoke test can't give.
//
// Unlike smoke.js (launch + render + no-fatal), this DRIVES the real UI over the
// Chrome DevTools Protocol (Electron's --remote-debugging-port). Raw CDP evaluates
// JS in the renderer and dispatches DOM events regardless of nodeIntegration —
// which is why it works here where Playwright's renderer instrumentation doesn't.
//
// It adds a location + a lens through the actual breakdown inputs, then asserts
// the DOM updated AND the values persisted to project.json + the scene file with
// referential integrity (the scene/shot metadata id resolves to the project vocab).
//
// Run: node test/e2e/drive-breakdown.js   (requires a display; uses a temp copy)

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const appDir = path.resolve(__dirname, '..', '..')
const electron = require('electron')
const PORT = Number(process.env.DRIVE_PORT) || 9229
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS) || 12000

// throwaway copy so autosave writes to a temp project, never a committed fixture
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drive-'))
fs.copySync(path.join(appDir, 'test', 'fixtures', 'example'), path.join(workDir, 'example'))
const fixture = path.join(workDir, 'example', 'example.storyboarder')

// global WebSocket is stable on Node 22.4+ (what .nvmrc pins); fall back to the ws
// package on any older/quirky runtime. Both support the addEventListener API used below.
const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (msg) => { console.log('DRIVE FAIL:', msg); cleanup(); process.exit(1) }
let child
function cleanup() {
  try { child && child.kill('SIGKILL') } catch {}
  try { fs.removeSync(workDir) } catch {}
}

async function findMainTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const main = targets.find((t) => t.type === 'page' && /main-window\.html/.test(t.url))
      if (main && main.webSocketDebuggerUrl) return main
    } catch {}
    await sleep(500)
  }
  throw new Error('main-window target never appeared')
}

function connect(wsUrl) {
  const ws = new WS(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }))
  })
  const ready = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails.exception))
    return r.result.result.value
  }
  return { ready, evaluate }
}

const typeAndEnter = (selector, value) => `(() => {
  const inp = document.querySelector(${JSON.stringify(selector)})
  if (!inp) throw new Error('missing ' + ${JSON.stringify(selector)})
  inp.value = ${JSON.stringify(value)}
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`

async function main() {
  const args = ['.', fixture, `--remote-debugging-port=${PORT}`]
  if (process.platform === 'linux') args.push('--no-sandbox')
  child = spawn(electron, args, { cwd: appDir, env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {})

  const target = await findMainTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await sleep(SETTLE_MS) // let the board render + the panel populate

  await cdp.evaluate(typeAndEnter('#breakdown-add-location', 'INT. KITCHEN'))
  await cdp.evaluate(typeAndEnter('#breakdown-add-lens', '35mm'))

  const dom = JSON.parse(await cdp.evaluate(`JSON.stringify({
    locSelected: document.querySelector('#breakdown-location').selectedOptions[0].textContent,
    lensSelected: document.querySelector('#breakdown-lens').selectedOptions[0].textContent
  })`))
  console.log('DOM after drive:', JSON.stringify(dom))
  if (dom.locSelected !== 'INT. KITCHEN') fail(`location not selected in DOM: ${dom.locSelected}`)
  if (dom.lensSelected !== '35mm') fail(`lens not selected in DOM: ${dom.lensSelected}`)

  await sleep(7000) // scene autosave timer is 5s; project.json writes immediately

  const project = fs.readJsonSync(path.join(path.dirname(fixture), 'project.json'))
  const scene = fs.readJsonSync(fixture)
  const firstShot = scene.shots && scene.shots[0]

  const checks = {
    projectHasLocation: project.breakdown.locations.some((l) => l.name === 'INT. KITCHEN'),
    projectHasLens: project.breakdown.lensKit.some((l) => l.name === '35mm'),
    sceneLocationResolves: !!(scene.metadata && project.breakdown.locations.some((l) => l.id === scene.metadata.locationId)),
    shotLensResolves: !!(firstShot && firstShot.metadata && project.breakdown.lensKit.some((l) => l.id === firstShot.metadata.lensId)),
  }
  console.log('Persisted checks:', JSON.stringify(checks))
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
  if (failed.length) fail(`persistence checks failed: ${failed.join(', ')}`)

  console.log('DRIVE PASS')
  cleanup()
  process.exit(0)
}

main().catch((err) => fail(err.message))
