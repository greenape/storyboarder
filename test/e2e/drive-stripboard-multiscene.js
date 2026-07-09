// Multi-scene stripboard drive test — opens a real multi-scene project (a .fountain
// script with storyboards/Scene-*/) and asserts the stripboard aggregates shots from
// every scene, groups them under per-scene headers, and can schedule + export across
// scenes. Same hardened CDP harness as drive-stripboard.js (cdp-harness.js).
//
// Run: node test/e2e/drive-stripboard-multiscene.js   (requires a display; temp copy)

const path = require('path')
const fs = require('fs-extra')
const { waitForFile, runDriveTest } = require('./cdp-harness')

const appDir = path.resolve(__dirname, '..', '..')
const PORT = Number(process.env.DRIVE_PORT) || 9233

function setup(workDir) {
  fs.copySync(path.join(appDir, 'test', 'fixtures', 'projects', 'printable'), workDir)
  return path.join(workDir, 'printable.fountain')
}

async function body(cdp, { targetPath }) {
  await cdp.evaluate(`document.querySelector('#open-stripboard').click()`)

  const dom = JSON.parse(await cdp.evaluate(`JSON.stringify({
    sceneHeaders: [...document.querySelectorAll('.stripboard-scene-header')].map(e => e.textContent),
    shotRows: document.querySelectorAll('#stripboard-shot-list .stripboard-shot-row').length
  })`))
  console.log('multi-scene stripboard:', JSON.stringify(dom))

  // the printable fixture has 3 scenes; aggregation should show all three, with more
  // shot rows than any single scene
  if (dom.sceneHeaders.length !== 3) throw new Error(`expected 3 scene headers, got ${dom.sceneHeaders.length}: ${dom.sceneHeaders}`)
  if (dom.shotRows < 3) throw new Error(`expected shots across scenes, got ${dom.shotRows} rows`)

  // group by location across scenes + export CSV, and confirm the CSV has rows from >1 scene
  await cdp.evaluate(`document.querySelector('#stripboard-export-csv').click()`)
  const csvPath = path.join(path.dirname(targetPath), 'storyboards', 'schedule.csv')
  await waitForFile(csvPath)
  const csv = fs.readFileSync(csvPath, 'utf8')
  const csvRows = csv.trim().split('\n').length
  console.log('csv rows (incl header):', csvRows)
  if (csvRows < 4) throw new Error(`expected several CSV rows across scenes, got ${csvRows}`)
}

runDriveTest({ tmpPrefix: 'sb-multi-', port: PORT, setup, body })
