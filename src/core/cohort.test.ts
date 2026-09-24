import { describe, it, expect } from 'vitest';
import { buildCohort } from './cohort';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange, DAY } from './__fixtures__';
import type { AnalyticsEvent, CohortQuery } from '../types';

const run = (events: AnalyticsEvent[], over: Partial<CohortQuery> = {}) =>
  buildCohort(
    events,
    { did: [{ step: { event_type: 'A' } }], range: daysRange(30), ...over },
    buildIdentityGraph(events),
  );

describe('did clauses', () => {
  const events = [
    ev({ type: 'A', user: 'yes', t: day(0) }),
    ev({ type: 'B', user: 'no', t: day(0) }),
  ];

  it('selects users who performed the event', () => {
    const r = run(events);
    expect(r.userIds).toEqual(['yes']);
    expect(r.size).toBe(1);
  });

  it('reports the share of all users in range', () => {
    const r = run(events);
    expect(r.totalUsersInRange).toBe(2);
    expect(r.share).toBe(0.5);
  });

  it('requires every did clause', () => {
    const both = [
      ev({ type: 'A', user: 'both', t: day(0) }),
      ev({ type: 'B', user: 'both', t: day(1) }),
      ev({ type: 'A', user: 'onlyA', t: day(0) }),
    ];
    const r = run(both, { did: [{ step: { event_type: 'A' } }, { step: { event_type: 'B' } }] });
    expect(r.userIds).toEqual(['both']);
  });

  it('honours atLeast', () => {
    const events3 = [
      ev({ type: 'A', user: 'thrice', t: day(0) }),
      ev({ type: 'A', user: 'thrice', t: day(1) }),
      ev({ type: 'A', user: 'thrice', t: day(2) }),
      ev({ type: 'A', user: 'once', t: day(0) }),
    ];
    expect(run(events3, { did: [{ step: { event_type: 'A' }, atLeast: 3 }] }).userIds).toEqual(['thrice']);
    expect(run(events3, { did: [{ step: { event_type: 'A' }, atLeast: 1 }] }).size).toBe(2);
  });

  it('honours atMost', () => {
    const events3 = [
      ev({ type: 'A', user: 'thrice', t: day(0) }),
      ev({ type: 'A', user: 'thrice', t: day(1) }),
      ev({ type: 'A', user: 'thrice', t: day(2) }),
      ev({ type: 'A', user: 'once', t: day(0) }),
    ];
    expect(run(events3, { did: [{ step: { event_type: 'A' }, atMost: 1 }] }).userIds).toEqual(['once']);
  });

  it('applies step filters', () => {
    const events2 = [
      ev({ type: 'A', user: 'pro', t: day(0), props: { plan: 'pro' } }),
      ev({ type: 'A', user: 'free', t: day(0), props: { plan: 'free' } }),
    ];
    const r = run(events2, {
      did: [{
        step: {
          event_type: 'A',
          filters: [{ property: { scope: 'event', key: 'plan' }, op: 'eq', value: 'pro' }],
        },
      }],
    });
    expect(r.userIds).toEqual(['pro']);
  });

  it('returns nobody when the did list is empty', () => {
    expect(run(events, { did: [] }).size).toBe(0);
  });
});

describe('didNot clauses', () => {
  it('excludes users who performed the forbidden event', () => {
    const events = [
      ev({ type: 'A', user: 'clean', t: day(0) }),
      ev({ type: 'A', user: 'upgraded', t: day(0) }),
      ev({ type: 'Upgrade', user: 'upgraded', t: day(1) }),
    ];
    const r = run(events, { didNot: [{ event_type: 'Upgrade' }] });
    expect(r.userIds).toEqual(['clean']);
  });

  it('only considers the forbidden event inside the window', () => {
    // An upgrade long after the window should not disqualify the user.
    const events = [
      ev({ type: 'A', user: 'u', t: day(0) }),
      ev({ type: 'Upgrade', user: 'u', t: day(20) }),
    ];
    expect(run(events, { didNot: [{ event_type: 'Upgrade' }], withinMs: 7 * DAY }).size).toBe(1);
    expect(run(events, { didNot: [{ event_type: 'Upgrade' }] }).size).toBe(0);
  });
});

describe('the within window', () => {
  it('is measured from each user\'s own first matching event, not the range start', () => {
    // `late` starts on day 10, so their window runs to day 12, not day 2.
    const events = [
      ev({ type: 'A', user: 'late', t: day(10) }),
      ev({ type: 'B', user: 'late', t: day(11) }),
      ev({ type: 'A', user: 'early', t: day(0) }),
      ev({ type: 'B', user: 'early', t: day(11) }),
    ];
    const r = run(events, {
      did: [{ step: { event_type: 'A' } }, { step: { event_type: 'B' } }],
      withinMs: 2 * DAY,
    });
    expect(r.userIds).toEqual(['late']);
  });

  it('is unbounded when omitted', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0) }),
      ev({ type: 'B', user: 'u', t: day(25) }),
    ];
    const r = run(events, { did: [{ step: { event_type: 'A' } }, { step: { event_type: 'B' } }] });
    expect(r.size).toBe(1);
  });
});

describe('user property filters', () => {
  it('matches against merged latest properties, not one event', () => {
    // The plan is set on a later event than the one that qualifies the user.
    const events = [
      ev({ type: 'A', user: 'pro', t: day(0) }),
      ev({ type: 'Ping', user: 'pro', t: day(1), userProps: { $set: { plan: 'pro' } } }),
      ev({ type: 'A', user: 'free', t: day(0) }),
      ev({ type: 'Ping', user: 'free', t: day(1), userProps: { $set: { plan: 'free' } } }),
    ];
    const r = run(events, {
      userFilters: [{ property: { scope: 'user', key: 'plan' }, op: 'eq', value: 'pro' }],
    });
    expect(r.userIds).toEqual(['pro']);
  });

  it('sees the final value after a sequence of updates', () => {
    const events = [
      ev({ type: 'A', user: 'u', t: day(0), userProps: { $set: { plan: 'free' } } }),
      ev({ type: 'Ping', user: 'u', t: day(1), userProps: { $set: { plan: 'pro' } } }),
    ];
    expect(run(events, {
      userFilters: [{ property: { scope: 'user', key: 'plan' }, op: 'eq', value: 'pro' }],
    }).size).toBe(1);
  });
});

describe('output', () => {
  it('sorts user ids so the result is stable', () => {
    const events = [
      ev({ type: 'A', user: 'c', t: day(0) }),
      ev({ type: 'A', user: 'a', t: day(0) }),
      ev({ type: 'A', user: 'b', t: day(0) }),
    ];
    expect(run(events).userIds).toEqual(['a', 'b', 'c']);
  });

  it('echoes the definition back, so a cohort can be reused as a segment', () => {
    const q: Partial<CohortQuery> = { did: [{ step: { event_type: 'A' } }] };
    expect(run([], q).definition.did).toEqual(q.did);
  });

  it('returns zeros rather than NaN for an empty input', () => {
    const r = run([]);
    expect(r).toMatchObject({ size: 0, totalUsersInRange: 0, share: 0 });
  });

  it('resolves a pre-login device into the logged-in user', () => {
    const events = [
      ev({ type: 'A', device: 'd1', t: day(0) }),
      ev({ type: 'Login', device: 'd1', user: 'u1', t: day(1) }),
    ];
    expect(run(events).userIds).toEqual(['u1']);
  });
});
