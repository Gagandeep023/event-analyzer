import { describe, it, expect } from 'vitest';
import {
  bucketStart, bucketRange, bucketLabel, periodsBetween, addPeriods, inRange,
  MS_PER_DAY, MS_PER_HOUR,
} from './time';

/** Minutes east of UTC for India Standard Time. */
const IST = 330;

describe('bucketStart', () => {
  it('floors to the hour', () => {
    const t = Date.UTC(2026, 0, 15, 13, 47, 22);
    expect(bucketStart(t, 'hour')).toBe(Date.UTC(2026, 0, 15, 13));
  });

  it('floors to the day in UTC', () => {
    const t = Date.UTC(2026, 0, 15, 13, 47);
    expect(bucketStart(t, 'day')).toBe(Date.UTC(2026, 0, 15));
  });

  it('starts weeks on Monday', () => {
    // 2026-01-15 is a Thursday; its week starts Monday 2026-01-12.
    expect(new Date(Date.UTC(2026, 0, 15)).getUTCDay()).toBe(4);
    expect(bucketStart(Date.UTC(2026, 0, 15, 9), 'week')).toBe(Date.UTC(2026, 0, 12));
  });

  it('keeps a Monday in its own week', () => {
    expect(bucketStart(Date.UTC(2026, 0, 12, 23, 59), 'week')).toBe(Date.UTC(2026, 0, 12));
  });

  it('puts a Sunday in the week that started the previous Monday', () => {
    // 2026-01-18 is a Sunday.
    expect(new Date(Date.UTC(2026, 0, 18)).getUTCDay()).toBe(0);
    expect(bucketStart(Date.UTC(2026, 0, 18, 12), 'week')).toBe(Date.UTC(2026, 0, 12));
  });

  it('starts months on the 1st', () => {
    expect(bucketStart(Date.UTC(2026, 2, 27, 18), 'month')).toBe(Date.UTC(2026, 2, 1));
  });

  it('is idempotent', () => {
    const t = Date.UTC(2026, 5, 9, 14, 23);
    for (const g of ['hour', 'day', 'week', 'month'] as const) {
      const once = bucketStart(t, g);
      expect(bucketStart(once, g)).toBe(once);
    }
  });
});

describe('timezone offset', () => {
  it('assigns a late-evening UTC instant to the next day in IST', () => {
    // 2026-01-15T19:00Z is 2026-01-16T00:30 IST, so it belongs to the 16th.
    const t = Date.UTC(2026, 0, 15, 19, 0);
    expect(bucketStart(t, 'day', 0)).toBe(Date.UTC(2026, 0, 15));
    // The IST day boundary sits at 18:30Z the previous evening.
    expect(bucketStart(t, 'day', IST)).toBe(Date.UTC(2026, 0, 15, 18, 30));
  });

  it('puts events either side of a local midnight into different days', () => {
    // 18:29Z and 18:31Z straddle midnight IST but share a UTC day.
    const before = Date.UTC(2026, 0, 15, 18, 29);
    const after = Date.UTC(2026, 0, 15, 18, 31);

    expect(bucketStart(before, 'day', 0)).toBe(bucketStart(after, 'day', 0));
    expect(bucketStart(before, 'day', IST)).not.toBe(bucketStart(after, 'day', IST));
    expect(periodsBetween(before, after, 'day', IST)).toBe(1);
    expect(periodsBetween(before, after, 'day', 0)).toBe(0);
  });

  it('handles a negative offset', () => {
    const NY = -300;
    // 2026-01-15T02:00Z is 2026-01-14T21:00 in UTC-5.
    const t = Date.UTC(2026, 0, 15, 2, 0);
    expect(bucketStart(t, 'day', NY)).toBe(Date.UTC(2026, 0, 14, 5, 0));
  });
});

