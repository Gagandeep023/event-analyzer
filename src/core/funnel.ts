/**
 * Funnel conversion and drop-off.
 *
 * Three ordering modes, using the vocabulary established by product analytics
 * tools, so a migrated
 * query keeps its meaning:
 *
 *   ordered    steps in the given order, other events permitted between them
 *   unordered  all steps within the window, in any order
 *   sequential steps in the given order with NO other event between two steps
 *
 * Note that `sequential` is not the intuitive plain in-order mode. `ordered` is.
 */

import type {
  AnalyticsEvent,
  FunnelQuery,
  FunnelResult,
  FunnelStepResult,
  PropertyRef,
  StepSpec,
} from '../types';
import { buildIdentityGraph, groupByUser, type IdentityGraph } from './identity';
import { matchesAll, matchesStep, resolveProperty, stepLabel } from './filter';
import { ascending, percentile, ratio } from './stats';
import { inRange } from './time';

/**
 * Cap on re-entry attempts per user.
 *
 * A user with thousands of step-0 events would otherwise make the walk
 * quadratic. Fifty attempts is far beyond what a real funnel needs, and the cap
 * only ever reduces a reported depth, never inflates it.
 */
export const MAX_FUNNEL_ATTEMPTS = 50;

/** One completed walk through the steps. */
interface Attempt {
  /** How many steps were reached, 0..steps.length. */
  depth: number;
  /** Elapsed ms from each step to the next. Index i is the hop into step i+1. */
  hopTimes: number[];
  /** Total elapsed ms across the whole walk, when the funnel completed. */
  totalMs: number | null;
  /** Index of the last event this attempt consumed, for `totals` accounting. */
  lastIndex: number;
}

export function funnel(
  events: readonly AnalyticsEvent[],
  q: FunnelQuery,
  ids?: IdentityGraph,
  opts: { allowRegex?: boolean } = {},
): FunnelResult {
  const graph = ids ?? buildIdentityGraph(events);
  const allowRegex = opts.allowRegex === true;

  if (q.steps.length === 0) return emptyResult(q);

  const scoped = events.filter((ev) => inRange(ev.time ?? 0, q.range));
  const byUser = groupByUser(scoped, graph);

  if (!q.groupBy) {
    return compute(byUser, q, { allowRegex });
  }

  // Grouped: partition users by the group value on their step-0 event, then
  // recurse. Doing it this way keeps each group internally consistent.
  const overall = compute(byUser, q, { allowRegex });
  const partitions = new Map<string, Map<string, AnalyticsEvent[]>>();

  for (const [userKey, userEvents] of byUser) {
    const entry = userEvents.find(
      (ev) =>
        matchesStep(ev, q.steps[0]!, { allowRegex }) &&
        matchesAll(ev, q.segment, { allowRegex }),
    );
    if (!entry) continue;
    const label = groupValue(entry, q.groupBy);
    let part = partitions.get(label);
    if (!part) {
      part = new Map();
      partitions.set(label, part);
    }
    part.set(userKey, userEvents);
  }

  const groups: Record<string, FunnelResult> = {};
  for (const [label, part] of partitions) {
    groups[label] = compute(part, q, { allowRegex });
  }

  return { ...overall, groups };
}

