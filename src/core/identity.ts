/**
 * Device-to-user resolution.
 *
 * Events arrive keyed by `device_id` before login and `user_id` after. Without
 * resolution one person appears as two users and every retention number is wrong.
 *
 * The graph is built once per query and passed down into every analysis, so the
 * cost is paid once rather than per chart.
 */

import type { AnalyticsEvent, UserAlias } from '../types';

/** Resolved identity lookup for a set of events. */
export interface IdentityGraph {
  /** Canonical user key for an event. Empty string when the event has no identifier. */
  resolve(ev: AnalyticsEvent): string;
  /** Canonical key for a raw identifier. */
  resolveKey(rawKey: string): string;
  /** How many device-to-user unions were made. */
  aliasCount: number;
  /** Events carrying neither `user_id` nor `device_id`. Surfaced, not hidden. */
  skipped: number;
}

/** Namespaced node ids, so a device id can never collide with a user id. */
function userNode(id: string): string {
  return `u:${id}`;
}
function deviceNode(id: string): string {
  return `d:${id}`;
}

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
      this.rank.set(node, 0);
    }
  }

  find(node: string): string {
    this.add(node);
    let root = node;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cursor = node;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  /** Returns true when two distinct sets were merged. */
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;

    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
    return true;
  }

  nodes(): IterableIterator<string> {
    return this.parent.keys();
  }
}

/**
 * Builds the identity graph.
 *
 * Any event carrying both `user_id` and `device_id` unions those two nodes.
 * Explicit aliases are unioned first, as seeds.
 *
 * Canonical key selection prefers a real `user_id` over a `device_id`, so any
 * set that has ever seen a login resolves to the login. Among several user ids
 * in one set, the lexicographically smallest wins, which keeps the choice
 * deterministic regardless of event order.
 */
export function buildIdentityGraph(
  events: readonly AnalyticsEvent[],
  aliases: readonly UserAlias[] = [],
): IdentityGraph {
  const uf = new UnionFind();
  let aliasCount = 0;
  let skipped = 0;

  for (const alias of aliases) {
    if (alias.unmap || !alias.global_user_id) continue;
    if (uf.union(userNode(alias.user_id), userNode(alias.global_user_id))) aliasCount++;
  }

  for (const ev of events) {
    const hasUser = typeof ev.user_id === 'string' && ev.user_id.length > 0;
    const hasDevice = typeof ev.device_id === 'string' && ev.device_id.length > 0;

    if (!hasUser && !hasDevice) {
      skipped++;
      continue;
    }
    if (hasUser) uf.add(userNode(ev.user_id!));
    if (hasDevice) uf.add(deviceNode(ev.device_id!));
    if (hasUser && hasDevice) {
      if (uf.union(userNode(ev.user_id!), deviceNode(ev.device_id!))) aliasCount++;
    }
  }

  // Pick one canonical label per set: a user id if the set has any, else a device id.
  const canonical = new Map<string, string>();
  for (const node of uf.nodes()) {
    const root = uf.find(node);
    const current = canonical.get(root);
    if (current === undefined || better(node, current)) canonical.set(root, node);
  }

  const cache = new Map<string, string>();

  const resolveNode = (node: string): string => {
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    const label = canonical.get(uf.find(node)) ?? node;
    // Strip the namespace prefix; callers want the bare id.
    const bare = label.slice(2);
    cache.set(node, bare);
    return bare;
  };

  return {
    aliasCount,
    skipped,
    resolve(ev: AnalyticsEvent): string {
      if (typeof ev.user_id === 'string' && ev.user_id.length > 0) {
        return resolveNode(userNode(ev.user_id));
      }
      if (typeof ev.device_id === 'string' && ev.device_id.length > 0) {
        return resolveNode(deviceNode(ev.device_id));
      }
      return '';
    },
    resolveKey(rawKey: string): string {
      const asUser = userNode(rawKey);
      const asDevice = deviceNode(rawKey);
      // Prefer the user-id interpretation when the graph knows it.
      for (const node of [asUser, asDevice]) {
        if (canonical.has(uf.find(node))) return resolveNode(node);
      }
      return rawKey;
    },
  };
}

/** A user node beats a device node; among equals, the smaller id wins. */
function better(candidate: string, current: string): boolean {
  const candidateIsUser = candidate.startsWith('u:');
  const currentIsUser = current.startsWith('u:');
  if (candidateIsUser !== currentIsUser) return candidateIsUser;
  return candidate < current;
}

/** Groups events by resolved user key, each group sorted by `(time, event_id)`. */
export function groupByUser(
  events: readonly AnalyticsEvent[],
  ids: IdentityGraph,
): Map<string, AnalyticsEvent[]> {
  const byUser = new Map<string, AnalyticsEvent[]>();

  for (const ev of events) {
    const key = ids.resolve(ev);
    if (!key) continue;
    const bucket = byUser.get(key);
    if (bucket) bucket.push(ev);
    else byUser.set(key, [ev]);
  }

  for (const list of byUser.values()) list.sort(byTime);
  return byUser;
}

/**
 * A membership test against a set of resolved user keys.
 *
 * Built once per analysis rather than per event, and resolved through the
 * graph rather than read off the event, because a raw `user_id` comparison
 * would drop a user's pre-login events at exactly the point identity
 * resolution exists to keep them.
 */
export function userSetMatcher(
  ids: IdentityGraph,
  userKeys: readonly string[] | undefined,
): (ev: AnalyticsEvent) => boolean {
  if (!userKeys || userKeys.length === 0) return () => true;
  const set = new Set(userKeys);
  return (ev) => set.has(ids.resolve(ev));
}

/** Chronological comparator. `event_id` breaks ties on identical timestamps. */
export function byTime(a: AnalyticsEvent, b: AnalyticsEvent): number {
  const ta = a.time ?? 0;
  const tb = b.time ?? 0;
  if (ta !== tb) return ta - tb;
  return (a.event_id ?? 0) - (b.event_id ?? 0);
}
