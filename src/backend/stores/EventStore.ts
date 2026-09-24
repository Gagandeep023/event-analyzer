/**
 * Persistence interface.
 *
 * Exported so SQLite or Postgres can be dropped in without touching the router.
 */

import type {
  AnalyticsEvent,
  EventStore,
  Filter,
  PropertyRef,
  StoreMeta,
  TimeRange,
  UserAlias,
} from '../../types';

export type { EventStore, StoreMeta };

/** Optional capabilities a store may offer beyond the base interface. */
export interface AliasCapableStore extends EventStore {
  appendAliases(aliases: UserAlias[]): Promise<void>;
  aliases(): Promise<UserAlias[]>;
}

export function isAliasCapable(store: EventStore): store is AliasCapableStore {
  return typeof (store as AliasCapableStore).appendAliases === 'function';
}

/** Discovers event types and property keys from a sample of events. */
export function deriveMeta(events: readonly AnalyticsEvent[]): StoreMeta {
  const eventTypes = new Set<string>();
  const keys = new Map<string, PropertyRef>();
  let oldest: number | null = null;
  let newest: number | null = null;

  const note = (scope: PropertyRef['scope'], key: string) => {
    const id = `${scope}:${key}`;
    if (!keys.has(id)) keys.set(id, { scope, key });
  };

  for (const ev of events) {
    eventTypes.add(ev.event_type);
    const t = ev.time ?? 0;
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;

    for (const k of Object.keys(ev.event_properties ?? {})) note('event', k);
    for (const k of Object.keys(ev.context ?? {})) note('context', k);
    for (const k of Object.keys(ev.groups ?? {})) note('group', k);

    for (const [k, v] of Object.entries(ev.user_properties ?? {})) {
      if (k.startsWith('$')) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          for (const inner of Object.keys(v)) note('user', inner);
        }
      } else {
        note('user', k);
      }
    }
  }

  return {
    eventTypes: [...eventTypes].sort(),
    propertyKeys: [...keys.values()].sort(
      (a, b) => a.scope.localeCompare(b.scope) || a.key.localeCompare(b.key),
    ),
    oldest,
    newest,
    totalEvents: events.length,
  };
}

/** Half-open range check used by every store. */
export function withinRange(ev: AnalyticsEvent, range: TimeRange): boolean {
  const t = ev.time ?? 0;
  return t >= range.from && t < range.to;
}

/** Re-exported for stores that filter during a scan. */
export type { AnalyticsEvent, Filter, TimeRange, UserAlias };
