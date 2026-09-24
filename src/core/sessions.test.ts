import { describe, it, expect } from 'vitest';
import { deriveSessions, sessionStats, stickiness, DEFAULT_SESSION_TIMEOUT_MS } from './sessions';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange, MINUTE, HOUR, DAY, T0 } from './__fixtures__';
import { MAX_SESSION_MS } from '../types';

describe('deriveSessions with explicit session_id', () => {
  it('groups events sharing a session id', () => {
    const s0 = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u', t: s0, session: s0 }),
      ev({ type: 'B', user: 'u', t: s0 + 5 * MINUTE, session: s0 }),
      ev({ type: 'C', user: 'u', t: s0 + 12 * MINUTE, session: s0 }),
    ];
    const sessions = deriveSessions(events, buildIdentityGraph(events));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.eventCount).toBe(3);
    expect(sessions[0]!.durationMs).toBe(12 * MINUTE);
    expect(sessions[0]!.eventTypes).toEqual(['A', 'B', 'C']);
  });

  it('splits on differing session ids even when the events are close together', () => {
    const a = day(0, 9);
    const b = a + MINUTE;
    const events = [
      ev({ type: 'A', user: 'u', t: a, session: a }),
      ev({ type: 'B', user: 'u', t: b, session: b }),
    ];
    expect(deriveSessions(events, buildIdentityGraph(events))).toHaveLength(2);
  });

  it('gives a single-event session zero duration', () => {
    const t = day(0, 9);
    const events = [ev({ type: 'A', user: 'u', t, session: t })];
    expect(deriveSessions(events, buildIdentityGraph(events))[0]!.durationMs).toBe(0);
  });

  it('clamps a pathological session to the one-day cap', () => {
    const s = day(0);
    const events = [
      ev({ type: 'A', user: 'u', t: s, session: s }),
      ev({ type: 'B', user: 'u', t: s + 5 * DAY, session: s }),
    ];
    expect(deriveSessions(events, buildIdentityGraph(events))[0]!.durationMs).toBe(MAX_SESSION_MS);
  });

  it('keeps sessions separate per user', () => {
    const s = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u1', t: s, session: s }),
      ev({ type: 'A', user: 'u2', t: s, session: s }),
    ];
    expect(deriveSessions(events, buildIdentityGraph(events))).toHaveLength(2);
  });
});

describe('deriveSessions reconstructed from gaps', () => {
  it('splits a stream wherever the gap exceeds the timeout', () => {
    // A server-side SDK or a raw HTTP client sends no session_id.
    const base = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u', t: base }),
      ev({ type: 'B', user: 'u', t: base + 10 * MINUTE }),
      ev({ type: 'C', user: 'u', t: base + 10 * MINUTE + DEFAULT_SESSION_TIMEOUT_MS + 1 }),
    ];
    const sessions = deriveSessions(events, buildIdentityGraph(events));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.eventCount).toBe(2);
    expect(sessions[1]!.eventCount).toBe(1);
  });

  it('keeps events exactly at the timeout in the same session', () => {
    const base = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u', t: base }),
      ev({ type: 'B', user: 'u', t: base + DEFAULT_SESSION_TIMEOUT_MS }),
    ];
    expect(deriveSessions(events, buildIdentityGraph(events))).toHaveLength(1);
  });

  it('honours a custom timeout', () => {
    const base = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u', t: base }),
      ev({ type: 'B', user: 'u', t: base + 2 * MINUTE }),
    ];
    const g = buildIdentityGraph(events);
    expect(deriveSessions(events, g, { sessionTimeoutMs: MINUTE })).toHaveLength(2);
    expect(deriveSessions(events, g, { sessionTimeoutMs: 5 * MINUTE })).toHaveLength(1);
  });

  it('uses the session start as the identifier, so no session table is needed', () => {
    const base = day(0, 9);
    const events = [ev({ type: 'A', user: 'u', t: base })];
    expect(deriveSessions(events, buildIdentityGraph(events))[0]!.sessionId).toBe(base);
  });

  it('handles a stream mixing events with and without session ids', () => {
    const s = day(0, 9);
    const events = [
      ev({ type: 'A', user: 'u', t: s, session: s }),
      ev({ type: 'B', user: 'u', t: day(3, 9) }),
    ];
    expect(deriveSessions(events, buildIdentityGraph(events))).toHaveLength(2);
  });

  it('merges a pre-login device into the logged-in user', () => {
    const events = [
      ev({ type: 'A', device: 'd1', t: day(0, 9) }),
      ev({ type: 'Login', device: 'd1', user: 'u1', t: day(0, 9) + MINUTE }),
    ];
    const sessions = deriveSessions(events, buildIdentityGraph(events));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.userKey).toBe('u1');
  });
});

