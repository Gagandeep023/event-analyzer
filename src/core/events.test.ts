import { describe, it, expect } from 'vitest';
import { eventStats } from './events';
import { segmentation } from './segmentation';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange } from './__fixtures__';
import type { AnalyticsEvent } from '../types';

/** Three days of traffic, two users, three event types. */
function fixture(): AnalyticsEvent[] {
  return [
    ev({ type: 'Page Viewed', user: 'alice', t: day(0, 1) }),
    ev({ type: 'Page Viewed', user: 'alice', t: day(0, 2) }),
    ev({ type: 'Page Viewed', user: 'bobby', t: day(1, 1) }),
    ev({ type: 'Signed Up', user: 'alice', t: day(1, 3) }),
    ev({ type: 'Purchased', user: 'bobby', t: day(2, 5) }),
  ];
}

const run = (events: AnalyticsEvent[], over = {}) =>
  eventStats(events, { range: daysRange(3), ...over }, buildIdentityGraph(events));

describe('eventStats', () => {
  it('counts events and distinct users per type', () => {
    const r = run(fixture());
    const pv = r.events.find((e) => e.event_type === 'Page Viewed')!;
    expect(pv.count).toBe(3);
    expect(pv.users).toBe(2);
  });

  it('ranks by count descending', () => {
    expect(run(fixture()).events.map((e) => e.event_type))
      .toEqual(['Page Viewed', 'Purchased', 'Signed Up']);
  });

  it('reports first and last seen', () => {
    const pv = run(fixture()).events.find((e) => e.event_type === 'Page Viewed')!;
    expect(pv.firstSeen).toBe(day(0, 1));
    expect(pv.lastSeen).toBe(day(1, 1));
  });

  it('reports each type\'s share of the range', () => {
    const r = run(fixture());
    expect(r.totalEvents).toBe(5);
    expect(r.events.find((e) => e.event_type === 'Page Viewed')!.share).toBeCloseTo(0.6, 10);
    // Shares reconcile to 1.
    expect(r.events.reduce((n, e) => n + e.share, 0)).toBeCloseTo(1, 10);
  });

  it('counts a user once across the whole range', () => {
    expect(run(fixture()).totalUsers).toBe(2);
  });

  it('filters by substring, case-insensitively', () => {
    const r = run(fixture(), { search: 'page' });
    expect(r.events.map((e) => e.event_type)).toEqual(['Page Viewed']);
  });

  it('reports distinctTypes before the limit is applied', () => {
    const r = run(fixture(), { limit: 1 });
    expect(r.events).toHaveLength(1);
    expect(r.distinctTypes).toBe(3);
  });

  it('excludes events outside the range', () => {
    const events = [...fixture(), ev({ type: 'Ancient', user: 'alice', t: day(-40) })];
    expect(run(events).events.map((e) => e.event_type)).not.toContain('Ancient');
  });

  it('resolves a pre-login device into the logged-in user', () => {
    const events = [
      ev({ type: 'Page Viewed', device: 'd1', t: day(0, 1) }),
      ev({ type: 'Page Viewed', device: 'd1', user: 'u1', t: day(0, 2) }),
    ];
    expect(run(events).events[0]!.users).toBe(1);
  });

  it('returns an empty, zeroed shape for no data', () => {
    expect(run([])).toEqual({ events: [], totalEvents: 0, totalUsers: 0, distinctTypes: 0 });
  });
});

describe('eventStats comparison', () => {
  /** Same two days, doubled traffic in the later window. */
  function twoWindows(): AnalyticsEvent[] {
    const out: AnalyticsEvent[] = [];
    for (let i = 0; i < 2; i++) out.push(ev({ type: 'A', user: `u${i}`, t: day(-2, 1) }));
    for (let i = 0; i < 4; i++) out.push(ev({ type: 'A', user: `u${i}`, t: day(0, 1) }));
    out.push(ev({ type: 'Brand New', user: 'u9', t: day(0, 2) }));
    return out;
  }

  it('reports change against the preceding window of equal length', () => {
    const events = twoWindows();
    const r = eventStats(
      events,
      { range: { from: day(0), to: day(2) }, compare: true },
      buildIdentityGraph(events),
    );
    // 4 now vs 2 before.
    expect(r.events.find((e) => e.event_type === 'A')!.change).toBeCloseTo(1, 10);
  });

  it('reports null rather than Infinity for an event with no baseline', () => {
    // Appearing from nothing is not "up 100%". Null says "new".
    const events = twoWindows();
    const r = eventStats(
      events,
      { range: { from: day(0), to: day(2) }, compare: true },
      buildIdentityGraph(events),
    );
    expect(r.events.find((e) => e.event_type === 'Brand New')!.change).toBeNull();
  });

  it('omits change entirely when compare is off', () => {
    const events = twoWindows();
    const r = eventStats(events, { range: { from: day(0), to: day(2) } }, buildIdentityGraph(events));
    expect(r.events[0]!.change).toBeUndefined();
  });
});

describe('segmentation comparison', () => {
  function events(): AnalyticsEvent[] {
    return [
      // previous window: 1 user
      ev({ type: 'View', user: 'old', t: day(-2, 1) }),
      // current window: 3 users
      ev({ type: 'View', user: 'a', t: day(0, 1) }),
      ev({ type: 'View', user: 'b', t: day(0, 2) }),
      ev({ type: 'View', user: 'c', t: day(1, 1) }),
    ];
  }

  const q = {
    events: [{ event_type: 'View' }],
    countBy: 'uniques' as const,
    granularity: 'day' as const,
    range: { from: day(0), to: day(2) },
  };

  it('returns nothing extra when compare is off', () => {
    const e = events();
    expect(segmentation(e, q, buildIdentityGraph(e)).previous).toBeUndefined();
  });

  it('returns the preceding window of equal length', () => {
    const e = events();
    const r = segmentation(e, { ...q, compare: true }, buildIdentityGraph(e));
    expect(r.previous!.range).toEqual({ from: day(-2), to: day(0) });
    expect(r.previous!.series[0]!.total).toBe(1);
  });

  it('computes the change', () => {
    const e = events();
    const r = segmentation(e, { ...q, compare: true }, buildIdentityGraph(e));
    const d = r.previous!.delta[0]!;
    expect(d.current).toBe(3);
    expect(d.previous).toBe(1);
    expect(d.change).toBeCloseTo(2, 10);
  });

  it('aligns the previous series index-for-index so both draw on one axis', () => {
    const e = events();
    const r = segmentation(e, { ...q, compare: true }, buildIdentityGraph(e));
    expect(r.previous!.series[0]!.points).toHaveLength(r.series[0]!.points.length);
  });

  it('reports null change when the previous window is empty', () => {
    const e = [ev({ type: 'View', user: 'a', t: day(0, 1) })];
    const r = segmentation(e, { ...q, compare: true }, buildIdentityGraph(e));
    expect(r.previous!.delta[0]!.change).toBeNull();
  });

  it('does not recurse: the previous window has no previous of its own', () => {
    const e = events();
    const r = segmentation(e, { ...q, compare: true }, buildIdentityGraph(e));
    expect((r.previous!.series as unknown as { previous?: unknown }).previous).toBeUndefined();
  });
});
