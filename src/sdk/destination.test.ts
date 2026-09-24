import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Destination, QUEUE_KEY, rejectedIndices } from './destination';
import { memoryStorage } from './storage';
import { FakeTransport, quietLogger } from './__fixtures__';
import { SDK_DEFAULTS } from '../types';
import type { AnalyticsEvent, ResolvedSdkConfig, StorageAdapter } from '../types';

function makeConfig(
  transport: FakeTransport,
  storage: StorageAdapter,
  over: Partial<ResolvedSdkConfig> = {},
): ResolvedSdkConfig {
  return {
    endpoint: 'https://example.test/collect',
    flushIntervalMillis: 1000,
    flushQueueSize: 30,
    flushMaxRetries: 3,
    maxBatchSize: 500,
    sessionTimeoutMs: 1_800_000,
    minIdLength: 5,
    optOut: false,
    offline: false,
    logLevel: 'none',
    transport,
    storage,
    autocapture: {},
    loggerProvider: quietLogger,
    defaultContext: {},
    ...over,
  };
}

const anEvent = (n: number): AnalyticsEvent => ({ event_type: `E${n}`, user_id: 'user1' });

describe('rejectedIndices', () => {
  it('collects every named index across all rejection maps', () => {
    const map = rejectedIndices({
      events_with_missing_fields: { event_type: [0, 2] },
      events_with_invalid_fields: { time: [5] },
      events_with_invalid_id_lengths: { user_id: [7] },
      duplicate_events: [9],
    });
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([0, 2, 5, 7, 9]);
    expect(map.get(0)).toContain('event_type');
    expect(map.get(9)).toContain('duplicate');
  });

  it('returns an empty map for a body with no detail', () => {
    expect(rejectedIndices({ error: 'nope' }).size).toBe(0);
    expect(rejectedIndices(null).size).toBe(0);
  });
});

describe('Destination', () => {
  let transport: FakeTransport;
  let storage: StorageAdapter;
  let dest: Destination;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    storage = memoryStorage();
    dest = new Destination();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async (over: Partial<ResolvedSdkConfig> = {}) => {
    await dest.setup(makeConfig(transport, storage, over));
  };

  it('stamps insert_id on entry so retries are idempotent', async () => {
    await start();
    const event = anEvent(1);
    void dest.deliver(event);
    expect(event.insert_id).toBeTruthy();
  });

  it('keeps a caller-supplied insert_id', async () => {
    await start();
    const event = { ...anEvent(1), insert_id: 'mine' };
    void dest.deliver(event);
    expect(event.insert_id).toBe('mine');
  });

  it('batches until the flush interval elapses', async () => {
    await start();
    void dest.deliver(anEvent(1));
    void dest.deliver(anEvent(2));
    expect(transport.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.events).toHaveLength(2);
  });

  it('flushes immediately at the queue-size threshold', async () => {
    await start({ flushQueueSize: 3 });
    void dest.deliver(anEvent(1));
    void dest.deliver(anEvent(2));
    void dest.deliver(anEvent(3));

    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent).toHaveLength(1);
  });

  it('sends the api key as a header, never in the body', async () => {
    await start({ apiKey: 'pk_test' });
    void dest.deliver(anEvent(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sent[0]!.headers['X-EA-Key']).toBe('pk_test');
  });

  it('splits a batch exceeding maxBatchSize', async () => {
    await start({ maxBatchSize: 2, flushQueueSize: 5 });
    for (let i = 0; i < 5; i++) void dest.deliver(anEvent(i));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sent.map((b) => b.events.length)).toEqual([2, 2, 1]);
  });

  it('resolves each event on a 2xx', async () => {
    await start();
    const p = dest.deliver(anEvent(1));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ code: 200, message: 'success' });
  });
});

