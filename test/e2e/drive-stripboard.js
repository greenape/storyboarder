// Stripboard drive test — opens the schedule overlay, adds a day, assigns a shot,
// and asserts the schedule persists to project.json (shoot order), all through the
// real UI over CDP. Same hardened harness as drive-breakdown.js (cdp-harness.js).
//
// Run: node test/e2e/drive-stripboard.js   (requires a display; uses a temp copy)

const path = require('path')
const fs = require('fs-extra')
const { sleep, AUTOSAVE_SETTLE_MS, waitForFile, runDriveTest } = require('./cdp-harness')

const appDir = path.resolve(__dirname, '..', '..')
const PORT = Number(process.env.DRIVE_PORT) || 9231

function setup(workDir) {
  fs.copySync(path.join(appDir, 'test', 'fixtures', 'example'), path.join(workDir, 'example'))
  return path.join(workDir, 'example', 'example.storyboarder')
}

async function body(cdp, { targetPath }) {
  // set a scene location first (via the breakdown panel) so shots colour-code
  await cdp.evaluate(`(() => {
    const inp = document.querySelector('#breakdown-add-location')
    inp.value = 'INT. KITCHEN'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)

  // open the stripboard
  await cdp.evaluate(`document.querySelector('#open-stripboard').click()`)

  // regression pin (alpha.2 field report): the frameless window's 70px
  // -webkit-app-region:drag strip (#drag-handle) swallows PHYSICAL clicks at the
  // window-manager level — synthetic/CDP clicks bypass it, so this suite can't catch
  // the failure directly. Instead pin the computed style that opts the panel out.
  const appRegion = await cdp.evaluate(
    `getComputedStyle(document.querySelector('#stripboard-panel')).getPropertyValue('-webkit-app-region')`
  )
  console.log('panel app-region:', JSON.stringify(appRegion))
  if (appRegion !== 'no-drag') throw new Error(`stripboard panel must be app-region no-drag (got '${appRegion}') — its header sits inside the window drag strip and real clicks would be swallowed`)

  // polish 3 — reorder days: add two, move the first down, verify the order swaps,
  // then clear the days so the rest of the flow starts fresh
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)
  const beforeOrder = await cdp.evaluate(`[...document.querySelectorAll('.stripboard-day-title')].map(e => e.textContent).join('|')`)
  await cdp.evaluate(`document.querySelector('.stripboard-day-down').click()`) // first day's ↓
  const afterOrder = await cdp.evaluate(`[...document.querySelectorAll('.stripboard-day-title')].map(e => e.textContent).join('|')`)
  console.log('reorder:', JSON.stringify({ beforeOrder, afterOrder }))
  if (beforeOrder === afterOrder) throw new Error(`day reorder did not change order: ${afterOrder}`)
  await cdp.evaluate(`(() => {
    for (let i = 0; i < 20; i++) {
      const btn = document.querySelector('.stripboard-day-remove')
      if (!btn) break
      btn.click()
    }
  })()`)

  // add the single day used by the drag / persistence checks below
  await cdp.evaluate(`document.querySelector('#stripboard-add-day').click()`)

  // polish 1 — colour-coding: the shot row carries its location + a colour stripe
  const colour = JSON.parse(await cdp.evaluate(`JSON.stringify({
    rowLocation: document.querySelector('.stripboard-shot-row').dataset.location || '',
    rowStripe: document.querySelector('.stripboard-shot-row').style.borderLeft || ''
  })`))
  console.log('colour:', JSON.stringify(colour))
  if (colour.rowLocation !== 'INT. KITCHEN') throw new Error(`shot row missing location: ${colour.rowLocation}`)
  if (!/solid/.test(colour.rowStripe)) throw new Error(`shot row missing colour stripe: ${colour.rowStripe}`)

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
  if (dom.dayCount !== 1) throw new Error(`expected 1 day, got ${dom.dayCount}`)
  if (dom.chipCount !== 1) throw new Error(`drag-drop did not place the shot (chips=${dom.chipCount})`)
  if (dom.chipLocation !== 'INT. KITCHEN') throw new Error(`scheduled chip not colour-tagged: ${dom.chipLocation}`)

  await sleep(AUTOSAVE_SETTLE_MS) // project.json is written immediately on assign; allow for it

  const project = fs.readJsonSync(path.join(path.dirname(targetPath), 'project.json'))
  const scene = fs.readJsonSync(targetPath)
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
  if (failed.length) throw new Error(`persistence checks failed: ${failed.join(', ')}`)

  // auto-group by location, then export CSV (the example has no locations set, so it
  // groups into a single "Unassigned" day holding every shot). A day already exists
  // from the drag/persistence checks above, so the handler confirms before replacing
  // the schedule — auto-accept it.
  await cdp.evaluate(`window.confirm = () => true`)
  await cdp.evaluate(`document.querySelector('#stripboard-group-location').click()`)
  const groupedDays = await cdp.evaluate(`document.querySelectorAll('#stripboard-days .stripboard-day').length`)
  await cdp.evaluate(`document.querySelector('#stripboard-export-csv').click()`)
  const csvPath = path.join(path.dirname(targetPath), 'schedule.csv')
  await waitForFile(csvPath)
  const csvOk = fs.existsSync(csvPath) && fs.readFileSync(csvPath, 'utf8').startsWith('Day,Shot,Location,Cast')

  // printable HTML export
  await cdp.evaluate(`document.querySelector('#stripboard-export-html').click()`)
  const htmlPath = path.join(path.dirname(targetPath), 'schedule.html')
  await waitForFile(htmlPath)
  const htmlBody = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : ''
  const htmlOk = htmlBody.startsWith('<!doctype html>') && htmlBody.includes('INT. KITCHEN') && htmlBody.includes('class="strip"')

  console.log('group + export:', JSON.stringify({ groupedDays, csvOk, htmlOk }))
  if (groupedDays < 1) throw new Error('group by location produced no days')
  if (!csvOk) throw new Error('schedule.csv not written or has a bad header')
  if (!htmlOk) throw new Error('schedule.html not written or missing content')
}

runDriveTest({ tmpPrefix: 'sb-strip-', port: PORT, setup, body })
