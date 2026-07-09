//
// USAGE:  npx mocha test/models/stripboard-model.test.js
// Pure Node test (no Electron) — runs under `npm run test:node`.

const assert = require('assert')

const stripboardModel = require('../../src/js/models/stripboard')
const shotModel = require('../../src/js/models/shot')
const sceneModel = require('../../src/js/models/scene')
const projectModel = require('../../src/js/models/project')

const makeScene = (uids) =>
  sceneModel.migrateSceneMetadata(shotModel.migrateToShots({ boards: uids.map(u => ({ uid: u, newShot: true })) }))

describe('models/stripboard (buildStripboardModel)', () => {
  it('aggregates shots across scenes, in scene then story order', () => {
    const a = makeScene(['a0', 'a1'])
    const b = makeScene(['b0'])
    const project = projectModel.defaultProject()

    const model = stripboardModel.buildStripboardModel(
      [{ title: 'Scene 1', data: a }, { title: 'Scene 2', data: b }],
      project
    )

    assert.deepStrictEqual(model.shotsByScene.map(s => s.title), ['Scene 1', 'Scene 2'])
    assert.strictEqual(model.shotsByScene[0].shots.length, 2)
    assert.strictEqual(model.shotsByScene[1].shots.length, 1)
    assert.strictEqual(model.allShotIds.length, 3, 'every shot across scenes')
    // shotIndex resolves any shot to its scene
    const firstId = a.shots[0].id
    assert.strictEqual(model.shotIndex[firstId].sceneTitle, 'Scene 1')
    assert.strictEqual(model.shotIndex[b.shots[0].id].sceneTitle, 'Scene 2')
  })

  it('resolves each shot\'s location + cast via the project vocab', () => {
    const scene = makeScene(['u0'])
    const project = projectModel.defaultProject()
    const loc = projectModel.addVocabItem(project, 'locations', { name: 'INT. KITCHEN' })
    const jane = projectModel.addVocabItem(project, 'cast', { name: 'JANE' })
    scene.metadata.locationId = loc.id
    scene.metadata.castIds = [jane.id]

    const model = stripboardModel.buildStripboardModel([{ title: 'S', data: scene }], project)
    const shot = model.shotsByScene[0].shots[0]
    assert.strictEqual(shot.location, 'INT. KITCHEN')
    assert.deepStrictEqual(shot.cast, ['JANE']) // breakdownSummaryForBoard resolves cast to names
  })

  it('is robust to empty / missing scene data', () => {
    const model = stripboardModel.buildStripboardModel([{ title: 'Empty', data: {} }], projectModel.defaultProject())
    assert.deepStrictEqual(model.shotsByScene, [{ title: 'Empty', shots: [] }])
    assert.deepStrictEqual(model.allShotIds, [])
  })

  describe('scheduleToHtml (printable)', () => {
    const schedule = { days: [{ id: 'd1', label: 'Day 1', shotIds: ['a', 'b'] }], unscheduled: ['c'] }
    const shotIndex = {
      a: { label: '1A', location: 'INT. KITCHEN', cast: ['JANE'], sceneTitle: 'Scene 1' },
      b: { label: '2A', location: 'STREET', cast: [], sceneTitle: 'Scene 1' },
      c: { label: '1A', location: null, cast: [], sceneTitle: 'Scene 2' }
    }

    it('renders a day section per day plus an unscheduled tail', () => {
      const html = stripboardModel.scheduleToHtml(schedule, shotIndex, { title: 'My Shoot' })
      assert.ok(html.startsWith('<!doctype html>'))
      assert.ok(html.includes('<title>My Shoot</title>'))
      assert.ok(html.includes('Day 1 <span class="count">(2)</span>'))
      assert.ok(html.includes('Unscheduled <span class="count">(1)</span>'))
      assert.ok(html.includes('1A') && html.includes('INT. KITCHEN') && html.includes('JANE'))
    })

    it('colours each strip by location (same hue as the UI) and escapes HTML', () => {
      const html = stripboardModel.scheduleToHtml(
        { days: [{ id: 'd', label: 'D', shotIds: ['x'] }], unscheduled: [] },
        { x: { label: '1A', location: 'A & B <big>', cast: [], sceneTitle: 'S' } }
      )
      assert.ok(html.includes(`border-left-color:${stripboardModel.locationColor('A & B <big>')}`))
      assert.ok(html.includes('A &amp; B &lt;big&gt;'), 'escaped')
      assert.ok(!html.includes('<big>'), 'no raw injection')
    })

    it('locationColor is stable + null-safe', () => {
      assert.strictEqual(stripboardModel.locationColor('KITCHEN'), stripboardModel.locationColor('KITCHEN'))
      assert.ok(stripboardModel.locationColor(null).startsWith('hsl('))
    })
  })
})
