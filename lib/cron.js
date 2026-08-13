/**
 * Routine schedule parsing and next-occurrence math.
 *
 * Accepted schedule strings:
 * - `"0 2 * * *"` — 5-field cron (minute hour day-of-month month day-of-week)
 * - `"@daily"`, `"@hourly"`, `"@midnight"`, `"@weekly"`, `"@monthly"`,
 *   `"@yearly"` / `"@annually"` — cron macros
 * - `"every 4h"`, `"every 30m"` — fixed-rate intervals
 *
 * Fields support `*`, step suffixes (`/n` on any field), ranges (`a-b`),
 * lists (`a,b,c`), single numbers, `?` (treated as `*`), and month/day
 * names (`jan`–`dec`, `sun`–`sat`). Day-of-week 0 and 7 are both Sunday.
 * When both day-of-month and day-of-week are restricted, a day matches if
 * EITHER matches (Vixie cron semantics). All math happens in the routine's
 * explicit timezone; the host zone is never consulted.
 *
 * @module @dsh-routines/bundle/cron
 */
import { isValidTimeZone, wallParts, wallToInstant } from "./time.js";
/** How far forward `nextAfter` will search for a cron occurrence. */
export const CRON_SEARCH_HORIZON_DAYS = 366 * 10;
const MONTH_NAMES = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
/** Parse a schedule string, or throw with a human-readable message. */
export function parseSchedule(rawSpec) {
    const spec = rawSpec.trim().toLowerCase();
    if (spec === '')
        throw new Error('schedule is empty');
    const every = /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(spec);
    if (every !== null) {
        const n = Number(every[1]);
        const unit = every[2] ?? 'h';
        if (!Number.isSafeInteger(n) || n <= 0)
            throw new Error(`invalid "every" schedule ${JSON.stringify(rawSpec)}`);
        const multiplier = unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : 3_600_000;
        const intervalMs = n * multiplier;
        if (intervalMs < 60_000)
            throw new Error(`"every" interval must be at least 1 minute (got ${JSON.stringify(rawSpec)})`);
        return { kind: 'every', intervalMs, raw: rawSpec };
    }
    const macro = {
        '@daily': '0 0 * * *',
        '@midnight': '0 0 * * *',
        '@hourly': '0 * * * *',
        '@weekly': '0 0 * * 0',
        '@monthly': '0 0 1 * *',
        '@yearly': '0 0 1 1 *',
        '@annually': '0 0 1 1 *',
    };
    const expanded = macro[spec];
    const fields = (expanded ?? spec).split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`schedule ${JSON.stringify(rawSpec)} must be 5 cron fields, a cron macro (@daily, @hourly, ...), or "every <n>h|m"`);
    }
    const [minute, hour, dom, month, dow] = fields;
    return {
        kind: 'cron',
        minute: parseField(minute ?? '*', 0, 59, false, rawSpec) ?? fullRange(0, 59),
        hour: parseField(hour ?? '*', 0, 23, false, rawSpec) ?? fullRange(0, 23),
        dom: parseField(dom ?? '*', 1, 31, true, rawSpec),
        month: parseField(month ?? '*', 1, 12, false, rawSpec) ?? fullRange(1, 12),
        dow: parseField(dow ?? '*', 0, 7, false, rawSpec),
        raw: rawSpec,
    };
}
/** The full value set of one field range. */
function fullRange(min, max) {
    const set = new Set();
    for (let v = min; v <= max; v++)
        set.add(v);
    return set;
}
/** Parse one cron field into its accepted values. */
function parseField(field, min, max, allowQuestion, rawSpec) {
    if (field === '*')
        return null;
    if (allowQuestion && field === '?')
        return null;
    const values = new Set();
    for (const piece of field.split(',')) {
        if (piece === '')
            throw new Error(`schedule ${JSON.stringify(rawSpec)} has an empty field element`);
        let step = 1;
        let range = piece;
        const stepMatch = /^(.+)\/(\d+)$/.exec(piece);
        if (stepMatch !== null) {
            range = stepMatch[1] ?? '';
            step = Number(stepMatch[2]);
            if (!Number.isSafeInteger(step) || step <= 0)
                throw new Error(`schedule ${JSON.stringify(rawSpec)} has an invalid step ${JSON.stringify(piece)}`);
        }
        let lo;
        let hi;
        if (range === '*') {
            lo = min;
            hi = max;
        }
        else {
            const rangeMatch = /^([a-z0-9]+)-([a-z0-9]+)$/.exec(range);
            if (rangeMatch !== null) {
                lo = parseAtom(rangeMatch[1], min, max, rawSpec);
                hi = parseAtom(rangeMatch[2], min, max, rawSpec);
                if (lo > hi)
                    throw new Error(`schedule ${JSON.stringify(rawSpec)} has a reversed range ${JSON.stringify(piece)}`);
            }
            else {
                lo = parseAtom(range, min, max, rawSpec);
                hi = lo;
            }
        }
        if (step === 1) {
            for (let v = lo; v <= hi; v++)
                values.add(v);
        }
        else {
            for (let v = lo; v <= hi; v += step)
                values.add(v);
        }
    }
    // Day-of-week 7 is Sunday; normalize to 0 so it matches.
    const isDow = max === 7;
    const normalized = new Set();
    for (const v of values)
        normalized.add(isDow && v === 7 ? 0 : v);
    if (normalized.size === 0)
        throw new Error(`schedule ${JSON.stringify(rawSpec)} matches nothing`);
    return normalized;
}
/** Resolve one atom (number or name) within a field's range. */
function parseAtom(atom, min, max, rawSpec) {
    let value;
    if (/^\d+$/.test(atom)) {
        value = Number(atom);
    }
    else {
        value = (max === 12 ? MONTH_NAMES : max === 7 ? DOW_NAMES : {})[atom] ?? Number.NaN;
        if (Number.isNaN(value))
            throw new Error(`schedule ${JSON.stringify(rawSpec)} has an unknown field value ${JSON.stringify(atom)}`);
    }
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`schedule ${JSON.stringify(rawSpec)} has value ${JSON.stringify(atom)} outside ${min}..${max}`);
    }
    return value;
}
/**
 * The next occurrence of `schedule` strictly after `after` (epoch ms),
 * evaluated in `timeZone`. A fixed-rate schedule is a plain interval. A cron
 * schedule that never recurs (e.g. Feb 30) returns `null` after the search
 * horizon.
 */
