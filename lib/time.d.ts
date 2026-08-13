/**
 * Timezone-aware wall-clock conversion helpers, built only on `Intl`.
 *
 * dsh-routines never reads the host time zone: every schedule is interpreted
 * in the routine's explicit IANA `timezone`. These helpers convert between
 * epoch milliseconds and wall-clock fields in an arbitrary zone.
 *
 * @module @dsh-routines/bundle/time
 */
/** Wall-clock fields in a named zone. */
export interface WallParts {
    year: number;
    /** 1-based month. */
    month: number;
    /** 1-based day. */
    day: number;
    hour: number;
    minute: number;
    second: number;
}
/** Whether `timeZone` is a valid IANA zone name. */
export declare function isValidTimeZone(timeZone: string): boolean;
/** The UTC offset (ms, east positive) in effect at `instant` in `timeZone`. */
export declare function tzOffsetMs(instant: number, timeZone: string): number;
/** Split an instant into wall-clock fields in `timeZone`. */
export declare function wallParts(instant: number, timeZone: string): WallParts;
/**
 * Convert wall-clock fields in `timeZone` to an epoch-ms instant.
 *
 * One offset-correction pass resolves DST transitions; an ambiguous wall time
 * (a DST overlap) resolves to the earlier instant. A wall time inside a
 * daylight-saving gap has no true instant; the corrected value is the closest
 * instant in the transition hour and is the caller's problem to interpret.
 */
export declare function wallToInstant(parts: WallParts, timeZone: string): number;
/** The wall-clock day index (local calendar date) of `instant` in `timeZone`. */
export declare function wallDayIndex(instant: number, timeZone: string): number;
//# sourceMappingURL=time.d.ts.map