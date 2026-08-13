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
  year: number
  /** 1-based month. */
  month: number
  /** 1-based day. */
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

/** Whether `timeZone` is a valid IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** The UTC offset (ms, east positive) in effect at `instant` in `timeZone`. */
export function tzOffsetMs(instant: number, timeZone: string): number {
  // The offset is the difference between the wall clock and UTC; derive it
  // by formatting the instant and re-encoding the wall fields as UTC.
  const parts = wallParts(instant, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant
}

/** Split an instant into wall-clock fields in `timeZone`. */
export function wallParts(instant: number, timeZone: string): WallParts {
  const parts = formatter(timeZone).formatToParts(instant)
  const out: Record<string, number> = {}
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute' || part.type === 'second') {
      out[part.type] = Number(part.value)
    }
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/**
 * Convert wall-clock fields in `timeZone` to an epoch-ms instant.
 *
 * One offset-correction pass resolves DST transitions; an ambiguous wall time
 * (a DST overlap) resolves to the earlier instant. A wall time inside a
 * daylight-saving gap has no true instant; the corrected value is the closest
 * instant in the transition hour and is the caller's problem to interpret.
 */
export function wallToInstant(parts: WallParts, timeZone: string): number {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = tzOffsetMs(guess, timeZone)
  const instant = guess - offset
  const corrected = tzOffsetMs(instant, timeZone)
  return corrected === offset ? instant : guess - corrected
}

/** The wall-clock day index (local calendar date) of `instant` in `timeZone`. */
export function wallDayIndex(instant: number, timeZone: string): number {
  const w = wallParts(instant, timeZone)
  return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000)
}
