import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextAfter, parseSchedule } from '../src/cron.ts'

/** Parse a UTC instant string into epoch ms. */
function at(iso: string): number {
  return Date.parse(iso)
}

test('cron: parses 5-field schedules and rejects bad shapes', () => {
  assert.equal(parseSchedule('0 2 * * *').kind, 'cron')
  assert.equal(parseSchedule('*/15 9-17 * * mon-fri').kind, 'cron')
  assert.equal(parseSchedule('0 0 1 */2 0,6').kind, 'cron')
  assert.equal(parseSchedule('@daily').kind, 'cron')
  assert.equal(parseSchedule('@hourly').kind, 'cron')
  assert.equal(parseSchedule('every 4h').kind, 'every')
  assert.equal(parseSchedule('every 30m').kind, 'every')
  assert.throws(() => parseSchedule(''))
  assert.throws(() => parseSchedule('not a schedule'))
  assert.throws(() => parseSchedule('0 2 * *')) // four fields
  assert.throws(() => parseSchedule('61 2 * * *')) // minute out of range
  assert.throws(() => parseSchedule('0 25 * * *')) // hour out of range
  assert.throws(() => parseSchedule('0 2 * * xyz')) // bad dow
  assert.throws(() => parseSchedule('every 30s')) // below 1 minute
  assert.throws(() => parseSchedule('*/0 * * * *')) // zero step
})

test('cron: next occurrence for a daily schedule in UTC', () => {
  const daily = parseSchedule('0 2 * * *')
  assert.equal(nextAfter(daily, at('2026-08-14T01:00:00Z'), 'UTC'), at('2026-08-14T02:00:00Z'))
  assert.equal(nextAfter(daily, at('2026-08-14T02:00:00Z'), 'UTC'), at('2026-08-15T02:00:00Z'))
  assert.equal(nextAfter(daily, at('2026-08-14T02:00:01Z'), 'UTC'), at('2026-08-15T02:00:00Z'))
})

test('cron: timezone-aware next occurrence (Asia/Shanghai = UTC+8)', () => {
  const daily = parseSchedule('0 2 * * *')
  // 2026-08-14 02:00 Asia/Shanghai == 2026-08-13 18:00 UTC
  assert.equal(nextAfter(daily, at('2026-08-13T00:00:00Z'), 'Asia/Shanghai'), at('2026-08-13T18:00:00Z'))
})

test('cron: hour and minute lists with steps', () => {
  const every15 = parseSchedule('*/15 * * * *')
  assert.equal(nextAfter(every15, at('2026-08-14T10:00:00Z'), 'UTC'), at('2026-08-14T10:15:00Z'))
  assert.equal(nextAfter(every15, at('2026-08-14T10:14:59Z'), 'UTC'), at('2026-08-14T10:15:00Z'))
  const at9and17 = parseSchedule('0 9,17 * * *')
  assert.equal(nextAfter(at9and17, at('2026-08-14T10:00:00Z'), 'UTC'), at('2026-08-14T17:00:00Z'))
  const step3 = parseSchedule('*/20 * * * *')
  assert.equal(nextAfter(step3, at('2026-08-14T10:40:00Z'), 'UTC'), at('2026-08-14T11:00:00Z'))
})

test('cron: day-of-week matching (0 and 7 are Sunday)', () => {
  // 2026-08-14 is a Friday. Next Monday = 2026-08-17.
  const mondays = parseSchedule('0 9 * * mon')
  assert.equal(nextAfter(mondays, at('2026-08-14T00:00:00Z'), 'UTC'), at('2026-08-17T09:00:00Z'))
  const sundays = parseSchedule('0 9 * * 0')
  const sundays7 = parseSchedule('0 9 * * 7')
  assert.equal(nextAfter(sundays, at('2026-08-14T00:00:00Z'), 'UTC'), at('2026-08-16T09:00:00Z'))
  assert.equal(nextAfter(sundays7, at('2026-08-14T00:00:00Z'), 'UTC'), at('2026-08-16T09:00:00Z'))
})

test('cron: day-of-month and Vixie either-match semantics', () => {
  const firstOfMonth = parseSchedule('0 0 1 * *')
  assert.equal(nextAfter(firstOfMonth, at('2026-08-14T00:00:00Z'), 'UTC'), at('2026-09-01T00:00:00Z'))
  // dom=13 AND dow=fri, both restricted: a day matches if EITHER matches.
  // 2026-08-13 was a Thursday (dom matches); 2026-08-14 is Friday (dow matches).
  const either = parseSchedule('0 0 13 * fri')
  assert.equal(nextAfter(either, at('2026-08-12T00:00:00Z'), 'UTC'), at('2026-08-13T00:00:00Z'))
  // dom-only restriction: dow must not restrict (dow is *).
  const domOnly = parseSchedule('0 0 13 * *')
  assert.equal(nextAfter(domOnly, at('2026-08-12T00:00:00Z'), 'UTC'), at('2026-08-13T00:00:00Z'))
})

test('cron: impossible dates never recur (Feb 30)', () => {
  const never = parseSchedule('0 0 30 2 *')
  assert.equal(nextAfter(never, at('2026-01-01T00:00:00Z'), 'UTC'), null)
})

test('cron: every-N intervals are plain intervals', () => {
  const every4h = parseSchedule('every 4h')
  assert.equal(nextAfter(every4h, at('2026-08-14T10:00:00Z'), 'UTC'), at('2026-08-14T14:00:00Z'))
  const every90m = parseSchedule('every 90m')
  assert.equal(nextAfter(every90m, at('2026-08-14T10:00:00Z'), 'UTC'), at('2026-08-14T11:30:00Z'))
})

test('cron: DST transition in a real zone does not break daily matching', () => {
  // Europe/Berlin: 2026-03-29 02:00 CET -> 03:00 CEST (spring forward).
  const daily = parseSchedule('0 3 * * *')
  // 03:00 exists both before and after the transition; the next occurrence
  // after 2026-03-28 12:00Z is 2026-03-29 03:00 CEST == 01:00Z.
  assert.equal(nextAfter(daily, at('2026-03-28T12:00:00Z'), 'Europe/Berlin'), at('2026-03-29T01:00:00Z'))
})

test('cron: month names and day names', () => {
  const janFirst = parseSchedule('0 0 1 jan *')
  assert.equal(nextAfter(janFirst, at('2026-08-14T00:00:00Z'), 'UTC'), at('2027-01-01T00:00:00Z'))
  const weekday = parseSchedule('0 12 * * mon-fri')
  // 2026-08-14 is Friday; next is 12:00 UTC same day.
  assert.equal(nextAfter(weekday, at('2026-08-14T11:00:00Z'), 'UTC'), at('2026-08-14T12:00:00Z'))
  // After Friday, next is Monday 2026-08-17.
  assert.equal(nextAfter(weekday, at('2026-08-14T13:00:00Z'), 'UTC'), at('2026-08-17T12:00:00Z'))
})

test('cron: question mark treated as star', () => {
  const q = parseSchedule('0 2 ? * *')
  assert.equal(nextAfter(q, at('2026-08-14T01:00:00Z'), 'UTC'), at('2026-08-14T02:00:00Z'))
})

test('cron: hourly macro', () => {
  const hourly = parseSchedule('@hourly')
  assert.equal(nextAfter(hourly, at('2026-08-14T10:30:00Z'), 'UTC'), at('2026-08-14T11:00:00Z'))
})

test('cron: invalid timezone throws', () => {
  const daily = parseSchedule('0 2 * * *')
  assert.throws(() => nextAfter(daily, at('2026-08-14T00:00:00Z'), 'Not/AZone'))
})
