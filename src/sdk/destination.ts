/**
 * Delivery: batching, retry, backoff and persistence.
 *
 * The part most likely to lose data if written carelessly, so the behaviours
 * are spelled out here rather than left implicit.
 */

import type {
  AnalyticsEvent,
  DeliveryResult,
  Logger,
  ResolvedSdkConfig,
  StorageAdapter,
} from '../types';
import { SDK_DEFAULTS } from '../types';
import type { DestinationPlugin } from './timeline';
import { chunk, uuid } from './util';

/** Storage key holding the unsent queue. */
export const QUEUE_KEY = 'event-analyzer.queue';

interface Pending {
  event: AnalyticsEvent;
  attempts: number;
  resolve: (r: DeliveryResult) => void;
}

/** Index-addressed rejection body returned by `/collect` on a 400. */
interface RejectionBody {
  events_with_missing_fields?: Record<string, number[]>;
  events_with_invalid_fields?: Record<string, number[]>;
  events_with_invalid_id_lengths?: Record<string, number[]>;
  duplicate_events?: number[];
  error?: string;
}

/** Collects every event index named anywhere in a rejection body. */
export function rejectedIndices(body: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (typeof body !== 'object' || body === null) return out;
  const b = body as RejectionBody & Record<string, unknown>;

  const maps: Array<[string, Record<string, number[]> | undefined]> = [
    ['missing field', b.events_with_missing_fields],
    ['invalid field', b.events_with_invalid_fields],
    ['invalid id length', b.events_with_invalid_id_lengths],
  ];
  for (const [kind, map] of maps) {
    if (!map) continue;
    for (const [field, indices] of Object.entries(map)) {
      for (const i of indices ?? []) out.set(i, `${kind}: ${field}`);
    }
  }
  for (const i of b.duplicate_events ?? []) out.set(i, 'duplicate insert_id');
  return out;
}

export class Destination implements DestinationPlugin {
  name = 'event-analyzer';
  type = 'destination' as const;

  private queue: Pending[] = [];
  private scheduleId: ReturnType<typeof setTimeout> | null = null;
  private scheduledTimeout = 0;
  private flushing = false;
  private config!: ResolvedSdkConfig;
  private storage!: StorageAdapter;
  private logger!: Logger;

  async setup(config: ResolvedSdkConfig): Promise<void> {
    this.config = config;
    this.storage = config.storage;
    this.logger = config.loggerProvider;

    // Replaying the persisted queue is the entire offline story, and why a tab
    // closing mid-batch does not lose events.
    const unsent = await this.storage.get<AnalyticsEvent[]>(QUEUE_KEY);
    if (unsent && unsent.length > 0) {
      this.logger.debug(`replaying ${unsent.length} persisted events`);
      for (const event of unsent) void this.deliver(event);
    }
  }

  deliver(event: AnalyticsEvent): Promise<DeliveryResult> {
    // Stamping on entry makes every retry idempotent and lets the server dedupe.
    if (!event.insert_id) event.insert_id = uuid();

    return new Promise<DeliveryResult>((resolve) => {
      this.queue.push({ event, attempts: 0, resolve });
      void this.persist();

      if (this.queue.length >= this.config.flushQueueSize) {
        void this.flush();
      } else {
        this.schedule(this.config.flushIntervalMillis);
      }
    });
  }

  /**
   * Schedules a flush.
   *
   * A new schedule replaces the pending one only when its timeout is LONGER.
   * Without this rule, steady traffic keeps rescheduling a 30 second throttle
   * backoff down to 5 seconds, and the client hammers a server that has already
   * said stop.
   */
  private schedule(timeoutMs: number): void {
    if (this.config.offline) return;
    if (this.scheduleId !== null && timeoutMs <= this.scheduledTimeout) return;
    if (this.scheduleId !== null) clearTimeout(this.scheduleId);

    this.scheduledTimeout = timeoutMs;
    this.scheduleId = setTimeout(() => {
      this.scheduleId = null;
      this.scheduledTimeout = 0;
      void this.flush();
    }, timeoutMs);
  }

