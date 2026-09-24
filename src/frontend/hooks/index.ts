/** Data access. Abortable, deduped, and unaware of how storage works. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MetaResponse, QueryKind, StreamMessage, TimeRange } from '../../types';

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
 * One query against `POST /query/:kind`.
 *
 * Changing the range fires several panel queries at once, so each hook aborts
 * its own previous request. Without that, dragging a range control queues
 * requests whose last-to-arrive is not necessarily the latest.
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

    api.fetcher(`${api.baseUrl}/query/${kind}`, {
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

  return { data, error, loading, refetch: useCallback(() => setNonce((n) => n + 1), []) };
}

/** `/meta`, once per session. Drives the event pickers so nothing is free text. */
export function useMeta(api: ApiContext): QueryState<MetaResponse> {
  const [data, setData] = useState<MetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.fetcher(`${api.baseUrl}/meta`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as MetaResponse;
      })
      .then((parsed) => { if (!cancelled) { setData(parsed); setLoading(false); } })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, nonce]);

  return { data, error, loading, refetch: () => setNonce((n) => n + 1) };
}

export interface LiveEvent {
  id: string;
  time: number;
  event_type: string;
  user: string;
  props: string;
}

export interface StreamState {
  events: LiveEvent[];
  connected: boolean;
  /** Events received per second, last 60 seconds. */
  rate: number[];
  freshId: string | null;
}

/** SSE feed with reconnect and a bounded buffer. */
export function useEventStream(api: ApiContext, enabled: boolean, limit = 40): StreamState {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [rate, setRate] = useState<number[]>(() => Array(60).fill(0));
  const [freshId, setFreshId] = useState<string | null>(null);
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setConnected(false);
      return;
    }
    const source = new EventSource(`${api.baseUrl}/stream`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('batch', (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent<string>).data) as StreamMessage;
        countRef.current += msg.events.length;
        const mapped: LiveEvent[] = msg.events.slice().reverse().map((ev, i) => ({
          id: ev.insert_id ?? `${ev.time ?? 0}-${i}`,
          time: ev.time ?? Date.now(),
          event_type: ev.event_type,
          user: ev.user_id ?? ev.device_id ?? '—',
          props: summarise(ev.event_properties),
        }));
        if (mapped[0]) setFreshId(mapped[0].id);
        setEvents((prev) => [...mapped, ...prev].slice(0, limit));
      } catch {
        // A torn frame is not worth tearing down the connection for.
      }
    });

    const ticker = setInterval(() => {
      setRate((prev) => [...prev.slice(1), countRef.current]);
      countRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(ticker);
      source.close();
      setConnected(false);
    };
  }, [api, enabled, limit]);

  return { events, connected, rate, freshId };
}

function summarise(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  return Object.entries(props)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}

/** A trailing-window range, recomputed only when the day count changes. */
export function useRange(days: number): TimeRange {
  return useMemo(() => {
    const to = Date.now();
    return { from: to - days * 86_400_000, to };
  }, [days]);
}