export function nextAfter(schedule, after, timeZone) {
    if (!isValidTimeZone(timeZone))
        throw new Error(`invalid timezone ${JSON.stringify(timeZone)}`);
    if (schedule.kind === 'every')
        return after + schedule.intervalMs;
    return nextCronAfter(schedule, after, timeZone);
}
/** Binary-search the first minute-of-day (h*60+m) strictly greater than `target`. */
function firstCandidateAfter(candidates, target) {
    let lo = 0;
    let hi = candidates.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((candidates[mid] ?? 0) <= target)
            lo = mid + 1;
        else
            hi = mid;
    }
    return candidates[lo];
}
/** Next cron occurrence after `after` in `timeZone`. */
function nextCronAfter(schedule, after, timeZone) {
    const { minute, hour, dom, month, dow } = schedule;
    // All valid (h*60+m) minute-of-day slots, sorted.
    const candidates = [];
    for (const h of hour)
        for (const m of minute)
            candidates.push(h * 60 + m);
    candidates.sort((a, b) => a - b);
    if (candidates.length === 0)
        return null;
    const start = wallParts(after, timeZone);
    const startDay = wallToInstant({ year: start.year, month: start.month, day: start.day, hour: 0, minute: 0, second: 0 }, timeZone);
    const currentMinuteOfDay = start.hour * 60 + start.minute;
    let cursor = startDay;
    for (let dayOffset = 0; dayOffset <= CRON_SEARCH_HORIZON_DAYS; dayOffset++) {
        const day = wallParts(cursor, timeZone);
        if (!month.has(day.month)) {
            cursor = nextDay(cursor, day, timeZone);
            continue;
        }
        const domMatches = dom === null || dom.has(day.day);
        const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
        const dowMatches = dow === null || dow.has(weekday);
        // Vixie semantics: both restricted → either matches; one restricted → it must match.
        const dayMatches = dom !== null && dow !== null ? domMatches || dowMatches : domMatches && dowMatches;
        if (!dayMatches) {
            cursor = nextDay(cursor, day, timeZone);
            continue;
        }
        const slot = dayOffset === 0 ? firstCandidateAfter(candidates, currentMinuteOfDay) : candidates[0];
        if (slot !== undefined) {
            const instant = wallToInstant({ year: day.year, month: day.month, day: day.day, hour: Math.floor(slot / 60), minute: slot % 60, second: 0 }, timeZone);
            if (instant > after)
                return instant;
        }
        cursor = nextDay(cursor, day, timeZone);
    }
    return null;
}
/** Advance `cursor` by one wall-clock day (DST-safe via UTC day arithmetic). */
function nextDay(cursor, day, timeZone) {
    return wallToInstant({ year: day.year, month: day.month, day: day.day + 1, hour: 0, minute: 0, second: 0 }, timeZone);
}
//# sourceMappingURL=cron.js.map