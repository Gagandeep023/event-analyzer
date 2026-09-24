import { describe, it, expect } from 'vitest';
import { mergeUserProperties, latestUserProperties } from './properties';
import { buildIdentityGraph } from './identity';
import { ev, day } from './__fixtures__';
import type { UserProperties } from '../types';

const m = (current: Record<string, unknown>, incoming: UserProperties) =>
  mergeUserProperties(current as never, incoming);

describe('mergeUserProperties', () => {
  it('treats bare keys as $set', () => {
    expect(m({}, { plan: 'pro' } as UserProperties)).toEqual({ plan: 'pro' });
  });

  it('does not mutate its input', () => {
    const current = { a: 1 };
    const out = m(current, { $set: { a: 2 } });
    expect(current).toEqual({ a: 1 });
    expect(out).toEqual({ a: 2 });
  });

  it('$set overwrites', () => {
    expect(m({ plan: 'free' }, { $set: { plan: 'pro' } })).toEqual({ plan: 'pro' });
  });

  it('$setOnce writes only when the key is absent', () => {
    expect(m({}, { $setOnce: { src: 'blog' } })).toEqual({ src: 'blog' });
    expect(m({ src: 'ads' }, { $setOnce: { src: 'blog' } })).toEqual({ src: 'ads' });
  });

  it('$unset deletes', () => {
    expect(m({ a: 1, b: 2 }, { $unset: { a: '-' } })).toEqual({ b: 2 });
  });

  it('$clearAll wipes everything and invalidates the rest of the payload', () => {
    // $clearAll dominates its own object by definition.
    expect(m({ a: 1 }, { $clearAll: '-', $set: { b: 2 } })).toEqual({});
  });

  it('$add increments, seeding from absent', () => {
    expect(m({}, { $add: { logins: 1 } })).toEqual({ logins: 1 });
    expect(m({ logins: 4 }, { $add: { logins: 2 } })).toEqual({ logins: 6 });
  });

  it('$add against a non-numeric value is a no-op, never NaN', () => {
    const out = m({ logins: 'many' }, { $add: { logins: 1 } });
    expect(out.logins).toBe('many');
    expect(Number.isNaN(out.logins as number)).toBe(false);
  });

  it('$add ignores a non-numeric increment', () => {
    expect(m({ n: 1 }, { $add: { n: 'x' } } as unknown as UserProperties)).toEqual({ n: 1 });
  });

  it('$append and $prepend build lists, promoting a scalar first', () => {
    expect(m({}, { $append: { f: 'a' } })).toEqual({ f: ['a'] });
    expect(m({ f: 'a' }, { $append: { f: 'b' } })).toEqual({ f: ['a', 'b'] });
    expect(m({ f: ['b'] }, { $prepend: { f: 'a' } })).toEqual({ f: ['a', 'b'] });
  });

  it('$append allows duplicates; $postInsert does not', () => {
    expect(m({ t: ['a'] }, { $append: { t: 'a' } })).toEqual({ t: ['a', 'a'] });
    expect(m({ t: ['a'] }, { $postInsert: { t: 'a' } })).toEqual({ t: ['a'] });
    expect(m({ t: ['a'] }, { $postInsert: { t: 'b' } })).toEqual({ t: ['a', 'b'] });
  });

  it('$preInsert inserts at the front only when absent', () => {
    expect(m({ t: ['b'] }, { $preInsert: { t: 'a' } })).toEqual({ t: ['a', 'b'] });
    expect(m({ t: ['a', 'b'] }, { $preInsert: { t: 'a' } })).toEqual({ t: ['a', 'b'] });
  });

  it('$remove drops every matching member', () => {
    expect(m({ t: ['a', 'b', 'a'] }, { $remove: { t: 'a' } })).toEqual({ t: ['b'] });
  });

  it('applies $add after $set, so an increment lands on top', () => {
    // If $add ran first, the $set would overwrite it and the increment is lost.
    expect(m({ n: 100 }, { $set: { n: 1 }, $add: { n: 5 } })).toEqual({ n: 6 });
  });

  it('applies $setOnce before $set, so an explicit $set still wins', () => {
    expect(m({}, { $setOnce: { p: 'a' }, $set: { p: 'b' } })).toEqual({ p: 'b' });
  });

  it('applies $unset before $setOnce, so a key can be cleared then reseeded', () => {
    expect(m({ p: 'old' }, { $unset: { p: '-' }, $setOnce: { p: 'new' } })).toEqual({ p: 'new' });
  });

  it('lets an explicit $set beat a bare key in the same payload', () => {
    expect(m({}, { p: 'bare', $set: { p: 'explicit' } } as UserProperties)).toEqual({ p: 'explicit' });
  });

  it('ignores unknown $ keys rather than storing them', () => {
    expect(m({}, { $bogus: { a: 1 } } as unknown as UserProperties)).toEqual({});
  });
});

describe('latestUserProperties', () => {
  it('replays in time order across a user', () => {
    const events = [
      ev({ type: 'A', user: 'u1', t: day(0), userProps: { $set: { plan: 'free' }, $add: { logins: 1 } } }),
      ev({ type: 'B', user: 'u1', t: day(1), userProps: { $set: { plan: 'pro' }, $add: { logins: 1 } } }),
    ];
    const out = latestUserProperties(events, buildIdentityGraph(events));
    expect(out.get('u1')).toEqual({ plan: 'pro', logins: 2 });
  });

  it('replays in time order even when the input is shuffled', () => {
    const later = ev({ type: 'B', user: 'u1', t: day(1), userProps: { $set: { plan: 'pro' } } });
    const earlier = ev({ type: 'A', user: 'u1', t: day(0), userProps: { $set: { plan: 'free' } } });
    const out = latestUserProperties([later, earlier], buildIdentityGraph([later, earlier]));
    expect(out.get('u1')?.plan).toBe('pro');
  });

  it('merges across a device-to-user alias', () => {
    // Properties set before login must survive the merge into the user id.
    const events = [
      ev({ type: 'A', device: 'd1', t: day(0), userProps: { $set: { src: 'blog' } } }),
      ev({ type: 'Login', user: 'u1', device: 'd1', t: day(1), userProps: { $set: { plan: 'pro' } } }),
    ];
    const out = latestUserProperties(events, buildIdentityGraph(events));
    expect(out.get('u1')).toEqual({ src: 'blog', plan: 'pro' });
  });

  it('records a user with no properties as an empty bag', () => {
    const events = [ev({ type: 'A', user: 'u1', t: day(0) })];
    const out = latestUserProperties(events, buildIdentityGraph(events));
    expect(out.get('u1')).toEqual({});
  });
});
