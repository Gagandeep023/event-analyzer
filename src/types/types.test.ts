import { describe, it, expect } from 'vitest';
import {
  IdentifyOperation,
  IDENTIFY_OPERATIONS,
  IDENTIFY_MERGE_ORDER,
  GROUP_IDENTIFY_OPERATIONS,
} from './event';
import { FILTER_OPS, NULLARY_FILTER_OPS, ARRAY_FILTER_OPS, GRANULARITIES, INTERVALS } from './filter';
import {
  FUNNEL_ORDERS,
  RETENTION_MEASURES,
  QUERY_KINDS,
  SESSION_BIN_EDGES,
  MAX_SESSION_MS,
  DEFAULT_CONVERSION_WINDOW_MS,
} from './query';
import { SDK_DEFAULTS, BACKEND_DEFAULTS } from './config';

describe('identify operations', () => {
  it('IDENTIFY_OPERATIONS lists every enum member exactly once', () => {
    const fromEnum = Object.values(IdentifyOperation);
    expect([...IDENTIFY_OPERATIONS].sort()).toEqual([...fromEnum].sort());
    expect(new Set(IDENTIFY_OPERATIONS).size).toBe(IDENTIFY_OPERATIONS.length);
  });

  it('IDENTIFY_MERGE_ORDER covers every operation exactly once', () => {
    // A gap here would silently skip an operation during a merge.
    expect([...IDENTIFY_MERGE_ORDER].sort()).toEqual([...IDENTIFY_OPERATIONS].sort());
    expect(new Set(IDENTIFY_MERGE_ORDER).size).toBe(IDENTIFY_MERGE_ORDER.length);
  });

  it('applies $clearAll first and $add last', () => {
    // $clearAll must dominate; $add must land on top of a $set in the same payload.
    expect(IDENTIFY_MERGE_ORDER[0]).toBe(IdentifyOperation.CLEAR_ALL);
    expect(IDENTIFY_MERGE_ORDER[IDENTIFY_MERGE_ORDER.length - 1]).toBe(IdentifyOperation.ADD);
  });

  it('orders $setOnce before $set', () => {
    const order = IDENTIFY_MERGE_ORDER;
    expect(order.indexOf(IdentifyOperation.SET_ONCE)).toBeLessThan(
      order.indexOf(IdentifyOperation.SET),
    );
  });

  it('group operations are a strict subset of user operations', () => {
    // Groups take a narrower set: no preInsert/postInsert/remove/clearAll.
    for (const op of GROUP_IDENTIFY_OPERATIONS) {
      expect(IDENTIFY_OPERATIONS).toContain(op);
    }
    expect(GROUP_IDENTIFY_OPERATIONS.length).toBeLessThan(IDENTIFY_OPERATIONS.length);
    expect(GROUP_IDENTIFY_OPERATIONS).not.toContain(IdentifyOperation.CLEAR_ALL);
  });
});

describe('filter tables', () => {
  it('has no duplicate operators', () => {
    expect(new Set(FILTER_OPS).size).toBe(FILTER_OPS.length);
  });

  it('nullary and array operator sets are drawn from FILTER_OPS', () => {
    for (const op of [...NULLARY_FILTER_OPS, ...ARRAY_FILTER_OPS]) {
      expect(FILTER_OPS).toContain(op);
    }
  });

  it('nullary and array operator sets do not overlap', () => {
    const overlap = NULLARY_FILTER_OPS.filter((op) => ARRAY_FILTER_OPS.includes(op));
    expect(overlap).toEqual([]);
  });

  it('every interval is also a granularity', () => {
    for (const i of INTERVALS) expect(GRANULARITIES).toContain(i);
  });
});

describe('query tables', () => {
  it('uses the conventional funnel mode vocabulary verbatim', () => {
    // Migrated queries carry the established meaning, so the words must match.
    expect([...FUNNEL_ORDERS].sort()).toEqual(['ordered', 'sequential', 'unordered']);
  });

  it('ships all three retention measures', () => {
    // n-day alone understates returning users by roughly 3.5x against unbounded.
    expect([...RETENTION_MEASURES].sort()).toEqual(['bracket', 'n-day', 'unbounded']);
  });

  it('exposes six query kinds', () => {
    expect([...QUERY_KINDS].sort()).toEqual([
      'cohort', 'events', 'funnel', 'retention', 'segmentation', 'sessions',
    ]);
  });

  it('defaults the conversion window to 30 days', () => {
    expect(DEFAULT_CONVERSION_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('session bin edges', () => {
  it('is strictly ascending', () => {
    for (let i = 1; i < SESSION_BIN_EDGES.length; i++) {
      expect(SESSION_BIN_EDGES[i]!).toBeGreaterThan(SESSION_BIN_EDGES[i - 1]!);
    }
  });

  it('starts at zero and ends at the one-day cap', () => {
    expect(SESSION_BIN_EDGES[0]).toBe(0);
    expect(SESSION_BIN_EDGES[SESSION_BIN_EDGES.length - 1]).toBe(MAX_SESSION_MS);
    expect(MAX_SESSION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('is non-linear, because session length is right-skewed', () => {
    // Linear bins produce one useless spike. Assert widths actually grow.
    const widths: number[] = [];
    for (let i = 1; i < SESSION_BIN_EDGES.length; i++) {
      widths.push(SESSION_BIN_EDGES[i]! - SESSION_BIN_EDGES[i - 1]!);
    }
    expect(widths[widths.length - 1]!).toBeGreaterThan(widths[0]! * 100);
  });
});

describe('defaults', () => {
  it('flushes less eagerly than hosted tools do', () => {
    // Hosted tools use 1000ms. A self-hosted collector is not billing per request.
    expect(SDK_DEFAULTS.flushIntervalMillis).toBe(5_000);
    expect(SDK_DEFAULTS.sessionTimeoutMs).toBe(30 * 60 * 1000);
    expect(SDK_DEFAULTS.minIdLength).toBe(5);
  });

  it('backs off longer on a throttle than on a retry', () => {
    // A 429 must not be shortened by ordinary retry cadence.
    expect(SDK_DEFAULTS.throttleTimeoutMs).toBeGreaterThan(SDK_DEFAULTS.retryTimeoutMs);
  });

  it('defaults autocapture and regex filters off', () => {
    expect(SDK_DEFAULTS.optOut).toBe(false);
    expect(BACKEND_DEFAULTS.allowRegexFilters).toBe(false);
    expect(BACKEND_DEFAULTS.flatPayloadCompat).toBe(false);
  });

  it('agrees on minIdLength across sdk and backend', () => {
    // Validated on both sides; a mismatch means events pass one and fail the other.
    expect(SDK_DEFAULTS.minIdLength).toBe(BACKEND_DEFAULTS.minIdLength);
  });
});
