/**
 * Bounded in-memory store.
 *
 * Good for tests, demos and development. Evicts the oldest events past
 * `maxEvents` and loses everything on restart.
 */

import type { AnalyticsEvent, Filter, TimeRange, UserAlias } from '../../types';
import { matchesAll } from '../../core/filter';
import { deriveMeta, withinRange, type AliasCapableStore, type StoreMeta } from './EventStore';

export interface MemoryStoreOptions {
  /** Default 100,000. Oldest events are evicted past this. */
  maxEvents?: number;
  allowRegexFilters?: boolean;
}

export class MemoryStore implements AliasCapableStore {
  name = 'MemoryStore';
  private events: AnalyticsEvent[] = [];
  private aliasList: UserAlias[] = [];
  private maxEvents: number;
  private allowRegex: boolean;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? 100_000;
    this.allowRegex = options.allowRegexFilters ?? false;
  }

  async append(events: AnalyticsEvent[]): Promise<void> {
    this.events.push(...events);
    // Keep the newest by time, so eviction does not depend on arrival order.
    this.events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(this.events.length - this.maxEvents);
    }
  }

  async query(range: TimeRange, filters?: Filter[]): Promise<AnalyticsEvent[]> {
    const allowRegex = this.allowRegex;
    return this.events.filter(
      (ev) => withinRange(ev, range) && matchesAll(ev, filters, { allowRegex }),
    );
  }

  async count(range?: TimeRange): Promise<number> {
    if (!range) return this.events.length;
    let n = 0;
    for (const ev of this.events) if (withinRange(ev, range)) n++;
    return n;
  }

  async meta(): Promise<StoreMeta> {
    return deriveMeta(this.events);
  }

  async appendAliases(aliases: UserAlias[]): Promise<void> {
    this.aliasList.push(...aliases);
  }

  async aliases(): Promise<UserAlias[]> {
    return [...this.aliasList];
  }

  async clear(): Promise<void> {
    this.events = [];
    this.aliasList = [];
  }

  /** Every stored event, for tests and for `/export`. */
  all(): readonly AnalyticsEvent[] {
    return this.events;
  }
}
