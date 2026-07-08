// Shot — a first-class, addressable grouping of boards within a scene.
//
// Historically a "shot" was not stored: each board carried a boolean `newShot`
// and the numbering loop (`main-window.js` `updateSceneTiming`) derived the
// display label ("1A", "1B", "2A") on the fly. This model makes shots
// first-class while staying label-compatible with that loop, so migrating a
// legacy scene never changes rendered output (revival-plan §3.3 invariant 1).
//
// Pure + Node-safe (no Electron), so it runs under `test:node`.

const util = require('../utils/index')

const SHOT_ID_PREFIX = 'sht_'

const makeShotId = () => SHOT_ID_PREFIX + util.uidGen(6).toLowerCase()

const defaultShotMetadata = () => ({
  lensId: null,
  locationId: null, // null = inherit scene.metadata.locationId
  castIds: [],
  cameraMove: 'static',
  notes: ''
})

// Does this scene use explicit shot boundaries? Mirrors `updateSceneTiming`'s
// `hasShots`. When false, the legacy loop labels *every* board as its own shot
// (1A, 2A, 3A …); when true, boards group under `newShot` boundaries (1A, 1B, 2A).
const hasExplicitShots = boards => boards.some(board => board.newShot)

// Is `board` (at index `i`) the first board of a shot, under the legacy rules?
const startsShot = (board, i, hasShots) =>
  hasShots ? (Boolean(board.newShot) || i === 0) : true

// The quirky sub-shot letter sequence from the legacy loop:
// 0 → A … 25 → Z, 26 → A2, 51 → Z2, 52 → A3 … (a direct port so labels match).
const subShotLetter = subShot => {
  let letter = String.fromCharCode(97 + (subShot % 26)).toUpperCase()
  if ((Math.ceil(subShot / 25) - 1) > 0) {
    letter += (Math.ceil(subShot / 25))
  }
  return letter
}

// Build the ordered `shots[]` for a scene's boards, label-compatible with the
// legacy numbering loop. Pure: does not mutate the boards.
const shotsFromBoards = boards => {
  const hasShots = hasExplicitShots(boards)
  const shots = []

  boards.forEach((board, i) => {
    if (startsShot(board, i, hasShots)) {
      shots.push({
        id: makeShotId(),
        // the first board of shot N gets label "<N>A" in the legacy loop; prefer
        // the persisted board.shot when present, so we preserve exactly what was
        // last rendered.
        label: board.shot || `${shots.length + 1}A`,
        boardUids: [],
        metadata: defaultShotMetadata()
      })
    }
    // every board belongs to the current (most recent) shot
    shots[shots.length - 1].boardUids.push(board.uid)
  })

  return shots
}

// Board display labels ("1A", "1B", "2A") sourced from `shots[]` — the
// shots-based equivalent of `updateSceneTiming`'s label computation. Boards in
// shot N (1-based) get "<N><sub-shot letter>". Returns a `{ [uid]: label }` map.
// This reproduces the legacy labels in BOTH modes (see the parity test), which
// is what lets Phase 2 PR-C re-source the numbering loop from shots[] without
// changing rendered output.
const boardLabelsFromShots = boardData => {
  const labels = {}
  boardData.shots.forEach((shot, shotIndex) => {
    shot.boardUids.forEach((uid, subShot) => {
      labels[uid] = `${shotIndex + 1}${subShotLetter(subShot)}`
    })
  })
  return labels
}

// Migrate a scene's `boardData` in place: derive `shots[]` from the boards'
// `newShot` boundaries and stamp each board with its `shotId`. Idempotent — a
// scene that already carries `shots[]` is left untouched, so shot IDs stay
// stable across loads (revival-plan §3.3 invariant, stable IDs).
const migrateToShots = boardData => {
  if (!boardData || !Array.isArray(boardData.boards)) return boardData
  if (Array.isArray(boardData.shots) && boardData.shots.length) return boardData

  // every board needs a uid to be addressable by a shot
  boardData.boards.forEach(board => {
    if (!board.uid) board.uid = util.uidGen(5)
  })

  const shots = shotsFromBoards(boardData.boards)

  const shotIdByUid = {}
  shots.forEach(shot => {
    shot.boardUids.forEach(uid => { shotIdByUid[uid] = shot.id })
  })
  boardData.boards.forEach(board => { board.shotId = shotIdByUid[board.uid] })

  boardData.shots = shots
  return boardData
}

// Delete a shot, re-parenting its boards to the adjacent shot (the previous one,
// or the next when deleting the first shot). Non-destructive: boards are kept and
// re-stamped, never dropped; a scene is never left shot-less. Deterministic, per
// revival-plan §3.3 invariant 4 (the "re-parent" choice — a shot is a grouping,
// so removing the grouping must not lose the drawings). Removing the shot's ids
// from the Phase 4 schedule is handled where the schedule lives.
const removeShot = (boardData, shotId) => {
  const idx = boardData.shots.findIndex(shot => shot.id === shotId)
  if (idx === -1) return boardData
  if (boardData.shots.length === 1) return boardData // never leave a scene shot-less

  const shot = boardData.shots[idx]
  const target = idx === 0 ? boardData.shots[1] : boardData.shots[idx - 1]

  target.boardUids = idx === 0
    ? [...shot.boardUids, ...target.boardUids] // prepend to the next shot
    : [...target.boardUids, ...shot.boardUids] // append to the previous shot

  shot.boardUids.forEach(uid => {
    const board = boardData.boards.find(b => b.uid === uid)
    if (board) board.shotId = target.id
  })

  boardData.shots.splice(idx, 1)
  return boardData
}

module.exports = {
  SHOT_ID_PREFIX,
  makeShotId,
  defaultShotMetadata,
  hasExplicitShots,
  startsShot,
  subShotLetter,
  shotsFromBoards,
  boardLabelsFromShots,
  migrateToShots,
  removeShot
}
