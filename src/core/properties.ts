/**
 * User and group property merging.
 *
 * Applies the ten `$` operations in documented precedence. Pure: never mutates
 * its input.
 */

import type {
  AnalyticsEvent,
  PropertyValue,
  UserProperties,
} from '../types';
import { IDENTIFY_MERGE_ORDER, IdentifyOperation } from '../types';
import type { IdentityGraph } from './identity';

type Bag = Record<string, PropertyValue>;

/** Splits a property object into operation buckets plus bare keys. */
function partition(incoming: UserProperties): {
  ops: Map<IdentifyOperation, Bag>;
  bare: Bag;
} {
  const ops = new Map<IdentifyOperation, Bag>();
  const bare: Bag = {};

  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;

    if (key.startsWith('$')) {
      const op = key as IdentifyOperation;
      if (!IDENTIFY_MERGE_ORDER.includes(op)) continue;
      if (op === IdentifyOperation.CLEAR_ALL) {
        ops.set(op, {});
        continue;
      }
      if (isBag(value)) ops.set(op, value);
      continue;
    }
    bare[key] = value as PropertyValue;
  }
  return { ops, bare };
}

function isBag(v: unknown): v is Bag {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asList(v: PropertyValue | undefined): PropertyValue[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? [...v] : [v];
}

function sameValue(a: PropertyValue, b: PropertyValue): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merges one property payload onto an existing bag.
 *
 * Precedence, from `IDENTIFY_MERGE_ORDER`:
 * `$clearAll`, `$unset`, `$setOnce`, `$set`, list operations, `$add`.
 *
 * `$clearAll` is applied first and invalidates every other operation on the same
 * object. `$add` is applied last so an increment lands on top of a `$set` in the
 * same payload rather than being overwritten by it.
 */
export function mergeUserProperties(current: Bag, incoming: UserProperties): Bag {
  const { ops, bare } = partition(incoming);

  // $clearAll dominates: nothing else in this payload survives it.
  if (ops.has(IdentifyOperation.CLEAR_ALL)) return {};

  const out: Bag = { ...current };

  // Bare keys are an implicit $set, applied before explicit operations so an
  // explicit $set in the same payload wins.
  for (const [k, v] of Object.entries(bare)) out[k] = v;

  for (const op of IDENTIFY_MERGE_ORDER) {
    const bag = ops.get(op);
    if (!bag) continue;

    for (const [key, value] of Object.entries(bag)) {
      switch (op) {
        case IdentifyOperation.UNSET:
          delete out[key];
          break;

        case IdentifyOperation.SET_ONCE:
          if (!(key in out)) out[key] = value;
          break;

        case IdentifyOperation.SET:
          out[key] = value;
          break;

        case IdentifyOperation.APPEND:
          out[key] = [...asList(out[key]), ...asList(value)];
          break;

        case IdentifyOperation.PREPEND:
          out[key] = [...asList(value), ...asList(out[key])];
          break;

        case IdentifyOperation.PRE_INSERT: {
          const existing = asList(out[key]);
          const additions = asList(value).filter(
            (v) => !existing.some((e) => sameValue(e, v)),
          );
          out[key] = [...additions, ...existing];
          break;
        }

        case IdentifyOperation.POST_INSERT: {
          const existing = asList(out[key]);
          const additions = asList(value).filter(
            (v) => !existing.some((e) => sameValue(e, v)),
          );
          out[key] = [...existing, ...additions];
          break;
        }

        case IdentifyOperation.REMOVE: {
          const drop = asList(value);
          out[key] = asList(out[key]).filter(
            (e) => !drop.some((d) => sameValue(e, d)),
          );
          break;
        }

        case IdentifyOperation.ADD: {
          // Numbers only. A non-numeric current value is a no-op rather than NaN.
          if (typeof value !== 'number' || !Number.isFinite(value)) break;
          const existing = out[key];
          if (existing === undefined) out[key] = value;
          else if (typeof existing === 'number') out[key] = existing + value;
          break;
        }

        case IdentifyOperation.CLEAR_ALL:
          break;
      }
    }
  }

  return out;
}

/**
 * Replays every event's `user_properties` in time order to produce each user's
 * latest merged property bag.
 *
 * Used by cohort `userFilters`, which match against current state rather than
 * against whatever happened to be attached to one event.
 */
export function latestUserProperties(
  events: readonly AnalyticsEvent[],
  ids?: IdentityGraph,
): Map<string, Bag> {
  const byUser = new Map<string, Bag>();
  const ordered = [...events].sort(
    (a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.event_id ?? 0) - (b.event_id ?? 0),
  );

  for (const ev of ordered) {
    const key = ids ? ids.resolve(ev) : (ev.user_id ?? ev.device_id ?? '');
    if (!key) continue;
    if (!ev.user_properties) {
      if (!byUser.has(key)) byUser.set(key, {});
      continue;
    }
    byUser.set(key, mergeUserProperties(byUser.get(key) ?? {}, ev.user_properties));
  }
  return byUser;
}

/**
 * Builds a synthetic event carrying a user's merged properties, so cohort
 * `userFilters` can reuse the ordinary filter machinery instead of a parallel
 * evaluator.
 */
export function asPropertyCarrier(userKey: string, props: Bag): AnalyticsEvent {
  return {
    event_type: '__user_properties__',
    user_id: userKey,
    user_properties: props as UserProperties,
  };
}
