/** Test doubles for the SDK. */

import type { Transport, TransportResponse } from '../types';

export interface SentBatch {
  url: string;
  events: Array<Record<string, unknown>>;
  headers: Record<string, string>;
}

/** A transport that records every batch and replies from a scripted queue. */
export class FakeTransport implements Transport {
  name = 'fake';
  sent: SentBatch[] = [];
  private replies: TransportResponse[] = [];
  private fallback: TransportResponse = { status: 200 };
  private throwNext = 0;

  /** Queues one reply per subsequent send, in order. */
  reply(...responses: TransportResponse[]): this {
    this.replies.push(...responses);
    return this;
  }

  /** Reply used once the scripted queue is empty. */
  then(response: TransportResponse): this {
    this.fallback = response;
    return this;
  }

  /** Makes the next `n` sends throw, simulating a network failure. */
  fail(n = 1): this {
    this.throwNext += n;
    return this;
  }

  async send(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<TransportResponse> {
    const payload = body as { events: Array<Record<string, unknown>> };
    this.sent.push({ url, events: payload.events, headers });

    if (this.throwNext > 0) {
      this.throwNext -= 1;
      throw new Error('network down');
    }
    return this.replies.shift() ?? this.fallback;
  }

  /** Every event across every batch, flattened. */
  allEvents(): Array<Record<string, unknown>> {
    return this.sent.flatMap((b) => b.events);
  }

  reset(): void {
    this.sent = [];
    this.replies = [];
    this.throwNext = 0;
  }
}

/** Silent logger, so test output stays readable. */
export const quietLogger = {
  error: () => {},
  warn: () => {},
  debug: () => {},
};

/** Lets pending microtasks and zero-delay timers settle. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
