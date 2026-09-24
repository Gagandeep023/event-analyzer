import { describe, it, expect } from 'vitest';
import { breakdown, OTHER_ROW, UNKNOWN_VALUE } from './breakdown';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange } from './__fixtures__';
import type { AnalyticsEvent } from '../types';

const BROWSER = { scope: 'context' as const, key: 'browser' };

/** Three browsers, one visitor counted twice on the same browser. */
function fixture(): AnalyticsEvent[] {
  return [
    ev({ type: 'Page Viewed', user: 'a', t: day(0, 1), context: { browser: 'Chrome' } }),
    ev({ type: 'Page Viewed', user: 'a', t: day(0, 2), context: { browser: 'Chrome' } }),
    ev({ type: 'Page Viewed', user: 'b', t: day(0, 3), context: { browser: 'Chrome' } }),
    ev({ type: 'Page Viewed', user: 'c', t: day(1, 1), context: { browser: 'Safari' } }),
    ev({ type: 'Signed Up', user: 'd', t: day(1, 2), context: { browser: 'Firefox' } }),
    ev({ type: 'Page Viewed', user: 'e', t: day(1, 3) }),
  ];
}

const run = (events: AnalyticsEvent[], over = {}) =>
  breakdown(events, { property: BROWSER, range: daysRange(3), ...over }, buildIdentityGraph(events));

describe('breakdown', () => {
  it('ranks by distinct users, not event count', () => {
    // 'a' fired twice on Chrome; that must not outrank two separate people.
    const r = run(fixture());
    expect(r.rows[0]).toMatchObject({ value: 'Chrome', users: 2, events: 3 });
  });

  it('can rank by events instead', () => {
    const r = run(fixture(), { rankBy: 'events' });
    expect(r.rows[0]!.events).toBe(3);
  });

  it('labels a missing property rather than dropping the event', () => {
    // Dropping it would silently shrink the denominator.
    const values = run(fixture()).rows.map((x) => x.value);
    expect(values).toContain(UNKNOWN_VALUE);
  });

  it('restricts to one event type when asked', () => {
    const r = run(fixture(), { event: { event_type: 'Signed Up' } });
    expect(r.rows.map((x) => x.value)).toEqual(['Firefox']);
  });

  it('applies the segment filter', () => {
    const r = run(fixture(), {
      segment: [{ property: { scope: 'context', key: 'browser' }, op: 'eq', value: 'Safari' }],
    });
    expect(r.rows.map((x) => x.value)).toEqual(['Safari']);
  });

  it('folds the tail into Other and keeps distinctValues honest', () => {
    const many: AnalyticsEvent[] = [];
    for (let i = 0; i < 6; i++) {
      many.push(ev({ type: 'X', user: `u${i}`, t: day(0, 1), context: { browser: `B${i}` } }));
    }
    const r = breakdown(many, { property: BROWSER, range: daysRange(3), limit: 2 },
      buildIdentityGraph(many));
    expect(r.rows).toHaveLength(3);
    expect(r.rows[2]!.value).toBe(OTHER_ROW);
    expect(r.distinctValues).toBe(6);
  });

  it('reports totals across the range', () => {
    const r = run(fixture());
    expect(r.totalEvents).toBe(6);
    expect(r.totalUsers).toBe(5);
  });

  it('reports change against the preceding window, null with no baseline', () => {
    const events = [
      ev({ type: 'X', user: 'old', t: day(-2, 1), context: { browser: 'Chrome' } }),
      ev({ type: 'X', user: 'a', t: day(0, 1), context: { browser: 'Chrome' } }),
      ev({ type: 'X', user: 'b', t: day(0, 2), context: { browser: 'Chrome' } }),
      ev({ type: 'X', user: 'c', t: day(0, 3), context: { browser: 'Edge' } }),
    ];
    const r = breakdown(events, { property: BROWSER, range: { from: day(0), to: day(2) }, compare: true },
      buildIdentityGraph(events));
    expect(r.rows.find((x) => x.value === 'Chrome')!.change).toBeCloseTo(1, 10);
    expect(r.rows.find((x) => x.value === 'Edge')!.change).toBeNull();
  });

  it('returns an empty shape for no data', () => {
    const r = run([]);
    expect(r.rows).toEqual([]);
    expect(r.totalUsers).toBe(0);
  });

  it('resolves a pre-login device into the logged-in user', () => {
    const events = [
      ev({ type: 'X', device: 'd1', t: day(0, 1), context: { browser: 'Chrome' } }),
      ev({ type: 'X', device: 'd1', user: 'u1', t: day(0, 2), context: { browser: 'Chrome' } }),
    ];
    expect(run(events).rows[0]!.users).toBe(1);
  });
});
