//
// USAGE:  npx mocha test/models/shot.test.js
//
// Pure Node test (no Electron) — runs under `npm run test:node`.
//
// Covers the revival-plan §3.3 invariants for first-class shots, plus the
// load-bearing property that shot-sourced board labels are byte-identical to the
// legacy numbering loop (so Phase 2 PR-C can re-source that loop without changing
// rendered output).

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const shotModel = require('../../src/js/models/shot')
const projectModel = require('../../src/js/models/project')

const fixturesPath = path.join(__dirname, '..', 'fixtures')

// An exact port of `main-window.js` `updateSceneTiming`'s label computation — the
// ground truth we must not diverge from. Returns { [uid]: label }.
const legacyLabels = boards => {
  const hasShots = boards.find(b => b.newShot) != null
  let currentShot = 0
  let subShot = 0
  let boardNumber = 1
  const labels = {}
  for (const board of boards) {
    let shot
    if (hasShots) {
      if (board.newShot || currentShot === 0) {
        currentShot++
        subShot = 0
      } else {
        subShot++
      }
      let substr = String.fromCharCode(97 + (subShot % 26)).toUpperCase()
      if ((Math.ceil(subShot / 25) - 1) > 0) {
        substr += (Math.ceil(subShot / 25))
      }
      shot = currentShot + substr
    } else {
      shot = boardNumber + 'A'
    }
    boardNumber++
    labels[board.uid] = shot
  }
  return labels
}

// Build boards from a newShot pattern like "S..S." (S = newShot true, . = false).
const boardsFromPattern = pattern =>
  pattern.split('').map((ch, i) => ({ uid: `u${i}`, newShot: ch === 'S' }))

const loadFixtureScene = relPath =>
  JSON.parse(fs.readFileSync(path.join(fixturesPath, relPath), 'utf8'))

