// Stripboard render model — aggregate every scene's shots into the data the
// stripboard UI (and the printable export) draw. Separates the pure aggregation
// from the renderer's file I/O so it can be unit-tested.
//
// Pure + Node-safe (no Electron), so it runs under test:node.

const sceneModel = require('./scene')

const shotLabel = shot => shot.label || shot.id

// Build the stripboard model from all scenes + the project vocab.
//   scenes: [{ title, data }]  — `data` is a migrated boardData (shots + metadata)
// Returns:
//   shotsByScene: [{ title, shots: [{ id, label, location, cast }] }]  (story order)
//   shotIndex:    { [shotId]: { id, label, location, cast, sceneTitle } }
//   allShotIds:   every shot id across every scene (for reconcileSchedule)
const buildStripboardModel = (scenes, project) => {
  const shotsByScene = []
  const shotIndex = {}
  const allShotIds = []

  for (const scene of (scenes || [])) {
    const data = scene.data || {}
    const entry = { title: scene.title || 'Scene', shots: [] }

    for (const shot of (data.shots || [])) {
      const firstBoard = (data.boards || []).find(b => b.uid === shot.boardUids[0])
      const summary = firstBoard ? sceneModel.breakdownSummaryForBoard(data, project, firstBoard) : null
      const info = {
        id: shot.id,
        label: shotLabel(shot),
        location: summary && summary.location ? summary.location : null,
        cast: summary && summary.cast ? summary.cast : []
      }
      entry.shots.push(info)
      shotIndex[shot.id] = { ...info, sceneTitle: entry.title }
      allShotIds.push(shot.id)
    }

    shotsByScene.push(entry)
  }

  return { shotsByScene, shotIndex, allShotIds }
}

// A stable colour per location name (matches the stripboard UI's stripes). Shared so
// the printable export and the on-screen strips read the same.
const locationColor = (name) => {
  if (!name) return 'hsl(0, 0%, 55%)'
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return `hsl(${Math.abs(hash) % 360}, 45%, 42%)`
}

const escapeHtml = (value) =>
  String(value == null ? '' : value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// A print-ready HTML stripboard: each day a section of coloured shot strips
// (label · location · cast · scene), then an unscheduled tail. `shotIndex[shotId]` →
// { label, location, cast, sceneTitle }. Pure — the caller writes it to disk / prints.
const scheduleToHtml = (schedule, shotIndex, options = {}) => {
  const title = options.title || 'Shooting Schedule'
  const index = shotIndex || {}

  const strip = (shotId) => {
    const info = index[shotId] || {}
    const meta = [info.location, (info.cast || []).join(', '), info.sceneTitle].filter(Boolean).join(' · ')
    return `<div class="strip" style="border-left-color:${locationColor(info.location)}">` +
      `<span class="lbl">${escapeHtml(info.label || shotId)}</span> ` +
      `<span class="meta">${escapeHtml(meta)}</span></div>`
  }
  const daySection = (label, shotIds) =>
    `<section class="day"><h2>${escapeHtml(label)} <span class="count">(${shotIds.length})</span></h2>` +
    `${shotIds.map(strip).join('')}</section>`

  const sections = [
    ...(schedule.days || []).map((d) => daySection(d.label, d.shotIds)),
    ...(((schedule.unscheduled || []).length) ? [daySection('Unscheduled', schedule.unscheduled)] : [])
  ].join('\n')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; color: #222; margin: 24px; }
  h1 { font-size: 20px; }
  h2 { font-size: 14px; margin: 16px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  .count { color: #888; font-weight: normal; }
  .strip { border-left: 6px solid #888; padding: 4px 8px; margin: 3px 0; background: #f6f6f6; page-break-inside: avoid; }
  .lbl { font-weight: bold; }
  .meta { color: #555; font-size: 12px; }
  @media print { .day { page-break-inside: avoid; } }
</style></head>
<body><h1>${escapeHtml(title)}</h1>
${sections}
</body></html>
`
}

module.exports = {
  shotLabel,
  buildStripboardModel,
  locationColor,
  escapeHtml,
  scheduleToHtml
}
