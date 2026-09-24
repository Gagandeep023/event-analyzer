import { describe, it, expect } from 'vitest';
import { retention } from './retention';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange, retentionFixture, T0, DAY } from './__fixtures__';
import type { RetentionQuery, RetentionResult } from '../types';

const BASE: Omit<RetentionQuery, 'measure'> = {
  startAction: { event_type: 'Signed Up' },
  returnAction: { event_type: 'Opened App' },
  interval: 'day',
  periods: 4,
  // Five whole days, so every cohort can be fairly measured out to day 4.
  range: daysRange(5),
};

function run(over: Partial<RetentionQuery> & Pick<RetentionQuery, 'measure'>): RetentionResult {
  const events = retentionFixture();
  return retention(events, { ...BASE, ...over }, buildIdentityGraph(events));
}

const retained = (r: RetentionResult) => r.curve.map((p) => p.retained);

describe('the three measures disagree on the same fixture', () => {
  /**
   * Nine users, all starting day 0. Return days:
   *   u1 1,2,3,4   u2 1   u3 2   u4 3   u5 4
   *   u6 1,4       u7 2,3 u8 none u9 4
   *
   * If all three measures agreed here, the fixture would not be exercising the
   * difference between them, and the most likely real bug (all three code paths
   * accidentally doing the same thing) would pass unnoticed.
   */

  it('n-day counts a return on exactly that day', () => {
    // d1 u1,u2,u6 | d2 u1,u3,u7 | d3 u1,u4,u7 | d4 u1,u5,u6,u9
    expect(retained(run({ measure: 'n-day' }))).toEqual([9, 3, 3, 3, 4]);
  });

  it('unbounded counts a return on that day or any day after', () => {
    // d1 everyone but u8 | d2 7 | d3 6 | d4 4
    expect(retained(run({ measure: 'unbounded' }))).toEqual([9, 8, 7, 6, 4]);
  });

  it('bracket counts a return anywhere inside the window', () => {
    // [1,2] u1,u2,u3,u6,u7 = 5 | [3,4] u1,u4,u5,u6,u7,u9 = 6
    const r = run({ measure: 'bracket', brackets: [[1, 2], [3, 4]] });
    expect(retained(r)).toEqual([5, 6]);
  });

  it('unbounded is never below n-day, and is strictly above it here', () => {
    // n-day understates returners badly; see the fixture note above.
    const n = retained(run({ measure: 'n-day' }));
    const u = retained(run({ measure: 'unbounded' }));
    for (let i = 0; i < n.length; i++) expect(u[i]!).toBeGreaterThanOrEqual(n[i]!);
    expect(u.slice(1, 4)).not.toEqual(n.slice(1, 4));
  });
});

describe('period 0', () => {
  it('is always the full cohort, since the start event is in the window', () => {
    for (const measure of ['n-day', 'unbounded'] as const) {
      const r = run({ measure });
      expect(r.curve[0]!.rate).toBe(1);
      expect(r.curve[0]!.retained).toBe(9);
    }
  });

  it('anchors the curve so the first point is not a drop from nowhere', () => {
    expect(run({ measure: 'n-day' }).curve[0]!.period).toBe(0);
  });
});

