// Schedule — the shooting order (revival-plan §3.1 / Phase 4 stripboard).
//
// A second ordering over the same shots: `project.json.schedule` holds ordered
// `days` (each an ordered list of shotIds) plus an `unscheduled` pool. Story order
// (sceneOrder + the in-scene shot order) is never touched here — a shot is the same
// underlying object in both orderings, referenced by its stable shotId.
//
// Every operation keeps the invariant that a shot appears in AT MOST one place
// (one day, or unscheduled) by detaching it everywhere before re-inserting.
//
// Pure + Node-safe (no Electron), so it runs under test:node.

const util = require('../utils/index')

const DAY_ID_PREFIX = 'day_'
const makeDayId = () => DAY_ID_PREFIX + util.uidGen(6).toLowerCase()

const emptySchedule = () => ({ days: [], unscheduled: [] })

// Normalise a possibly-partial schedule so the ops below are always safe.
const ensureSchedule = schedule => {
  if (!schedule) return emptySchedule()
  if (!Array.isArray(schedule.days)) schedule.days = []
  if (!Array.isArray(schedule.unscheduled)) schedule.unscheduled = []
  for (const day of schedule.days) {
    if (!Array.isArray(day.shotIds)) day.shotIds = []
  }
  return schedule
}

const addDay = (schedule, label) => {
  ensureSchedule(schedule)
  const day = {
    id: makeDayId(),
    label: label || `Day ${schedule.days.length + 1}`,
    shotIds: []
  }
  schedule.days.push(day)
  return day
}

const renameDay = (schedule, dayId, label) => {
  ensureSchedule(schedule)
  const day = schedule.days.find(d => d.id === dayId)
  if (day) day.label = label
  return day
}

// Remove a day; its shots fall back to the unscheduled pool (order preserved).
const removeDay = (schedule, dayId) => {
  ensureSchedule(schedule)
  const idx = schedule.days.findIndex(d => d.id === dayId)
  if (idx === -1) return schedule
  const [day] = schedule.days.splice(idx, 1)
  schedule.unscheduled.push(...day.shotIds)
  return schedule
}

// Move a day to a new position in the shoot order.
const reorderDays = (schedule, dayId, index) => {
  ensureSchedule(schedule)
  const from = schedule.days.findIndex(d => d.id === dayId)
  if (from === -1) return schedule
  const [day] = schedule.days.splice(from, 1)
  const clamped = Math.max(0, Math.min(index, schedule.days.length))
  schedule.days.splice(clamped, 0, day)
  return schedule
}

// Detach a shot from every day and the unscheduled pool.
const detachShot = (schedule, shotId) => {
  for (const day of schedule.days) day.shotIds = day.shotIds.filter(id => id !== shotId)
  schedule.unscheduled = schedule.unscheduled.filter(id => id !== shotId)
}

const insertAt = (list, item, index) => {
  if (index == null || index < 0 || index > list.length) list.push(item)
  else list.splice(index, 0, item)
}

// Move a shot into a day at `index` (append when index is null/out of range).
const moveShotToDay = (schedule, shotId, dayId, index = null) => {
  ensureSchedule(schedule)
  const day = schedule.days.find(d => d.id === dayId)
  if (!day) return schedule
  detachShot(schedule, shotId)
  insertAt(day.shotIds, shotId, index)
  return schedule
}

// Move a shot back to the unscheduled pool.
const moveShotToUnscheduled = (schedule, shotId, index = null) => {
  ensureSchedule(schedule)
  detachShot(schedule, shotId)
  insertAt(schedule.unscheduled, shotId, index)
  return schedule
}

const scheduledShotIds = schedule => (schedule.days || []).flatMap(d => d.shotIds)
const allScheduleShotIds = schedule =>
  [...scheduledShotIds(schedule), ...((schedule && schedule.unscheduled) || [])]

// Reconcile the schedule with the project's current shots: drop references to
// deleted shots, add newly-created shots to the unscheduled pool (in the given
// order), and de-duplicate (a shot kept only at its first occurrence). Existing
// day assignments + order are preserved. Call after shots are added/removed.
const reconcileSchedule = (schedule, allShotIds) => {
  ensureSchedule(schedule)
  const valid = new Set(allShotIds)
  const seen = new Set()

  const clean = ids => ids.filter(id => {
    if (!valid.has(id) || seen.has(id)) return false
    seen.add(id)
    return true
  })

  for (const day of schedule.days) day.shotIds = clean(day.shotIds)
  schedule.unscheduled = clean(schedule.unscheduled)

  for (const id of allShotIds) {
    if (!seen.has(id)) {
      seen.add(id)
      schedule.unscheduled.push(id)
    }
  }
  return schedule
}

module.exports = {
  DAY_ID_PREFIX,
  makeDayId,
  emptySchedule,
  ensureSchedule,
  addDay,
  renameDay,
  removeDay,
  reorderDays,
  moveShotToDay,
  moveShotToUnscheduled,
  scheduledShotIds,
  allScheduleShotIds,
  reconcileSchedule
}
