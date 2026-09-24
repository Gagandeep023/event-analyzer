/** Transport adapters. Each sends a batch and reports what happened. */

import type { Transport, TransportResponse } from '../../types';
import { isBrowser } from '../util';

/** `fetch`, the browser default. Also works in Node 18 and later. */
export const fetchTransport: Transport = {
  name: 'fetch',
  async send(url, body, headers): Promise<TransportResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      keepalive: true,
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  },
};

/**
 * `navigator.sendBeacon`, which survives page navigation where `fetch` does not.
 *
 * The browser gives no response, so a queued beacon is reported as accepted.
 * That is the right trade at unload: the alternative is losing the batch.
 */
export const beaconTransport: Transport = {
  name: 'beacon',
  async send(url, body): Promise<TransportResponse> {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (!nav?.sendBeacon) return { status: 0 };
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
    const queued = nav.sendBeacon(url, blob);
    return { status: queued ? 200 : 0 };
  },
};

/** Node transport. Uses global fetch, present from Node 18. */
export const nodeTransport: Transport = {
  name: 'node',
  send: fetchTransport.send,
};

/** Picks a transport for the current host. */
export function resolveTransport(
  choice: 'auto' | 'fetch' | 'beacon' | 'node' | Transport | undefined,
): Transport {
  if (choice && typeof choice === 'object') return choice;
  switch (choice) {
    case 'fetch':
      return fetchTransport;
    case 'beacon':
      return beaconTransport;
    case 'node':
      return nodeTransport;
    default:
      return isBrowser() ? fetchTransport : nodeTransport;
  }
}