describe('incomplete cohorts', () => {
  it('marks periods the range cannot observe', () => {
    // Only three days of range, so day 3 and day 4 cannot be measured fairly.
    const r = run({ measure: 'n-day', range: daysRange(3) });
    expect(r.curve.map((p) => p.incomplete)).toEqual([false, false, false, true, true]);
  });

  it('does not let an under-observed cohort drag the denominator to zero', () => {
    // A cohort that started yesterday must not appear in the Day 30 denominator.
    // Two cohorts: day 0 (observable to day 4) and day 4 (observable to day 0).
    const events = [
      ...retentionFixture(),
      ev({ type: 'Signed Up', user: 'late', t: day(4, 9) }),
    ];
    const r = retention(
      events,
      { ...BASE, measure: 'n-day' },
      buildIdentityGraph(events),
    );
    // Day 4's denominator excludes `late`, whose cohort has no day-4 horizon.
    const d4 = r.curve[4]!;
    expect(d4.cohortSize).toBe(9);
    expect(d4.incomplete).toBe(false);
  });

  it('each curve point carries its own denominator', () => {
    const events = [
      ...retentionFixture(),
      ev({ type: 'Signed Up', user: 'late', t: day(3, 9) }),
      ev({ type: 'Opened App', user: 'late', t: day(4, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    // Day 0 and day 1 can see both cohorts; day 4 can only see the first.
    expect(r.curve[0]!.cohortSize).toBe(10);
    expect(r.curve[1]!.cohortSize).toBe(10);
    expect(r.curve[4]!.cohortSize).toBe(9);
  });

  it('still reports a number for a fully unobservable period rather than a bare zero', () => {
    const r = run({ measure: 'n-day', periods: 10, range: daysRange(5) });
    const d9 = r.curve[9]!;
    expect(d9.incomplete).toBe(true);
    expect(d9.cohortSize).toBe(9);
  });
});

describe('cohort table', () => {
  it('produces one row per cohort bucket', () => {
    const events = [
      ...retentionFixture(),
      ev({ type: 'Signed Up', user: 'late', t: day(2, 9) }),
      ev({ type: 'Opened App', user: 'late', t: day(3, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.table).toHaveLength(2);
    expect(r.table[0]!.cohortSize).toBe(9);
    expect(r.table[1]!.cohortSize).toBe(1);
    expect(r.table[1]!.cohortLabel).toBe('2026-01-03');
  });

  it('flags the staircase edge where a cohort runs out of observation', () => {
    const events = [
      ...retentionFixture(),
      ev({ type: 'Signed Up', user: 'late', t: day(3, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    const lateRow = r.table[1]!;
    // The day-3 cohort can only be observed one day out inside a five-day range.
    expect(lateRow.cells.map((c) => c.incomplete)).toEqual([false, false, true, true, true]);
  });

  it('rows are ordered by cohort start', () => {
    const events = [
      ev({ type: 'Signed Up', user: 'b', t: day(2) }),
      ev({ type: 'Signed Up', user: 'a', t: day(0) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.table.map((row) => row.cohortStart)).toEqual([T0, T0 + 2 * DAY]);
  });
});

describe('actions and segments', () => {
  it('takes the earliest matching start event as the cohort anchor', () => {
    const events = [
      ev({ type: 'Signed Up', user: 'u', t: day(0, 9) }),
      ev({ type: 'Signed Up', user: 'u', t: day(2, 9) }),
      ev({ type: 'Opened App', user: 'u', t: day(1, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.table[0]!.cohortStart).toBe(T0);
    expect(r.curve[1]!.retained).toBe(1);
  });

  it('supports any event as the return action', () => {
    const events = [
      ev({ type: 'Signed Up', user: 'u', t: day(0, 9) }),
      ev({ type: 'Anything', user: 'u', t: day(1, 9) }),
    ];
    const r = retention(
      events,
      { ...BASE, measure: 'n-day', returnAction: { event_type: '*' } },
      buildIdentityGraph(events),
    );
    expect(r.curve[1]!.retained).toBe(1);
  });

  it('applies the segment to the start action only', () => {
    // The return events carry no plan; a segment applied to them would match nothing.
    const events = [
      ev({ type: 'Signed Up', user: 'p', t: day(0, 9), context: { plan: 'pro' } }),
      ev({ type: 'Opened App', user: 'p', t: day(1, 9) }),
      ev({ type: 'Signed Up', user: 'f', t: day(0, 9), context: { plan: 'free' } }),
      ev({ type: 'Opened App', user: 'f', t: day(1, 9) }),
    ];
    const r = retention(
      events,
      {
        ...BASE,
        measure: 'n-day',
        segment: [{ property: { scope: 'context', key: 'plan' }, op: 'eq', value: 'pro' }],
      },
      buildIdentityGraph(events),
    );
    expect(r.totalUsers).toBe(1);
    expect(r.curve[1]!.retained).toBe(1);
  });

  it('ignores return events that precede the start event', () => {
    const events = [
      ev({ type: 'Opened App', user: 'u', t: day(0, 1) }),
      ev({ type: 'Signed Up', user: 'u', t: day(0, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.curve[1]!.retained).toBe(0);
  });

  it('excludes users who never performed the start action', () => {
    const events = [ev({ type: 'Opened App', user: 'u', t: day(0, 9) })];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.totalUsers).toBe(0);
    expect(r.table).toHaveLength(0);
  });
});

describe('intervals and identity', () => {
  it('buckets weekly', () => {
    const events = [
      ev({ type: 'Signed Up', user: 'u', t: day(0, 9) }),
      ev({ type: 'Opened App', user: 'u', t: day(9, 9) }),
    ];
    const r = retention(
      events,
      { ...BASE, measure: 'n-day', interval: 'week', periods: 3, range: daysRange(30) },
      buildIdentityGraph(events),
    );
    // 2026-01-01 is a Thursday, so day 9 falls in the following week bucket.
    expect(r.curve[1]!.retained).toBe(1);
  });

  it('treats a pre-login device and a post-login user as one person', () => {
    const events = [
      ev({ type: 'Signed Up', device: 'd1', t: day(0, 9) }),
      ev({ type: 'Opened App', device: 'd1', user: 'u1', t: day(1, 9) }),
    ];
    const r = retention(events, { ...BASE, measure: 'n-day' }, buildIdentityGraph(events));
    expect(r.totalUsers).toBe(1);
    expect(r.curve[1]!.retained).toBe(1);
  });

  it('reports the measure and interval it ran with', () => {
    const r = run({ measure: 'unbounded' });
    expect(r.measure).toBe('unbounded');
    expect(r.interval).toBe('day');
  });
});
