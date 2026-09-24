import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient, Client } from './client';
import { Identify, Revenue } from './identify';
import { memoryStorage } from './storage';
import { FakeTransport, quietLogger } from './__fixtures__';
import type { StorageAdapter } from '../types';

function make(over: Record<string, unknown> = {}, storage?: StorageAdapter) {
  const transport = new FakeTransport();
  const client = createClient({
    endpoint: 'https://example.test/collect',
    transport,
    storage: storage ?? memoryStorage(),
    loggerProvider: quietLogger,
    logLevel: 'none',
    flushIntervalMillis: 1000,
    ...over,
  });
  return { client, transport };
}

async function drain(client: Client, transport: FakeTransport) {
  await client.flush();
  await vi.advanceTimersByTimeAsync(2000);
  return transport.allEvents();
}

describe('tracking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tracks an event by name and properties', async () => {
    const { client, transport } = make();
    client.track('Checkout Started', { cart_value: 4200 });
    const [event] = await drain(client, transport);

    expect(event!.event_type).toBe('Checkout Started');
    expect(event!.event_properties).toEqual({ cart_value: 4200 });
  });

  it('accepts a full event object', async () => {
    const { client, transport } = make();
    client.track({ event_type: 'Plan Upgraded', groups: { org: 'acme' } });
    const [event] = await drain(client, transport);

    expect(event!.groups).toEqual({ org: 'acme' });
  });

  it('returns a promise that resolves, without requiring the caller to await', async () => {
    const { client, transport } = make();
    const result = client.track('A');
    expect(result.promise).toBeInstanceOf(Promise);
    await drain(client, transport);
    await expect(result.promise).resolves.toMatchObject({ code: 200 });
  });

  it('stamps time, session, insert_id, event_id and context', async () => {
    const { client, transport } = make();
    client.track('A');
    const [event] = await drain(client, transport);

    expect(typeof event!.time).toBe('number');
    expect(typeof event!.session_id).toBe('number');
    expect(event!.insert_id).toBeTruthy();
    expect(event!.event_id).toBe(0);
    expect((event!.context as Record<string, unknown>).library).toMatch(/event-analyzer-sdk/);
  });

  it('increments event_id so events sharing a timestamp stay ordered', async () => {
    const { client, transport } = make();
    client.track('A');
    client.track('B');
    const events = await drain(client, transport);
    expect(events.map((e) => e.event_id)).toEqual([0, 1]);
  });

  it('always attaches a device id, and a user id once set', async () => {
    const { client, transport } = make();
    client.track('anon');
    client.setUserId('u1');
    client.track('known');
    const events = await drain(client, transport);

    expect(events[0]!.device_id).toBeTruthy();
    expect(events[0]!.user_id).toBeUndefined();
    expect(events[1]!.user_id).toBe('u1');
  });

  it('sends identify as a $identify event carrying the operations', async () => {
    const { client, transport } = make();
    client.identify(new Identify().set('plan', 'pro').add('logins', 1));
    const [event] = await drain(client, transport);

    expect(event!.event_type).toBe('$identify');
    expect(event!.user_properties).toEqual({ $set: { plan: 'pro' }, $add: { logins: 1 } });
  });

  it('sends groupIdentify with the group and its properties', async () => {
    const { client, transport } = make();
    client.groupIdentify('org', 'acme', new Identify().set('seats', 40));
    const [event] = await drain(client, transport);

    expect(event!.groups).toEqual({ org: 'acme' });
    expect(event!.group_properties).toEqual({ $set: { seats: 40 } });
  });

  it('sends revenue with computed totals', async () => {
    const { client, transport } = make();
    client.revenue(new Revenue().setPrice(29).setQuantity(2).setEventProperties({ campaign: 'launch' }));
    const [event] = await drain(client, transport);

    expect(event!.revenue).toMatchObject({ price: 29, quantity: 2, revenue: 58 });
    expect(event!.event_properties).toEqual({ campaign: 'launch' });
  });
});

