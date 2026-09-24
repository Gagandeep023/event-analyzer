import { describe, it, expect } from 'vitest';
import { funnel } from './funnel';
import { buildIdentityGraph } from './identity';
import { ev, day, wideRange, HOUR, DAY } from './__fixtures__';
import type { AnalyticsEvent, FunnelQuery, FunnelOrder } from '../types';
import { DEFAULT_CONVERSION_WINDOW_MS } from '../types';

const STEPS = [
  { event_type: 'A' },
  { event_type: 'B' },
  { event_type: 'C' },
];

function q(over: Partial<FunnelQuery> = {}): FunnelQuery {
  return {
    steps: STEPS,
    order: 'ordered',
    conversionWindowMs: DEFAULT_CONVERSION_WINDOW_MS,
    countBy: 'uniques',
    range: wideRange(),
    ...over,
  };
}

const run = (events: AnalyticsEvent[], over: Partial<FunnelQuery> = {}) =>
  funnel(events, q(over), buildIdentityGraph(events));

const counts = (events: AnalyticsEvent[], over: Partial<FunnelQuery> = {}) =>
  run(events, over).steps.map((s) => s.count);

describe('basic conversion', () => {
  const events = [
    // converts fully
    ev({ type: 'A', user: 'f1', t: day(0, 0) }),
    ev({ type: 'B', user: 'f1', t: day(0, 1) }),
    ev({ type: 'C', user: 'f1', t: day(0, 3) }),
    // drops at C
    ev({ type: 'A', user: 'f2', t: day(0, 0) }),
    ev({ type: 'B', user: 'f2', t: day(0, 2) }),
    // drops at B
    ev({ type: 'A', user: 'f3', t: day(0, 0) }),
  ];

  it('counts users reaching each depth', () => {
    expect(counts(events)).toEqual([3, 2, 1]);
  });

  it('reports conversion from start and from previous', () => {
    const r = run(events);
    expect(r.steps[0]!.conversionFromStart).toBe(1);
    expect(r.steps[1]!.conversionFromStart).toBeCloseTo(2 / 3, 10);
    expect(r.steps[2]!.conversionFromStart).toBeCloseTo(1 / 3, 10);
    expect(r.steps[2]!.conversionFromPrevious).toBe(0.5);
    expect(r.overallConversion).toBeCloseTo(1 / 3, 10);
  });

  it('reports drop-off counts and rates', () => {
    const r = run(events);
    expect(r.steps[0]!.dropOff).toBe(0);
    expect(r.steps[1]!.dropOff).toBe(1);
    expect(r.steps[2]!.dropOff).toBe(1);
    expect(r.steps[2]!.dropOffRate).toBe(0.5);
  });

  it('reports per-hop timing, and null for the first step', () => {
    const r = run(events);
    expect(r.steps[0]!.medianTimeFromPreviousMs).toBeNull();
    // f1 took 1h into B, f2 took 2h. Median of [1h, 2h] is 1.5h.
    expect(r.steps[1]!.medianTimeFromPreviousMs).toBe(1.5 * HOUR);
    // Only f1 reached C, 2h after B.
    expect(r.steps[2]!.medianTimeFromPreviousMs).toBe(2 * HOUR);
  });

  it('returns an all-zero shape when nothing matches', () => {
    const r = run([ev({ type: 'Z', user: 'x', t: day(0) })]);
    expect(counts([ev({ type: 'Z', user: 'x', t: day(0) })])).toEqual([0, 0, 0]);
    expect(r.overallConversion).toBe(0);
    expect(r.medianTotalTimeMs).toBeNull();
  });
});

