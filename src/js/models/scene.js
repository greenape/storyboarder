const boardModel = require('./board')
const projectModel = require('./project')

const sceneDuration = scene =>
  scene.boards
    .map(board => board.time + boardModel.boardDurationWithAudio(scene, board))
    // ... sort numerically high to low
    .sort((a, b) => b - a)[0]

// --- Breakdown metadata (Phase 3) -------------------------------------------
//
// A `.storyboarder` file is one scene. These add the breakdown metadata
// (location / cast / time-of-day / notes) that hangs off the scene, the
// shot-inherits-scene resolution for location, and the referential cleanup a
// scene needs when a project-level vocab item is deleted. Scene + shot metadata
// reference the project.json `breakdown` vocabularies by id.

const defaultSceneMetadata = () => ({
  locationId: null,
  castIds: [],
  timeOfDay: null, // e.g. "DAY" / "NIGHT"
  notes: ''
})

// Ensure a loaded scene carries an id + a fully-populated metadata block
// (idempotent — existing values are kept, only missing fields are backfilled), so
// callers can read scene.metadata.* without guarding. Mirrors migrateToShots'
// add-if-absent contract.
const migrateSceneMetadata = boardData => {
  if (!boardData) return boardData

  if (!boardData.id) boardData.id = projectModel.makeSceneId()

  if (!boardData.metadata) {
    boardData.metadata = defaultSceneMetadata()
  } else {
    const defaults = defaultSceneMetadata()
    for (const key of Object.keys(defaults)) {
      if (!(key in boardData.metadata)) boardData.metadata[key] = defaults[key]
    }
  }

  return boardData
}

// The effective locationId for a shot: its own if set, else inherited from the
// scene (a shot's `locationId === null` means "inherit", per the model). Read-only.
const resolveShotLocationId = (boardData, shot) => {
  const own = shot && shot.metadata ? shot.metadata.locationId : null
  if (own != null) return own
  return boardData && boardData.metadata ? boardData.metadata.locationId : null
}

// A resolved, read-only view of a shot's breakdown metadata with scene
// inheritance applied (only locationId inherits; cast/lens are shot-specific).
const resolveShotMetadata = (boardData, shot) => {
  const meta = (shot && shot.metadata) || {}
  return {
    lensId: meta.lensId != null ? meta.lensId : null,
    locationId: resolveShotLocationId(boardData, shot),
    castIds: Array.isArray(meta.castIds) ? meta.castIds : [],
    cameraMove: meta.cameraMove != null ? meta.cameraMove : null,
    notes: meta.notes != null ? meta.notes : ''
  }
}

// When a project-level vocab item is deleted, drop references to it from a
// scene's own metadata and every shot in the scene. Scenes are separate files, so
// the caller applies this across each loaded scene after project.removeVocabItem.
// `kind` is a project.VOCAB_KINDS value.
const cleanupSceneReferences = (boardData, kind, id) => {
  if (!boardData || id == null) return boardData

  const clearRef = ref => (ref === id ? null : ref)
  const dropFromList = list => (Array.isArray(list) ? list.filter(x => x !== id) : list)

  if (boardData.metadata) {
    if (kind === 'locations') boardData.metadata.locationId = clearRef(boardData.metadata.locationId)
    if (kind === 'cast') boardData.metadata.castIds = dropFromList(boardData.metadata.castIds)
  }

  for (const shot of boardData.shots || []) {
    if (!shot.metadata) continue
    if (kind === 'locations') shot.metadata.locationId = clearRef(shot.metadata.locationId)
    if (kind === 'lensKit') shot.metadata.lensId = clearRef(shot.metadata.lensId)
    if (kind === 'cast') shot.metadata.castIds = dropFromList(shot.metadata.castIds)
  }

  return boardData
}

module.exports = {
  sceneDuration,
  defaultSceneMetadata,
  migrateSceneMetadata,
  resolveShotLocationId,
  resolveShotMetadata,
  cleanupSceneReferences
}
