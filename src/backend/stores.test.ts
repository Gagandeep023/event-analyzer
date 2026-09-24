import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './stores/MemoryStore';
import { JsonlFileStore } from './stores/JsonlFileStore';
import { deriveMeta, isAliasCapable, type AliasCapableStore } from './stores/EventStore';
import type { AnalyticsEvent } from '../types';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

const ev = (n: number, over: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  event_type: `E${n}`,
  user_id: `user${n}`,
  time: T0 + n * DAY,
  insert_id: `i${n}`,
  ...over,
});

/**
 * One suite run against both stores.
 *
 * Any store dropped in later, SQLite included, must pass this unchanged.
 */
function sharedSuite(name: string, make: () => AliasCapableStore, cleanup?: () => void) {
  describe(name, () => {
    let store: AliasCapableStore;

    beforeEach(() => { store = make(); });
    afterEach(() => cleanup?.());

    it('appends and counts', async () => {
      await store.append([ev(0), ev(1)]);
      expect(await store.count()).toBe(2);
    });

    it('queries a half-open range', async () => {
      await store.append([ev(0), ev(1), ev(2)]);
      const got = await store.query({ from: T0, to: T0 + 2 * DAY });
      expect(got.map((e) => e.event_type)).toEqual(['E0', 'E1']);
    });

    it('excludes the upper bound', async () => {
      await store.append([ev(0)]);
      expect(await store.query({ from: T0, to: T0 })).toHaveLength(0);
    });

    it('applies filters during the scan', async () => {
      await store.append([
        ev(0, { event_properties: { plan: 'pro' } }),
        ev(1, { event_properties: { plan: 'free' } }),
      ]);
      const got = await store.query(
        { from: T0, to: T0 + 10 * DAY },
        [{ property: { scope: 'event', key: 'plan' }, op: 'eq', value: 'pro' }],
      );
      expect(got).toHaveLength(1);
    });

    it('returns events in chronological order', async () => {
      await store.append([ev(3), ev(1), ev(2)]);
      const got = await store.query({ from: T0, to: T0 + 10 * DAY });
      expect(got.map((e) => e.time)).toEqual([T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
    });

    it('reports meta', async () => {
      await store.append([
        ev(0, { event_properties: { a: 1 }, context: { platform: 'web' } }),
        ev(1, { user_properties: { $set: { plan: 'pro' } } }),
      ]);
      const meta = await store.meta();
      expect(meta.eventTypes).toEqual(['E0', 'E1']);
      expect(meta.totalEvents).toBe(2);
      expect(meta.oldest).toBe(T0);
      expect(meta.newest).toBe(T0 + DAY);
      expect(meta.propertyKeys).toContainEqual({ scope: 'event', key: 'a' });
      expect(meta.propertyKeys).toContainEqual({ scope: 'context', key: 'platform' });
      // A $set-wrapped key is discoverable by its bare name.
      expect(meta.propertyKeys).toContainEqual({ scope: 'user', key: 'plan' });
    });

    it('stores and returns aliases', async () => {
      expect(isAliasCapable(store)).toBe(true);
      await store.appendAliases([{ user_id: 'a', global_user_id: 'b' }]);
      expect(await store.aliases()).toEqual([{ user_id: 'a', global_user_id: 'b' }]);
    });

    it('clears', async () => {
      await store.append([ev(0)]);
      await store.clear!();
      expect(await store.count()).toBe(0);
    });

    it('handles an empty append', async () => {
      await store.append([]);
      expect(await store.count()).toBe(0);
    });
  });
}

sharedSuite('MemoryStore', () => new MemoryStore());

let dir = '';
sharedSuite(
  'JsonlFileStore',
  () => {
    dir = mkdtempSync(join(tmpdir(), 'ea-store-'));
    return new JsonlFileStore({ dir });
  },
  () => { if (dir) rmSync(dir, { recursive: true, force: true }); },
);

describe('MemoryStore eviction', () => {
  it('evicts the oldest events past maxEvents', async () => {
    const store = new MemoryStore({ maxEvents: 2 });
    await store.append([ev(0), ev(1), ev(2)]);
    expect(await store.count()).toBe(2);
    const kept = await store.query({ from: T0, to: T0 + 10 * DAY });
    expect(kept.map((e) => e.event_type)).toEqual(['E1', 'E2']);
  });

  it('evicts by event time, not arrival order', async () => {
    const store = new MemoryStore({ maxEvents: 2 });
    await store.append([ev(5)]);
    await store.append([ev(0), ev(1)]);
    const kept = await store.query({ from: T0, to: T0 + 10 * DAY });
    expect(kept.map((e) => e.event_type)).toEqual(['E1', 'E5']);
  });
});

describe('JsonlFileStore segments', () => {
  let d = '';
  beforeEach(() => { d = mkdtempSync(join(tmpdir(), 'ea-seg-')); });
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('writes one file per event day', async () => {
    const store = new JsonlFileStore({ dir: d });
    await store.append([ev(0), ev(1), ev(2)]);
    expect(store.segmentCount()).toBe(3);
  });

  it('files by event time, not arrival time, so a late event lands correctly', async () => {
    const store = new JsonlFileStore({ dir: d });
    await store.append([ev(2)]);
    await store.append([ev(0)]);
    const got = await store.query({ from: T0, to: T0 + DAY });
    expect(got.map((e) => e.event_type)).toEqual(['E0']);
  });

  it('survives a reopen, which is the point of a file store', async () => {
    const first = new JsonlFileStore({ dir: d });
    await first.append([ev(0), ev(1)]);
    const second = new JsonlFileStore({ dir: d });
    expect(await second.count()).toBe(2);
  });

  it('skips a torn final line rather than failing the read', async () => {
    const store = new JsonlFileStore({ dir: d });
    await store.append([ev(0)]);
    const { appendFileSync, readdirSync } = await import('node:fs');
    const file = readdirSync(d).find((f) => f.startsWith('events-'))!;
    appendFileSync(join(d, file), '{"event_type":"trunc', 'utf-8');

    const reopened = new JsonlFileStore({ dir: d });
    expect(await reopened.count()).toBe(1);
  });

  it('serves a repeated query from cache until a write bumps the generation', async () => {
    const store = new JsonlFileStore({ dir: d });
    await store.append([ev(0)]);
    const range = { from: T0, to: T0 + 10 * DAY };
    const a = await store.query(range);
    const b = await store.query(range);
    // Same array identity means the disk was not read twice.
    expect(b).toBe(a);

    await store.append([ev(1)]);
    expect(await store.query(range)).not.toBe(a);
  });
});

describe('deriveMeta', () => {
  it('returns nulls for an empty input', () => {
    expect(deriveMeta([])).toEqual({
      eventTypes: [], propertyKeys: [], oldest: null, newest: null, totalEvents: 0,
    });
  });

  it('sorts event types and property keys', () => {
    const meta = deriveMeta([ev(1, { event_properties: { z: 1, a: 2 } }), ev(0)]);
    expect(meta.eventTypes).toEqual(['E0', 'E1']);
    expect(meta.propertyKeys.map((p) => p.key)).toEqual(['a', 'z']);
  });
});
