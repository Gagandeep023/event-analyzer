/**
 * Time bucketing and calendar arithmetic.
 *
 * Every function takes an explicit `tzOffsetMin` because bucketing is a
 * correctness decision, not a formatting one. "Day 1 retention" means a calendar
 * day boundary in someone's timezone, and bucketing in UTC when users are in IST
 * shifts every cohort by five and a half hours and quietly changes the numbers.
 *
 * The model is a fixed offset, so it cannot express a zone whose offset changes
 * partway through the queried range. That limitation is documented in
 * docs/12-risks.md rather than hidden.
 */

import type { Granularity, Interval, TimeRange, TzOffsetMin } from '../types';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_WEEK = 604_800_000;

/** Shifts an absolute instant into "local wall clock" space. */
function toLocal(t: number, tzOffsetMin: TzOffsetMin): number {
  return t + tzOffsetMin * MS_PER_MINUTE;
}

/** Shifts back from local wall clock space to an absolute instant. */
function fromLocal(t: number, tzOffsetMin: TzOffsetMin): number {
  return t - tzOffsetMin * MS_PER_MINUTE;
}

/**
 * Start of the bucket containing `t`.
 *
 * Week buckets start Monday. Month buckets start on the 1st.
 */
export function bucketStart(t: number, g: Granularity, tzOffsetMin: TzOffsetMin = 0): number {
  const local = toLocal(t, tzOffsetMin);

  switch (g) {
    case 'hour':
      return fromLocal(Math.floor(local / MS_PER_HOUR) * MS_PER_HOUR, tzOffsetMin);

    case 'day':
      return fromLocal(Math.floor(local / MS_PER_DAY) * MS_PER_DAY, tzOffsetMin);

    case 'week': {
      const dayStart = Math.floor(local / MS_PER_DAY) * MS_PER_DAY;
      // getUTCDay: 0 = Sunday. Shift so Monday is 0.
      const dow = (new Date(dayStart).getUTCDay() + 6) % 7;
      return fromLocal(dayStart - dow * MS_PER_DAY, tzOffsetMin);
    }

    case 'month': {
      const d = new Date(local);
      return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), tzOffsetMin);
    }
  }
}

/** Advances a bucket start by `n` whole periods. */
export function addPeriods(
  bucketStartMs: number,
  n: number,
  g: Granularity,
  tzOffsetMin: TzOffsetMin = 0,
): number {
  if (n === 0) return bucketStartMs;
  const local = toLocal(bucketStartMs, tzOffsetMin);

  switch (g) {
    case 'hour':
      return fromLocal(local + n * MS_PER_HOUR, tzOffsetMin);
    case 'day':
      return fromLocal(local + n * MS_PER_DAY, tzOffsetMin);
    case 'week':
      return fromLocal(local + n * MS_PER_WEEK, tzOffsetMin);
    case 'month': {
      const d = new Date(local);
      return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1), tzOffsetMin);
    }
  }
}

/**
 * Every bucket start covering `range`, ascending.
 *
 * Empty buckets are included so a chart draws a continuous line instead of
 * interpolating across a gap.
 */
export function bucketRange(
  range: TimeRange,
  g: Granularity,
  tzOffsetMin: TzOffsetMin = 0,
): number[] {
  if (range.to <= range.from) return [];
  const out: number[] = [];
  let cursor = bucketStart(range.from, g, tzOffsetMin);
  // Guard against a pathological range producing an unbounded array.
  const limit = 100_000;
  while (cursor < range.to && out.length < limit) {
    out.push(cursor);
    cursor = addPeriods(cursor, 1, g, tzOffsetMin);
  }
  return out;
}

/**
 * Whole periods between the buckets containing `a` and `b`.
 *
 * Negative when `b` precedes `a`. This is calendar arithmetic, not division:
 * months vary in length, so a month difference counts calendar months.
 */
export function periodsBetween(
  a: number,
  b: number,
  g: Granularity,
  tzOffsetMin: TzOffsetMin = 0,
): number {
  const startA = bucketStart(a, g, tzOffsetMin);
  const startB = bucketStart(b, g, tzOffsetMin);

  switch (g) {
    case 'hour':
      return Math.round((startB - startA) / MS_PER_HOUR);
    case 'day':
      return Math.round((startB - startA) / MS_PER_DAY);
    case 'week':
      return Math.round((startB - startA) / MS_PER_WEEK);
    case 'month': {
      const da = new Date(toLocal(startA, tzOffsetMin));
      const db = new Date(toLocal(startB, tzOffsetMin));
      return (db.getUTCFullYear() - da.getUTCFullYear()) * 12 +
        (db.getUTCMonth() - da.getUTCMonth());
    }
  }
}

/** Display label for a bucket start. */
export function bucketLabel(t: number, g: Granularity, tzOffsetMin: TzOffsetMin = 0): string {
  const d = new Date(toLocal(t, tzOffsetMin));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');

  switch (g) {
    case 'hour':
      return `${yyyy}-${mm}-${dd} ${hh}:00`;
    case 'day':
    case 'week':
      return `${yyyy}-${mm}-${dd}`;
    case 'month':
      return `${yyyy}-${mm}`;
  }
}

/** Label for a retention period, e.g. `Day 7` or `Week 3`. */
export function periodLabel(period: number, interval: Interval): string {
  const noun = interval === 'day' ? 'Day' : interval === 'week' ? 'Week' : 'Month';
  return `${noun} ${period}`;
}

/** True when `t` falls in the half-open interval `[range.from, range.to)`. */
export function inRange(t: number, range: TimeRange): boolean {
  return t >= range.from && t < range.to;
}