  private clearSchedule(): void {
    if (this.scheduleId !== null) clearTimeout(this.scheduleId);
    this.scheduleId = null;
    this.scheduledTimeout = 0;
  }

  async flush(): Promise<void> {
    if (this.config.offline) {
      this.logger.debug('offline, skipping flush');
      return;
    }
    if (this.flushing) return;
    if (this.queue.length === 0) {
      this.clearSchedule();
      return;
    }

    this.flushing = true;
    this.clearSchedule();

    const batch = this.queue;
    this.queue = [];

    try {
      for (const part of chunk(batch, this.config.maxBatchSize)) {
        await this.send(part);
      }
    } finally {
      this.flushing = false;
      await this.persist();
      if (this.queue.length > 0) this.schedule(this.config.flushIntervalMillis);
    }
  }

  private async send(batch: Pending[]): Promise<void> {
    if (batch.length === 0) return;

    const headers: Record<string, string> = {};
    if (this.config.apiKey) headers['X-EA-Key'] = this.config.apiKey;

    let status: number;
    let body: unknown;
    try {
      const res = await this.config.transport.send(
        this.config.endpoint,
        { events: batch.map((p) => p.event) },
        headers,
      );
      status = res.status;
      body = res.body;
    } catch (err) {
      this.logger.debug('transport threw, retrying', err);
      this.retry(batch, SDK_DEFAULTS.retryTimeoutMs);
      return;
    }

    if (status >= 200 && status < 300) {
      for (const p of batch) p.resolve({ code: status, message: 'success', event: p.event });
      return;
    }

    if (status === 400) {
      // Drop only the events the server named; requeue the rest. One bad event
      // must not cost the caller the other 499.
      const bad = rejectedIndices(body);
      const survivors: Pending[] = [];
      batch.forEach((p, i) => {
        const reason = bad.get(i);
        if (reason !== undefined) {
          p.resolve({ code: 400, message: reason, event: p.event });
        } else if (bad.size === 0) {
          // Whole batch rejected with no index detail; nothing to salvage.
          p.resolve({ code: 400, message: 'rejected', event: p.event });
        } else {
          survivors.push(p);
        }
      });
      if (survivors.length > 0) this.retry(survivors, SDK_DEFAULTS.retryTimeoutMs);
      return;
    }

    if (status === 413) {
      if (batch.length === 1) {
        // A single event too large will never fit; dropping beats looping.
        batch[0]!.resolve({ code: 413, message: 'event too large', event: batch[0]!.event });
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await this.send(batch.slice(0, mid));
      await this.send(batch.slice(mid));
      return;
    }

    if (status === 401 || status === 403) {
      // An auth failure will not fix itself by retrying.
      for (const p of batch) {
        p.resolve({ code: status, message: 'unauthorized', event: p.event });
      }
      return;
    }

    if (status === 429) {
      this.retry(batch, SDK_DEFAULTS.throttleTimeoutMs);
      return;
    }

    this.retry(batch, SDK_DEFAULTS.retryTimeoutMs);
  }

  /** Requeues, dropping anything that has exhausted its retries. */
  private retry(batch: Pending[], timeoutMs: number): void {
    for (const p of batch) {
      p.attempts += 1;
      if (p.attempts >= this.config.flushMaxRetries) {
        // Bounded memory even against a server that has been down for a week.
        p.resolve({ code: 500, message: 'max retries exceeded', event: p.event });
        continue;
      }
      this.queue.push(p);
    }
    if (this.queue.length > 0) this.schedule(timeoutMs);
  }

  private async persist(): Promise<void> {
    try {
      if (this.queue.length === 0) await this.storage.remove(QUEUE_KEY);
      else await this.storage.set(QUEUE_KEY, this.queue.map((p) => p.event));
    } catch (err) {
      this.logger.debug('failed to persist queue', err);
    }
  }

  /** Queue depth. Test and diagnostic hook. */
  pending(): number {
    return this.queue.length;
  }

  async teardown(): Promise<void> {
    this.clearSchedule();
  }
}
