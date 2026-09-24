/** Small helpers shared across the SDK. No dependencies. */

import type { Logger, LogLevel } from '../types';

/** RFC 4122 v4 UUID. Uses crypto when available, falling back to Math.random. */
export function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' +
    hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' +
    hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

const LEVELS: Record<LogLevel, number> = { none: 0, error: 1, warn: 2, debug: 3 };

/** Console logger gated by level. */
export function createLogger(level: LogLevel): Logger {
  const threshold = LEVELS[level] ?? LEVELS.warn;
  const prefix = '[event-analyzer]';
  return {
    error: (...a) => { if (threshold >= 1) console.error(prefix, ...a); },
    warn: (...a) => { if (threshold >= 2) console.warn(prefix, ...a); },
    debug: (...a) => { if (threshold >= 3) console.debug(prefix, ...a); },
  };
}

/** True when running in a browser with a DOM. */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/** Splits an array into chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