describe('opt out', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops everything while set', async () => {
    const { client, transport } = make({ optOut: true });
    client.track('A');
    expect(await drain(client, transport)).toHaveLength(0);
  });

  it('can be toggled at runtime', async () => {
    const { client, transport } = make();
    client.setOptOut(true);
    client.track('dropped');
    client.setOptOut(false);
    client.track('kept');

    const events = await drain(client, transport);
    expect(events.map((e) => e.event_type)).toEqual(['kept']);
    expect(client.getOptOut()).toBe(false);
  });
});

describe('identity and session', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exposes and updates identity', async () => {
    const { client } = make();
    await client.flush();
    client.setUserId('u1');
    client.setDeviceId('d1');
    expect(client.getIdentity()).toEqual({ userId: 'u1', deviceId: 'd1' });
  });

  it('reset issues a new device id and clears the user', async () => {
    const { client } = make();
    await client.flush();
    client.setUserId('u1');
    const before = client.getDeviceId();

    await client.reset();
    expect(client.getUserId()).toBeUndefined();
    expect(client.getDeviceId()).not.toBe(before);
  });

  it('persists identity so a reload resumes the same device and session', async () => {
    const storage = memoryStorage();
    const first = make({}, storage);
    first.client.setUserId('u1');
    first.client.track('A');
    await drain(first.client, first.transport);

    const deviceId = first.client.getDeviceId();
    const sessionId = first.client.getSessionId();

    const second = make({}, storage);
    await second.client.flush();
    expect(second.client.getDeviceId()).toBe(deviceId);
    expect(second.client.getUserId()).toBe('u1');
    expect(second.client.getSessionId()).toBe(sessionId);
  });

  it('setSessionId overrides explicitly', async () => {
    const { client } = make();
    await client.flush();
    client.setSessionId(12345);
    expect(client.getSessionId()).toBe(12345);
  });
});

describe('plugins and configuration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a custom enrichment plugin', async () => {
    const { client, transport } = make();
    await client.add({
      name: 'tagger',
      execute: (event) => ({ ...event, event_properties: { ...event.event_properties, tagged: true } }),
    });
    client.track('A');
    const [event] = await drain(client, transport);
    expect((event!.event_properties as Record<string, unknown>).tagged).toBe(true);
  });

  it('removes a plugin by name', async () => {
    const { client, transport } = make();
    await client.add({ name: 'blocker', type: 'before', execute: () => null });
    client.track('dropped');
    await drain(client, transport);
    expect(transport.allEvents()).toHaveLength(0);

    await client.remove('blocker');
    client.track('kept');
    expect((await drain(client, transport)).map((e) => e.event_type)).toEqual(['kept']);
  });

  it('merges defaultContext under explicit per-event context', async () => {
    const { client, transport } = make({ defaultContext: { app_version: '2.4.1', platform: 'custom' } });
    client.track({ event_type: 'A', context: { platform: 'override' } });
    const [event] = await drain(client, transport);

    const ctx = event!.context as Record<string, unknown>;
    expect(ctx.app_version).toBe('2.4.1');
    expect(ctx.platform).toBe('override');
  });

  it('applies documented defaults', () => {
    const { client } = make({ flushIntervalMillis: undefined });
    const config = client.getConfig();
    expect(config.flushIntervalMillis).toBe(5000);
    expect(config.flushQueueSize).toBe(30);
    expect(config.sessionTimeoutMs).toBe(1_800_000);
  });

  it('defaults every autocapture mode off', () => {
    // Many tools default several on, which is how people ship tracking they did
    // not know about. The honest default for a self-hosted tool is nothing.
    expect(make().client.getConfig().autocapture).toEqual({});
  });

  it('requires an endpoint', () => {
    expect(() => createClient({ endpoint: '' })).toThrow(/endpoint/);
  });
});
