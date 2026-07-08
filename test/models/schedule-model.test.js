//
// USAGE:  npx mocha test/models/schedule-model.test.js
//
// Pure Node test (no Electron) — runs under `npm run test:node`.
// (Named schedule-model, not schedule, because the test:node glob drops basenames
//  ending in e/n/d/r — see the note on that fragility.)

const assert = require('assert')

const scheduleModel = require('../../src/js/models/schedule')
const shotModel = require('../../src/js/models/shot')
const projectModel = require('../../src/js/models/project')

// every shot lives in exactly one place: one day, or unscheduled
const assertEachShotOnce = (schedule, shotIds) => {
  const counts = {}
  for (const day of schedule.days) for (const id of day.shotIds) counts[id] = (counts[id] || 0) + 1
  for (const id of schedule.unscheduled) counts[id] = (counts[id] || 0) + 1
  for (const id of shotIds) assert.strictEqual(counts[id], 1, `${id} appears exactly once`)
}

describe('models/schedule', () => {
  describe('days', () => {
    it('adds days with auto labels', () => {
      const s = scheduleModel.emptySchedule()
      const d1 = scheduleModel.addDay(s)
      const d2 = scheduleModel.addDay(s, 'Kitchen day')
      assert.strictEqual(d1.label, 'Day 1')
      assert.strictEqual(d2.label, 'Kitchen day')
      assert.ok(d1.id.startsWith('day_') && d1.id !== d2.id)
    })

    it('reorders days without touching their shots', () => {
      const s = scheduleModel.emptySchedule()
      const a = scheduleModel.addDay(s, 'A')
      const b = scheduleModel.addDay(s, 'B')
      const c = scheduleModel.addDay(s, 'C')
      scheduleModel.reorderDays(s, c.id, 0)
      assert.deepStrictEqual(s.days.map(d => d.label), ['C', 'A', 'B'])
    })

    it('removeDay returns its shots to unscheduled', () => {
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s)
      scheduleModel.moveShotToDay(s, 'sht_1', day.id)
      scheduleModel.moveShotToDay(s, 'sht_2', day.id)
      scheduleModel.removeDay(s, day.id)
      assert.strictEqual(s.days.length, 0)
      assert.deepStrictEqual(s.unscheduled, ['sht_1', 'sht_2'])
    })
  })

  describe('moving shots keeps each in exactly one place', () => {
    it('unscheduled → day → other day → unscheduled', () => {
      const s = scheduleModel.emptySchedule()
      s.unscheduled = ['a', 'b', 'c']
      const d1 = scheduleModel.addDay(s)
      const d2 = scheduleModel.addDay(s)

      scheduleModel.moveShotToDay(s, 'b', d1.id)
      assertEachShotOnce(s, ['a', 'b', 'c'])
      assert.deepStrictEqual(d1.shotIds, ['b'])
      assert.deepStrictEqual(s.unscheduled, ['a', 'c'])

      scheduleModel.moveShotToDay(s, 'b', d2.id) // move between days
      assertEachShotOnce(s, ['a', 'b', 'c'])
      assert.deepStrictEqual(d1.shotIds, [])
      assert.deepStrictEqual(d2.shotIds, ['b'])

      scheduleModel.moveShotToUnscheduled(s, 'b')
      assertEachShotOnce(s, ['a', 'b', 'c'])
      assert.deepStrictEqual(d2.shotIds, [])
    })

    it('inserts at an index within a day', () => {
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s)
      scheduleModel.moveShotToDay(s, 'a', day.id)
      scheduleModel.moveShotToDay(s, 'b', day.id)
      scheduleModel.moveShotToDay(s, 'c', day.id, 1) // between a and b
      assert.deepStrictEqual(day.shotIds, ['a', 'c', 'b'])
    })
  })

  describe('reconcileSchedule', () => {
    it('adds new shots to unscheduled and preserves day assignments', () => {
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s)
      scheduleModel.moveShotToDay(s, 'a', day.id)
      scheduleModel.reconcileSchedule(s, ['a', 'b', 'c'])
      assert.deepStrictEqual(day.shotIds, ['a'], 'kept placed')
      assert.deepStrictEqual(s.unscheduled, ['b', 'c'], 'new shots unscheduled')
    })

    it('drops references to deleted shots', () => {
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s)
      scheduleModel.moveShotToDay(s, 'a', day.id)
      scheduleModel.moveShotToDay(s, 'gone', day.id)
      s.unscheduled = ['b', 'alsogone']
      scheduleModel.reconcileSchedule(s, ['a', 'b'])
      assert.deepStrictEqual(day.shotIds, ['a'])
      assert.deepStrictEqual(s.unscheduled, ['b'])
    })

    it('de-duplicates (keeps the first occurrence)', () => {
      const s = { days: [{ id: 'day_1', label: 'D', shotIds: ['a', 'a'] }], unscheduled: ['a', 'b'] }
      scheduleModel.reconcileSchedule(s, ['a', 'b'])
      assert.deepStrictEqual(s.days[0].shotIds, ['a'])
      assert.deepStrictEqual(s.unscheduled, ['b'])
      assertEachShotOnce(s, ['a', 'b'])
    })
  })

  describe('groupByLocation (auto-suggest)', () => {
    it('makes one day per location, shots in story order', () => {
      const shots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
      const locations = { a: 'KITCHEN', b: 'STREET', c: 'KITCHEN', d: 'STREET' }
      const s = scheduleModel.groupByLocation(shots, id => locations[id])
      assert.deepStrictEqual(s.days.map(d => d.label), ['KITCHEN', 'STREET'], 'first-appearance order')
      assert.deepStrictEqual(s.days[0].shotIds, ['a', 'c'])
      assert.deepStrictEqual(s.days[1].shotIds, ['b', 'd'])
      assert.deepStrictEqual(s.unscheduled, [])
    })

    it('buckets shots with no location under "Unassigned"', () => {
      const s = scheduleModel.groupByLocation([{ id: 'a' }, { id: 'b' }], () => null)
      assert.deepStrictEqual(s.days.map(d => d.label), ['Unassigned'])
      assert.deepStrictEqual(s.days[0].shotIds, ['a', 'b'])
    })
  })

  describe('scheduleToCsv', () => {
    it('emits a header, day rows, then unscheduled, with escaping', () => {
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s, 'Day 1')
      scheduleModel.moveShotToDay(s, 'a', day.id)
      s.unscheduled = ['b']
      const rows = { a: { shot: '1A', location: 'INT. KITCHEN, NIGHT', cast: 'JANE' }, b: { shot: '2A', location: 'STREET', cast: '' } }
      const csv = scheduleModel.scheduleToCsv(s, id => rows[id])
      const lines = csv.trim().split('\n')
      assert.strictEqual(lines[0], 'Day,Shot,Location,Cast')
      assert.strictEqual(lines[1], 'Day 1,1A,"INT. KITCHEN, NIGHT",JANE', 'comma-containing cell quoted')
      assert.strictEqual(lines[2], '(unscheduled),2A,STREET,')
    })
  })

  describe('acceptance invariants', () => {
    it('scheduling never mutates sceneOrder or the in-scene shot order', () => {
      // a scene with three shots, and a project referencing it
      const scene = shotModel.migrateToShots({
        boards: [{ uid: 'u0', newShot: true }, { uid: 'u1', newShot: true }, { uid: 'u2', newShot: true }]
      })
      const shotIds = scene.shots.map(sh => sh.id)
      const storyOrder = [...shotIds]

      const project = projectModel.synthesizeProject({}, [{ id: 'scn_1' }])
      const day = scheduleModel.addDay(project.schedule)
      // schedule them in REVERSE of story order
      for (const id of [...shotIds].reverse()) scheduleModel.moveShotToDay(project.schedule, id, day.id)

      // shoot order is reversed…
      assert.deepStrictEqual(day.shotIds, [...storyOrder].reverse())
      // …but story order is untouched
      assert.deepStrictEqual(scene.shots.map(sh => sh.id), storyOrder, 'in-scene order intact')
      assert.deepStrictEqual(project.sceneOrder, ['scn_1'], 'sceneOrder intact')
    })

    it('the same shotId identifies the shot in both orderings', () => {
      const scene = shotModel.migrateToShots({ boards: [{ uid: 'u0', newShot: true }] })
      const shotId = scene.shots[0].id
      const s = scheduleModel.emptySchedule()
      const day = scheduleModel.addDay(s)
      scheduleModel.moveShotToDay(s, shotId, day.id)
      assert.strictEqual(day.shotIds[0], scene.shots[0].id, 'same underlying shot')
    })
  })
})
