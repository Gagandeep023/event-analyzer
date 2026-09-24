/** Data hooks. Abortable, deduped, and unaware of how storage works. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MetaResponse, QueryKind, StreamMessage } from '../../types';

export type Fetcher = typeof fetch;

export interface ApiContext {
  baseUrl: string;
  fetcher: Fetcher;
}

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Runs one query against `POST /query/:kind`.
 *
 * Changing the range fires six panel queries at once, so each hook aborts its
 * own previous request. Without that, dragging a date picker queues dozens of
 * requests and the last response to arrive wins, which is not always the latest.
 */
export function useQuery<T>(
  api: ApiContext,
  kind: QueryKind,
  body: unknown,
  enabled = true,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const key = useMemo(() => JSON.stringify(body), [body]);

  useEffect(() => {
    if (!enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    api
      .fetcher(`${api.baseUrl}/query/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: key,
        signal: controller.signal,
      })
      .then(async (res) => {
        const parsed = (await res.json()) as T & { error?: string };
        if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
        return parsed;
      })
      .then((parsed) => {
        if (controller.signal.aborted) return;
        setData(parsed);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => controller.abort();
  }, [api, kind, key, enabled, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refetch };
}

/**
 * Loads `/meta` once per session.
 *
 * Picking event types and property keys from discovered data rather than free
 * text removes the most common source of an empty result: a typo in an event
 * name.
 */
export function useMeta(api: ApiContext): QueryState<MetaResponse> {
  const [data, setData] = useState<MetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .fetcher(`${api.baseUrl}/meta`)
      .then((res) => res.json() as Promise<MetaResponse>)
      .then((parsed) => {
        if (cancelled) return;
        setData(parsed);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, nonce]);

  return { data, error, loading, refetch: () => setNonce((n) => n + 1) };
}

export interface StreamState {
  events: StreamMessage['events'];
  connected: boolean;
  perSecond: number[];
}

/** Live event feed over SSE, with reconnect and a bounded buffer. */
export function useEventStream(api: ApiContext, enabled: boolean, limit = 200): StreamState {
  const [events, setEvents] = useState<StreamMessage['events']>([]);
  const [connected, setConnected] = useState(false);
  const [perSecond, setPerSecond] = useState<number[]>(Array(60).fill(0));
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;

    const source = new EventSource(`${api.baseUrl}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('batch', (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent<string>).data) as StreamMessage;
        countRef.current += msg.events.length;
        // Newest first, bounded so a busy feed cannot grow without limit.
        setEvents((prev) => [...msg.events.slice().reverse(), ...prev].slice(0, limit));
      } catch {
        // A torn frame is not worth tearing down the connection for.
      }
    });

    const ticker = setInterval(() => {
      setPerSecond((prev) => [...prev.slice(1), countRef.current]);
      countRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(ticker);
      source.close();
      setConnected(false);
    };
  }, [api, enabled, limit]);

  return { events, connected, perSecond };
}

/** A time range expressed as trailing days, resolved on each render tick. */
export function useRange(days: number): { from: number; to: number } {
  return useMemo(() => {
    const to = Date.now();
    return { from: to - days * 86_400_000, to };
  }, [days]);
}
