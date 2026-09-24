import { describe, it, expect } from 'vitest';
import { buildIdentityGraph, groupByUser, byTime } from './identity';
import { ev, day } from './__fixtures__';

describe('buildIdentityGraph', () => {
  it('resolves an event with only a device id to that device id', () => {
    const events = [ev({ type: 'A', device: 'd1', t: day(0) })];
    expect(buildIdentityGraph(events).resolve(events[0]!)).toBe('d1');
  });

  it('unions a device to a user when one event carries both', () => {
    const anon = ev({ type: 'View', device: 'd1', t: day(0) });
    const login = ev({ type: 'Login', device: 'd1', user: 'u1', t: day(1) });
    const g = buildIdentityGraph([anon, login]);

    // Without this, one person counts as two users and retention is wrong.
    expect(g.resolve(anon)).toBe('u1');
    expect(g.resolve(login)).toBe('u1');
    expect(g.aliasCount).toBe(1);
  });

  it('prefers a user id over a device id as the canonical key', () => {
    const events = [ev({ type: 'Login', device: 'zzz', user: 'aaa', t: day(0) })];
    // Lexically 'aaa' < 'zzz', but the rule is user-beats-device regardless.
    const events2 = [ev({ type: 'Login', device: 'aaa', user: 'zzz', t: day(0) })];
    expect(buildIdentityGraph(events).resolve(events[0]!)).toBe('aaa');
    expect(buildIdentityGraph(events2).resolve(events2[0]!)).toBe('zzz');
  });

  it('merges transitively across two devices sharing one user', () => {
    const a = ev({ type: 'View', device: 'd1', t: day(0) });
    const b = ev({ type: 'Login', device: 'd1', user: 'u1', t: day(1) });
    const c = ev({ type: 'Login', device: 'd2', user: 'u1', t: day(2) });
    const d = ev({ type: 'View', device: 'd2', t: day(3) });
    const g = buildIdentityGraph([a, b, c, d]);

    for (const e of [a, b, c, d]) expect(g.resolve(e)).toBe('u1');
  });

  it('is deterministic regardless of event order', () => {
    const a = ev({ type: 'Login', device: 'd1', user: 'u2', t: day(0) });
    const b = ev({ type: 'Login', device: 'd1', user: 'u1', t: day(1) });
    // Two user ids joined through one device; the smaller id wins either way.
    expect(buildIdentityGraph([a, b]).resolve(a)).toBe('u1');
    expect(buildIdentityGraph([b, a]).resolve(a)).toBe('u1');
  });

  it('keeps unrelated identities separate', () => {
    const a = ev({ type: 'A', user: 'u1', t: day(0) });
    const b = ev({ type: 'A', user: 'u2', t: day(0) });
    const g = buildIdentityGraph([a, b]);
    expect(g.resolve(a)).toBe('u1');
    expect(g.resolve(b)).toBe('u2');
    expect(g.aliasCount).toBe(0);
  });

  it('counts events with neither identifier instead of hiding them', () => {
    const orphan = ev({ type: 'A', t: day(0) });
    const g = buildIdentityGraph([orphan, ev({ type: 'B', user: 'u1', t: day(0) })]);
    expect(g.skipped).toBe(1);
    expect(g.resolve(orphan)).toBe('');
  });

  it('seeds explicit aliases', () => {
    const a = ev({ type: 'A', user: 'u_old', t: day(0) });
    const b = ev({ type: 'B', user: 'u_new', t: day(1) });
    const g = buildIdentityGraph([a, b], [{ user_id: 'u_old', global_user_id: 'u_new' }]);
    expect(g.resolve(a)).toBe(g.resolve(b));
  });

  it('ignores an alias marked unmap', () => {
    const a = ev({ type: 'A', user: 'u_old', t: day(0) });
    const b = ev({ type: 'B', user: 'u_new', t: day(1) });
    const g = buildIdentityGraph([a, b], [{ user_id: 'u_old', global_user_id: 'u_new', unmap: true }]);
    expect(g.resolve(a)).not.toBe(g.resolve(b));
  });

  it('resolveKey maps a raw device id to its canonical user', () => {
    const events = [ev({ type: 'Login', device: 'd1', user: 'u1', t: day(0) })];
    const g = buildIdentityGraph(events);
    expect(g.resolveKey('d1')).toBe('u1');
    expect(g.resolveKey('unknown')).toBe('unknown');
  });

  it('does not collide a device id with an identical user id', () => {
    // 'x' as a device on one event and as a user on another are different actors.
    const a = ev({ type: 'A', device: 'x', t: day(0) });
    const b = ev({ type: 'B', user: 'x', t: day(0) });
    const g = buildIdentityGraph([a, b]);
    expect(g.aliasCount).toBe(0);
    expect(g.resolve(a)).toBe('x');
    expect(g.resolve(b)).toBe('x');
  });
});

describe('groupByUser', () => {
  it('groups and sorts each user chronologically', () => {
    const events = [
      ev({ type: 'C', user: 'u1', t: day(2) }),
      ev({ type: 'A', user: 'u1', t: day(0) }),
      ev({ type: 'B', user: 'u1', t: day(1) }),
      ev({ type: 'Z', user: 'u2', t: day(0) }),
    ];
    const grouped = groupByUser(events, buildIdentityGraph(events));
    expect(grouped.get('u1')!.map((e) => e.event_type)).toEqual(['A', 'B', 'C']);
    expect(grouped.get('u2')).toHaveLength(1);
  });

  it('breaks ties on identical timestamps with event_id', () => {
    const events = [
      ev({ type: 'second', user: 'u1', t: day(0), eventId: 2 }),
      ev({ type: 'first', user: 'u1', t: day(0), eventId: 1 }),
    ];
    const grouped = groupByUser(events, buildIdentityGraph(events));
    expect(grouped.get('u1')!.map((e) => e.event_type)).toEqual(['first', 'second']);
  });

  it('drops unidentified events from the grouping', () => {
    const events = [ev({ type: 'A', t: day(0) }), ev({ type: 'B', user: 'u1', t: day(0) })];
    const grouped = groupByUser(events, buildIdentityGraph(events));
    expect(grouped.size).toBe(1);
  });

  it('byTime is a stable chronological comparator', () => {
    const a = ev({ type: 'A', t: 100 });
    const b = ev({ type: 'B', t: 200 });
    expect(byTime(a, b)).toBeLessThan(0);
    expect(byTime(b, a)).toBeGreaterThan(0);
    expect(byTime(a, a)).toBe(0);
  });
});
