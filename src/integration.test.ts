/**
 * End-to-end: SDK through a real Express instance, into a store, back out
 * through the query endpoints.
 *
 * Runs against both stores, because the export round trip is only meaningful if
 * persistence is really involved.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEventAnalyzerRouter } from './backend';
import { MemoryStore } from './backend/stores/MemoryStore';
import { JsonlFileStore } from './backend/stores/JsonlFileStore';
import { createClient } from './sdk';
import type { AnalyticsEvent, FunnelResult, RetentionResult, SegmentationResult } from './types';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const WRITE_KEY = 'pk_test_key';

let server: Server;
let baseUrl = '';
let store: MemoryStore;
let dir = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ea-int-'));
  store = new MemoryStore();

  const app = express();
  app.use('/api/events', createEventAnalyzerRouter(express, {
    store,
    apiKeys: [WRITE_KEY],
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
  }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}/api/events`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await store.clear();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function query<T>(kind: string, q: unknown): Promise<T> {
  const res = await post(`/query/${kind}`, q, { 'X-EA-Key': WRITE_KEY });
  return res.body as T;
}

const ev = (over: Partial<AnalyticsEvent>): AnalyticsEvent => ({
  event_type: 'A',
  user_id: 'user1',
  time: T0,
  ...over,
});

describe('ingestion', () => {
  it('accepts a batch and reports what landed', async () => {
    const res = await post('/collect', { events: [ev({}), ev({ event_type: 'B' })] }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: 200, events_ingested: 2, events_rejected: 0 });
    expect(await store.count()).toBe(2);
  });

  it('refuses a missing write key', async () => {
    const res = await post('/collect', { events: [ev({})] });
    expect(res.status).toBe(401);
    expect(await store.count()).toBe(0);
  });

  it('partially accepts, naming failures by index', async () => {
    // One bad event must not cost the caller the others.
    const res = await post('/collect', {
      events: [ev({}), { event_type: 'NoIdentity' }, ev({ event_type: 'C' })],
    }, { 'X-EA-Key': WRITE_KEY });

    expect(res.status).toBe(200);
    expect(res.body.events_ingested).toBe(2);
    expect(res.body.events_rejected).toBe(1);
    const rejected = res.body.rejected as Record<string, Record<string, number[]>>;
    expect(rejected.events_with_missing_fields!.user_id).toEqual([1]);
  });

  it('returns 400 only when nothing in the batch was usable', async () => {
    const res = await post('/collect', { events: [{ event_type: 'X' }] }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no valid events');
  });

  it('rejects a body without an events array', async () => {
    const res = await post('/collect', { nope: true }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(400);
  });

  it('deduplicates a repeated insert_id', async () => {
    const event = ev({ insert_id: 'dup-1' });
    await post('/collect', { events: [event] }, { 'X-EA-Key': WRITE_KEY });
    const second = await post('/collect', { events: [event] }, { 'X-EA-Key': WRITE_KEY });
    expect(second.body.events_ingested).toBe(0);
    expect(await store.count()).toBe(1);
  });
});

describe('the SDK against a real server', () => {
  it('delivers tracked events end to end', async () => {
    const client = createClient({
      endpoint: `${baseUrl}/collect`,
      apiKey: WRITE_KEY,
      storage: 'memory',
      logLevel: 'none',
      flushIntervalMillis: 10,
    });

    const result = await client.track('Checkout Started', { cart_value: 4200 }).promise;
    await client.flush();

    expect(result.code).toBe(200);
    const stored = await store.query({ from: 0, to: Date.now() + DAY });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.event_type).toBe('Checkout Started');
    expect(stored[0]!.insert_id).toBeTruthy();
    expect(stored[0]!.session_id).toBeTruthy();
  });

  it('surfaces an auth failure to the caller without retrying forever', async () => {
    const client = createClient({
      endpoint: `${baseUrl}/collect`,
      apiKey: 'wrong',
      storage: 'memory',
      logLevel: 'none',
      flushIntervalMillis: 10,
    });
    const result = await client.track('A').promise;
    expect(result.code).toBe(401);
  });
});

describe('query endpoints', () => {
  /** Two users, a real funnel with a drop, spread over three days. */
  async function seed() {
    const events: AnalyticsEvent[] = [
      ev({ event_type: 'Signed Up', user_id: 'alice', time: T0 }),
      ev({ event_type: 'Project Created', user_id: 'alice', time: T0 + 3600_000 }),
      ev({ event_type: 'Opened App', user_id: 'alice', time: T0 + DAY }),
      ev({ event_type: 'Signed Up', user_id: 'bobby', time: T0 }),
      ev({ event_type: 'Opened App', user_id: 'bobby', time: T0 + 2 * DAY }),
    ];
    await post('/collect', { events }, { 'X-EA-Key': WRITE_KEY });
  }

  const range = { from: T0, to: T0 + 5 * DAY };

  it('runs segmentation', async () => {
    await seed();
    const r = await query<SegmentationResult>('segmentation', {
      events: [{ event_type: 'Signed Up' }],
      countBy: 'uniques',
      granularity: 'day',
      range,
    });
    expect(r.series[0]!.total).toBe(2);
    expect(r.buckets).toHaveLength(5);
  });

  it('runs a funnel', async () => {
    await seed();
    const r = await query<FunnelResult>('funnel', {
      steps: [{ event_type: 'Signed Up' }, { event_type: 'Project Created' }],
      order: 'ordered',
      conversionWindowMs: 7 * DAY,
      countBy: 'uniques',
      range,
    });
    expect(r.steps.map((s) => s.count)).toEqual([2, 1]);
    expect(r.overallConversion).toBe(0.5);
  });

  it('runs retention with all three measures', async () => {
    await seed();
    const base = {
      startAction: { event_type: 'Signed Up' },
      returnAction: { event_type: 'Opened App' },
      interval: 'day',
      periods: 2,
      range,
    };
    const nday = await query<RetentionResult>('retention', { ...base, measure: 'n-day' });
    const unbounded = await query<RetentionResult>('retention', { ...base, measure: 'unbounded' });

    expect(nday.curve[1]!.retained).toBe(1);
    expect(unbounded.curve[1]!.retained).toBe(2);
    expect(unbounded.curve[0]!.incomplete).toBe(false);
  });

  it('runs sessions and cohorts', async () => {
    await seed();
    const sessions = await query<{ totalSessions: number }>('sessions', { granularity: 'day', range });
    expect(sessions.totalSessions).toBeGreaterThan(0);

    const cohort = await query<{ userIds: string[] }>('cohort', {
      did: [{ step: { event_type: 'Signed Up' } }],
      didNot: [{ event_type: 'Project Created' }],
      range,
    });
    expect(cohort.userIds).toEqual(['bobby']);
  });

  it('rejects an unknown query kind with 404, not 400', async () => {
    const res = await post('/query/nonsense', { range }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(404);
  });

  it('requires a range', async () => {
    const res = await post('/query/segmentation', { events: [] }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(400);
  });

  it('refuses a regex filter while regex is disabled', async () => {
    // Untrusted regex compiled from a request body is a DoS vector.
    const res = await post('/query/segmentation', {
      events: [{
        event_type: 'A',
        filters: [{ property: { scope: 'event', key: 'x' }, op: 'regex', value: '.*' }],
      }],
      countBy: 'uniques', granularity: 'day', range,
    }, { 'X-EA-Key': WRITE_KEY });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('regex');
  });
});

