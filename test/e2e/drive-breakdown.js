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
// Robustness: every CDP await is bounded and a global watchdog force-exits, so a
// headless-runner hiccup fails fast instead of hanging the CI job. Modern Chromium
// rejects the CDP WebSocket upgrade unless --remote-allow-origins is set.
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

// global WebSocket is stable on Node 22.4+ (what .nvmrc pins); fall back to the ws
// package on any older/quirky runtime. Both support the addEventListener API used below.
const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

// throwaway copy so autosave writes to a temp project, never a committed fixture
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drive-'))
fs.copySync(path.join(appDir, 'test', 'fixtures', 'example'), path.join(workDir, 'example'))
const fixture = path.join(workDir, 'example', 'example.storyboarder')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
  ])

let child
let done = false
function cleanup() {
  try { child && child.kill('SIGKILL') } catch {}
  try { fs.removeSync(workDir) } catch {}
}
const fail = (msg) => { if (done) return; done = true; console.log('DRIVE FAIL:', msg); cleanup(); process.exit(1) }
const pass = () => { if (done) return; done = true; console.log('DRIVE PASS'); cleanup(); process.exit(0) }

// hard backstop: nothing below may hang the CI job
const watchdog = setTimeout(() => fail('watchdog: drive test exceeded max runtime'), SETTLE_MS + 120000)
watchdog.unref?.()

async function findMainTarget() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await withTimeout(fetch(`http://127.0.0.1:${PORT}/json/list`), 4000, 'json/list')
      const targets = await res.json()
      const main = targets.find((t) => t.type === 'page' && /main-window\.html/.test(t.url))
      if (main && main.webSocketDebuggerUrl) return main
    } catch {}
    await sleep(500)
  }
  throw new Error('main-window CDP target never appeared')
}

function connect(wsUrl) {
  const ws = new WS(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) =>
    withTimeout(new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    }), 15000, `cdp ${method}`)
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket connection error')), { once: true })
  })
  const enable = () => send('Runtime.enable') // establishes the execution context (needed on headless CI)
  const evaluateOnce = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) {
      throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails.exception))
    }
    return r.result.result.value
  }
  // retry once — the renderer's context can lag on a slow headless runner
  const evaluate = async (expression) => {
    try {
      return await evaluateOnce(expression)
    } catch (err) {
      await sleep(2000)
      return evaluateOnce(expression)
    }
  }
  return { ready, enable, evaluate }
}

const typeAndEnter = (selector, value) => `(() => {
  const inp = document.querySelector(${JSON.stringify(selector)})
  if (!inp) throw new Error('missing ' + ${JSON.stringify(selector)})
  inp.value = ${JSON.stringify(value)}
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`

async function main() {
  const args = ['.', fixture, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*']
  if (process.platform === 'linux') args.push('--no-sandbox')
  child = spawn(electron, args, { cwd: appDir, env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {})

  const target = await findMainTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await withTimeout(cdp.ready, 20000, 'cdp websocket open')
  await cdp.enable() // Runtime.enable — establish the execution context before evaluating
  await sleep(SETTLE_MS) // let the board render + the panel populate

  await cdp.evaluate(typeAndEnter('#breakdown-add-location', 'INT. KITCHEN'))
  await cdp.evaluate(typeAndEnter('#breakdown-add-lens', '35mm'))

  // cast: add two, then remove one via its chip ×
  await cdp.evaluate(typeAndEnter('#breakdown-add-cast', 'JANE'))
  await cdp.evaluate(typeAndEnter('#breakdown-add-cast', 'BOB'))
  const castAfterAdd = await cdp.evaluate(`document.querySelectorAll('#breakdown-cast-chips .breakdown-chip').length`)
  await cdp.evaluate(`document.querySelector('#breakdown-cast-chips .breakdown-chip-remove').click()`)
  const castAfterRemove = await cdp.evaluate(`document.querySelectorAll('#breakdown-cast-chips .breakdown-chip').length`)

  const dom = JSON.parse(await cdp.evaluate(`JSON.stringify({
    locSelected: document.querySelector('#breakdown-location').selectedOptions[0].textContent,
    lensSelected: document.querySelector('#breakdown-lens').selectedOptions[0].textContent
  })`))
  console.log('DOM after drive:', JSON.stringify({ ...dom, castAfterAdd, castAfterRemove }))
  if (dom.locSelected !== 'INT. KITCHEN') return fail(`location not selected in DOM: ${dom.locSelected}`)
  if (dom.lensSelected !== '35mm') return fail(`lens not selected in DOM: ${dom.lensSelected}`)
  if (castAfterAdd !== 2) return fail(`expected 2 cast chips, got ${castAfterAdd}`)
  if (castAfterRemove !== 1) return fail(`expected 1 cast chip after remove, got ${castAfterRemove}`)

  // lens-from-3D-camera: board 0 carries a Shot Generator camera (fov 22.25 → 38mm)
  await cdp.evaluate(`document.querySelector('#breakdown-lens-from-sg').click()`)
  const lensFromSg = await cdp.evaluate(`document.querySelector('#breakdown-lens').selectedOptions[0].textContent`)
  console.log('lens from 3D camera:', lensFromSg)
  if (lensFromSg !== '38mm') return fail(`expected 38mm from 3D camera, got ${lensFromSg}`)

  await sleep(7000) // scene autosave timer is 5s; project.json writes immediately

  const project = fs.readJsonSync(path.join(path.dirname(fixture), 'project.json'))
  const scene = fs.readJsonSync(fixture)
  const firstShot = scene.shots && scene.shots[0]

  const sceneCast = (scene.metadata && scene.metadata.castIds) || []
  const checks = {
    projectHasLocation: project.breakdown.locations.some((l) => l.name === 'INT. KITCHEN'),
    projectHasLens: project.breakdown.lensKit.some((l) => l.name === '35mm'),
    sceneLocationResolves: !!(scene.metadata && project.breakdown.locations.some((l) => l.id === scene.metadata.locationId)),
    shotLensResolves: !!(firstShot && firstShot.metadata && project.breakdown.lensKit.some((l) => l.id === firstShot.metadata.lensId)),
    projectHasBothCast: ['JANE', 'BOB'].every((n) => project.breakdown.cast.some((c) => c.name === n)),
    sceneCastAfterRemove: sceneCast.length === 1 && project.breakdown.cast.some((c) => c.id === sceneCast[0]),
  }
  console.log('Persisted checks:', JSON.stringify(checks))
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
  if (failed.length) return fail(`persistence checks failed: ${failed.join(', ')}`)

  clearTimeout(watchdog)
  pass()
}

main().catch((err) => fail(err.message))