describe('stickiness', () => {
  it('counts distinct users in trailing windows ending at range.to', () => {
    const to = T0 + 31 * DAY;
    const events = [
      ev({ type: 'A', user: 'today', t: to - HOUR }),
      ev({ type: 'A', user: 'thisWeek', t: to - 3 * DAY }),
      ev({ type: 'A', user: 'thisMonth', t: to - 20 * DAY }),
      ev({ type: 'A', user: 'ancient', t: to - 200 * DAY }),
    ];
    const s = stickiness(events, { from: T0 - 400 * DAY, to }, buildIdentityGraph(events));
    expect(s.dau).toBe(1);
    expect(s.wau).toBe(2);
    expect(s.mau).toBe(3);
    expect(s.dauOverMau).toBeCloseTo(1 / 3, 10);
    expect(s.dauOverWau).toBe(0.5);
  });

  it('returns zeros rather than NaN when there is no data', () => {
    const s = stickiness([], daysRange(30), buildIdentityGraph([]));
    expect(s).toEqual({ dau: 0, wau: 0, mau: 0, dauOverMau: 0, dauOverWau: 0 });
  });

  it('counts a user once no matter how many events they sent', () => {
    const to = T0 + DAY;
    const events = [
      ev({ type: 'A', user: 'u', t: to - HOUR }),
      ev({ type: 'B', user: 'u', t: to - 2 * HOUR }),
    ];
    expect(stickiness(events, { from: T0, to }, buildIdentityGraph(events)).dau).toBe(1);
  });
});

describe('sessionStats', () => {
  const events = [
    // u1: a 10 minute session on day 0
    ev({ type: 'A', user: 'u1', t: day(0, 9), session: day(0, 9) }),
    ev({ type: 'B', user: 'u1', t: day(0, 9) + 10 * MINUTE, session: day(0, 9) }),
    // u1: a 2 second bounce on day 1
    ev({ type: 'A', user: 'u1', t: day(1, 9), session: day(1, 9) }),
    ev({ type: 'B', user: 'u1', t: day(1, 9) + 2000, session: day(1, 9) }),
    // u2: a single-event session on day 1
    ev({ type: 'A', user: 'u2', t: day(1, 10), session: day(1, 10) }),
  ];
  const q = { granularity: 'day' as const, range: daysRange(5) };
  const stats = () => sessionStats(events, q, buildIdentityGraph(events));

  it('counts sessions and distinct users', () => {
    expect(stats().totalSessions).toBe(3);
    expect(stats().totalUsers).toBe(2);
  });

  it('reports duration percentiles', () => {
    // Durations are [0, 2000, 600000]; the median is 2000.
    expect(stats().medianDurationMs).toBe(2000);
  });

  it('reports mean events per session', () => {
    // 2 + 2 + 1 events across 3 sessions.
    expect(stats().meanEventsPerSession).toBeCloseTo(5 / 3, 10);
  });

  it('bins durations non-linearly, so bounces separate from real sessions', () => {
    const bins = stats().durationHistogram;
    // The first bin is [0, 3s): the 0ms and 2s sessions land there.
    expect(bins[0]!.count).toBe(2);
    // 10 minutes is exactly 600_000ms, the lower edge of the next bin, so the
    // half-open range puts it in [600s, 1800s) rather than [180s, 600s).
    expect(bins.find((b) => b.lowerMs === 180_000)!.count).toBe(0);
    expect(bins.find((b) => b.lowerMs === 600_000)!.count).toBe(1);
  });

  it('buckets sessions over time', () => {
    const over = stats().sessionsOverTime;
    expect(over).toHaveLength(2);
    expect(over[0]!.sessions).toBe(1);
    expect(over[1]!.sessions).toBe(2);
    expect(over[1]!.users).toBe(2);
  });

  it('applies the segment filter', () => {
    const filtered = sessionStats(
      events,
      { ...q, segment: [{ property: { scope: 'event', key: 'nope' }, op: 'exists' }] },
      buildIdentityGraph(events),
    );
    expect(filtered.totalSessions).toBe(0);
    expect(filtered.medianDurationMs).toBe(0);
  });
});
