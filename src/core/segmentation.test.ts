import { describe, it, expect } from 'vitest';
import { segmentation, OTHER_GROUP_LABEL } from './segmentation';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange } from './__fixtures__';
import type { AnalyticsEvent, SegmentationQuery } from '../types';

const base: Omit<SegmentationQuery, 'events'> = {
  countBy: 'uniques',
  granularity: 'day',
  range: daysRange(3),
};

const run = (events: AnalyticsEvent[], over: Partial<SegmentationQuery> = {}) =>
  segmentation(
    events,
    { ...base, events: [{ event_type: 'View' }], ...over },
    buildIdentityGraph(events),
  );

describe('counting', () => {
  const events = [
    ev({ type: 'View', user: 'u1', t: day(0, 1) }),
    ev({ type: 'View', user: 'u1', t: day(0, 2) }),
    ev({ type: 'View', user: 'u2', t: day(0, 3) }),
    ev({ type: 'View', user: 'u1', t: day(1, 1) }),
  ];

  it('counts distinct users under uniques', () => {
    expect(run(events).series[0]!.points.map((p) => p.value)).toEqual([2, 1, 0]);
  });

  it('counts events under totals', () => {
    expect(run(events, { countBy: 'totals' }).series[0]!.points.map((p) => p.value)).toEqual([3, 1, 0]);
  });

  it('divides totals by uniques under average, returning 0 for empty buckets', () => {
    const values = run(events, { countBy: 'average' }).series[0]!.points.map((p) => p.value);
    expect(values[0]).toBeCloseTo(1.5, 10);
    expect(values[1]).toBe(1);
    // The empty bucket must be 0, never NaN.
    expect(values[2]).toBe(0);
    expect(Number.isNaN(values[2]!)).toBe(false);
  });

  it('emits empty buckets as zeros so the chart draws a continuous line', () => {
    const r = run(events);
    expect(r.buckets).toHaveLength(3);
    expect(r.series[0]!.points).toHaveLength(3);
  });

  it('reports a series total', () => {
    expect(run(events).series[0]!.total).toBe(3);
  });
});

describe('multiple events and filters', () => {
  const events = [
    ev({ type: 'View', user: 'u1', t: day(0, 1) }),
    ev({ type: 'Click', user: 'u1', t: day(0, 2) }),
  ];

  it('produces one series per declared event, in declared order', () => {
    const r = run(events, { events: [{ event_type: 'Click' }, { event_type: 'View' }] });
    expect(r.series.map((s) => s.label)).toEqual(['Click', 'View']);
  });

  it('keeps an event with no data as a flat zero line rather than dropping it', () => {
    // Otherwise the legend silently loses an entry the user explicitly asked for.
    const r = run(events, { events: [{ event_type: 'View' }, { event_type: 'Never' }] });
    expect(r.series).toHaveLength(2);
    expect(r.series[1]!.total).toBe(0);
  });

  it('honours a custom step label', () => {
    expect(run(events, { events: [{ event_type: 'View', label: 'Page Views' }] }).series[0]!.label)
      .toBe('Page Views');
  });

  it('applies step filters', () => {
    const withProps = [
      ev({ type: 'View', user: 'u1', t: day(0, 1), props: { page: 'home' } }),
      ev({ type: 'View', user: 'u2', t: day(0, 2), props: { page: 'pricing' } }),
    ];
    const r = run(withProps, {
      events: [{
        event_type: 'View',
        filters: [{ property: { scope: 'event', key: 'page' }, op: 'eq', value: 'home' }],
      }],
    });
    expect(r.series[0]!.total).toBe(1);
  });

  it('applies the segment filter across all events', () => {
    const withCtx = [
      ev({ type: 'View', user: 'u1', t: day(0, 1), context: { platform: 'web' } }),
      ev({ type: 'View', user: 'u2', t: day(0, 2), context: { platform: 'ios' } }),
    ];
    const r = run(withCtx, {
      segment: [{ property: { scope: 'context', key: 'platform' }, op: 'eq', value: 'web' }],
    });
    expect(r.series[0]!.total).toBe(1);
  });

  it('excludes events outside the range', () => {
    const spread = [
      ev({ type: 'View', user: 'u1', t: day(0, 1) }),
      ev({ type: 'View', user: 'u2', t: day(99, 1) }),
    ];
    expect(run(spread).series[0]!.total).toBe(1);
  });
});

describe('group by', () => {
  const events = [
    ev({ type: 'View', user: 'w1', t: day(0, 1), context: { platform: 'web' } }),
    ev({ type: 'View', user: 'w2', t: day(0, 2), context: { platform: 'web' } }),
    ev({ type: 'View', user: 'i1', t: day(0, 3), context: { platform: 'ios' } }),
  ];
  const platform = { scope: 'context' as const, key: 'platform' };

  it('fans out one series per group value', () => {
    const r = run(events, { groupBy: platform });
    expect(r.series.map((s) => s.label)).toEqual(['web', 'ios']);
    expect(r.series[0]!.total).toBe(2);
  });

  it('ranks groups by total', () => {
    const r = run(events, { groupBy: platform });
    expect(r.series[0]!.total).toBeGreaterThanOrEqual(r.series[1]!.total);
  });

  it('collapses a missing group value into a single bucket', () => {
    const mixed = [...events, ev({ type: 'View', user: 'x', t: day(0, 4) })];
    const r = run(mixed, { groupBy: platform });
    expect(r.series.map((s) => s.label)).toContain('(none)');
  });

  it('folds the tail into Other, keeping totals reconciled', () => {
    const many: AnalyticsEvent[] = [];
    for (let i = 0; i < 6; i++) {
      // Group i gets i+1 users, so ranking is unambiguous.
      for (let u = 0; u <= i; u++) {
        many.push(ev({ type: 'View', user: `g${i}u${u}`, t: day(0, 1), context: { platform: `p${i}` } }));
      }
    }
    const r = run(many, { groupBy: platform, limitGroups: 2 });
    expect(r.series).toHaveLength(3);
    expect(r.series[2]!.label).toBe(OTHER_GROUP_LABEL);

    const grandTotal = r.series.reduce((n, s) => n + s.total, 0);
    const ungrouped = run(many).series[0]!.total;
    expect(grandTotal).toBe(ungrouped);
  });

  it('does not fold when the group count is within the limit', () => {
    const r = run(events, { groupBy: platform, limitGroups: 10 });
    expect(r.series.map((s) => s.label)).not.toContain(OTHER_GROUP_LABEL);
  });
});

describe('granularity and identity', () => {
  it('buckets hourly', () => {
    const events = [
      ev({ type: 'View', user: 'u', t: day(0, 1) }),
      ev({ type: 'View', user: 'u', t: day(0, 2) }),
    ];
    const r = run(events, { granularity: 'hour', range: { from: day(0), to: day(0, 4) } });
    expect(r.buckets).toHaveLength(4);
    expect(r.series[0]!.points.map((p) => p.value)).toEqual([0, 1, 1, 0]);
  });

  it('counts a pre-login device and a post-login user as one unique', () => {
    const events = [
      ev({ type: 'View', device: 'd1', t: day(0, 1) }),
      ev({ type: 'View', device: 'd1', user: 'u1', t: day(0, 2) }),
    ];
    expect(run(events).series[0]!.points[0]!.value).toBe(1);
  });

  it('reports the granularity it ran with', () => {
    expect(run([]).granularity).toBe('day');
  });
});
