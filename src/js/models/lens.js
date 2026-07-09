// Lens-from-ShotGenerator — populate a shot's breakdown lens from its 3D camera.
//
// A board's Shot Generator data stores the camera as a field-of-view (`fov`, in
// degrees), not a focal length. Shot Generator itself converts fov → mm with a
// three.js PerspectiveCamera (`getFocalLength()`) configured with filmGauge 35 and
// aspect 2.348927875243665 (see CameraPanelInspector). focalLengthFromFov is a pure
// port of that formula, verified bit-identical to three.js in the tests — so a 3D
// shot can drive the `lensId` in the project's lens kit.
//
// Pure + Node-safe (no Electron / no three.js at runtime), so it runs under test:node.

const projectModel = require('./project')

// Shot Generator's fakeCamera constants (CameraPanelInspector/index.js).
const SG_FILM_GAUGE = 35
const SG_ASPECT = 2.348927875243665

// three.js PerspectiveCamera.getFocalLength(), inlined:
//   filmHeight    = filmGauge / max(aspect, 1)
//   vExtentSlope  = tan(deg2rad * 0.5 * fov)      (zoom = 1)
//   focalLength   = 0.5 * filmHeight / vExtentSlope
const focalLengthFromFov = (fov) => {
  const filmHeight = SG_FILM_GAUGE / Math.max(SG_ASPECT, 1)
  const vExtentSlope = Math.tan((Math.PI / 180) * 0.5 * fov)
  return 0.5 * filmHeight / vExtentSlope
}

// The active camera's fov from a board's Shot Generator data, or null if the board
// carries no 3D camera.
const cameraFovFromBoard = (board) => {
  const data = board && board.sg && board.sg.data
  if (!data || !data.sceneObjects) return null
  const camera = data.sceneObjects[data.activeCamera]
  return camera && typeof camera.fov === 'number' ? camera.fov : null
}

// Parse the mm out of a lens name like "35mm" → 35 (null if it isn't lens-shaped).
const parseLensMm = (name) => {
  const match = /(\d+(?:\.\d+)?)\s*mm/i.exec(name || '')
  return match ? parseFloat(match[1]) : null
}

// Resolve (find or create) the lens-kit id matching a board's 3D camera. Mutates
// project.breakdown.lensKit when a matching lens doesn't exist yet. Returns
// `{ id, created }` (`created` true iff a new lens was minted this call), or null
// when the board has no camera fov — so a caller can tell "minted a new lens" from
// "reused an existing one" without diffing lensKit.length itself.
const findOrCreateLensId = (project, board) => {
  const fov = cameraFovFromBoard(board)
  if (fov == null) return null

  const mm = Math.round(focalLengthFromFov(fov))
  projectModel.ensureBreakdown(project)

  let lens = project.breakdown.lensKit.find((item) => {
    const parsed = parseLensMm(item.name)
    return parsed != null && Math.abs(parsed - mm) < 1
  })
  let created = false
  if (!lens) {
    lens = projectModel.addVocabItem(project, 'lensKit', { name: `${mm}mm` })
    created = true
  }
  return { id: lens.id, created }
}

module.exports = {
  SG_FILM_GAUGE,
  SG_ASPECT,
  focalLengthFromFov,
  cameraFovFromBoard,
  parseLensMm,
  findOrCreateLensId
}
