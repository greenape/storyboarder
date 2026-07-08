// Project — the manifest that sits *above* the per-scene `.storyboarder` files.
//
// Today project-level state is a thin `storyboard.settings` = `{lastScene,
// aspectRatio}`. This model introduces `project.json` (revival-plan §3.1): the
// story order of scenes, the controlled breakdown vocabularies (cast / locations
// / lens kit), and the Phase 4 shoot-order schedule. Story order and shoot order
// become two orderings over the same stable shot IDs.
//
// The synthesis functions are pure (Node-safe, no Electron) so they run under
// `test:node`; the read/write helpers use fs-extra with the same atomic
// backup-then-move as `saveBoardFile`.

const path = require('path')
const fs = require('fs-extra')
const util = require('../utils/index')

const PROJECT_FILENAME = 'project.json'
const PROJECT_VERSION = 2

const SCENE_ID_PREFIX = 'scn_'
const DEFAULT_ASPECT_RATIO = 2.35
const DEFAULT_FPS = 24

const makeSceneId = () => SCENE_ID_PREFIX + util.uidGen(6).toLowerCase()

const defaultBreakdown = () => ({
  cast: [],
  locations: [],
  lensKit: []
})

const defaultSchedule = () => ({
  days: [],
  unscheduled: []
})

const firstDefined = (...values) => values.find(v => v != null)

// Synthesize a `project.json` from the thin legacy `storyboard.settings` plus a
// list of scene descriptors `{ id, aspectRatio?, fps? }` in story order. Old
// single-file projects yield a one-scene manifest. Pure.
const synthesizeProject = (settings = {}, scenes = []) => {
  const first = scenes[0] || {}
  return {
    version: PROJECT_VERSION,
    aspectRatio: firstDefined(settings.aspectRatio, first.aspectRatio, DEFAULT_ASPECT_RATIO),
    fps: firstDefined(settings.fps, first.fps, DEFAULT_FPS),
    sceneOrder: scenes.map(scene => scene.id),
    breakdown: defaultBreakdown(),
    schedule: defaultSchedule()
  }
}

// A fully-defaulted empty project (used when there is nothing to synthesize from).
const defaultProject = ({ aspectRatio, fps } = {}) => ({
  version: PROJECT_VERSION,
  aspectRatio: firstDefined(aspectRatio, DEFAULT_ASPECT_RATIO),
  fps: firstDefined(fps, DEFAULT_FPS),
  sceneOrder: [],
  breakdown: defaultBreakdown(),
  schedule: defaultSchedule()
})

// --- Breakdown vocabularies (Phase 3) ---------------------------------------
//
// The controlled project-level lists that scene + shot metadata reference by id:
// cast members, locations, and the lens kit. Editing is CRUD over
// project.breakdown[kind]; deletion needs referential cleanup in every scene that
// references the item, which lives in scene.js (scenes are separate files, so the
// caller applies it per open scene).

const VOCAB_KINDS = ['cast', 'locations', 'lensKit']

const VOCAB_ID_PREFIX = {
  cast: 'cast_',
  locations: 'loc_',
  lensKit: 'lens_'
}

const makeVocabId = kind => VOCAB_ID_PREFIX[kind] + util.uidGen(6).toLowerCase()

// Backfill breakdown/schedule on a project that predates them (a project.json
// written before this phase), so CRUD never dereferences undefined.
const ensureBreakdown = project => {
  if (!project.breakdown) project.breakdown = defaultBreakdown()
  for (const kind of VOCAB_KINDS) {
    if (!Array.isArray(project.breakdown[kind])) project.breakdown[kind] = []
  }
  if (!project.schedule) project.schedule = defaultSchedule()
  return project
}

const addVocabItem = (project, kind, fields = {}) => {
  if (!VOCAB_KINDS.includes(kind)) throw new Error(`unknown vocab kind: ${kind}`)
  ensureBreakdown(project)
  const item = { id: makeVocabId(kind), ...fields }
  project.breakdown[kind].push(item)
  return item
}

const renameVocabItem = (project, kind, id, name) => {
  ensureBreakdown(project)
  const item = project.breakdown[kind].find(entry => entry.id === id)
  if (item) item.name = name
  return item
}

// Remove a vocab item from the project. Returns the removed id (or null) so the
// caller can drive scene.cleanupSceneReferences across the open scenes.
const removeVocabItem = (project, kind, id) => {
  ensureBreakdown(project)
  const before = project.breakdown[kind].length
  project.breakdown[kind] = project.breakdown[kind].filter(entry => entry.id !== id)
  return project.breakdown[kind].length < before ? id : null
}

const projectFilePath = projectRoot => path.join(projectRoot, PROJECT_FILENAME)

const projectExists = projectRoot => fs.existsSync(projectFilePath(projectRoot))

const readProject = projectRoot => {
  const filePath = projectFilePath(projectRoot)
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

// Atomic write: mirror `saveBoardFile` — write a timestamped backup beside the
// target, then move it over (overwrite), so a crash mid-write can't truncate a
// live manifest.
const writeProject = (projectRoot, project) => {
  const filePath = projectFilePath(projectRoot)
  const backupPath = `${filePath}.backup-${Date.now()}`
  fs.writeFileSync(backupPath, JSON.stringify(project, null, 2))
  fs.moveSync(backupPath, filePath, { overwrite: true })
  return filePath
}

module.exports = {
  PROJECT_FILENAME,
  PROJECT_VERSION,
  SCENE_ID_PREFIX,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_FPS,
  makeSceneId,
  defaultBreakdown,
  defaultSchedule,
  synthesizeProject,
  defaultProject,
  VOCAB_KINDS,
  makeVocabId,
  ensureBreakdown,
  addVocabItem,
  renameVocabItem,
  removeVocabItem,
  projectFilePath,
  projectExists,
  readProject,
  writeProject
}
