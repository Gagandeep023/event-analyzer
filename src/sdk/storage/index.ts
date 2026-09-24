/**
 * Storage adapters.
 *
 * Persisting the unsent queue is the entire offline story, and why a browser
 * tab closing mid-batch does not lose events.
 */

import type { StorageAdapter } from '../../types';
import { isBrowser } from '../util';

/** In-memory. Lost on restart. The default in Node. */
export function memoryStorage(): StorageAdapter {
  const map = new Map<string, unknown>();
  return {
    name: 'memory',
    async get<T>(key: string): Promise<T | null> {
      return (map.get(key) as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

/**
 * `localStorage`, with quota handling.
 *
 * A quota error must never break the host application, so a failed write is
 * logged and dropped rather than thrown. The events stay in the in-memory queue
 * either way; only the crash-survival guarantee is lost.
 */
export function localStorageAdapter(): StorageAdapter {
  return {
    name: 'local',
    async get<T>(key: string): Promise<T | null> {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as T);
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Quota exceeded, or storage disabled in a private window.
      }
    },
    async remove(key: string): Promise<void> {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Nothing useful to do.
      }
    },
  };
}

/** Picks a storage adapter for the current host. */
export function resolveStorage(
  choice: 'auto' | 'memory' | 'local' | StorageAdapter | undefined,
): StorageAdapter {
  if (choice && typeof choice === 'object') return choice;
  switch (choice) {
    case 'memory':
      return memoryStorage();
    case 'local':
      return isBrowser() ? localStorageAdapter() : memoryStorage();
    default:
      return isBrowser() ? localStorageAdapter() : memoryStorage();
  }
}
