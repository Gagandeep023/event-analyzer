/**
 * Growth accounting: new, returning, resurrected, churned.
 *
 * The question an active-user count cannot answer. A flat line can hide heavy
 * churn masked by heavy acquisition, and the two are very different businesses.
 * This splits each period's actives by where they came from, and counts who
 * fell out.
 */

import type { AnalyticsEvent, GrowthPoint, GrowthQuery, GrowthResult } from '../types';
import { buildIdentityGraph, userSetMatcher, type IdentityGraph } from './identity';
import { matchesAll, matchesStep } from './filter';
import { ratio } from './stats';
import { bucketLabel, bucketRange, bucketStart, inRange } from './time';

export const DEFAULT_DORMANT_AFTER = 2;

export function growth(
  events: readonly AnalyticsEvent[],
  q: GrowthQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): GrowthResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const tz = q.tzOffsetMin ?? 0;
  const dormantAfter = q.dormantAfter ?? DEFAULT_DORMANT_AFTER;

  const buckets = bucketRange(q.range, q.interval, tz);
  const index = new Map(buckets.map((t, i) => [t, i]));

  // Which periods each user was active in, plus the first time they were EVER
  // seen. "Ever" has to look outside the range, or every user in the first
  // period is miscounted as new.
  const activeIn = new Map<string, Set<number>>();
  const firstEver = new Map<string, number>();

  const inSet = userSetMatcher(graph, q.userKeys);

  for (const ev of events) {
    const t = ev.time ?? 0;
    if (!inSet(ev)) continue;
    if (q.event && !matchesStep(ev, q.event, { allowRegex })) continue;
    if (!matchesAll(ev, q.segment, { allowRegex })) continue;

    const key = graph.resolve(ev);
    if (!key) continue;

    const seen = firstEver.get(key);
    if (seen === undefined || t < seen) firstEver.set(key, t);

    if (!inRange(t, q.range)) continue;
    const i = index.get(bucketStart(t, q.interval, tz));
    if (i === undefined) continue;
    let set = activeIn.get(key);
    if (!set) { set = new Set(); activeIn.set(key, set); }
    set.add(i);
  }

  const points: GrowthPoint[] = buckets.map((t) => ({
    t,
    label: bucketLabel(t, q.interval, tz),
    newUsers: 0, returning: 0, resurrected: 0, churned: 0, active: 0, netChange: 0,
  }));

  for (const [key, periods] of activeIn) {
    const first = firstEver.get(key) ?? 0;
    const firstIndex = index.get(bucketStart(first, q.interval, tz));

    for (const i of periods) {
      const p = points[i]!;
      p.active += 1;

      if (firstIndex === i && inRange(first, q.range)) {
        p.newUsers += 1;
      } else if (periods.has(i - 1)) {
        p.returning += 1;
      } else {
        // Active now, not last period. Resurrected only after a real gap;
        // otherwise it is just an irregular user and calling that a comeback
        // inflates the number.
        let gap = 0;
        for (let k = i - 1; k >= 0 && !periods.has(k); k--) gap += 1;
        if (gap >= dormantAfter) p.resurrected += 1;
        else p.returning += 1;
      }
    }

    // Churn: active last period, absent this one.
    for (let i = 1; i < points.length; i++) {
      if (periods.has(i - 1) && !periods.has(i)) points[i]!.churned -= 1;
    }
  }

  for (const p of points) p.netChange = p.newUsers + p.resurrected + p.churned;

  const totals = points.reduce(
    (acc, p) => ({
      newUsers: acc.newUsers + p.newUsers,
      resurrected: acc.resurrected + p.resurrected,
      churned: acc.churned + p.churned,
    }),
    { newUsers: 0, resurrected: 0, churned: 0 },
  );

  return {
    interval: q.interval,
    points,
    totals,
    // Above 1 means growth is outpacing churn.
    quickRatio: totals.churned === 0
      ? null
      : (totals.newUsers + totals.resurrected) / Math.abs(totals.churned),
  };
}

/** Exposed for tests: share of period-over-period retention across the range. */
export function retentionRatio(result: GrowthResult): number {
  const returning = result.points.reduce((n, p) => n + p.returning, 0);
  const active = result.points.reduce((n, p) => n + p.active, 0);
  return ratio(returning, active);
}
