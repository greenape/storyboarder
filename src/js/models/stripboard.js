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

module.exports = {
  shotLabel,
  buildStripboardModel
}
