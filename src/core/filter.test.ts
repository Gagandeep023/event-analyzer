import { describe, it, expect, beforeEach } from 'vitest';
import { resolveProperty, evaluateFilter, matchesAll, matchesStep, stepLabel, _clearRegexCache, MAX_REGEX_LENGTH } from './filter';
import type { AnalyticsEvent, Filter } from '../types';
import { ev } from './__fixtures__';

const sample: AnalyticsEvent = ev({
  type: 'Checkout Started',
  user: 'u1',
  props: { cart_value: 4200, items: 3, coupon: 'SAVE10', tags: ['a', 'b'], nested: { deep: { v: 7 } } },
  userProps: { plan: 'pro', $set: { tier: 'gold' }, $unset: { stale: '-' } },
  context: { platform: 'web', page_url: 'https://example.com/checkout' },
  groups: { org: 'acme' },
});

const f = (scope: Filter['property']['scope'], key: string, op: Filter['op'], value?: unknown): Filter =>
  ({ property: { scope, key }, op, value: value as never });

describe('resolveProperty', () => {
  it('reads each scope', () => {
    expect(resolveProperty(sample, { scope: 'event', key: 'cart_value' })).toBe(4200);
    expect(resolveProperty(sample, { scope: 'context', key: 'platform' })).toBe('web');
    expect(resolveProperty(sample, { scope: 'group', key: 'org' })).toBe('acme');
    expect(resolveProperty(sample, { scope: 'user', key: 'plan' })).toBe('pro');
  });

  it('flattens $ operations so a filter addresses the bare key', () => {
    // A caller filters on `tier`, not on `$set.tier`.
    expect(resolveProperty(sample, { scope: 'user', key: 'tier' })).toBe('gold');
  });

  it('ignores $unset and $clearAll when flattening', () => {
    expect(resolveProperty(sample, { scope: 'user', key: 'stale' })).toBeUndefined();
  });

  it('walks a dot path', () => {
    expect(resolveProperty(sample, { scope: 'event', key: 'nested.deep.v' })).toBe(7);
  });

  it('returns undefined at the first missing segment instead of throwing', () => {
    expect(resolveProperty(sample, { scope: 'event', key: 'nested.missing.v' })).toBeUndefined();
    expect(resolveProperty(sample, { scope: 'event', key: 'absent' })).toBeUndefined();
    expect(resolveProperty(ev({ type: 'X' }), { scope: 'event', key: 'a' })).toBeUndefined();
  });
});

describe('existence operators', () => {
  it('exists and not_exists are the only operators that treat undefined as meaningful', () => {
    expect(evaluateFilter(sample, f('event', 'coupon', 'exists'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'absent', 'exists'))).toBe(false);
    expect(evaluateFilter(sample, f('event', 'absent', 'not_exists'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'coupon', 'not_exists'))).toBe(false);
  });

  it('a missing property never satisfies neq', () => {
    // The classic bug: "plan is not free" quietly matching every event that has
    // no plan at all.
    expect(evaluateFilter(sample, f('event', 'absent', 'neq', 'anything'))).toBe(false);
  });

  it('every non-existence operator is false against a missing property', () => {
    for (const op of ['eq', 'neq', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in'] as const) {
      expect(evaluateFilter(sample, f('event', 'absent', op, 'x'))).toBe(false);
    }
  });
});

describe('equality and membership', () => {
  it('matches exact scalars', () => {
    expect(evaluateFilter(sample, f('event', 'coupon', 'eq', 'SAVE10'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'coupon', 'eq', 'OTHER'))).toBe(false);
    expect(evaluateFilter(sample, f('event', 'cart_value', 'eq', 4200))).toBe(true);
  });

  it('matches a number against its string form, since query bodies arrive as JSON', () => {
    expect(evaluateFilter(sample, f('event', 'cart_value', 'eq', '4200'))).toBe(true);
  });

  it('matches any member of an array-valued property', () => {
    expect(evaluateFilter(sample, f('event', 'tags', 'eq', 'b'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'tags', 'eq', 'z'))).toBe(false);
  });

  it('handles in and not_in', () => {
    expect(evaluateFilter(sample, f('event', 'coupon', 'in', ['SAVE10', 'X']))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'coupon', 'not_in', ['X', 'Y']))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'coupon', 'not_in', ['SAVE10']))).toBe(false);
  });

  it('handles contains for strings and arrays', () => {
    expect(evaluateFilter(sample, f('context', 'page_url', 'contains', 'checkout'))).toBe(true);
    expect(evaluateFilter(sample, f('context', 'page_url', 'not_contains', 'login'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'tags', 'contains', 'a'))).toBe(true);
  });
});

