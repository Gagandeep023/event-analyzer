import { describe, it, expect, vi } from 'vitest';
import { Timeline, type Plugin, type DestinationPlugin } from './timeline';
import { quietLogger } from './__fixtures__';
import type { AnalyticsEvent, DeliveryResult, ResolvedSdkConfig } from '../types';

const config = {} as ResolvedSdkConfig;
const anEvent = (): AnalyticsEvent => ({ event_type: 'A' });

function sink(name = 'sink'): DestinationPlugin & { received: AnalyticsEvent[] } {
  const received: AnalyticsEvent[] = [];
  return {
    name,
    type: 'destination',
    received,
    async deliver(event): Promise<DeliveryResult> {
      received.push(event);
      return { code: 200, message: 'ok', event };
    },
  };
}

describe('registration', () => {
  it('defaults a plugin to the enrichment stage', async () => {
    const t = new Timeline(quietLogger);
    const p: Plugin = { name: 'p' };
    await t.register(p, config, null);
    expect(p.type).toBe('enrichment');
  });

  it('refuses a duplicate name', async () => {
    const t = new Timeline(quietLogger);
    await t.register({ name: 'dup' }, config, null);
    await t.register({ name: 'dup' }, config, null);
    expect(t.count()).toBe(1);
  });

  it('locks the name synchronously, before setup is awaited', async () => {
    // Without the lock, two concurrent add() calls both pass the existence
    // check and install twice, and every event gets enriched twice.
    const t = new Timeline(quietLogger);
    let resolveSetup!: () => void;
    const slow: Plugin = {
      name: 'slow',
      setup: () => new Promise<void>((r) => { resolveSetup = r; }),
    };
    const second: Plugin = { name: 'slow' };

    const a = t.register(slow, config, null);
    const b = t.register(second, config, null);
    resolveSetup();
    await Promise.all([a, b]);

    expect(t.count()).toBe(1);
  });

  it('does not install a plugin whose setup threw', async () => {
    const t = new Timeline(quietLogger);
    await t.register({ name: 'bad', setup: () => { throw new Error('boom'); } }, config, null);
    expect(t.count()).toBe(0);
    // The name is released, so a fixed version can register later.
    expect(t.has('bad')).toBe(false);
  });

  it('deregisters and calls teardown', async () => {
    const t = new Timeline(quietLogger);
    const teardown = vi.fn();
    await t.register({ name: 'p', teardown }, config, null);
    await t.deregister('p');
    expect(teardown).toHaveBeenCalledOnce();
    expect(t.count()).toBe(0);
  });
});

describe('pipeline order', () => {
  it('runs before, then enrichment, then destination', async () => {
    const order: string[] = [];
    const t = new Timeline(quietLogger);
    await t.register({ name: 'e', type: 'enrichment', execute: (ev) => { order.push('e'); return ev; } }, config, null);
    await t.register({ name: 'b', type: 'before', execute: (ev) => { order.push('b'); return ev; } }, config, null);
    const d = sink();
    await t.register({ ...d, execute: undefined }, config, null);

    await t.push(anEvent());
    expect(order).toEqual(['b', 'e']);
    expect(d.received).toHaveLength(1);
  });

  it('passes the transformed event down the chain', async () => {
    const t = new Timeline(quietLogger);
    await t.register({
      name: 'enrich',
      execute: (ev) => ({ ...ev, event_properties: { added: true } }),
    }, config, null);
    const d = sink();
    await t.register(d, config, null);

    await t.push(anEvent());
    expect(d.received[0]!.event_properties).toEqual({ added: true });
  });
});

describe('dropping', () => {
  it('a before plugin returning null drops the event', async () => {
    const t = new Timeline(quietLogger);
    await t.register({ name: 'block', type: 'before', execute: () => null }, config, null);
    const d = sink();
    await t.register(d, config, null);

    const r = await t.push(anEvent());
    expect(d.received).toHaveLength(0);
    expect(r.code).toBe(0);
    expect(r.message).toContain('block');
  });

  it('resolves a dropped event rather than hanging', async () => {
    // A caller awaiting track(...).promise must never be left waiting forever.
    const t = new Timeline(quietLogger);
    await t.register({ name: 'block', type: 'before', execute: () => null }, config, null);
    await expect(t.push(anEvent())).resolves.toBeDefined();
  });

  it('a plugin that throws drops the event instead of breaking the host app', async () => {
    const t = new Timeline(quietLogger);
    await t.register({ name: 'boom', execute: () => { throw new Error('x'); } }, config, null);
    const d = sink();
    await t.register(d, config, null);

    const r = await t.push(anEvent());
    expect(d.received).toHaveLength(0);
    expect(r.code).toBe(0);
  });

  it('resolves with a clear message when no destination is registered', async () => {
    const t = new Timeline(quietLogger);
    const r = await t.push(anEvent());
    expect(r.message).toContain('no destination');
  });
});

describe('fan-out and lifecycle hooks', () => {
  it('delivers to every destination', async () => {
    const t = new Timeline(quietLogger);
    const a = sink('a');
    const b = sink('b');
    await t.register(a, config, null);
    await t.register(b, config, null);

    await t.push(anEvent());
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });

  it('survives a destination that throws', async () => {
    const t = new Timeline(quietLogger);
    const good = sink('good');
    await t.register({
      name: 'bad',
      type: 'destination',
      deliver: () => Promise.reject(new Error('down')),
    } as DestinationPlugin, config, null);
    await t.register(good, config, null);

    await expect(t.push(anEvent())).resolves.toBeDefined();
    expect(good.received).toHaveLength(1);
  });

  it('notifies lifecycle hooks', async () => {
    const t = new Timeline(quietLogger);
    const onSessionIdChanged = vi.fn();
    const onOptOutChanged = vi.fn();
    const onReset = vi.fn();
    await t.register({ name: 'p', onSessionIdChanged, onOptOutChanged, onReset }, config, null);

    await t.notifySessionId(123);
    await t.notifyOptOut(true);
    await t.notifyReset();

    expect(onSessionIdChanged).toHaveBeenCalledWith(123);
    expect(onOptOutChanged).toHaveBeenCalledWith(true);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('a throwing lifecycle hook does not stop the others', async () => {
    const t = new Timeline(quietLogger);
    const good = vi.fn();
    await t.register({ name: 'bad', onReset: () => { throw new Error('x'); } }, config, null);
    await t.register({ name: 'good', onReset: good }, config, null);

    await t.notifyReset();
    expect(good).toHaveBeenCalledOnce();
  });
});
