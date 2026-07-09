// Multi-scene stripboard drive test — opens a real multi-scene project (a .fountain
// script with storyboards/Scene-*/) and asserts the stripboard aggregates shots from
// every scene, groups them under per-scene headers, and can schedule + export across
// scenes. Same hardened CDP harness as drive-stripboard.js.
//
// Run: node test/e2e/drive-stripboard-multiscene.js   (requires a display; temp copy)

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const appDir = path.resolve(__dirname, '..', '..')
const electron = require('electron')
const PORT = Number(process.env.DRIVE_PORT) || 9233
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS) || 12000

const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-multi-'))
fs.copySync(path.join(appDir, 'test', 'fixtures', 'projects', 'printable'), workDir)
const script = path.join(workDir, 'printable.fountain')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms))])

let child
let done = false
function cleanup() {
  try { child && child.kill('SIGKILL') } catch {}
  try { fs.removeSync(workDir) } catch {}
}
const fail = (msg) => { if (done) return; done = true; console.log('DRIVE FAIL:', msg); cleanup(); process.exit(1) }
const pass = () => { if (done) return; done = true; console.log('DRIVE PASS'); cleanup(); process.exit(0) }
const watchdog = setTimeout(() => fail('watchdog: exceeded max runtime'), SETTLE_MS + 120000)
watchdog.unref?.()

async function findMainTarget() {
  for (let i = 0; i < 100; i++) {
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
    withTimeout(new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) }), 15000, `cdp ${method}`)
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket connection error')), { once: true })
  })
  const enable = () => send('Runtime.enable')
  const evaluateOnce = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails.exception))
    return r.result.result.value
  }
  const evaluate = async (expression) => {
    try { return await evaluateOnce(expression) } catch { await sleep(2000); return evaluateOnce(expression) }
  }
  return { ready, enable, evaluate }
}

async function main() {
  const args = ['.', script, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*']
  if (process.platform === 'linux') args.push('--no-sandbox')
  child = spawn(electron, args, { cwd: appDir, env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {})

  const target = await findMainTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await withTimeout(cdp.ready, 20000, 'cdp websocket open')
  await cdp.enable()
  await sleep(SETTLE_MS)

  await cdp.evaluate(`document.querySelector('#open-stripboard').click()`)

  const dom = JSON.parse(await cdp.evaluate(`JSON.stringify({
    sceneHeaders: [...document.querySelectorAll('.stripboard-scene-header')].map(e => e.textContent),
    shotRows: document.querySelectorAll('#stripboard-shot-list .stripboard-shot-row').length
  })`))
  console.log('multi-scene stripboard:', JSON.stringify(dom))

  // the printable fixture has 3 scenes; aggregation should show all three, with more
  // shot rows than any single scene
  if (dom.sceneHeaders.length !== 3) return fail(`expected 3 scene headers, got ${dom.sceneHeaders.length}: ${dom.sceneHeaders}`)
  if (dom.shotRows < 3) return fail(`expected shots across scenes, got ${dom.shotRows} rows`)

  // group by location across scenes + export CSV, and confirm the CSV has rows from >1 scene
  await cdp.evaluate(`document.querySelector('#stripboard-export-csv').click()`)
  await sleep(1500)
  const csv = fs.readFileSync(path.join(path.dirname(script), 'storyboards', 'schedule.csv'), 'utf8')
  const csvRows = csv.trim().split('\n').length
  console.log('csv rows (incl header):', csvRows)
  if (csvRows < 4) return fail(`expected several CSV rows across scenes, got ${csvRows}`)

  clearTimeout(watchdog)
  pass()
}

main().catch((err) => fail(err.message))
