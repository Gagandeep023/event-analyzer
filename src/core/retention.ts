/**
 * Retention: how many users come back, and when.
 *
 * Three measures, because shipping only `n-day` is the usual way a retention
 * implementation is quietly wrong. Amplitude's own research found `n-day`
 * understates returning users by roughly 3.5x against `unbounded`.
 *
 *   n-day     returned on exactly period N
 *   unbounded returned on period N or any period after
 *   bracket   returned within a caller-defined [lo, hi]
 */

import type {
  AnalyticsEvent,
  RetentionCell,
  RetentionCohortRow,
  RetentionCurvePoint,
  RetentionQuery,
  RetentionResult,
} from '../types';
import { buildIdentityGraph, groupByUser, type IdentityGraph } from './identity';
import { matchesAll, matchesStep } from './filter';
import { ratio } from './stats';
import { bucketLabel, bucketStart, inRange, periodLabel, periodsBetween } from './time';

/** One user's retention record: their cohort, and which periods they returned in. */
interface UserRecord {
  cohortStart: number;
  /** Ascending, deduplicated period offsets of return events. Always includes 0. */
  returns: number[];
}

export function retention(
  events: readonly AnalyticsEvent[],
  q: RetentionQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): RetentionResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;
  const tz = q.tzOffsetMin ?? 0;

  const scoped = events.filter((ev) => inRange(ev.time ?? 0, q.range));
  const byUser = groupByUser(scoped, graph);

  const records: UserRecord[] = [];

  for (const userEvents of byUser.values()) {
    // The segment applies to the START action only, matching Amplitude.
    const start = userEvents.find(
      (ev) =>
        matchesStep(ev, q.startAction, { allowRegex }) &&
        matchesAll(ev, q.segment, { allowRegex }),
    );
    if (!start) continue;

    const startTime = start.time ?? 0;
    const cohortStart = bucketStart(startTime, q.interval, tz);
    const seen = new Set<number>([0]);

    for (const ev of userEvents) {
      const t = ev.time ?? 0;
      if (t < startTime) continue;
      if (!matchesStep(ev, q.returnAction, { allowRegex })) continue;
      const period = periodsBetween(startTime, t, q.interval, tz);
      if (period >= 0) seen.add(period);
    }

    records.push({ cohortStart, returns: [...seen].sort((a, b) => a - b) });
  }

  const periods = periodList(q);

  // Group users by cohort bucket.
  const cohorts = new Map<number, UserRecord[]>();
  for (const r of records) {
    const bucket = cohorts.get(r.cohortStart);
    if (bucket) bucket.push(r);
    else cohorts.set(r.cohortStart, [r]);
  }

  const table: RetentionCohortRow[] = [];
  // periodIndex -> running totals across cohorts that can be fairly measured.
  const curveRetained = new Array<number>(periods.length).fill(0);
  const curveDenominator = new Array<number>(periods.length).fill(0);
  // Retained counts from cohorts that cannot yet be fairly measured. Kept so an
  // incomplete curve point still reports something rather than a bare zero.
  const partialRetained = new Array<number>(periods.length).fill(0);
  const partialDenominator = new Array<number>(periods.length).fill(0);

  for (const [cohortStart, members] of [...cohorts.entries()].sort((a, b) => a[0] - b[0])) {
    const cells: RetentionCell[] = [];

    for (let i = 0; i < periods.length; i++) {
      const spec = periods[i]!;
      const observable = isObservable(cohortStart, spec.maxPeriod, q, tz);

      let retained = 0;
      for (const m of members) {
        if (isRetained(m.returns, spec)) retained++;
      }

      cells.push({
        period: spec.period,
        retained,
        rate: ratio(retained, members.length),
        incomplete: !observable,
      });

      if (observable) {
        curveRetained[i]! += retained;
        curveDenominator[i]! += members.length;
      } else {
        partialRetained[i]! += retained;
        partialDenominator[i]! += members.length;
      }
    }

    table.push({
      cohortStart,
      cohortLabel: bucketLabel(cohortStart, q.interval, tz),
      cohortSize: members.length,
      cells,
    });
  }

  const curve: RetentionCurvePoint[] = periods.map((spec, i) => {
    const fullDenominator = curveDenominator[i]!;
    // Each point uses its OWN denominator: only cohorts with enough elapsed time.
    // Counting a cohort that started yesterday in the Day 30 denominator would
    // drive the whole curve toward zero.
    const usePartial = fullDenominator === 0;
    const retained = usePartial ? partialRetained[i]! : curveRetained[i]!;
    const cohortSize = usePartial ? partialDenominator[i]! : fullDenominator;

    return {
      period: spec.period,
      label: spec.label,
      cohortSize,
      retained,
      rate: ratio(retained, cohortSize),
      incomplete: usePartial,
    };
  });

  return {
    measure: q.measure,
    interval: q.interval,
    totalUsers: records.length,
    curve,
    table,
  };
}

/** One column of the output: a period index plus the rule for counting it. */
interface PeriodSpec {
  period: number;
  label: string;
  /** Inclusive lower bound of the window this column covers. */
  lo: number;
  /** Inclusive upper bound, or Infinity for unbounded. */
  hi: number;
  /** The furthest period that must be observable for this column to be fair. */
  maxPeriod: number;
}

function periodList(q: RetentionQuery): PeriodSpec[] {
  if (q.measure === 'bracket') {
    const brackets = q.brackets ?? [];
    return brackets.map(([lo, hi], i) => ({
      period: i,
      label: lo === hi ? periodLabel(lo, q.interval) : `${lo}-${hi}`,
      lo,
      hi,
      maxPeriod: hi,
    }));
  }

  const out: PeriodSpec[] = [];
  for (let n = 0; n <= q.periods; n++) {
    out.push({
      period: n,
      label: periodLabel(n, q.interval),
      lo: n,
      // `unbounded` counts a return on period N or any period after.
      hi: q.measure === 'unbounded' ? Number.POSITIVE_INFINITY : n,
      maxPeriod: n,
    });
  }
  return out;
}

/** Does this user's return set satisfy the column's window? */
function isRetained(returns: readonly number[], spec: PeriodSpec): boolean {
  for (const p of returns) {
    if (p >= spec.lo && p <= spec.hi) return true;
  }
  return false;
}

/**
 * A cohort is only fairly measurable at period N if the query range actually
 * extends N periods past the cohort start.
 *
 * Amplitude flags rather than excludes, leaving the decision to the renderer.
 * We adopt both the behaviour and the field name.
 */
function isObservable(
  cohortStart: number,
  maxPeriod: number,
  q: RetentionQuery,
  tz: number,
): boolean {
  if (!Number.isFinite(maxPeriod)) {
    // Unbounded columns still need `period` whole intervals of observation.
    return true;
  }
  const available = periodsBetween(cohortStart, q.range.to - 1, q.interval, tz);
  return available >= maxPeriod;
}
