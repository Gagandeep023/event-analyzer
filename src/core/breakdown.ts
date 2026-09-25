/**
 * Top values of one property.
 *
 * Every "top pages / browsers / referrers / countries" table is this query with
 * a different `property`. Ranking by distinct users rather than event count is
 * the default because one enthusiastic visitor refreshing a page forty times
 * should not outrank forty visitors.
 */

import type {
  AnalyticsEvent, BreakdownQuery, BreakdownResult, BreakdownRow, TimeRange,
} from '../types';
import { buildIdentityGraph, userSetMatcher, type IdentityGraph } from './identity';
import { matchesAll, matchesStep, resolveProperty } from './filter';
import { ratio } from './stats';
import { inRange } from './time';

export const DEFAULT_BREAKDOWN_LIMIT = 20;
export const OTHER_ROW = 'Other';
/** Shown when the property is absent on an event, rather than dropping it. */
export const UNKNOWN_VALUE = '(not set)';

interface Cell { users: Set<string>; events: number; }

function tally(
  events: readonly AnalyticsEvent[],
  range: TimeRange,
  q: BreakdownQuery,
  ids: IdentityGraph,
  allowRegex: boolean,
): { byValue: Map<string, Cell>; users: Set<string>; total: number } {
  const byValue = new Map<string, Cell>();
  const users = new Set<string>();
  let total = 0;

  const inSet = userSetMatcher(ids, q.userKeys);

  for (const ev of events) {
    if (!inRange(ev.time ?? 0, range)) continue;
    if (!inSet(ev)) continue;
    if (q.event && !matchesStep(ev, q.event, { allowRegex })) continue;
    if (!matchesAll(ev, q.segment, { allowRegex })) continue;

    const raw = resolveProperty(ev, q.property);
    const value = normalise(raw);
    const key = ids.resolve(ev);

    total += 1;
    if (key) users.add(key);

    let cell = byValue.get(value);
    if (!cell) {
      cell = { users: new Set(), events: 0 };
      byValue.set(value, cell);
    }
    cell.events += 1;
    if (key) cell.users.add(key);
  }

  return { byValue, users, total };
}

function normalise(v: unknown): string {
  if (v === undefined || v === null || v === '') return UNKNOWN_VALUE;
  if (Array.isArray(v)) return v.length === 0 ? UNKNOWN_VALUE : String(v[0]);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 200);
}

export function breakdown(
  events: readonly AnalyticsEvent[],
  q: BreakdownQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): BreakdownResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const limit = q.limit ?? DEFAULT_BREAKDOWN_LIMIT;
  const rankBy = q.rankBy ?? 'users';

  const current = tally(events, q.range, q, graph, allowRegex);

  let prior: Map<string, Cell> | null = null;
  if (q.compare) {
    const span = q.range.to - q.range.from;
    prior = tally(events, { from: q.range.from - span, to: q.range.from }, q, graph, allowRegex).byValue;
  }

  const metric = (c: Cell) => (rankBy === 'users' ? c.users.size : c.events);
  const grand = rankBy === 'users' ? current.users.size : current.total;

  const all: BreakdownRow[] = [...current.byValue.entries()].map(([value, cell]) => {
    const row: BreakdownRow = {
      value,
      users: cell.users.size,
      events: cell.events,
      // Shares of a unique-user breakdown can exceed 1 in total, because one
      // person can appear under two browsers. That is a property of the data,
      // not a bug, so the share is per-row against the grand total.
      share: ratio(metric(cell), grand),
    };
    if (prior) {
      const before = prior.get(value);
      const beforeN = before ? metric(before) : 0;
      row.change = beforeN === 0 ? null : (metric(cell) - beforeN) / beforeN;
    }
    return row;
  });

  all.sort((a, b) => {
    const am = rankBy === 'users' ? a.users : a.events;
    const bm = rankBy === 'users' ? b.users : b.events;
    return bm - am || a.value.localeCompare(b.value);
  });

  const rows = all.slice(0, limit);
  const tail = all.slice(limit);
  if (tail.length > 0) {
    rows.push({
      value: OTHER_ROW,
      // Users cannot be summed across the tail without double counting, so this
      // is an upper bound and is labelled as a fold, not a distinct count.
      users: tail.reduce((n, r) => n + r.users, 0),
      events: tail.reduce((n, r) => n + r.events, 0),
      share: tail.reduce((n, r) => n + r.share, 0),
    });
  }

  return {
    property: q.property,
    rows,
    totalUsers: current.users.size,
    totalEvents: current.total,
    distinctValues: all.length,
  };
}
