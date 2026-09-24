/**
 * Event counts over time, optionally grouped and segmented.
 *
 * The workhorse chart. Also covers what other tools split into separate
 * `users` and `composition` endpoints, which are the same computation with
 * different defaults.
 */

import type {
  AnalyticsEvent,
  PropertyRef,
  SegmentationQuery,
  SegmentationResult,
  Series,
} from '../types';
import { buildIdentityGraph, type IdentityGraph } from './identity';
import { matchesAll, matchesStep, resolveProperty, stepLabel } from './filter';
import { ratio } from './stats';
import { bucketRange, bucketStart, inRange } from './time';

/** Label for the folded tail when there are more groups than `limitGroups`. */
export const OTHER_GROUP_LABEL = 'Other';

/** Default number of group-by values returned before folding into `Other`. */
export const DEFAULT_LIMIT_GROUPS = 10;

interface Cell {
  totals: number;
  uniques: Set<string>;
}

function emptyCell(): Cell {
  return { totals: 0, uniques: new Set() };
}

function cellValue(cell: Cell | undefined, countBy: SegmentationQuery['countBy']): number {
  if (!cell) return 0;
  switch (countBy) {
    case 'totals':
      return cell.totals;
    case 'uniques':
      return cell.uniques.size;
    case 'average':
      // Returns 0 rather than NaN for an empty bucket.
      return ratio(cell.totals, cell.uniques.size);
  }
}

export function segmentation(
  events: readonly AnalyticsEvent[],
  q: SegmentationQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): SegmentationResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const tz = q.tzOffsetMin ?? 0;
  const buckets = bucketRange(q.range, q.granularity, tz);
  const limit = q.limitGroups ?? DEFAULT_LIMIT_GROUPS;

  // seriesKey -> bucketStart -> cell
  const table = new Map<string, Map<number, Cell>>();
  // Preserves the declared event order when there is no group-by.
  const seriesOrder: string[] = [];

  const touch = (seriesKey: string, bucket: number): Cell => {
    let row = table.get(seriesKey);
    if (!row) {
      row = new Map();
      table.set(seriesKey, row);
      seriesOrder.push(seriesKey);
    }
    let cell = row.get(bucket);
    if (!cell) {
      cell = emptyCell();
      row.set(bucket, cell);
    }
    return cell;
  };

  // Seed a series per declared event so an event with no data still draws a
  // flat zero line rather than disappearing from the legend.
  if (!q.groupBy) {
    q.events.forEach((step, i) => touch(stepLabel(step, i), buckets[0] ?? q.range.from));
  }

  for (const ev of events) {
    const t = ev.time ?? 0;
    if (!inRange(t, q.range)) continue;
    if (!matchesAll(ev, q.segment, { allowRegex })) continue;

    const userKey = graph.resolve(ev);
    const bucket = bucketStart(t, q.granularity, tz);

    for (let i = 0; i < q.events.length; i++) {
      const step = q.events[i]!;
      if (!matchesStep(ev, step, { allowRegex })) continue;

      const seriesKey = q.groupBy
        ? groupValue(ev, q.groupBy)
        : stepLabel(step, i);

      const cell = touch(seriesKey, bucket);
      cell.totals += 1;
      if (userKey) cell.uniques.add(userKey);
    }
  }

  // Materialise, rank by total, then fold the tail.
  let series: Series[] = seriesOrder.map((label) => {
    const row = table.get(label)!;
    const points = buckets.map((t) => ({ t, value: cellValue(row.get(t), q.countBy) }));
    let total = 0;
    for (const p of points) total += p.value;
    return { label, points, total };
  });

  if (q.groupBy && series.length > limit) {
    series.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    const kept = series.slice(0, limit);
    const tail = series.slice(limit);

    // Folding keeps the chart legible while the totals still reconcile.
    const other: Series = {
      label: OTHER_GROUP_LABEL,
      points: buckets.map((t, i) => ({
        t,
        value: tail.reduce((sum, s) => sum + (s.points[i]?.value ?? 0), 0),
      })),
      total: tail.reduce((sum, s) => sum + s.total, 0),
    };
    series = [...kept, other];
  } else if (q.groupBy) {
    series.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }

  return { series, buckets, granularity: q.granularity };
}

/** Group label for an event. Missing values collapse into a single bucket. */
function groupValue(ev: AnalyticsEvent, ref: PropertyRef): string {
  const v = resolveProperty(ev, ref);
  if (v === undefined || v === null) return '(none)';
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : String(v[0]);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
