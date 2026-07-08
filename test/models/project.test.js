//
// USAGE:  npx mocha test/models/project.test.js
//
// Pure Node test (no Electron) — runs under `npm run test:node`.

const assert = require('assert')
const fs = require('fs-extra')
const path = require('path')
const tmp = require('tmp')

const projectModel = require('../../src/js/models/project')

describe('models/project', () => {
  describe('synthesizeProject', () => {
    it('builds a v2 manifest from settings + scene descriptors', () => {
      const project = projectModel.synthesizeProject(
        { aspectRatio: 1.7777777777777777 },
        [
          { id: 'scn_a', aspectRatio: 1.7777777777777777, fps: 24 },
          { id: 'scn_b' }
        ]
      )
      assert.strictEqual(project.version, 2)
      assert.strictEqual(project.aspectRatio, 1.7777777777777777)
      assert.strictEqual(project.fps, 24)
      assert.deepStrictEqual(project.sceneOrder, ['scn_a', 'scn_b'], 'story order = scene order')
      assert.deepStrictEqual(project.breakdown, { cast: [], locations: [], lensKit: [] })
      assert.deepStrictEqual(project.schedule, { days: [], unscheduled: [] })
    })

    it('prefers settings, then the first scene, then defaults', () => {
      // settings win
      assert.strictEqual(
        projectModel.synthesizeProject({ aspectRatio: 2.35 }, [{ id: 's', aspectRatio: 1.85 }]).aspectRatio,
        2.35
      )
      // fall back to first scene when settings is silent
      assert.strictEqual(
        projectModel.synthesizeProject({}, [{ id: 's', aspectRatio: 1.85, fps: 30 }]).fps,
        30
      )
      // fall back to defaults when neither has it
      const bare = projectModel.synthesizeProject({}, [{ id: 's' }])
      assert.strictEqual(bare.aspectRatio, projectModel.DEFAULT_ASPECT_RATIO)
      assert.strictEqual(bare.fps, projectModel.DEFAULT_FPS)
    })

    it('yields a one-scene manifest for an old single-file project', () => {
      const project = projectModel.synthesizeProject({ aspectRatio: 2.35 }, [{ id: 'scn_only' }])
      assert.deepStrictEqual(project.sceneOrder, ['scn_only'])
    })
  })

  describe('makeSceneId', () => {
    it('mints unique, prefixed scene ids', () => {
      const ids = new Set()
      for (let i = 0; i < 200; i++) ids.add(projectModel.makeSceneId())
      for (const id of ids) assert.ok(id.startsWith(projectModel.SCENE_ID_PREFIX))
      assert.ok(ids.size > 190, 'ids are effectively unique')
    })
  })

  describe('read / write (atomic, round-trip)', () => {
    it('writes project.json and reads it back identically', () => {
      const dir = tmp.dirSync({ unsafeCleanup: true })
      try {
        assert.strictEqual(projectModel.readProject(dir.name), null, 'no manifest yet')
        assert.strictEqual(projectModel.projectExists(dir.name), false)

        const project = projectModel.synthesizeProject({ aspectRatio: 2.35 }, [{ id: 'scn_1' }])
        const written = projectModel.writeProject(dir.name, project)

        assert.strictEqual(written, path.join(dir.name, projectModel.PROJECT_FILENAME))
        assert.strictEqual(projectModel.projectExists(dir.name), true)
        assert.deepStrictEqual(projectModel.readProject(dir.name), project)
      } finally {
        dir.removeCallback()
      }
    })

    it('overwrites an existing manifest and leaves no backup files behind', () => {
      const dir = tmp.dirSync({ unsafeCleanup: true })
      try {
        projectModel.writeProject(dir.name, projectModel.defaultProject({ aspectRatio: 1.85 }))
        projectModel.writeProject(dir.name, projectModel.synthesizeProject({ aspectRatio: 2.35 }, [{ id: 'scn_x' }]))

        assert.strictEqual(projectModel.readProject(dir.name).aspectRatio, 2.35)
        const leftovers = fs.readdirSync(dir.name).filter(f => f.includes('.backup-'))
        assert.deepStrictEqual(leftovers, [], 'atomic move leaves no backup')
      } finally {
        dir.removeCallback()
      }
    })
  })

  describe('defaultProject', () => {
    it('is a fully-defaulted empty v2 manifest', () => {
      const project = projectModel.defaultProject()
      assert.strictEqual(project.version, 2)
      assert.deepStrictEqual(project.sceneOrder, [])
      assert.strictEqual(project.aspectRatio, projectModel.DEFAULT_ASPECT_RATIO)
    })
  })
})