describe('ordering modes', () => {
  // X sits between A and B, which only `sequential` objects to.
  const interleaved = [
    ev({ type: 'A', user: 'u', t: day(0, 0) }),
    ev({ type: 'X', user: 'u', t: day(0, 1) }),
    ev({ type: 'B', user: 'u', t: day(0, 2) }),
    ev({ type: 'C', user: 'u', t: day(0, 3) }),
  ];

  it('ordered permits unrelated events between steps', () => {
    expect(counts(interleaved, { order: 'ordered' })).toEqual([1, 1, 1]);
  });

  it('sequential forbids any other event between two steps', () => {
    // This is Amplitude's meaning of the word, not the intuitive one.
    expect(counts(interleaved, { order: 'sequential' })).toEqual([1, 0, 0]);
  });

  it('sequential accepts a strictly adjacent run', () => {
    const adjacent = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'C', user: 'u', t: day(0, 2) }),
    ];
    expect(counts(adjacent, { order: 'sequential' })).toEqual([1, 1, 1]);
  });

  it('ordered rejects steps that occur out of order', () => {
    const reversed = [
      ev({ type: 'C', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'A', user: 'u', t: day(0, 2) }),
    ];
    expect(counts(reversed, { order: 'ordered' })).toEqual([1, 0, 0]);
  });

  it('unordered accepts steps in any order', () => {
    const reversed = [
      ev({ type: 'C', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'A', user: 'u', t: day(0, 2) }),
    ];
    // The window opens at the step-0 match, so B and C must be re-findable.
    const later = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'C', user: 'u', t: day(0, 1) }),
      ev({ type: 'B', user: 'u', t: day(0, 2) }),
    ];
    expect(counts(later, { order: 'unordered' })).toEqual([1, 1, 1]);
    expect(counts(reversed, { order: 'unordered' })).toEqual([1, 0, 0]);
  });

  it('unordered gives partial credit for a partial set', () => {
    const partial = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'C', user: 'u', t: day(0, 1) }),
    ];
    expect(counts(partial, { order: 'unordered' })).toEqual([1, 1, 0]);
  });
});

describe('conversion window', () => {
  const slow = [
    ev({ type: 'A', user: 'u', t: day(0) }),
    ev({ type: 'B', user: 'u', t: day(5) }),
    ev({ type: 'C', user: 'u', t: day(10) }),
  ];

  it('bounds the whole funnel, not each hop', () => {
    // Each hop is 5 days, but the total is 10. A 7-day window must reject the
    // second hop even though that hop on its own fits.
    expect(counts(slow, { conversionWindowMs: 7 * DAY })).toEqual([1, 1, 0]);
    expect(counts(slow, { conversionWindowMs: 11 * DAY })).toEqual([1, 1, 1]);
  });

  it('treats an event exactly at the deadline as inside the window', () => {
    const boundary = [
      ev({ type: 'A', user: 'u', t: day(0) }),
      ev({ type: 'B', user: 'u', t: day(0) + DAY }),
      ev({ type: 'C', user: 'u', t: day(0) + DAY }),
    ];
    expect(counts(boundary, { conversionWindowMs: DAY })).toEqual([1, 1, 1]);
  });
});

describe('re-entry', () => {
  it('lets a user who abandoned once still convert later', () => {
    // Without re-entry this reads as a drop-off, and any funnel over a long
    // window understates conversion badly.
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      // first attempt dies here
      ev({ type: 'A', user: 'u', t: day(1, 0) }),
      ev({ type: 'B', user: 'u', t: day(1, 1) }),
      ev({ type: 'C', user: 'u', t: day(1, 2) }),
    ];
    expect(counts(events)).toEqual([1, 1, 1]);
  });

  it('records the best attempt, not the first', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'A', user: 'u', t: day(1, 0) }),
      ev({ type: 'B', user: 'u', t: day(1, 1) }),
      ev({ type: 'C', user: 'u', t: day(1, 2) }),
    ];
    expect(counts(events)).toEqual([1, 1, 1]);
  });

  it('counts attempts rather than users under countBy totals', () => {
    // The correct denominator for a transactional funnel such as checkout.
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'C', user: 'u', t: day(0, 2) }),
      ev({ type: 'A', user: 'u', t: day(1, 0) }),
      ev({ type: 'B', user: 'u', t: day(1, 1) }),
      ev({ type: 'C', user: 'u', t: day(1, 2) }),
    ];
    expect(counts(events, { countBy: 'uniques' })).toEqual([1, 1, 1]);
    expect(counts(events, { countBy: 'totals' })).toEqual([2, 2, 2]);
  });
});

describe('exclusions', () => {
  it('truncates an attempt at the step before the exclusion', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'Refund', user: 'u', t: day(0, 2) }),
      ev({ type: 'C', user: 'u', t: day(0, 3) }),
    ];
    expect(counts(events)).toEqual([1, 1, 1]);
    expect(counts(events, { exclusions: [{ event_type: 'Refund' }] })).toEqual([1, 1, 0]);
  });

  it('leaves a funnel alone when the exclusion never fires', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'B', user: 'u', t: day(0, 1) }),
      ev({ type: 'C', user: 'u', t: day(0, 2) }),
    ];
    expect(counts(events, { exclusions: [{ event_type: 'Refund' }] })).toEqual([1, 1, 1]);
  });
});

