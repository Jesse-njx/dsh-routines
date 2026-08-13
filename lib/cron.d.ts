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
/** A parsed, validated schedule. */
export type RoutineSchedule = {
    kind: 'cron';
    minute: ReadonlySet<number>;
    hour: ReadonlySet<number>;
    /** `null` means `*` (unrestricted). */
    dom: ReadonlySet<number> | null;
    month: ReadonlySet<number>;
    /** `null` means `*` (unrestricted). */
    dow: ReadonlySet<number> | null;
    raw: string;
} | {
    kind: 'every';
    intervalMs: number;
    raw: string;
};
/** How far forward `nextAfter` will search for a cron occurrence. */
export declare const CRON_SEARCH_HORIZON_DAYS: number;
/** Parse a schedule string, or throw with a human-readable message. */
export declare function parseSchedule(rawSpec: string): RoutineSchedule;
/**
 * The next occurrence of `schedule` strictly after `after` (epoch ms),
 * evaluated in `timeZone`. A fixed-rate schedule is a plain interval. A cron
 * schedule that never recurs (e.g. Feb 30) returns `null` after the search
 * horizon.
 */
export declare function nextAfter(schedule: RoutineSchedule, after: number, timeZone: string): number | null;
//# sourceMappingURL=cron.d.ts.map