function compute(
  byUser: Map<string, AnalyticsEvent[]>,
  q: FunnelQuery,
  opts: { allowRegex: boolean },
): FunnelResult {
  const stepCount = q.steps.length;
  // reached[k] counts users (or attempts) reaching depth >= k + 1.
  const reached = new Array<number>(stepCount).fill(0);
  const hopSamples: number[][] = Array.from({ length: stepCount }, () => []);
  const totalSamples: number[] = [];
  const byTotals = q.countBy === 'totals';

  for (const userEvents of byUser.values()) {
    const attempts = walkUser(userEvents, q, opts);
    if (attempts.length === 0) continue;

    if (byTotals) {
      // Every attempt contributes, so one user converting three times counts
      // three. The correct denominator for transactional funnels.
      for (const a of attempts) {
        for (let k = 0; k < a.depth; k++) reached[k]! += 1;
        collect(a, hopSamples, totalSamples);
      }
    } else {
      // A user's recorded depth is the best they ever achieved.
      let best = attempts[0]!;
      for (const a of attempts) if (a.depth > best.depth) best = a;
      for (let k = 0; k < best.depth; k++) reached[k]! += 1;
      collect(best, hopSamples, totalSamples);
    }
  }

  const totalEntered = reached[0] ?? 0;
  const totalConverted = reached[stepCount - 1] ?? 0;

  const steps: FunnelStepResult[] = q.steps.map((step, k) => {
    const count = reached[k] ?? 0;
    const prev = k === 0 ? count : (reached[k - 1] ?? 0);
    const hops = k === 0 ? [] : hopSamples[k]!.slice().sort(ascending);

    return {
      index: k,
      label: stepLabel(step, k),
      event_type: step.event_type,
      count,
      conversionFromStart: ratio(count, totalEntered),
      conversionFromPrevious: k === 0 ? (count > 0 ? 1 : 0) : ratio(count, prev),
      dropOff: k === 0 ? 0 : prev - count,
      dropOffRate: k === 0 ? 0 : ratio(prev - count, prev),
      medianTimeFromPreviousMs: k === 0 ? null : percentile(hops, 0.5),
      p90TimeFromPreviousMs: k === 0 ? null : percentile(hops, 0.9),
    };
  });

  return {
    steps,
    totalEntered,
    totalConverted,
    overallConversion: ratio(totalConverted, totalEntered),
    medianTotalTimeMs: percentile(totalSamples.slice().sort(ascending), 0.5),
  };
}

function collect(a: Attempt, hopSamples: number[][], totalSamples: number[]): void {
  for (let i = 0; i < a.hopTimes.length; i++) {
    const bucket = hopSamples[i + 1];
    if (bucket) bucket.push(a.hopTimes[i]!);
  }
  if (a.totalMs !== null) totalSamples.push(a.totalMs);
}

/** Every attempt this user made, one per step-0 match. */
function walkUser(
  userEvents: readonly AnalyticsEvent[],
  q: FunnelQuery,
  opts: { allowRegex: boolean },
): Attempt[] {
  const first = q.steps[0]!;
  const starts: number[] = [];

  for (let i = 0; i < userEvents.length; i++) {
    const ev = userEvents[i]!;
    // The segment applies to the FIRST step only, matching convention.
    if (matchesStep(ev, first, opts) && matchesAll(ev, q.segment, opts)) {
      starts.push(i);
      if (starts.length >= MAX_FUNNEL_ATTEMPTS) break;
    }
  }
  if (starts.length === 0) return [];

  const attempts: Attempt[] = [];
  let consumedUpto = -1;
  for (const startIdx of starts) {
    // Under `totals` each attempt consumes its events, so a completed walk does
    // not get re-counted from a step-0 match that sat inside it.
    if (q.countBy === 'totals' && startIdx <= consumedUpto) continue;
    const attempt =
      q.order === 'unordered'
        ? walkUnordered(userEvents, startIdx, q, opts)
        : walkInOrder(userEvents, startIdx, q, opts);
    attempts.push(attempt);
    if (q.countBy === 'totals') consumedUpto = attempt.lastIndex;
    // A complete funnel cannot be beaten, so under `uniques` there is nothing
    // left to find. Under `totals` every attempt counts, so keep walking.
    if (q.countBy !== 'totals' && attempt.depth === q.steps.length) break;
  }
  return attempts;
}

