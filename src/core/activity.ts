/**
 * Day-of-week by hour-of-day activity matrix.
 *
 * Answers "when are people actually here", which drives when to deploy, when to
 * send, and when a quiet period is normal rather than alarming.
 */

import type { ActivityQuery, ActivityResult, AnalyticsEvent } from '../types';
import { buildIdentityGraph, type IdentityGraph } from './identity';
import { matchesAll, matchesStep } from './filter';
import { MS_PER_MINUTE, inRange } from './time';

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function activity(
  events: readonly AnalyticsEvent[],
  q: ActivityQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): ActivityResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const tz = q.tzOffsetMin ?? 0;
  const byUsers = (q.countBy ?? 'uniques') === 'uniques';

  // 7 days x 24 hours. Sets while counting uniques, plain numbers otherwise.
  const uniq: Array<Array<Set<string>>> = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => new Set<string>()));
  const totals: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));

  for (const ev of events) {
    const t = ev.time ?? 0;
    if (!inRange(t, q.range)) continue;
    if (q.event && !matchesStep(ev, q.event, { allowRegex })) continue;
    if (!matchesAll(ev, q.segment, { allowRegex })) continue;

    // Local wall clock, so "9am" means 9am where the audience is.
    const local = new Date(t + tz * MS_PER_MINUTE);
    // getUTCDay is 0=Sunday; shift so Monday is 0.
    const day = (local.getUTCDay() + 6) % 7;
    const hour = local.getUTCHours();

    totals[day]![hour]! += 1;
    const key = graph.resolve(ev);
    if (key) uniq[day]![hour]!.add(key);
  }

  const cells = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => (byUsers ? uniq[d]![h]!.size : totals[d]![h]!)));

  let peak = 0;
  let busiest: ActivityResult['busiest'] = null;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const v = cells[d]![h]!;
      if (v > peak) { peak = v; busiest = { day: d, hour: h, value: v }; }
    }
  }

  return {
    cells,
    peak,
    byDay: cells.map((row) => row.reduce((n, v) => n + v, 0)),
    byHour: Array.from({ length: 24 }, (_, h) => cells.reduce((n, row) => n + row[h]!, 0)),
    busiest,
  };
}