describe('segment and grouping', () => {
  const events = [
    ev({ type: 'A', user: 'w1', t: day(0, 0), context: { platform: 'web' } }),
    ev({ type: 'B', user: 'w1', t: day(0, 1) }),
    ev({ type: 'C', user: 'w1', t: day(0, 2) }),
    ev({ type: 'A', user: 'i1', t: day(0, 0), context: { platform: 'ios' } }),
    ev({ type: 'B', user: 'i1', t: day(0, 1) }),
    ev({ type: 'A', user: 'i2', t: day(0, 0), context: { platform: 'ios' } }),
  ];

  const platform = { scope: 'context' as const, key: 'platform' };

  it('applies the segment to the first step only', () => {
    // The later steps carry no platform at all; if the segment were applied to
    // every step, nothing would convert.
    const r = run(events, {
      segment: [{ property: platform, op: 'eq', value: 'web' }],
    });
    expect(r.steps.map((s) => s.count)).toEqual([1, 1, 1]);
  });

  it('partitions by the group value on the step-0 event', () => {
    const r = run(events, { groupBy: platform });
    expect(r.steps.map((s) => s.count)).toEqual([3, 2, 1]);
    expect(r.groups!['web']!.steps.map((s) => s.count)).toEqual([1, 1, 1]);
    expect(r.groups!['ios']!.steps.map((s) => s.count)).toEqual([2, 1, 0]);
  });

  it('group totals reconcile with the ungrouped total', () => {
    const r = run(events, { groupBy: platform });
    const summed = Object.values(r.groups!).reduce((n, g) => n + g.totalEntered, 0);
    expect(summed).toBe(r.totalEntered);
  });
});

describe('monotonicity invariant', () => {
  /**
   * Step counts must be non-increasing for any input. A violation means the walk
   * is double-counting a re-entry, which is the easiest bug to introduce here
   * and the hardest to spot by eye, because the output still looks plausible.
   */
  function assertMonotonic(events: AnalyticsEvent[], order: FunnelOrder, countBy: 'uniques' | 'totals') {
    const r = run(events, { order, countBy });
    for (let i = 1; i < r.steps.length; i++) {
      expect(r.steps[i]!.count).toBeLessThanOrEqual(r.steps[i - 1]!.count);
    }
  }

  // Deterministic pseudo-random generator, so a failure is reproducible.
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  it('holds across many generated event streams', () => {
    const types = ['A', 'B', 'C', 'X', 'Refund'];
    for (let seed = 1; seed <= 40; seed++) {
      const rand = lcg(seed);
      const events: AnalyticsEvent[] = [];
      const userCount = 1 + Math.floor(rand() * 6);
      for (let u = 0; u < userCount; u++) {
        const n = Math.floor(rand() * 12);
        for (let i = 0; i < n; i++) {
          events.push(
            ev({
              type: types[Math.floor(rand() * types.length)]!,
              user: `u${u}`,
              t: day(0) + Math.floor(rand() * 20 * HOUR),
              eventId: i,
            }),
          );
        }
      }
      for (const order of ['ordered', 'unordered', 'sequential'] as const) {
        for (const countBy of ['uniques', 'totals'] as const) {
          assertMonotonic(events, order, countBy);
        }
      }
    }
  });

  it('holds with exclusions in play', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0, 0) }),
      ev({ type: 'Refund', user: 'u', t: day(0, 1) }),
      ev({ type: 'B', user: 'u', t: day(0, 2) }),
      ev({ type: 'C', user: 'u', t: day(0, 3) }),
    ];
    const r = run(events, { exclusions: [{ event_type: 'Refund' }] });
    for (let i = 1; i < r.steps.length; i++) {
      expect(r.steps[i]!.count).toBeLessThanOrEqual(r.steps[i - 1]!.count);
    }
  });
});

describe('identity resolution', () => {
  it('a pre-login device and a post-login user are one funnel entrant', () => {
    const events = [
      ev({ type: 'A', device: 'd1', t: day(0, 0) }),
      ev({ type: 'B', device: 'd1', user: 'u1', t: day(0, 1) }),
      ev({ type: 'C', user: 'u1', t: day(0, 2) }),
    ];
    expect(counts(events)).toEqual([1, 1, 1]);
  });
});