describe('models/shot', () => {
  describe('label parity with the legacy numbering loop', () => {
    const patterns = [
      'S....',      // one grouped shot: 1A 1B 1C 1D 1E
      'S.S.S',      // 1A 1B 2A 2B 3A
      'SS.S',       // consecutive boundaries: 1A 2A 2B 3A
      '.....',      // NO explicit shots → each board is its own shot: 1A 2A 3A 4A 5A
      '.',          // single board, no shot
      'S'           // single board, explicit shot
    ]
    for (const pattern of patterns) {
      it(`matches for pattern "${pattern}"`, () => {
        const boardData = { boards: boardsFromPattern(pattern) }
        shotModel.migrateToShots(boardData)
        assert.deepStrictEqual(
          shotModel.boardLabelsFromShots(boardData),
          legacyLabels(boardData.boards)
        )
      })
    }

    it('matches across the sub-shot letter rollover (>26 boards in one shot)', () => {
      // 30 boards, all in shot 1 → A..Z then A2, B2, C2, D2
      const boards = [{ uid: 'u0', newShot: true }]
      for (let i = 1; i < 30; i++) boards.push({ uid: `u${i}`, newShot: false })
      const boardData = { boards }
      shotModel.migrateToShots(boardData)
      const labels = shotModel.boardLabelsFromShots(boardData)
      assert.deepStrictEqual(labels, legacyLabels(boards))
      assert.strictEqual(labels.u25, '1Z')
      assert.strictEqual(labels.u26, '1A2')
    })
  })

  describe('§3.3 invariant 1 — legacy load produces shots[] with unchanged output', () => {
    const legacyFixtures = [
      'old-scene/old-scene.storyboarder',
      'example/example.storyboarder',
      'projects/printable/storyboards/Scene-1-EXT-A-PLACE-DAY-1-7BUNG/Scene-1-EXT-A-PLACE-DAY-1-7BUNG.storyboarder'
    ]
    for (const rel of legacyFixtures) {
      it(`migrates ${rel} losslessly`, () => {
        const scene = loadFixtureScene(rel)
        assert.ok(!scene.shots, 'fixture should be pre-migration')
        const before = legacyLabels(scene.boards)

        shotModel.migrateToShots(scene)

        assert.ok(Array.isArray(scene.shots) && scene.shots.length > 0, 'gains shots[]')
        assert.deepStrictEqual(
          shotModel.boardLabelsFromShots(scene),
          before,
          'rendered labels are unchanged'
        )
      })
    }
  })

  describe('§3.3 invariant 2 — every board belongs to exactly one shot in the scene', () => {
    it('stamps board.shotId to a shot in the same scene', () => {
      const boardData = { boards: boardsFromPattern('S.S.S.') }
      shotModel.migrateToShots(boardData)

      const shotIds = new Set(boardData.shots.map(s => s.id))
      for (const board of boardData.boards) {
        assert.ok(shotIds.has(board.shotId), `board ${board.uid} shotId resolves`)
      }
      // each uid appears in exactly one shot's boardUids
      const seen = {}
      for (const shot of boardData.shots) {
        for (const uid of shot.boardUids) {
          seen[uid] = (seen[uid] || 0) + 1
        }
      }
      for (const board of boardData.boards) {
        assert.strictEqual(seen[board.uid], 1, `board ${board.uid} in exactly one shot`)
      }
    })
  })

  describe('stable IDs — migrateToShots is idempotent', () => {
    it('does not re-mint shot IDs on a second migration', () => {
      const boardData = { boards: boardsFromPattern('S.S.') }
      shotModel.migrateToShots(boardData)
      const firstIds = boardData.shots.map(s => s.id)

      shotModel.migrateToShots(boardData) // second pass
      assert.deepStrictEqual(boardData.shots.map(s => s.id), firstIds)
    })

    it('mints unique, prefixed IDs', () => {
      const boardData = { boards: boardsFromPattern('S.S.S') }
      shotModel.migrateToShots(boardData)
      const ids = boardData.shots.map(s => s.id)
      assert.strictEqual(new Set(ids).size, ids.length, 'unique')
      for (const id of ids) assert.ok(id.startsWith(shotModel.SHOT_ID_PREFIX))
    })

    it('assigns a uid to any board missing one', () => {
      const boardData = { boards: [{ newShot: true }, { newShot: false }] }
      shotModel.migrateToShots(boardData)
      for (const board of boardData.boards) {
        assert.ok(board.uid, 'board gained a uid')
        assert.ok(board.shotId, 'board gained a shotId')
      }
    })
  })

  describe('§3.3 invariant 4 — deleting a shot re-parents its boards deterministically', () => {
    it('re-parents a middle shot to the previous shot, keeping boards', () => {
      const boardData = { boards: boardsFromPattern('S.S.S.') } // shots: [u0,u1][u2,u3][u4,u5]
      shotModel.migrateToShots(boardData)
      const [, mid, last] = boardData.shots
      const prev = boardData.shots[0]

      shotModel.removeShot(boardData, mid.id)

      assert.strictEqual(boardData.shots.length, 2)
      assert.ok(!boardData.shots.find(s => s.id === mid.id), 'shot removed')
      assert.deepStrictEqual(prev.boardUids, ['u0', 'u1', 'u2', 'u3'], 'boards appended to previous')
      assert.strictEqual(boardData.boards.find(b => b.uid === 'u2').shotId, prev.id, 're-stamped')
      assert.ok(last, 'later shot untouched')
      // no board lost
      assert.strictEqual(boardData.boards.length, 6)
    })

    it('re-parents the first shot to the next shot', () => {
      const boardData = { boards: boardsFromPattern('S.S.') } // [u0,u1][u2,u3]
      shotModel.migrateToShots(boardData)
      const first = boardData.shots[0]
      const next = boardData.shots[1]

      shotModel.removeShot(boardData, first.id)

      assert.strictEqual(boardData.shots.length, 1)
      assert.deepStrictEqual(next.boardUids, ['u0', 'u1', 'u2', 'u3'], 'boards prepended to next')
      assert.strictEqual(boardData.boards.find(b => b.uid === 'u0').shotId, next.id)
    })

    it('never leaves a scene shot-less', () => {
      const boardData = { boards: boardsFromPattern('S.') }
      shotModel.migrateToShots(boardData)
      shotModel.removeShot(boardData, boardData.shots[0].id)
      assert.strictEqual(boardData.shots.length, 1, 'the only shot is kept')
    })

    it('is durable under reconcileShots — the merge is not resurrected on the next save', () => {
      const boardData = { boards: boardsFromPattern('S.S.S.') } // shots: [u0,u1][u2,u3][u4,u5]
      shotModel.migrateToShots(boardData)
      const [first, mid, last] = boardData.shots

      shotModel.removeShot(boardData, mid.id)
      shotModel.reconcileShots(boardData)

      assert.strictEqual(boardData.shots.length, 2, 'still merged after reconcile')
      assert.deepStrictEqual(
        boardData.shots.map(s => s.id).sort(),
        [first.id, last.id].sort(),
        'surviving ids unchanged'
      )
      const shotIds = new Set(boardData.shots.map(s => s.id))
      for (const board of boardData.boards) {
        assert.ok(shotIds.has(board.shotId), `board ${board.uid} shotId resolves`)
      }
      assert.deepStrictEqual(boardData.shots.map(s => s.label), ['1A', '2A'])
    })

    it('is durable under reconcileShots for an implicit-mode scene (no prior newShot boundaries)', () => {
      const boardData = { boards: boardsFromPattern('...') } // no explicit shots → one shot per board
      shotModel.migrateToShots(boardData)
      assert.strictEqual(boardData.shots.length, 3, 'one shot per board before removal')

      const middle = boardData.shots[1]
      shotModel.removeShot(boardData, middle.id)
      assert.strictEqual(boardData.shots.length, 2, 'merged, 3 boards in 2 shots')

      shotModel.reconcileShots(boardData)
      assert.strictEqual(boardData.shots.length, 2, 'still merged after reconcile')
    })
  })

  describe('reconcileShots — shots[] stays correct across edits with stable IDs', () => {
    // set some metadata so we can prove it survives edits
    const withMetadata = boardData => {
      boardData.shots.forEach((shot, i) => { shot.metadata.lensId = `ln${i}` })
      return boardData
    }

    it('is a no-op (same IDs + metadata) when nothing changed', () => {
      const boardData = withMetadata(shotModel.migrateToShots({ boards: boardsFromPattern('S.S.S') }))
      const before = boardData.shots.map(s => ({ id: s.id, lensId: s.metadata.lensId, uids: [...s.boardUids] }))

      shotModel.reconcileShots(boardData)

      const after = boardData.shots.map(s => ({ id: s.id, lensId: s.metadata.lensId, uids: [...s.boardUids] }))
      assert.deepStrictEqual(after, before)
    })

    it('keeps shot IDs + metadata when a board is added inside a shot', () => {
      const boardData = withMetadata(shotModel.migrateToShots({ boards: boardsFromPattern('S.S.') })) // [u0,u1][u2,u3]
      const ids = boardData.shots.map(s => s.id)

      // insert a new (non-boundary) board into the first shot
      boardData.boards.splice(1, 0, { uid: 'uNew', newShot: false })
      shotModel.reconcileShots(boardData)

      assert.deepStrictEqual(boardData.shots.map(s => s.id), ids, 'IDs preserved')
      assert.deepStrictEqual(boardData.shots.map(s => s.metadata.lensId), ['ln0', 'ln1'], 'metadata preserved')
      assert.deepStrictEqual(boardData.shots[0].boardUids, ['u0', 'uNew', 'u1'], 'new board joins the shot')
      assert.strictEqual(boardData.boards.find(b => b.uid === 'uNew').shotId, ids[0], 're-stamped')
    })

    it('mints a new shot when a new boundary is added, preserving the others', () => {
      const boardData = withMetadata(shotModel.migrateToShots({ boards: boardsFromPattern('S.S.') }))
      const [firstId, secondId] = boardData.shots.map(s => s.id)

      // turn the second board into a shot boundary → three shots now
      boardData.boards[1].newShot = true
      shotModel.reconcileShots(boardData)

      assert.strictEqual(boardData.shots.length, 3)
      assert.strictEqual(boardData.shots[0].id, firstId, 'first shot id kept')
      assert.strictEqual(boardData.shots[2].id, secondId, 'the shot starting at u2 kept its id')
      assert.ok(![firstId, secondId].includes(boardData.shots[1].id), 'middle shot is newly minted')
      assert.strictEqual(boardData.shots[0].metadata.lensId, 'ln0', 'kept metadata')
    })

    it('re-stamps board.shotId for every board and stays idempotent', () => {
      const boardData = shotModel.migrateToShots({ boards: boardsFromPattern('S.S.S.') })
      shotModel.reconcileShots(boardData)
      const snapshot = JSON.stringify(boardData.shots)

      shotModel.reconcileShots(boardData) // second pass
      assert.strictEqual(JSON.stringify(boardData.shots), snapshot, 'idempotent')

      const shotIds = new Set(boardData.shots.map(s => s.id))
      for (const board of boardData.boards) assert.ok(shotIds.has(board.shotId))
    })

    it('labels track the new grouping after a reorder', () => {
      const boardData = shotModel.migrateToShots({ boards: boardsFromPattern('S.S.S') })
      // reverse the boards; newShot flags travel with them
      boardData.boards.reverse()
      shotModel.reconcileShots(boardData)
      assert.deepStrictEqual(
        shotModel.boardLabelsFromShots(boardData),
        legacyLabels(boardData.boards),
        'labels match the legacy loop for the reordered boards'
      )
    })
  })

  describe('§3.3 invariant 3 — schedule order is independent of story order', () => {
    it('reordering the schedule does not mutate sceneOrder or in-scene shot order', () => {
      const boardData = { boards: boardsFromPattern('S.S.S.') }
      shotModel.migrateToShots(boardData)
      const storyOrder = boardData.shots.map(s => s.id)

      const project = projectModel.synthesizeProject({}, [{ id: 'scn_1', aspectRatio: 2.35 }])
      project.sceneOrder = ['scn_1']
      project.schedule.days = [{ id: 'd1', label: 'Day 1', shotIds: [...storyOrder] }]

      // reorder the schedule (shoot order) — reverse it
      project.schedule.days[0].shotIds.reverse()

      assert.deepStrictEqual(project.sceneOrder, ['scn_1'], 'sceneOrder untouched')
      assert.deepStrictEqual(boardData.shots.map(s => s.id), storyOrder, 'in-scene shot order untouched')
    })
  })
})
