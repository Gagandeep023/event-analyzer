/** Percentiles and histogram binning. No dependencies, no clock. */

import type { HistogramBin } from '../types';

/**
 * Percentile by linear interpolation between ranks, the convention behind the
 * usual p50 / p90 reporting.
 *
 * Returns null for an empty input rather than NaN or 0, so an empty funnel hop
 * renders as "no data" instead of "zero milliseconds".
 *
 * @param sorted values in ascending order. Not sorted internally; callers that
 *   already sorted should not pay for it twice. Use {@link percentileOf} otherwise.
 * @param p percentile in [0, 1].
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0]!;

  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const rank = clamped * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;

  const weight = rank - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

/** Sorts a copy, then takes the percentile. */
export function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  return percentile([...values].sort(ascending), p);
}

/** Median of an unsorted input. */
export function median(values: readonly number[]): number | null {
  return percentileOf(values, 0.5);
}

/** Mean, or null for an empty input. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Numeric ascending comparator. `Array.sort` defaults to lexicographic. */
export function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * Bins values into half-open ranges `[edges[i], edges[i+1])`.
 *
 * Values below the first edge are dropped. Values at or above the last edge are
 * clamped into the final bin, so a session longer than the one-day cap still
 * counts rather than vanishing.
 */
export function histogram(values: readonly number[], edges: readonly number[]): HistogramBin[] {
  const bins: HistogramBin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lowerMs = edges[i]!;
    const upperMs = edges[i + 1]!;
    bins.push({ bucketLabel: binLabel(lowerMs, upperMs), lowerMs, upperMs, count: 0 });
  }
  if (bins.length === 0) return bins;

  const first = edges[0]!;
  for (const v of values) {
    if (v < first) continue;
    let idx = upperBound(edges, v) - 1;
    if (idx < 0) idx = 0;
    if (idx >= bins.length) idx = bins.length - 1;
    bins[idx]!.count += 1;
  }
  return bins;
}

/** Index of the first edge strictly greater than `value`. */
function upperBound(edges: readonly number[], value: number): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Human label for a duration bin, e.g. `3-10s` or `30m+`. */
export function binLabel(lowerMs: number, upperMs: number): string {
  return `${durationLabel(lowerMs)}-${durationLabel(upperMs)}`;
}

/** Compact duration label: `0s`, `30s`, `5m`, `2h`, `1d`. */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`.replace('0ms', '0s');
  const s = ms / 1000;
  if (s < 60) return `${trim(s)}s`;
  const m = s / 60;
  if (m < 60) return `${trim(m)}m`;
  const h = m / 60;
  if (h < 24) return `${trim(h)}h`;
  return `${trim(h / 24)}d`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/** Counts distinct values. A tiny helper used across the analyses. */
export function countDistinct<T>(values: Iterable<T>): number {
  return new Set(values).size;
}

/** Safe ratio. Returns 0 rather than NaN or Infinity when the denominator is 0. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}