describe('meta, health and export', () => {
  it('discovers event types and property keys', async () => {
    await post('/collect', {
      events: [ev({ event_properties: { plan: 'pro' }, context: { platform: 'web' } })],
    }, { 'X-EA-Key': WRITE_KEY });

    const res = await fetch(`${baseUrl}/meta`);
    const meta = await res.json() as { eventTypes: Array<{ event_type: string }>; propertyKeys: unknown[] };
    expect(meta.eventTypes.map((e) => e.event_type)).toContain('A');
    expect(meta.propertyKeys).toContainEqual({ scope: 'event', key: 'plan' });
  });

  it('reports health without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('round trips: collect, export, replay, identical query results', async () => {
    // This is what makes "one event shape everywhere" enforceable rather than
    // aspirational. If an internal representation ever diverges from the wire
    // format, this fails immediately.
    const events = [
      ev({ event_type: 'Signed Up', user_id: 'alice', time: T0 }),
      ev({ event_type: 'Opened App', user_id: 'alice', time: T0 + DAY }),
      ev({ event_type: 'Signed Up', user_id: 'bobby', time: T0 }),
    ];
    await post('/collect', { events }, { 'X-EA-Key': WRITE_KEY });

    const exported = await fetch(`${baseUrl}/export?from=${T0}&to=${T0 + 5 * DAY}`);
    const ndjson = await exported.text();
    const lines = ndjson.trim().split('\n');
    expect(lines).toHaveLength(3);

    const replayed = lines.map((l) => JSON.parse(l) as AnalyticsEvent);

    // Replay into a FILE store, so the round trip really goes through disk and
    // a serialisation divergence cannot hide behind a shared in-memory object.
    const second = new JsonlFileStore({ dir: join(dir, 'replay') });
    await second.append(replayed);

    const range = { from: T0, to: T0 + 5 * DAY };
    const { segmentation } = await import('./core');
    const q = {
      events: [{ event_type: 'Signed Up' }],
      countBy: 'uniques' as const,
      granularity: 'day' as const,
      range,
    };
    const fromOriginal = segmentation(await store.query(range), q);
    const fromReplay = segmentation(await second.query(range), q);

    expect(fromReplay).toEqual(fromOriginal);
  });
});