describe('ordered comparison', () => {
  it('compares numbers', () => {
    expect(evaluateFilter(sample, f('event', 'cart_value', 'gt', 1000))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'cart_value', 'lte', 4200))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'cart_value', 'lt', 100))).toBe(false);
  });

  it('does not fall back to JavaScript ordering across types', () => {
    // `"10" < "9"` is true as strings. A numeric property compared to a
    // non-numeric string must be false, not lexicographically true.
    expect(evaluateFilter(sample, f('event', 'cart_value', 'lt', 'banana'))).toBe(false);
    expect(evaluateFilter(sample, f('event', 'cart_value', 'gt', 'banana'))).toBe(false);
  });

  it('coerces a numeric string on either side', () => {
    expect(evaluateFilter(sample, f('event', 'cart_value', 'gt', '1000'))).toBe(true);
    expect(evaluateFilter(sample, f('event', 'coupon', 'gt', 'SAVE0'))).toBe(true);
  });

  it('is false when comparing an array or object', () => {
    expect(evaluateFilter(sample, f('event', 'tags', 'gt', 1))).toBe(false);
    expect(evaluateFilter(sample, f('event', 'nested', 'gt', 1))).toBe(false);
  });
});

describe('regex', () => {
  beforeEach(() => _clearRegexCache());

  it('is refused unless explicitly allowed', () => {
    const filter = f('context', 'page_url', 'regex', 'check.*');
    expect(evaluateFilter(sample, filter)).toBe(false);
    expect(evaluateFilter(sample, filter, { allowRegex: true })).toBe(true);
  });

  it('never throws on an invalid pattern', () => {
    const filter = f('context', 'page_url', 'regex', '([unclosed');
    expect(() => evaluateFilter(sample, filter, { allowRegex: true })).not.toThrow();
    expect(evaluateFilter(sample, filter, { allowRegex: true })).toBe(false);
  });

  it('refuses an over-long pattern', () => {
    const long = 'a'.repeat(MAX_REGEX_LENGTH + 1);
    expect(evaluateFilter(sample, f('context', 'page_url', 'regex', long), { allowRegex: true })).toBe(false);
  });
});

describe('matchesAll and matchesStep', () => {
  it('an empty or absent filter list always passes', () => {
    expect(matchesAll(sample, [])).toBe(true);
    expect(matchesAll(sample, undefined)).toBe(true);
  });

  it('requires every filter to pass', () => {
    expect(matchesAll(sample, [f('event', 'cart_value', 'gt', 1000), f('context', 'platform', 'eq', 'web')])).toBe(true);
    expect(matchesAll(sample, [f('event', 'cart_value', 'gt', 1000), f('context', 'platform', 'eq', 'ios')])).toBe(false);
  });

  it('matches on event type', () => {
    expect(matchesStep(sample, { event_type: 'Checkout Started' })).toBe(true);
    expect(matchesStep(sample, { event_type: 'Other' })).toBe(false);
  });

  it('the * wildcard matches any event type', () => {
    // This is what makes "any event" work in retention without a special path.
    expect(matchesStep(sample, { event_type: '*' })).toBe(true);
    expect(matchesStep(ev({ type: 'Anything' }), { event_type: '*' })).toBe(true);
  });

  it('applies step filters on top of the wildcard', () => {
    expect(matchesStep(sample, { event_type: '*', filters: [f('context', 'platform', 'eq', 'web')] })).toBe(true);
    expect(matchesStep(sample, { event_type: '*', filters: [f('context', 'platform', 'eq', 'ios')] })).toBe(false);
  });

  it('stepLabel falls back sensibly', () => {
    expect(stepLabel({ event_type: 'A', label: 'Custom' }, 0)).toBe('Custom');
    expect(stepLabel({ event_type: 'A' }, 0)).toBe('A');
    expect(stepLabel({ event_type: '*' }, 2)).toBe('Any event (3)');
  });
});
