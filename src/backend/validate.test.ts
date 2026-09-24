import { describe, it, expect } from 'vitest';
import {
  validateBatch, toRejectionMap, normalizeAmplitudeEvent,
  MAX_EVENT_TYPE_LENGTH, MAX_STRING_LENGTH, MIN_EVENT_TIME, MAX_CLOCK_SKEW_MS,
} from './validate';

const NOW = Date.UTC(2026, 0, 15);
const ok = { event_type: 'A', user_id: 'user1' };

const run = (events: unknown[], opts = {}) => validateBatch(events, { now: NOW, ...opts });

describe('acceptance', () => {
  it('accepts a well-formed event', () => {
    const { accepted, issues } = run([ok]);
    expect(accepted).toHaveLength(1);
    expect(issues).toHaveLength(0);
  });

  it('accepts a device id in place of a user id', () => {
    expect(run([{ event_type: 'A', device_id: 'dev123' }]).accepted).toHaveLength(1);
  });

  it('stamps server_received_time and fills a missing time', () => {
    const [event] = run([ok]).accepted;
    expect(event!.server_received_time).toBe(NOW);
    expect(event!.time).toBe(NOW);
  });

  it('generates a missing insert_id', () => {
    expect(run([ok]).accepted[0]!.insert_id).toBeTruthy();
  });

  it('keeps a caller-supplied insert_id', () => {
    expect(run([{ ...ok, insert_id: 'mine' }]).accepted[0]!.insert_id).toBe('mine');
  });

  it('does not mutate the caller\'s object', () => {
    const input = { ...ok };
    run([input]);
    expect(input).not.toHaveProperty('server_received_time');
  });
});

describe('rejection', () => {
  it('rejects a missing or empty event_type', () => {
    expect(run([{ user_id: 'user1' }]).issues[0]).toMatchObject({ field: 'event_type', kind: 'missing' });
    expect(run([{ event_type: '', user_id: 'user1' }]).issues[0]!.kind).toBe('missing');
  });

  it('rejects an over-long event_type', () => {
    const long = 'x'.repeat(MAX_EVENT_TYPE_LENGTH + 1);
    expect(run([{ event_type: long, user_id: 'user1' }]).issues[0]!.kind).toBe('invalid');
  });

  it('rejects an event with neither identifier', () => {
    expect(run([{ event_type: 'A' }]).issues[0]).toMatchObject({ field: 'user_id', kind: 'missing' });
  });

  it('rejects an identifier shorter than minIdLength', () => {
    expect(run([{ event_type: 'A', user_id: 'ab' }]).issues[0]!.kind).toBe('invalid_id_length');
    expect(run([{ event_type: 'A', user_id: 'ab' }], { minIdLength: 2 }).accepted).toHaveLength(1);
  });

  it('rejects a non-numeric time', () => {
    expect(run([{ ...ok, time: 'yesterday' }]).issues[0]!.field).toBe('time');
    expect(run([{ ...ok, time: NaN }]).issues[0]!.field).toBe('time');
  });

  it('rejects a time before 2000 or too far in the future', () => {
    expect(run([{ ...ok, time: MIN_EVENT_TIME - 1 }]).issues[0]!.field).toBe('time');
    expect(run([{ ...ok, time: NOW + MAX_CLOCK_SKEW_MS + 1 }]).issues[0]!.field).toBe('time');
    // A clock a few hours fast is tolerated.
    expect(run([{ ...ok, time: NOW + 3_600_000 }]).accepted).toHaveLength(1);
  });

  it('rejects a non-object', () => {
    expect(run(['string', 42, null, []]).issues).toHaveLength(4);
  });

  it('rejects an over-deep property object', () => {
    let nested: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 45; i++) nested = { nested };
    expect(run([{ ...ok, event_properties: nested }]).issues[0]!.field).toBe('event_properties');
  });
});

describe('partial acceptance', () => {
  it('keeps the good events and names the bad ones by index', () => {
    // One bad event must not cost the caller the other 499.
    const batch = [ok, { event_type: 'B' }, ok, { user_id: 'user1' }];
    const { accepted, issues } = run(batch);
    expect(accepted).toHaveLength(2);
    expect(issues.map((i) => i.index)).toEqual([1, 3]);
  });

  it('builds an index-addressed rejection map', () => {
    const batch = [ok, { event_type: 'B' }, { ...ok, time: 'x' }, { event_type: 'C', user_id: 'ab' }];
    const map = toRejectionMap(run(batch).issues);
    expect(map.events_with_missing_fields).toEqual({ user_id: [1] });
    expect(map.events_with_invalid_fields).toEqual({ time: [2] });
    expect(map.events_with_invalid_id_lengths).toEqual({ user_id: [3] });
  });

  it('groups several failures of the same kind under one field', () => {
    const map = toRejectionMap(run([{ event_type: 'A' }, { event_type: 'B' }]).issues);
    expect(map.events_with_missing_fields).toEqual({ user_id: [0, 1] });
  });
});

describe('truncation and deduplication', () => {
  it('truncates an over-long string rather than rejecting the event', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 500);
    const { accepted, issues } = run([{ ...ok, event_properties: { note: long } }]);
    expect(issues).toHaveLength(0);
    expect((accepted[0]!.event_properties!.note as string)).toHaveLength(MAX_STRING_LENGTH);
  });

  it('truncates nested strings too', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 1);
    const { accepted } = run([{ ...ok, event_properties: { deep: { note: long } } }]);
    const deep = accepted[0]!.event_properties!.deep as Record<string, string>;
    expect(deep.note).toHaveLength(MAX_STRING_LENGTH);
  });

  it('rejects a repeated insert_id when a dedupe set is supplied', () => {
    const seen = new Set<string>();
    const first = run([{ ...ok, insert_id: 'dup' }], { seen });
    const second = run([{ ...ok, insert_id: 'dup' }], { seen });
    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect(second.issues[0]!.kind).toBe('duplicate');
    expect(toRejectionMap(second.issues).duplicate_events).toEqual([0]);
  });
});

describe('Amplitude compatibility', () => {
  it('folds flat device and geo fields into context', () => {
    const out = normalizeAmplitudeEvent({
      event_type: 'A', user_id: 'user1',
      platform: 'iOS', os_name: 'iOS', os_version: '17', country: 'India', language: 'en',
    });
    expect(out.context).toMatchObject({ platform: 'iOS', os_version: '17', country: 'India' });
    expect(out).not.toHaveProperty('platform');
  });

  it('folds revenue fields, renaming to snake_case', () => {
    const out = normalizeAmplitudeEvent({
      event_type: 'A', user_id: 'user1',
      price: 29, quantity: 2, productId: 'pro', revenueType: 'purchase', currency: 'USD',
    });
    expect(out.revenue).toEqual({
      price: 29, quantity: 2, product_id: 'pro', revenue_type: 'purchase', currency: 'USD',
    });
  });

  it('leaves core fields alone', () => {
    const out = normalizeAmplitudeEvent({
      event_type: 'A', user_id: 'user1', session_id: 123,
      event_properties: { a: 1 }, insert_id: 'x',
    });
    expect(out).toMatchObject({ event_type: 'A', user_id: 'user1', session_id: 123, insert_id: 'x' });
  });

  it('produces something validateBatch accepts', () => {
    const normalized = normalizeAmplitudeEvent({ event_type: 'A', user_id: 'user1', platform: 'web' });
    expect(run([normalized]).accepted).toHaveLength(1);
  });
});
