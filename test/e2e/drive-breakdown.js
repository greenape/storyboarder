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
// The CDP launch/connect/poll/cleanup plumbing lives in cdp-harness.js (shared with
// drive-stripboard.js and drive-stripboard-multiscene.js).
//
// Run: node test/e2e/drive-breakdown.js   (requires a display; uses a temp copy)

const path = require('path')
const fs = require('fs-extra')
const { sleep, AUTOSAVE_SETTLE_MS, runDriveTest } = require('./cdp-harness')

const appDir = path.resolve(__dirname, '..', '..')
const PORT = Number(process.env.DRIVE_PORT) || 9229

function setup(workDir) {
  // throwaway copy so autosave writes to a temp project, never a committed fixture
  fs.copySync(path.join(appDir, 'test', 'fixtures', 'example'), path.join(workDir, 'example'))
  return path.join(workDir, 'example', 'example.storyboarder')
}

const typeAndEnter = (selector, value) => `(() => {
  const inp = document.querySelector(${JSON.stringify(selector)})
  if (!inp) throw new Error('missing ' + ${JSON.stringify(selector)})
  inp.value = ${JSON.stringify(value)}
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`

async function body(cdp, { targetPath }) {
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
  if (dom.locSelected !== 'INT. KITCHEN') throw new Error(`location not selected in DOM: ${dom.locSelected}`)
  if (dom.lensSelected !== '35mm') throw new Error(`lens not selected in DOM: ${dom.lensSelected}`)
  if (castAfterAdd !== 2) throw new Error(`expected 2 cast chips, got ${castAfterAdd}`)
  if (castAfterRemove !== 1) throw new Error(`expected 1 cast chip after remove, got ${castAfterRemove}`)

  // lens-from-3D-camera: board 0 carries a Shot Generator camera (fov 22.25 → 38mm)
  await cdp.evaluate(`document.querySelector('#breakdown-lens-from-sg').click()`)
  const lensFromSg = await cdp.evaluate(`document.querySelector('#breakdown-lens').selectedOptions[0].textContent`)
  console.log('lens from 3D camera:', lensFromSg)
  if (lensFromSg !== '38mm') throw new Error(`expected 38mm from 3D camera, got ${lensFromSg}`)

  await sleep(AUTOSAVE_SETTLE_MS)

  const project = fs.readJsonSync(path.join(path.dirname(targetPath), 'project.json'))
  const scene = fs.readJsonSync(targetPath)
  const firstShot = scene.shots && scene.shots[0]

  const sceneCast = (scene.metadata && scene.metadata.castIds) || []
  // chips render in castIds order; JANE was added first and the first chip's × was
  // clicked, so BOB — not just "a" cast member — must be the survivor.
  const survivor = sceneCast[0] && project.breakdown.cast.find((c) => c.id === sceneCast[0])
  const checks = {
    projectHasLocation: project.breakdown.locations.some((l) => l.name === 'INT. KITCHEN'),
    projectHasLens: project.breakdown.lensKit.some((l) => l.name === '35mm'),
    sceneLocationResolves: !!(scene.metadata && project.breakdown.locations.some((l) => l.id === scene.metadata.locationId)),
    shotLensResolves: !!(firstShot && firstShot.metadata && project.breakdown.lensKit.some((l) => l.id === firstShot.metadata.lensId)),
    projectHasBothCast: ['JANE', 'BOB'].every((n) => project.breakdown.cast.some((c) => c.name === n)),
    sceneCastAfterRemove: sceneCast.length === 1 && !!survivor,
    survivorIsBob: !!survivor && survivor.name === 'BOB',
  }
  console.log('Persisted checks:', JSON.stringify(checks))
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
  if (failed.length) throw new Error(`persistence checks failed: ${failed.join(', ')}`)
}

runDriveTest({ tmpPrefix: 'sb-drive-', port: PORT, setup, body })
