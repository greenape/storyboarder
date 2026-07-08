//
// USAGE:  npx mocha test/models/scene.test.js
//
// Pure Node test (no Electron) — runs under `npm run test:node`.

const assert = require('assert')

const sceneModel = require('../../src/js/models/scene')
const shotModel = require('../../src/js/models/shot')
const projectModel = require('../../src/js/models/project')

// a migrated 3-shot scene: [u0][u1][u2]
const makeScene = () =>
  shotModel.migrateToShots({
    boards: [
      { uid: 'u0', newShot: true },
      { uid: 'u1', newShot: true },
      { uid: 'u2', newShot: true }
    ]
  })

describe('models/scene (breakdown metadata)', () => {
  describe('migrateSceneMetadata', () => {
    it('adds an id + fully-defaulted metadata to a legacy scene', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      assert.ok(scene.id && scene.id.startsWith(projectModel.SCENE_ID_PREFIX))
      assert.deepStrictEqual(scene.metadata, {
        locationId: null,
        castIds: [],
        timeOfDay: null,
        notes: ''
      })
    })

    it('is idempotent — keeps the id and existing metadata', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      const id = scene.id
      scene.metadata.locationId = 'loc_x'
      scene.metadata.notes = 'kitchen sink'

      sceneModel.migrateSceneMetadata(scene) // second pass
      assert.strictEqual(scene.id, id)
      assert.strictEqual(scene.metadata.locationId, 'loc_x')
      assert.strictEqual(scene.metadata.notes, 'kitchen sink')
    })

    it('backfills only missing fields on a partial metadata block', () => {
      const scene = makeScene()
      scene.metadata = { locationId: 'loc_y' } // partial (from an older writer)
      sceneModel.migrateSceneMetadata(scene)
      assert.strictEqual(scene.metadata.locationId, 'loc_y', 'kept')
      assert.deepStrictEqual(scene.metadata.castIds, [], 'backfilled')
      assert.strictEqual(scene.metadata.timeOfDay, null, 'backfilled')
    })
  })

  describe('location inheritance (shot null inherits scene)', () => {
    it('resolves the shot own value when set', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.locationId = 'loc_scene'
      scene.shots[0].metadata.locationId = 'loc_shot'
      assert.strictEqual(sceneModel.resolveShotLocationId(scene, scene.shots[0]), 'loc_shot')
    })

    it('inherits the scene value when the shot is null', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.locationId = 'loc_scene'
      scene.shots[0].metadata.locationId = null
      assert.strictEqual(sceneModel.resolveShotLocationId(scene, scene.shots[0]), 'loc_scene')
    })

    it('resolveShotMetadata applies inheritance for location only', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.locationId = 'loc_scene'
      const shot = scene.shots[0]
      shot.metadata.lensId = 'lens_35'
      shot.metadata.castIds = ['cast_a']
      shot.metadata.locationId = null // inherit

      const resolved = sceneModel.resolveShotMetadata(scene, shot)
      assert.strictEqual(resolved.locationId, 'loc_scene', 'inherited')
      assert.strictEqual(resolved.lensId, 'lens_35', 'own')
      assert.deepStrictEqual(resolved.castIds, ['cast_a'], 'own, not inherited')
    })
  })

  describe('cleanupSceneReferences (referential cleanup on vocab delete)', () => {
    it('clears a deleted location from scene + shot metadata', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.locationId = 'loc_dead'
      scene.shots[0].metadata.locationId = 'loc_dead'
      scene.shots[1].metadata.locationId = 'loc_live'

      sceneModel.cleanupSceneReferences(scene, 'locations', 'loc_dead')
      assert.strictEqual(scene.metadata.locationId, null)
      assert.strictEqual(scene.shots[0].metadata.locationId, null)
      assert.strictEqual(scene.shots[1].metadata.locationId, 'loc_live', 'other refs untouched')
    })

    it('drops a deleted cast member from scene + shot lists', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.castIds = ['cast_a', 'cast_dead']
      scene.shots[0].metadata.castIds = ['cast_dead']

      sceneModel.cleanupSceneReferences(scene, 'cast', 'cast_dead')
      assert.deepStrictEqual(scene.metadata.castIds, ['cast_a'])
      assert.deepStrictEqual(scene.shots[0].metadata.castIds, [])
    })

    it('clears a deleted lens from shots only', () => {
      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.shots[0].metadata.lensId = 'lens_dead'
      sceneModel.cleanupSceneReferences(scene, 'lensKit', 'lens_dead')
      assert.strictEqual(scene.shots[0].metadata.lensId, null)
    })
  })

  describe('integration — delete vocab item then clean up scenes', () => {
    it('removeVocabItem returns the id, which drives scene cleanup', () => {
      const project = projectModel.defaultProject()
      const loc = projectModel.addVocabItem(project, 'locations', { name: 'INT. KITCHEN' })

      const scene = sceneModel.migrateSceneMetadata(makeScene())
      scene.metadata.locationId = loc.id
      scene.shots[0].metadata.locationId = loc.id

      const removedId = projectModel.removeVocabItem(project, 'locations', loc.id)
      assert.strictEqual(removedId, loc.id)
      assert.strictEqual(project.breakdown.locations.length, 0)

      sceneModel.cleanupSceneReferences(scene, 'locations', removedId)
      assert.strictEqual(scene.metadata.locationId, null)
      assert.strictEqual(scene.shots[0].metadata.locationId, null)
    })
  })
})
