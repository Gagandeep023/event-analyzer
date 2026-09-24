/**
 * The shared predicate layer.
 *
 * Everything else in `core` builds on this, which is why it is small and heavily
 * tested: a bug here silently corrupts every chart in the product.
 */

import type { AnalyticsEvent, Filter, PropertyRef, PropertyValue, StepSpec } from '../types';
import { ANY_EVENT, IdentifyOperation } from '../types';

/** Cap on a caller-supplied regex source, to limit catastrophic backtracking. */
export const MAX_REGEX_LENGTH = 200;

/**
 * Reads a property by scope and dot path.
 *
 * Returns undefined for any missing path segment rather than throwing, so a
 * filter against a property that does not exist on this event is a clean miss.
 */
export function resolveProperty(
  ev: AnalyticsEvent,
  ref: PropertyRef,
): PropertyValue | undefined {
  let root: unknown;

  switch (ref.scope) {
    case 'event':
      root = ev.event_properties;
      break;
    case 'context':
      root = ev.context;
      break;
    case 'group':
      root = ev.groups;
      break;
    case 'user':
      root = flattenUserProperties(ev.user_properties);
      break;
  }

  return walk(root, ref.key);
}

/**
 * Collapses `$`-operation wrappers so a filter can address `plan` rather than
 * `$set.plan`. Bare keys win over operation-wrapped ones, since a bare key is
 * already an implicit `$set`.
 */
function flattenUserProperties(props: unknown): Record<string, unknown> | undefined {
  if (!isRecord(props)) return undefined;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('$')) {
      if (key === IdentifyOperation.UNSET || key === IdentifyOperation.CLEAR_ALL) continue;
      if (isRecord(value)) {
        for (const [k, v] of Object.entries(value)) {
          if (!(k in out)) out[k] = v;
        }
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Walks a dot path. Returns undefined at the first missing segment. */
function walk(root: unknown, path: string): PropertyValue | undefined {
  if (root === undefined || root === null) return undefined;
  if (path === '') return undefined;

  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor)) return undefined;
    if (!(segment in cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor as PropertyValue | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Evaluates one filter against one event.
 *
 * `exists` and `not_exists` are the only operators for which a missing property
 * is meaningful. Every other operator returns false against undefined, so a
 * missing property never accidentally satisfies `neq`.
 */
export function evaluateFilter(
  ev: AnalyticsEvent,
  f: Filter,
  opts: { allowRegex?: boolean } = {},
): boolean {
  const actual = resolveProperty(ev, f.property);

  if (f.op === 'exists') return actual !== undefined && actual !== null;
  if (f.op === 'not_exists') return actual === undefined || actual === null;

  if (actual === undefined || actual === null) return false;

  switch (f.op) {
    case 'eq':
      return looseEquals(actual, f.value);
    case 'neq':
      return !looseEquals(actual, f.value);

    case 'in':
      return toArray(f.value).some((candidate) => looseEquals(actual, candidate));
    case 'not_in':
      return !toArray(f.value).some((candidate) => looseEquals(actual, candidate));

    case 'contains':
      return containsValue(actual, f.value);
    case 'not_contains':
      return !containsValue(actual, f.value);

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compare(actual, f.value, f.op);

    case 'regex':
      return opts.allowRegex === true && matchesRegex(actual, f.value);
  }
}

/**
 * Equality across a scalar or an array member.
 *
 * Numbers compare to numbers and strings to strings. A number is also allowed to
 * match its own string form, because query bodies arriving over HTTP routinely
 * carry `"200"` where the stored value is `200`.
 */
function looseEquals(actual: PropertyValue, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected));
  if (actual === expected) return true;

  if (typeof actual === 'number' && typeof expected === 'string') {
    return expected.trim() !== '' && Number(expected) === actual;
  }
  if (typeof actual === 'string' && typeof expected === 'number') {
    return actual.trim() !== '' && Number(actual) === expected;
  }
  if (typeof actual === 'boolean' && typeof expected === 'string') {
    return String(actual) === expected;
  }
  return false;
}

/** Substring for strings, membership for arrays. */
function containsValue(actual: PropertyValue, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected));
  if (typeof actual === 'string') return actual.includes(String(expected));
  return false;
}

/**
 * Ordered comparison.
 *
 * Coerces number-to-number and string-to-string only. Mixed types return false
 * rather than relying on JavaScript's ordering rules, where `"10" < "9"`.
 */
function compare(actual: PropertyValue, expected: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  let a: number | string;
  let b: number | string;

  if (typeof actual === 'number' && typeof expected === 'number') {
    a = actual;
    b = expected;
  } else if (typeof actual === 'number' && typeof expected === 'string') {
    const n = Number(expected);
    if (!Number.isFinite(n)) return false;
    a = actual;
    b = n;
  } else if (typeof actual === 'string' && typeof expected === 'number') {
    const n = Number(actual);
    if (!Number.isFinite(n)) return false;
    a = n;
    b = expected;
  } else if (typeof actual === 'string' && typeof expected === 'string') {
    a = actual;
    b = expected;
  } else {
    return false;
  }

  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
  }
}

const regexCache = new Map<string, RegExp | null>();

/** Compiles and caches a caller-supplied pattern. Never throws. */
function matchesRegex(actual: PropertyValue, pattern: unknown): boolean {
  if (typeof pattern !== 'string' || pattern.length > MAX_REGEX_LENGTH) return false;
  if (typeof actual !== 'string') return false;

  let re = regexCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    regexCache.set(pattern, re);
  }
  return re === null ? false : re.test(actual);
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === undefined ? [] : [v];
}

/** True when every filter passes. An empty or absent list always passes. */
export function matchesAll(
  ev: AnalyticsEvent,
  filters?: readonly Filter[],
  opts: { allowRegex?: boolean } = {},
): boolean {
  if (!filters || filters.length === 0) return true;
  for (const f of filters) {
    if (!evaluateFilter(ev, f, opts)) return false;
  }
  return true;
}

/**
 * True when the event matches a step: its type, and all of the step's filters.
 *
 * Short-circuits on `'*'`, which is what makes "any event" work in retention
 * without a special code path.
 */
export function matchesStep(
  ev: AnalyticsEvent,
  step: StepSpec,
  opts: { allowRegex?: boolean } = {},
): boolean {
  if (step.event_type !== ANY_EVENT && ev.event_type !== step.event_type) return false;
  return matchesAll(ev, step.filters, opts);
}

/** Display label for a step. */
export function stepLabel(step: StepSpec, index: number): string {
  if (step.label) return step.label;
  if (step.event_type === ANY_EVENT) return `Any event (${index + 1})`;
  return step.event_type;
}

/** Clears the compiled-regex cache. Test hook. */
export function _clearRegexCache(): void {
  regexCache.clear();
}