/** `ordered` and `sequential`. They differ only in what may sit between steps. */
function walkInOrder(
  userEvents: readonly AnalyticsEvent[],
  startIdx: number,
  q: FunnelQuery,
  opts: { allowRegex: boolean },
): Attempt {
  const strict = q.order === 'sequential';
  const t0 = userEvents[startIdx]!.time ?? 0;
  const deadline = t0 + q.conversionWindowMs;

  let cursor = startIdx;
  let lastTime = t0;
  let depth = 1;
  const hopTimes: number[] = [];

  for (let k = 1; k < q.steps.length; k++) {
    const step = q.steps[k]!;
    let found = -1;

    for (let i = cursor + 1; i < userEvents.length; i++) {
      const ev = userEvents[i]!;
      const t = ev.time ?? 0;
      if (t > deadline) break;

      if (isExcluded(ev, q, opts)) {
        // An exclusion between two steps truncates the attempt here.
        return { depth, hopTimes, totalMs: null, lastIndex: i };
      }
      if (matchesStep(ev, step, opts)) {
        found = i;
        break;
      }
      // `sequential` forbids anything else between two steps.
      if (strict) return { depth, hopTimes, totalMs: null, lastIndex: i };
    }

    if (found === -1) return { depth, hopTimes, totalMs: null, lastIndex: cursor };

    const t = userEvents[found]!.time ?? 0;
    hopTimes.push(Math.max(0, t - lastTime));
    lastTime = t;
    cursor = found;
    depth++;
  }

  return { depth, hopTimes, totalMs: lastTime - t0, lastIndex: cursor };
}

/**
 * `unordered`: every step must occur inside the window, order irrelevant.
 *
 * Depth is the number of distinct steps matched, so partial completion still
 * reports proportionally and step counts stay monotonic.
 */
function walkUnordered(
  userEvents: readonly AnalyticsEvent[],
  startIdx: number,
  q: FunnelQuery,
  opts: { allowRegex: boolean },
): Attempt {
  const t0 = userEvents[startIdx]!.time ?? 0;
  const deadline = t0 + q.conversionWindowMs;

  // Earliest time each step was satisfied, within the window.
  const firstSeen = new Array<number | null>(q.steps.length).fill(null);
  firstSeen[0] = t0;
  let exclusionAt: number | null = null;
  let lastIndex = startIdx;

  for (let i = startIdx; i < userEvents.length; i++) {
    const ev = userEvents[i]!;
    const t = ev.time ?? 0;
    if (t > deadline) break;

    if (exclusionAt === null && isExcluded(ev, q, opts)) {
      exclusionAt = t;
      continue;
    }
    for (let k = 1; k < q.steps.length; k++) {
      if (firstSeen[k] !== null) continue;
      if (matchesStep(ev, q.steps[k]!, opts)) {
        firstSeen[k] = t;
        lastIndex = i;
      }
    }
  }

  // Steps satisfied before any exclusion fired.
  const times: number[] = [];
  for (const t of firstSeen) {
    if (t === null) continue;
    if (exclusionAt !== null && t > exclusionAt) continue;
    times.push(t);
  }
  times.sort(ascending);

  const depth = times.length;
  const hopTimes: number[] = [];
  for (let i = 1; i < times.length; i++) hopTimes.push(times[i]! - times[i - 1]!);

  const complete = depth === q.steps.length;
  return {
    depth,
    hopTimes,
    totalMs: complete ? times[times.length - 1]! - times[0]! : null,
    lastIndex,
  };
}

function isExcluded(
  ev: AnalyticsEvent,
  q: FunnelQuery,
  opts: { allowRegex: boolean },
): boolean {
  if (!q.exclusions || q.exclusions.length === 0) return false;
  return q.exclusions.some((ex: StepSpec) => matchesStep(ev, ex, opts));
}

function groupValue(ev: AnalyticsEvent, ref: PropertyRef): string {
  const v = resolveProperty(ev, ref);
  if (v === undefined || v === null) return '(none)';
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : String(v[0]);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function emptyResult(q: FunnelQuery): FunnelResult {
  return {
    steps: q.steps.map((step, k) => ({
      index: k,
      label: stepLabel(step, k),
      event_type: step.event_type,
      count: 0,
      conversionFromStart: 0,
      conversionFromPrevious: 0,
      dropOff: 0,
      dropOffRate: 0,
      medianTimeFromPreviousMs: null,
      p90TimeFromPreviousMs: null,
    })),
    totalEntered: 0,
    totalConverted: 0,
    overallConversion: 0,
    medianTotalTimeMs: null,
  };
}