describe('response handling', () => {
  let transport: FakeTransport;
  let dest: Destination;

  beforeEach(async () => {
    vi.useFakeTimers();
    transport = new FakeTransport();
    dest = new Destination();
    await dest.setup(makeConfig(transport, memoryStorage(), { flushQueueSize: 100 }));
  });

  afterEach(() => vi.useRealTimers());

  it('on 400 drops only the named events and requeues the rest', async () => {
    // One bad event must not cost the caller the other 499.
    transport
      .reply({ status: 400, body: { events_with_missing_fields: { event_type: [1] } } })
      .then({ status: 200 });

    const a = dest.deliver(anEvent(0));
    const b = dest.deliver(anEvent(1));
    const c = dest.deliver(anEvent(2));

    await vi.advanceTimersByTimeAsync(1000);
    await expect(b).resolves.toMatchObject({ code: 400 });

    await vi.advanceTimersByTimeAsync(2000);
    await expect(a).resolves.toMatchObject({ code: 200 });
    await expect(c).resolves.toMatchObject({ code: 200 });
    expect(transport.sent[1]!.events).toHaveLength(2);
  });

  it('on 400 with no index detail rejects the whole batch without looping', async () => {
    transport.reply({ status: 400, body: { error: 'bad request' } });
    const p = dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ code: 400 });
    expect(transport.sent).toHaveLength(1);
  });

  it('on 413 splits the batch in half and retries both', async () => {
    transport.reply({ status: 413 }).then({ status: 200 });
    for (let i = 0; i < 4; i++) void dest.deliver(anEvent(i));

    await vi.advanceTimersByTimeAsync(1000);
    // One rejected batch of 4, then halves of 2 and 2.
    expect(transport.sent.map((b) => b.events.length)).toEqual([4, 2, 2]);
  });

  it('on 413 for a single event drops it rather than splitting forever', async () => {
    transport.then({ status: 413 });
    const p = dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ code: 413 });
  });

  it('on 429 backs off by the throttle timeout, not the retry timeout', async () => {
    transport.reply({ status: 429 }).then({ status: 200 });
    void dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sent).toHaveLength(1);

    // Still backing off after the ordinary retry delay.
    await vi.advanceTimersByTimeAsync(SDK_DEFAULTS.retryTimeoutMs);
    expect(transport.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(SDK_DEFAULTS.throttleTimeoutMs);
    expect(transport.sent).toHaveLength(2);
  });

  it('a throttle backoff is not shortened by incoming traffic', async () => {
    // Without longest-timeout-wins, steady traffic reschedules a 30 second
    // backoff down to the flush interval and hammers a server that said stop.
    transport.reply({ status: 429 }).then({ status: 200 });
    void dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.sent).toHaveLength(1);

    void dest.deliver(anEvent(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.sent).toHaveLength(1);
  });

  it('does not retry a 401, which will not fix itself', async () => {
    transport.then({ status: 401 });
    const p = dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toMatchObject({ code: 401 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sent).toHaveLength(1);
  });

  it('retries a 500', async () => {
    transport.reply({ status: 500 }).then({ status: 200 });
    const p = dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(SDK_DEFAULTS.retryTimeoutMs);
    await expect(p).resolves.toMatchObject({ code: 200 });
  });

  it('retries a thrown network error', async () => {
    transport.fail(1).then({ status: 200 });
    const p = dest.deliver(anEvent(0));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(SDK_DEFAULTS.retryTimeoutMs);
    await expect(p).resolves.toMatchObject({ code: 200 });
  });

  it('gives up at the retry ceiling, keeping memory bounded', async () => {
    // Bounded even against a server that has been down for a week.
    transport.then({ status: 500 });
    const p = dest.deliver(anEvent(0));
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(SDK_DEFAULTS.retryTimeoutMs + 1000);
    }
    await expect(p).resolves.toMatchObject({ code: 500, message: 'max retries exceeded' });
    expect(dest.pending()).toBe(0);
  });
});

describe('persistence and offline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('persists the unsent queue and replays it on setup', async () => {
    // The entire offline story, and why a tab closing mid-batch loses nothing.
    const storage = memoryStorage();
    const first = new Destination();
    await first.setup(makeConfig(new FakeTransport(), storage, { offline: true }));
    void first.deliver(anEvent(1));
    void first.deliver(anEvent(2));
    await vi.advanceTimersByTimeAsync(0);

    expect(await storage.get<AnalyticsEvent[]>(QUEUE_KEY)).toHaveLength(2);

    const transport = new FakeTransport();
    const second = new Destination();
    await second.setup(makeConfig(transport, storage));
    await vi.advanceTimersByTimeAsync(2000);

    expect(transport.allEvents()).toHaveLength(2);
  });

  it('queues but never sends while offline', async () => {
    const transport = new FakeTransport();
    const dest = new Destination();
    await dest.setup(makeConfig(transport, memoryStorage(), { offline: true }));

    void dest.deliver(anEvent(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.sent).toHaveLength(0);
    expect(dest.pending()).toBe(1);
  });

  it('clears the persisted queue once everything is delivered', async () => {
    const storage = memoryStorage();
    const dest = new Destination();
    await dest.setup(makeConfig(new FakeTransport(), storage));

    void dest.deliver(anEvent(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await storage.get(QUEUE_KEY)).toBeNull();
  });
});
