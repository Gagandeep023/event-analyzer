import { describe, it, expect } from 'vitest';
import {
  percentile, percentileOf, median, mean, histogram,
  durationLabel, countDistinct, ratio, ascending,
} from './stats';

describe('percentile', () => {
  it('returns null for an empty input, not NaN or zero', () => {
    // An empty funnel hop must render as "no data", not "zero milliseconds".
    expect(percentile([], 0.5)).toBeNull();
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it('returns the only value for a single-element input', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('takes the exact value when the rank lands on an index', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it('interpolates linearly between ranks', () => {
    // rank = 0.5 * (4 - 1) = 1.5, halfway between 20 and 30.
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    // rank = 0.9 * 3 = 2.7, 70% of the way from 30 to 40.
    expect(percentile([10, 20, 30, 40], 0.9)).toBeCloseTo(37, 10);
  });

  it('clamps out-of-range percentiles', () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });

  it('percentileOf sorts numerically, not lexicographically', () => {
    // Array.sort defaults to string comparison, which would order [10, 9] wrongly.
    expect(percentileOf([10, 9, 100, 2], 0)).toBe(2);
    expect(percentileOf([10, 9, 100, 2], 1)).toBe(100);
  });

  it('does not mutate its input', () => {
    const input = [3, 1, 2];
    percentileOf(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('histogram', () => {
  const edges = [0, 10, 20, 30];

  it('produces one bin per edge pair', () => {
    expect(histogram([], edges)).toHaveLength(3);
  });

  it('bins on half-open ranges', () => {
    const bins = histogram([0, 9, 10, 19, 20, 29], edges);
    expect(bins.map((b) => b.count)).toEqual([2, 2, 2]);
  });

  it('drops values below the first edge', () => {
    const bins = histogram([-5, -1, 5], edges);
    expect(bins.map((b) => b.count)).toEqual([1, 0, 0]);
  });

  it('clamps values at or above the last edge into the final bin', () => {
    // A session longer than the one-day cap must still count, not vanish.
    const bins = histogram([30, 999], edges);
    expect(bins.map((b) => b.count)).toEqual([0, 0, 2]);
  });

  it('returns no bins for fewer than two edges', () => {
    expect(histogram([1], [0])).toEqual([]);
  });
});

describe('helpers', () => {
  it('ratio returns 0 rather than NaN or Infinity on a zero denominator', () => {
    expect(ratio(0, 0)).toBe(0);
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(1, 4)).toBe(0.25);
  });

  it('countDistinct counts unique members', () => {
    expect(countDistinct(['a', 'b', 'a'])).toBe(2);
    expect(countDistinct([])).toBe(0);
  });

  it('ascending sorts numerically', () => {
    expect([10, 9, 100].sort(ascending)).toEqual([9, 10, 100]);
  });

  it('durationLabel scales through units', () => {
    expect(durationLabel(0)).toBe('0s');
    expect(durationLabel(30_000)).toBe('30s');
    expect(durationLabel(300_000)).toBe('5m');
    expect(durationLabel(7_200_000)).toBe('2h');
    expect(durationLabel(86_400_000)).toBe('1d');
  });
});
