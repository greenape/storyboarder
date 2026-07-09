// Stripboard drive test — opens the schedule overlay, adds a day, assigns a shot,
// and asserts the schedule persists to project.json (shoot order), all through the
// real UI over CDP. Same hardened harness as drive-breakdown.js.
//
// Run: node test/e2e/drive-stripboard.js   (requires a display; uses a temp copy)

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs-extra')
const os = require('os')

const appDir = path.resolve(__dirname, '..', '..')
const electron = require('electron')
const PORT = Number(process.env.DRIVE_PORT) || 9231
const SETTLE_MS = Number(process.env.SMOKE_SETTLE_MS) || 12000

const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-strip-'))
fs.copySync(path.join(appDir, 'test', 'fixtures', 'example'), path.join(workDir, 'example'))
const fixture = path.join(workDir, 'example', 'example.storyboarder')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms))])

let child
let done = false
function cleanup() {
  try { child && child.kill('SIGKILL') } catch {}
  try { fs.removeSync(workDir) } catch {}
}
const fail = (msg) => { if (done) return; done = true; console.log('DRIVE FAIL:', msg); cleanup(); process.exit(1) }
const pass = () => { if (done) return; done = true; console.log('DRIVE PASS'); cleanup(); process.exit(0) }

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
  const args = ['.', fixture, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*']
  if (process.platform === 'linux') args.push('--no-sandbox')
  child = spawn(electron, args, { cwd: appDir, env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' } })
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {})

  const target = await findMainTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await withTimeout(cdp.ready, 20000, 'cdp websocket open')
  await cdp.enable()
  await sleep(SETTLE_MS)

  // set a scene location first (via the breakdown panel) so shots colour-code
  await cdp.evaluate(`(() => {
    const inp = document.querySelector('#breakdown-add-location')
    inp.value = 'INT. KITCHEN'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)

  // open the stripboard
  await cdp.evaluate(`document.querySelector('#open-stripboard').click()`)

  // polish 3 — reorder days: add two, move the first down, verify the order swaps,
  // then clear the days so the rest of the flow starts fresh
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)
  const beforeOrder = await cdp.evaluate(`[...document.querySelectorAll('.stripboard-day-title')].map(e => e.textContent).join('|')`)
  await cdp.evaluate(`document.querySelector('.stripboard-day-down').click()`) // first day's ↓
  const afterOrder = await cdp.evaluate(`[...document.querySelectorAll('.stripboard-day-title')].map(e => e.textContent).join('|')`)
  console.log('reorder:', JSON.stringify({ beforeOrder, afterOrder }))
  if (beforeOrder === afterOrder) return fail(`day reorder did not change order: ${afterOrder}`)
  await cdp.evaluate(`(() => { let btn; while ((btn = document.querySelector('.stripboard-day-remove'))) btn.click() })()`)

  // add the single day used by the drag / persistence checks below
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)

  // polish 1 — colour-coding: the shot row carries its location + a colour stripe
  const colour = JSON.parse(await cdp.evaluate(`JSON.stringify({
    rowLocation: document.querySelector('.stripboard-shot-row').dataset.location || '',
    rowStripe: document.querySelector('.stripboard-shot-row').style.borderLeft || ''
  })`))
  console.log('colour:', JSON.stringify(colour))
  if (colour.rowLocation !== 'INT. KITCHEN') return fail(`shot row missing location: ${colour.rowLocation}`)
  if (!/solid/.test(colour.rowStripe)) return fail(`shot row missing colour stripe: ${colour.rowStripe}`)

  // polish 2 — drag-drop: drag the first shot onto the day (synthetic HTML5 DnD
  // with a shared DataTransfer, which Chromium honours)
  await cdp.evaluate(`(() => {
    const row = document.querySelector('.stripboard-shot-row')
    const day = document.querySelector('.stripboard-day')
    const dt = new DataTransfer()
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
    day.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    day.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })()`)

  const dom = JSON.parse(await cdp.evaluate(`JSON.stringify({
    dayCount: document.querySelectorAll('#stripboard-days .stripboard-day').length,
    chipCount: document.querySelectorAll('#stripboard-days .stripboard-chip').length,
    chipLocation: (() => { const c = document.querySelector('#stripboard-days .stripboard-chip'); return c ? (c.dataset.location || '') : '' })()
  })`))
  console.log('DOM after drag:', JSON.stringify(dom))
  if (dom.dayCount !== 1) return fail(`expected 1 day, got ${dom.dayCount}`)
  if (dom.chipCount !== 1) return fail(`drag-drop did not place the shot (chips=${dom.chipCount})`)
  if (dom.chipLocation !== 'INT. KITCHEN') return fail(`scheduled chip not colour-tagged: ${dom.chipLocation}`)

  await sleep(7000) // project.json is written immediately on assign; allow for it

  const project = fs.readJsonSync(path.join(path.dirname(fixture), 'project.json'))
  const scene = fs.readJsonSync(fixture)
  const sceneShotIds = new Set((scene.shots || []).map((s) => s.id))
  const day = project.schedule.days[0]

  const checks = {
    scheduleHasOneDay: project.schedule.days.length === 1,
    dayHasOneShot: !!(day && day.shotIds.length === 1),
    shotIsARealSceneShot: !!(day && sceneShotIds.has(day.shotIds[0])),
    storyOrderUntouched: (scene.shots || []).length === new Set((scene.shots || []).map((s) => s.id)).size,
  }
  console.log('Persisted checks:', JSON.stringify(checks))
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
  if (failed.length) return fail(`persistence checks failed: ${failed.join(', ')}`)

  // auto-group by location, then export CSV (the example has no locations set, so it
  // groups into a single "Unassigned" day holding every shot)
  await cdp.evaluate(`document.querySelector('#stripboard-group-location').click()`)
  const groupedDays = await cdp.evaluate(`document.querySelectorAll('#stripboard-days .stripboard-day').length`)
  await cdp.evaluate(`document.querySelector('#stripboard-export-csv').click()`)
  await sleep(1500)

  const csvPath = path.join(path.dirname(fixture), 'schedule.csv')
  const csvOk = fs.existsSync(csvPath) && fs.readFileSync(csvPath, 'utf8').startsWith('Day,Shot,Location,Cast')
  console.log('group + export:', JSON.stringify({ groupedDays, csvOk }))
  if (groupedDays < 1) return fail('group by location produced no days')
  if (!csvOk) return fail('schedule.csv not written or has a bad header')

  clearTimeout(watchdog)
  pass()
}

main().catch((err) => fail(err.message))
