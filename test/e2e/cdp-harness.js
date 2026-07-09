// Shared CDP drive-test harness — the launch/connect/poll/cleanup plumbing that
// drive-breakdown.js, drive-stripboard.js, and drive-stripboard-multiscene.js each
// used to copy-paste. A "drive" test launches Electron for real, drives the UI over
// the Chrome DevTools Protocol (Runtime.evaluate + dispatched DOM events — this works
// regardless of nodeIntegration, unlike Playwright's renderer instrumentation), and
// asserts both the DOM and what landed on disk.
//
// Robustness: every CDP await is bounded and a global watchdog force-exits, so a
// headless-runner hiccup fails fast instead of hanging the CI job. Modern Chromium
// rejects the CDP WebSocket upgrade unless --remote-allow-origins is set.

const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs-extra')

const repoRoot = path.resolve(__dirname, '..', '..')
const electron = require('electron')

// global WebSocket is stable on Node 22.4+ (what .nvmrc pins); fall back to the ws
// package on any older/quirky runtime. Both support the addEventListener API used below.
const WS = typeof WebSocket !== 'undefined' ? WebSocket : require('ws')

// scene autosave debounce is 5s (saveBoardFile timer) + margin; project.json writes immediately
const AUTOSAVE_SETTLE_MS = 7000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms)),
  ])

async function findMainTarget(port, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await withTimeout(fetch(`http://127.0.0.1:${port}/json/list`), 4000, 'json/list')
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

function waitForFile(filePath, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    ;(function poll() {
      if (fs.existsSync(filePath)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(poll, intervalMs)
    })()
  })
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// runDriveTest owns the whole lifecycle: spawn Electron pointed at a throwaway
// fixture copy, wait for the app to be interactive, hand off to the test's `body`,
// then tear everything down exactly once regardless of how the test ends. `body`
// signals failure by throwing; a clean return is a PASS.
async function runDriveTest({ tmpPrefix, port, setup, body }) {
  // Shared with smoke.js's SMOKE_SETTLE_MS env var (CI sets one value for both).
  const settleMs = Number(process.env.SMOKE_SETTLE_MS) || 12000

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix))
  const targetPath = setup(workDir)

  const args = ['.', targetPath, `--remote-debugging-port=${port}`, '--remote-allow-origins=*']
  if (process.platform === 'linux') args.push('--no-sandbox')

  const child = spawn(electron, args, {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'development', ELECTRON_ENABLE_LOGGING: '1' },
  })

  const log = []
  child.stdout.on('data', (d) => log.push(d.toString()))
  child.stderr.on('data', (d) => log.push(d.toString()))

  let done = false

  async function killChild() {
    try { child.kill('SIGTERM') } catch {}
    await sleep(1500)
    try { child.kill('SIGKILL') } catch {}
  }

  function removeWorkDir() {
    try {
      fs.removeSync(workDir)
    } catch (err) {
      console.log('warning: failed to remove temp workDir:', err.message)
    }
  }

  function printLogTail() {
    const text = stripAnsi(log.join(''))
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const tail = lines.slice(-40).map((l) => l.slice(0, 200))
    console.log(`--- app log tail (${tail.length} lines) ---`)
    for (const l of tail) console.log(`  ${l}`)
    console.log('--- end tail ---')
  }

  async function fail(msg) {
    if (done) return
    done = true
    clearTimeout(watchdog)
    printLogTail() // headless-CI failures are otherwise undiagnosable
    console.log('DRIVE FAIL:', msg)
    await killChild()
    removeWorkDir()
    process.exit(1)
  }

  async function pass() {
    if (done) return
    done = true
    clearTimeout(watchdog)
    console.log('DRIVE PASS')
    await killChild()
    removeWorkDir()
    process.exit(0)
  }

  // hard backstop: nothing below may hang the CI job
  const watchdog = setTimeout(() => { fail('watchdog: drive test exceeded max runtime') }, settleMs + 120000)
  watchdog.unref?.()

  // a spawn error (e.g. the electron binary is missing) is otherwise an uncaught
  // 'error' event that crashes the process and leaks the temp dir
  child.on('error', (err) => { fail('electron failed to launch: ' + err.message) })

  process.on('SIGINT', () => { fail('interrupted') })
  process.on('SIGTERM', () => { fail('interrupted') })

  try {
    const target = await findMainTarget(port)
    const cdp = connect(target.webSocketDebuggerUrl)
    await withTimeout(cdp.ready, 20000, 'cdp websocket open')
    await cdp.enable() // Runtime.enable — establish the execution context before evaluating

    // readiness poll: short-circuits fast local runs but keeps the same worst-case
    // bound as the flat sleep(settleMs) this replaces.
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline) {
      let ready = false
      try {
        ready = await cdp.evaluate(`!!document.querySelector('#open-stripboard')`)
      } catch {} // early evaluates can fail before the execution context is live
      if (ready) break
      await sleep(500)
    }
    await sleep(1500) // let rendering settle once the panel exists

    await body(cdp, { workDir, targetPath })
    await pass()
  } catch (err) {
    await fail(err.message)
  }
}

module.exports = {
  sleep,
  withTimeout,
  findMainTarget,
  connect,
  waitForFile,
  AUTOSAVE_SETTLE_MS,
  runDriveTest,
}
