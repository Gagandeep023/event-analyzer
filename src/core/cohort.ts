/**
 * Behavioural cohorts: users who did X but not Y.
 *
 * Returns the resolved user key list so a cohort can be fed straight back into
 * another query as a segment. That reuse is the entire point of the feature.
 */

import type { AnalyticsEvent, CohortQuery, CohortResult } from '../types';
import { buildIdentityGraph, groupByUser, type IdentityGraph } from './identity';
import { matchesAll, matchesStep } from './filter';
import { asPropertyCarrier, latestUserProperties } from './properties';
import { ratio } from './stats';
import { inRange } from './time';

export function buildCohort(
  events: readonly AnalyticsEvent[],
  q: CohortQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): CohortResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;

  const scoped = events.filter((ev) => inRange(ev.time ?? 0, q.range));
  const byUser = groupByUser(scoped, graph);
  const props = q.userFilters?.length ? latestUserProperties(scoped, graph) : null;

  const qualified: string[] = [];

  for (const [userKey, userEvents] of byUser) {
    if (qualifies(userEvents, q, { allowRegex })) {
      if (props) {
        const carrier = asPropertyCarrier(userKey, props.get(userKey) ?? {});
        if (!matchesAll(carrier, q.userFilters, { allowRegex })) continue;
      }
      qualified.push(userKey);
    }
  }

  qualified.sort();
  const total = byUser.size;

  return {
    userIds: qualified,
    size: qualified.length,
    totalUsersInRange: total,
    share: ratio(qualified.length, total),
    definition: q,
  };
}

function qualifies(
  userEvents: readonly AnalyticsEvent[],
  q: CohortQuery,
  opts: { allowRegex: boolean },
): boolean {
  if (q.did.length === 0) return false;

  // The anchor is the user's earliest event matching any `did` clause, and the
  // window is measured from there rather than from `range.from`.
  let anchor: number | null = null;
  for (const ev of userEvents) {
    if (q.did.some((c) => matchesStep(ev, c.step, opts))) {
      anchor = ev.time ?? 0;
      break;
    }
  }
  if (anchor === null) return false;

  const windowEnd =
    q.withinMs === undefined ? Number.POSITIVE_INFINITY : anchor + q.withinMs;

  const inWindow = userEvents.filter((ev) => {
    const t = ev.time ?? 0;
    return t >= anchor! && t < windowEnd;
  });

  for (const clause of q.did) {
    let hits = 0;
    for (const ev of inWindow) {
      if (matchesStep(ev, clause.step, opts)) hits++;
    }
    const atLeast = clause.atLeast ?? 1;
    if (hits < atLeast) return false;
    if (clause.atMost !== undefined && hits > clause.atMost) return false;
  }

  if (q.didNot && q.didNot.length > 0) {
    for (const ev of inWindow) {
      if (q.didNot.some((step) => matchesStep(ev, step, opts))) return false;
    }
  }

  return true;
}
