/**
 * Session derivation and session statistics.
 *
 * Sessions are derived, never stored. A session is the group of one user's
 * events sharing a `session_id`, which is itself the session's start timestamp.
 * That choice removes the need for a session table anywhere.
 *
 * Where `session_id` is absent, as with a server-side SDK or a raw HTTP client,
 * sessions are reconstructed by splitting each user's sorted event stream
 * wherever the inter-event gap exceeds the timeout.
 */

import type {
  AnalyticsEvent,
  Session,
  SessionQuery,
  SessionResult,
  Stickiness,
  TimeRange,
} from '../types';
import { MAX_SESSION_MS, SESSION_BIN_EDGES } from '../types';
import { buildIdentityGraph, byTime, groupByUser, type IdentityGraph } from './identity';
import { matchesAll } from './filter';
import { ascending, histogram, mean, percentile, ratio } from './stats';
import { MS_PER_DAY, bucketStart, inRange } from './time';

/** Default inactivity timeout used when reconstructing sessions, 30 minutes. */
export const DEFAULT_SESSION_TIMEOUT_MS = 1_800_000;

export interface DeriveOptions {
  sessionTimeoutMs?: number;
}

/**
 * Derives sessions from an event stream.
 *
 * Events carrying `session_id` are grouped by it. Events without one are split
 * on inactivity gaps. Both paths can coexist in a single stream.
 */
export function deriveSessions(
  events: readonly AnalyticsEvent[],
  ids?: IdentityGraph,
  opts: DeriveOptions = {},
): Session[] {
  const graph = ids ?? buildIdentityGraph(events);
  const timeout = opts.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const byUser = groupByUser(events, graph);
  const out: Session[] = [];

  for (const [userKey, userEvents] of byUser) {
    const withId: AnalyticsEvent[] = [];
    const withoutId: AnalyticsEvent[] = [];
    for (const ev of userEvents) {
      if (typeof ev.session_id === 'number' && Number.isFinite(ev.session_id)) withId.push(ev);
      else withoutId.push(ev);
    }

    // Grouped by the explicit identifier.
    const groups = new Map<number, AnalyticsEvent[]>();
    for (const ev of withId) {
      const sid = ev.session_id!;
      const bucket = groups.get(sid);
      if (bucket) bucket.push(ev);
      else groups.set(sid, [ev]);
    }
    for (const [sid, group] of groups) out.push(toSession(userKey, sid, group));

    // Reconstructed from inactivity gaps.
    let run: AnalyticsEvent[] = [];
    for (const ev of withoutId.sort(byTime)) {
      const last = run[run.length - 1];
      if (last && (ev.time ?? 0) - (last.time ?? 0) > timeout) {
        out.push(toSession(userKey, run[0]!.time ?? 0, run));
        run = [];
      }
      run.push(ev);
    }
    if (run.length > 0) out.push(toSession(userKey, run[0]!.time ?? 0, run));
  }

  out.sort((a, b) => a.start - b.start || a.userKey.localeCompare(b.userKey));
  return out;
}

function toSession(userKey: string, sessionId: number, group: AnalyticsEvent[]): Session {
  const sorted = [...group].sort(byTime);
  const start = sorted[0]!.time ?? sessionId;
  const end = sorted[sorted.length - 1]!.time ?? start;
  // Clamp to the one-day cap, the conventional ceiling.
  const durationMs = Math.min(Math.max(0, end - start), MAX_SESSION_MS);

  const types: string[] = [];
  for (const ev of sorted) {
    if (!types.includes(ev.event_type)) types.push(ev.event_type);
  }

  return {
    userKey,
    sessionId,
    start,
    end,
    durationMs,
    eventCount: sorted.length,
    eventTypes: types,
  };
}

/**
 * DAU, WAU and MAU as distinct resolved users in trailing 1, 7 and 30 day
 * windows ending at `range.to`, plus the two ratios.
 */
export function stickiness(
  events: readonly AnalyticsEvent[],
  range: TimeRange,
  ids?: IdentityGraph,
): Stickiness {
  const graph = ids ?? buildIdentityGraph(events);
  const day = new Set<string>();
  const week = new Set<string>();
  const month = new Set<string>();

  const dayFrom = range.to - MS_PER_DAY;
  const weekFrom = range.to - 7 * MS_PER_DAY;
  const monthFrom = range.to - 30 * MS_PER_DAY;

  for (const ev of events) {
    const t = ev.time ?? 0;
    if (t >= range.to) continue;
    const key = graph.resolve(ev);
    if (!key) continue;
    if (t >= monthFrom) month.add(key);
    if (t >= weekFrom) week.add(key);
    if (t >= dayFrom) day.add(key);
  }

  return {
    dau: day.size,
    wau: week.size,
    mau: month.size,
    dauOverMau: ratio(day.size, month.size),
    dauOverWau: ratio(day.size, week.size),
  };
}

/** Session statistics over a range. */
export function sessionStats(
  events: readonly AnalyticsEvent[],
  q: SessionQuery,
  ids?: IdentityGraph,
  opts: DeriveOptions & { allowRegex?: boolean } = {},
): SessionResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;

  const scoped = events.filter(
    (ev) => inRange(ev.time ?? 0, q.range) && matchesAll(ev, q.segment, { allowRegex }),
  );

  const sessions = deriveSessions(scoped, graph, opts);
  const durations = sessions.map((s) => s.durationMs).sort(ascending);
  const users = new Set(sessions.map((s) => s.userKey));

  const tz = q.tzOffsetMin ?? 0;
  const perBucket = new Map<number, { sessions: number; users: Set<string> }>();
  for (const s of sessions) {
    const b = bucketStart(s.start, q.granularity, tz);
    let cell = perBucket.get(b);
    if (!cell) {
      cell = { sessions: 0, users: new Set() };
      perBucket.set(b, cell);
    }
    cell.sessions += 1;
    cell.users.add(s.userKey);
  }

  const sessionsOverTime = [...perBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, cell]) => ({ t, sessions: cell.sessions, users: cell.users.size }));

  return {
    totalSessions: sessions.length,
    totalUsers: users.size,
    medianDurationMs: percentile(durations, 0.5) ?? 0,
    p90DurationMs: percentile(durations, 0.9) ?? 0,
    meanEventsPerSession: mean(sessions.map((s) => s.eventCount)) ?? 0,
    durationHistogram: histogram(durations, SESSION_BIN_EDGES),
    stickiness: stickiness(scoped, q.range, graph),
    sessionsOverTime,
  };
}