describe('periodsBetween', () => {
  it('counts whole days', () => {
    expect(periodsBetween(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 8), 'day')).toBe(7);
  });

  it('counts calendar boundaries, not elapsed time', () => {
    // 23:59 to 00:01 the next day is two minutes but one day boundary.
    const a = Date.UTC(2026, 0, 1, 23, 59);
    const b = Date.UTC(2026, 0, 2, 0, 1);
    expect(periodsBetween(a, b, 'day')).toBe(1);
  });

  it('counts calendar months across a year boundary', () => {
    expect(periodsBetween(Date.UTC(2025, 10, 15), Date.UTC(2026, 1, 3), 'month')).toBe(3);
  });

  it('counts months by calendar, not by dividing elapsed days', () => {
    // February is short; naive division by 30 days would give 0 here.
    expect(periodsBetween(Date.UTC(2026, 1, 1), Date.UTC(2026, 2, 1), 'month')).toBe(1);
  });

  it('is negative when the second instant precedes the first', () => {
    expect(periodsBetween(Date.UTC(2026, 0, 8), Date.UTC(2026, 0, 1), 'day')).toBe(-7);
  });

  it('is zero within one bucket', () => {
    expect(periodsBetween(Date.UTC(2026, 0, 1, 1), Date.UTC(2026, 0, 1, 23), 'day')).toBe(0);
  });
});

describe('addPeriods and bucketRange', () => {
  it('advances months by calendar, clamping to the 1st', () => {
    const jan = bucketStart(Date.UTC(2026, 0, 31), 'month');
    expect(addPeriods(jan, 1, 'month')).toBe(Date.UTC(2026, 1, 1));
    expect(addPeriods(jan, 13, 'month')).toBe(Date.UTC(2027, 1, 1));
  });

  it('round-trips through periodsBetween', () => {
    const start = bucketStart(Date.UTC(2026, 0, 15), 'day');
    for (const n of [1, 7, 30, 365]) {
      expect(periodsBetween(start, addPeriods(start, n, 'day'), 'day')).toBe(n);
    }
  });

  it('emits every bucket including empty ones', () => {
    const range = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 6) };
    expect(bucketRange(range, 'day')).toHaveLength(5);
  });

  it('includes the bucket containing `from` even when `from` is mid-bucket', () => {
    const range = { from: Date.UTC(2026, 0, 1, 13), to: Date.UTC(2026, 0, 3) };
    const buckets = bucketRange(range, 'day');
    expect(buckets[0]).toBe(Date.UTC(2026, 0, 1));
    expect(buckets).toHaveLength(2);
  });

  it('returns nothing for an inverted or empty range', () => {
    expect(bucketRange({ from: 100, to: 100 }, 'day')).toEqual([]);
    expect(bucketRange({ from: 200, to: 100 }, 'day')).toEqual([]);
  });
});

describe('labels and range checks', () => {
  it('formats by granularity', () => {
    const t = Date.UTC(2026, 2, 9, 14);
    expect(bucketLabel(t, 'hour')).toBe('2026-03-09 14:00');
    expect(bucketLabel(t, 'day')).toBe('2026-03-09');
    expect(bucketLabel(t, 'month')).toBe('2026-03');
  });

  it('labels in the caller timezone', () => {
    // 2026-03-09T19:00Z is 2026-03-10 in IST.
    expect(bucketLabel(Date.UTC(2026, 2, 9, 19), 'day', 0)).toBe('2026-03-09');
    expect(bucketLabel(Date.UTC(2026, 2, 9, 19), 'day', IST)).toBe('2026-03-10');
  });

  it('inRange is half-open', () => {
    const r = { from: 100, to: 200 };
    expect(inRange(100, r)).toBe(true);
    expect(inRange(199, r)).toBe(true);
    expect(inRange(200, r)).toBe(false);
    expect(inRange(99, r)).toBe(false);
  });

  it('exports the expected constants', () => {
    expect(MS_PER_HOUR).toBe(3_600_000);
    expect(MS_PER_DAY).toBe(86_400_000);
  });
});
