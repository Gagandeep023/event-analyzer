/** SDK and backend configuration. */

import type { AnalyticsEvent } from './event';
import type { Filter, PropertyRef, TimeRange, TzOffsetMin } from './filter';

// ---------------------------------------------------------------------------
// SDK
// ---------------------------------------------------------------------------

export type LogLevel = 'none' | 'error' | 'warn' | 'debug';

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** Outcome of delivering one event. */
export interface DeliveryResult {
  code: number;
  message: string;
  event: AnalyticsEvent;
}

/** Sends a batch and reports what happened. Swappable for tests. */
export interface Transport {
  name: string;
  send(url: string, body: unknown, headers: Record<string, string>): Promise<TransportResponse>;
}

export interface TransportResponse {
  status: number;
  body?: unknown;
}

/** Persists the unsent queue so a closing tab does not lose events. */
export interface StorageAdapter {
  name: string;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ClickAutocaptureOptions {
  /** Only elements matching one of these are captured. */
  cssSelectorAllowlist?: string[];
  /** Text content is truncated to this many characters. Never input values. */
  maxTextLength?: number;
}

export interface PageViewAutocaptureOptions {
  /** Capture SPA history changes, not only full loads. */
  trackHistoryChanges?: boolean;
  eventType?: string;
}

/**
 * Autocapture. Everything defaults to false.
 *
 * Amplitude defaults several of these on, which is convenient and also how people
 * ship tracking they did not know about. For a self-hosted tool the honest
 * default is to capture nothing until asked.
 */
export interface AutocaptureOptions {
  pageViews?: boolean | PageViewAutocaptureOptions;
  sessions?: boolean;
  clicks?: boolean | ClickAutocaptureOptions;
}

export interface SdkConfig {
  /** Required. Where batches are POSTed. */
  endpoint: string;
  /** Sent as `X-EA-Key`. Not a secret; a filter against casual noise. */
  apiKey?: string;

  userId?: string;
  deviceId?: string;
  sessionId?: number;

  /** Default 5000. Amplitude uses 1000; a self-hosted collector is not billing per request. */
  flushIntervalMillis?: number;
  /** Default 30. Flush immediately at this queue depth. */
  flushQueueSize?: number;
  /** Default 5. Then the event is dropped with a synthetic 500. */
  flushMaxRetries?: number;
  /** Default 500. Events per HTTP request. */
  maxBatchSize?: number;
  /** Default 30 minutes. */
  sessionTimeoutMs?: number;
  /** Default 5. Validated on both sides. */
  minIdLength?: number;

  transport?: 'auto' | 'fetch' | 'beacon' | 'node' | Transport;
  storage?: 'auto' | 'memory' | 'local' | StorageAdapter;

  /** Drops everything at the `before` stage. */
  optOut?: boolean;
  /** Queue but never flush. */
  offline?: boolean;

  autocapture?: AutocaptureOptions;

  logLevel?: LogLevel;
  loggerProvider?: Logger;

  /** Extra context merged onto every event. */
  defaultContext?: Record<string, unknown>;
}

/** `SdkConfig` after defaults are applied. What plugins receive. */
export type ResolvedSdkConfig = Required<
  Pick<
    SdkConfig,
    | 'endpoint'
    | 'flushIntervalMillis'
    | 'flushQueueSize'
    | 'flushMaxRetries'
    | 'maxBatchSize'
    | 'sessionTimeoutMs'
    | 'minIdLength'
    | 'optOut'
    | 'offline'
    | 'logLevel'
  >
> & {
  apiKey?: string;
  transport: Transport;
  storage: StorageAdapter;
  autocapture: AutocaptureOptions;
  loggerProvider: Logger;
  defaultContext: Record<string, unknown>;
};

/** SDK defaults. Exported so tests and docs cannot drift from the implementation. */
export const SDK_DEFAULTS = Object.freeze({
  flushIntervalMillis: 5_000,
  flushQueueSize: 30,
  flushMaxRetries: 5,
  maxBatchSize: 500,
  sessionTimeoutMs: 1_800_000,
  minIdLength: 5,
  optOut: false,
  offline: false,
  logLevel: 'warn' as LogLevel,
  /** Backoff applied on a 429, in ms. */
  throttleTimeoutMs: 30_000,
  /** Backoff applied on a retryable failure, in ms. */
  retryTimeoutMs: 1_000,
});

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/** Persistence. The interface is exported so SQLite or Postgres can drop in. */
export interface EventStore {
  name: string;
  append(events: AnalyticsEvent[]): Promise<void>;
  query(range: TimeRange, filters?: Filter[]): Promise<AnalyticsEvent[]>;
  count(range?: TimeRange): Promise<number>;
  meta(): Promise<StoreMeta>;
  clear?(): Promise<void>;
  close?(): Promise<void>;
}

export interface StoreMeta {
  eventTypes: string[];
  propertyKeys: PropertyRef[];
  oldest: number | null;
  newest: number | null;
  totalEvents: number;
}

/**
 * Minimal Express middleware shape, so `express` stays an optional peer.
 *
 * `req` and `res` are `any` rather than `unknown` on purpose. This is an interop
 * boundary: a caller passing a properly typed `(req: Request, res: Response)`
 * handler must be assignable here, and parameter contravariance makes that
 * impossible against `unknown`. Narrowing this would force every consumer to
 * cast their own middleware.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type RequestHandlerLike = (req: any, res: any, next: (err?: unknown) => void) => void;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BackendConfig {
  /** Required. */
  store: EventStore;

  /**
   * When set, `/collect` requires a matching `X-EA-Key`.
   * This key is public by nature; anything running the SDK must have it.
   */
  apiKeys?: string[];

  /**
   * Guards `/query/*`, `/meta`, `/export` and `/stream`, which expose every
   * event in the store. Separate from `apiKeys` so the two trust levels cannot
   * be collapsed by accident. The router warns at startup when this is absent.
   */
  queryAuth?: RequestHandlerLike;

  /** Default false. Untrusted regex from a request body is a DoS vector. */
  allowRegexFilters?: boolean;
  /** Default 0. Per-query override available. */
  defaultTzOffsetMin?: TzOffsetMin;
  /** Default 500. */
  maxEventsPerRequest?: number;
  /** Default 5 MB. */
  maxBodyBytes?: number;
  /** Default 50. An unbounded SSE endpoint is a memory exhaustion target. */
  maxStreamConnections?: number;
  /** Default 5. */
  minIdLength?: number;
  /** Accept Amplitude's own payload shape on `/collect`. Default false. */
  amplitudeCompat?: boolean;
  logger?: Logger;
}

export const BACKEND_DEFAULTS = Object.freeze({
  allowRegexFilters: false,
  defaultTzOffsetMin: 0,
  maxEventsPerRequest: 500,
  maxBodyBytes: 5_000_000,
  maxStreamConnections: 50,
  minIdLength: 5,
  amplitudeCompat: false,
  /** How many recent insert ids to remember for deduplication. */
  dedupeWindow: 10_000,
  /** SSE keepalive interval, in ms. */
  heartbeatMs: 15_000,
});
