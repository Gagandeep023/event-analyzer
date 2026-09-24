/**
 * Query primitives shared by every analysis.
 *
 * A typed restatement of Amplitude's `e` / `s` / `g` triple: a step is an event
 * with optional property filters, a segment is a list of filters, and a group-by
 * is a property reference. Learn it once, use it across all five analyses.
 */

import type { PropertyValue } from './event';

/** Where a property lives on an event. */
export type PropertyScope = 'event' | 'user' | 'context' | 'group';

/** A reference to one property. `key` is a dot path, e.g. `plan.tier`. */
export interface PropertyRef {
  scope: PropertyScope;
  key: string;
}

/**
 * Filter operators.
 *
 * `exists` and `not_exists` are the only operators for which a missing property
 * is meaningful. Every other operator returns false against `undefined`, so a
 * missing property never accidentally satisfies `neq`.
 */
export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists'
  | 'regex';

/** Every operator, for validation. */
export const FILTER_OPS: readonly FilterOp[] = Object.freeze([
  'eq', 'neq', 'contains', 'not_contains',
  'gt', 'gte', 'lt', 'lte',
  'in', 'not_in', 'exists', 'not_exists', 'regex',
]);

/** Operators that take no `value`. */
export const NULLARY_FILTER_OPS: readonly FilterOp[] = Object.freeze(['exists', 'not_exists']);

/** Operators whose `value` must be an array. */
export const ARRAY_FILTER_OPS: readonly FilterOp[] = Object.freeze(['in', 'not_in']);

/** One property predicate. */
export interface Filter {
  property: PropertyRef;
  op: FilterOp;
  value?: PropertyValue | PropertyValue[];
}

/** Matches any event type. Used for "any event" in retention without a special path. */
export const ANY_EVENT = '*' as const;

/** One funnel step, or the start / return action of a retention query. */
export interface StepSpec {
  /** An event type, or `'*'` to match any event. */
  event_type: string | typeof ANY_EVENT;
  filters?: Filter[];
  /** Display label. Falls back to `event_type`. */
  label?: string;
}

/** A half-open time interval, `[from, to)`, in milliseconds since epoch. */
export interface TimeRange {
  from: number;
  to: number;
}

/** Time bucket size. */
export type Granularity = 'hour' | 'day' | 'week' | 'month';

/** Every granularity, for validation. */
export const GRANULARITIES: readonly Granularity[] = Object.freeze([
  'hour', 'day', 'week', 'month',
]);

/** Retention and cohort interval, a subset of Granularity. */
export type Interval = 'day' | 'week' | 'month';

export const INTERVALS: readonly Interval[] = Object.freeze(['day', 'week', 'month']);

/**
 * Minutes east of UTC, e.g. 330 for IST.
 *
 * Bucketing is a correctness decision, not a formatting one: "Day 1 retention"
 * means a calendar day boundary in someone's timezone, and bucketing in UTC when
 * users are in IST shifts every cohort by five and a half hours.
 */
export type TzOffsetMin = number;
