/**
 * Week math for quotas. Weeks always start Monday 00:00 UTC, exactly as the
 * commercial contract describes, regardless of where the user lives.
 */

export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_WEEK = 604_800;

export interface WeekBounds {
  /** Unix seconds of Monday 00:00 UTC for the week containing the timestamp. */
  weekStart: number;
  /** Unix seconds of the following Monday 00:00 UTC. */
  resetsAt: number;
}

/**
 * Unix seconds of the Monday 00:00 UTC that starts the week containing `ts`.
 *
 * 1970-01-01 (unix day 0) was a Thursday, so `(days + 4) % 7` gives the UTC
 * day of week with Sunday as 0. Floor division keeps Sunday in the week that
 * started the previous Monday and puts Monday 00:00:00 into the new week.
 */
export function weekStartSeconds(ts: number): number {
  // Guard against non-finite input rather than producing NaN timestamps.
  if (!Number.isFinite(ts)) return 0;
  const days = Math.floor(ts / SECONDS_PER_DAY);
  const dayOfWeek = ((days + 4) % 7 + 7) % 7; // 0 = Sunday, 1 = Monday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return (days - daysSinceMonday) * SECONDS_PER_DAY;
}

export function weekBounds(ts: number): WeekBounds {
  const weekStart = weekStartSeconds(ts);
  return { weekStart, resetsAt: weekStart + SECONDS_PER_WEEK };
}

/** ISO-8601 with second precision (the shape the desktop parses). */
export function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
