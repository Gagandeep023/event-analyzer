/**
 * Per-event-type statistics.
 *
 * `/meta` says which event types exist. This counts them: how often each fired,
 * how many distinct people fired it, and when it was last seen. That is what an
 * "all events" table needs, and it is a different question from meta's.
 */

import type { AnalyticsEvent, EventsQuery, EventsResult, EventStat, TimeRange } from '../types';
import { buildIdentityGraph, type IdentityGraph } from './identity';
import { matchesAll } from './filter';
import { ratio } from './stats';
import { inRange } from './time';

export const DEFAULT_EVENT_LIMIT = 100;

interface Bucket {
  count: number;
  users: Set<string>;
  firstSeen: number;
  lastSeen: number;
}

function tally(
  events: readonly AnalyticsEvent[],
  range: TimeRange,
  ids: IdentityGraph,
  segment: EventsQuery['segment'],
  allowRegex: boolean,
): { byType: Map<string, Bucket>; total: number; users: Set<string> } {
  const byType = new Map<string, Bucket>();
  const users = new Set<string>();
  let total = 0;

  for (const ev of events) {
    const t = ev.time ?? 0;
    if (!inRange(t, range)) continue;
    if (!matchesAll(ev, segment, { allowRegex })) continue;

    total += 1;
    const key = ids.resolve(ev);
    if (key) users.add(key);

    let b = byType.get(ev.event_type);
    if (!b) {
      b = { count: 0, users: new Set(), firstSeen: t, lastSeen: t };
      byType.set(ev.event_type, b);
    }
    b.count += 1;
    if (key) b.users.add(key);
    if (t < b.firstSeen) b.firstSeen = t;
    if (t > b.lastSeen) b.lastSeen = t;
  }

  return { byType, total, users };
}

export function eventStats(
  events: readonly AnalyticsEvent[],
  q: EventsQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): EventsResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const limit = q.limit ?? DEFAULT_EVENT_LIMIT;

  const current = tally(events, q.range, graph, q.segment, allowRegex);

  // The preceding window of equal length, for the change column.
  let prior: Map<string, Bucket> | null = null;
  if (q.compare) {
    const span = q.range.to - q.range.from;
    prior = tally(
      events,
      { from: q.range.from - span, to: q.range.from },
      graph,
      q.segment,
      allowRegex,
    ).byType;
  }

  const needle = q.search?.trim().toLowerCase();

  let rows: EventStat[] = [];
  for (const [event_type, b] of current.byType) {
    if (needle && !event_type.toLowerCase().includes(needle)) continue;

    const stat: EventStat = {
      event_type,
      count: b.count,
      users: b.users.size,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      share: ratio(b.count, current.total),
    };
    if (prior) {
      const before = prior.get(event_type)?.count ?? 0;
      // Null rather than Infinity when there is no baseline: "new" is not "up 100%".
      stat.change = before === 0 ? null : (b.count - before) / before;
    }
    rows.push(stat);
  }

  const distinctTypes = rows.length;
  rows.sort((a, b) => b.count - a.count || a.event_type.localeCompare(b.event_type));
  rows = rows.slice(0, limit);

  return {
    events: rows,
    totalEvents: current.total,
    totalUsers: current.users.size,
    distinctTypes,
  };
}
