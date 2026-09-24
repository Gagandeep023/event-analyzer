/**
 * The Express router.
 *
 * Owns validation, persistence and routing. Owns no policy about authentication
 * beyond an optional shared key, because that belongs to the host application.
 */

import type {
  AnalyticsEvent,
  BackendConfig,
  CohortQuery,
  FunnelQuery,
  Logger,
  QueryKind,
  RetentionQuery,
  SegmentationQuery,
  SessionQuery,
  UserAlias,
} from '../types';
import { BACKEND_DEFAULTS, QUERY_KINDS } from '../types';
import {
  buildCohort,
  buildIdentityGraph,
  funnel,
  retention,
  segmentation,
  sessionStats,
} from '../core';
import { normalizeAmplitudeEvent, toRejectionMap, validateBatch } from './validate';
import { isAliasCapable } from './stores/EventStore';

/** Minimal shapes, so `express` stays an optional peer dependency. */
interface Req {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, unknown>;
  on?(event: string, fn: () => void): void;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
  end(): void;
  flushHeaders?(): void;
}
type Next = (err?: unknown) => void;
type Handler = (req: Req, res: Res, next: Next) => void | Promise<void>;

interface RouterLike {
  get(path: string, ...handlers: Handler[]): unknown;
  post(path: string, ...handlers: Handler[]): unknown;
  use(...args: unknown[]): unknown;
}

/**
 * The subset of the express module we need, injected to avoid a hard import.
 *
 * `R` is inferred from the caller's own express, so the router this factory
 * returns is typed as express's real `Router` and drops straight into
 * `app.use()` without a cast.
 */
export interface ExpressLike<R = unknown> {
  Router(): R;
  json(options?: { limit?: number | string }): unknown;
}

const noopLogger: Logger = { error: () => {}, warn: () => {}, debug: () => {} };

function resolve(config: BackendConfig) {
  return {
    store: config.store,
    apiKeys: config.apiKeys ?? [],
    queryAuth: config.queryAuth,
    allowRegexFilters: config.allowRegexFilters ?? BACKEND_DEFAULTS.allowRegexFilters,
    defaultTzOffsetMin: config.defaultTzOffsetMin ?? BACKEND_DEFAULTS.defaultTzOffsetMin,
    maxEventsPerRequest: config.maxEventsPerRequest ?? BACKEND_DEFAULTS.maxEventsPerRequest,
    maxBodyBytes: config.maxBodyBytes ?? BACKEND_DEFAULTS.maxBodyBytes,
    maxStreamConnections: config.maxStreamConnections ?? BACKEND_DEFAULTS.maxStreamConnections,
    minIdLength: config.minIdLength ?? BACKEND_DEFAULTS.minIdLength,
    amplitudeCompat: config.amplitudeCompat ?? BACKEND_DEFAULTS.amplitudeCompat,
    logger: config.logger ?? noopLogger,
  };
}

type Resolved = ReturnType<typeof resolve>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function wrap(handler: Handler): Handler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Builds the router.
 *
 * `express` is passed in rather than imported, so installing this package for
 * its analysis engine alone never pulls express into the dependency graph.
 */
export function createEventAnalyzerRouter<R>(express: ExpressLike<R>, config: BackendConfig): R {
  const cfg = resolve(config);
  const router = express.Router() as unknown as RouterLike;
  const startedAt = Date.now();
  const seenInsertIds = new Set<string>();
  const streams = new Set<Res>();

  if (!cfg.queryAuth) {
    // /query, /meta, /export and /stream expose every event in the store.
    cfg.logger.warn(
      'event-analyzer: no `queryAuth` configured. /query, /meta, /export and /stream ' +
        'expose every event in the store to anyone who can reach them.',
    );
  }

  router.use(express.json({ limit: cfg.maxBodyBytes }) as Handler);

  const requireWriteKey: Handler = (req, res, next) => {
    if (cfg.apiKeys.length === 0) return next();
    const header = req.headers?.['x-ea-key'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided === 'string' && cfg.apiKeys.includes(provided)) return next();
    res.status(401).json({ code: 401, error: 'missing or invalid X-EA-Key' });
  };

  const requireQueryAuth: Handler = cfg.queryAuth
    ? (cfg.queryAuth as Handler)
    : (_req, _res, next) => next();

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  router.post('/collect', requireWriteKey, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { events?: unknown; api_key?: unknown };
    const raw = body.events;
    if (!Array.isArray(raw)) {
      res.status(400).json({ code: 400, error: '`events` must be an array' });
      return;
    }
    if (raw.length > cfg.maxEventsPerRequest) {
      res.status(413).json({
        code: 413,
        error: `batch exceeds maxEventsPerRequest (${cfg.maxEventsPerRequest})`,
      });
      return;
    }

    const candidates = cfg.amplitudeCompat
      ? raw.map((r) => normalizeAmplitudeEvent(r as Record<string, unknown>))
      : raw;

    const { accepted, issues } = validateBatch(candidates, {
      minIdLength: cfg.minIdLength,
      seen: seenInsertIds,
    });
    // Bound the dedupe window so memory does not grow without limit.
    if (seenInsertIds.size > BACKEND_DEFAULTS.dedupeWindow * 2) {
      const keep = [...seenInsertIds].slice(-BACKEND_DEFAULTS.dedupeWindow);
      seenInsertIds.clear();
      for (const id of keep) seenInsertIds.add(id);
    }

    if (accepted.length > 0) {
      await cfg.store.append(accepted);
      broadcast(streams, accepted);
    }

    const payloadSize = JSON.stringify(req.body ?? {}).length;

    // A batch rejected purely as duplicates is a successful no-op, not a client
    // error. This is exactly the retry-after-timeout case insert_id exists for:
    // the server already has the events, so reporting 400 would make the SDK
    // surface a failure for work that actually succeeded.
    const realIssues = issues.filter((i) => i.kind !== 'duplicate');
    if (accepted.length === 0 && realIssues.length > 0) {
      res.status(400).json({
        code: 400,
        error: 'no valid events in batch',
        ...toRejectionMap(issues),
      });
      return;
    }

    res.status(200).json({
      code: 200,
      events_ingested: accepted.length,
      events_rejected: issues.length,
      payload_size_bytes: payloadSize,
      server_upload_time: Date.now(),
      ...(issues.length > 0 ? { rejected: toRejectionMap(issues) } : {}),
    });
  }));

  router.post('/identify', requireWriteKey, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { identification?: unknown };
    const list = asArray(body.identification as Record<string, unknown> | Record<string, unknown>[]);
    const events: AnalyticsEvent[] = list.map((id) => ({
      event_type: '$identify',
      user_id: id.user_id as string | undefined,
      device_id: id.device_id as string | undefined,
      user_properties: id.user_properties as AnalyticsEvent['user_properties'],
      groups: id.groups as AnalyticsEvent['groups'],
      context: id.context as AnalyticsEvent['context'],
    }));

    const { accepted, issues } = validateBatch(events, { minIdLength: cfg.minIdLength });
    if (accepted.length > 0) await cfg.store.append(accepted);
    res.status(accepted.length > 0 || issues.length === 0 ? 200 : 400).json({
      code: accepted.length > 0 || issues.length === 0 ? 200 : 400,
      identifications_applied: accepted.length,
      ...(issues.length > 0 ? { rejected: toRejectionMap(issues) } : {}),
    });
  }));

  router.post('/group-identify', requireWriteKey, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { identification?: unknown };
    const list = asArray(body.identification as Record<string, unknown> | Record<string, unknown>[]);
    const events: AnalyticsEvent[] = list.map((id) => ({
      event_type: '$groupidentify',
      // Group identifies carry no user, so the group value stands in as the key.
      device_id: `group:${String(id.group_type)}:${String(id.group_value)}`,
      groups: { [String(id.group_type)]: String(id.group_value) },
      group_properties: id.group_properties as AnalyticsEvent['group_properties'],
    }));

    const { accepted, issues } = validateBatch(events, { minIdLength: 1 });
    if (accepted.length > 0) await cfg.store.append(accepted);
    res.status(200).json({
      code: 200,
      identifications_applied: accepted.length,
      ...(issues.length > 0 ? { rejected: toRejectionMap(issues) } : {}),
    });
  }));

  router.post('/alias', requireWriteKey, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { mapping?: unknown };
    const list = asArray(body.mapping as UserAlias | UserAlias[]).filter(
      (m) => typeof m?.user_id === 'string',
    );
    if (!isAliasCapable(cfg.store)) {
      res.status(501).json({ code: 501, error: 'store does not support aliases' });
      return;
    }
    await cfg.store.appendAliases(list);
    res.status(200).json({ code: 200, aliases_applied: list.length });
  }));

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  router.post('/query/:kind', requireQueryAuth, wrap(async (req, res) => {
    const kind = req.params?.kind as QueryKind | undefined;
    if (!kind || !QUERY_KINDS.includes(kind)) {
      res.status(404).json({ code: 404, error: `unknown query kind "${String(kind)}"` });
      return;
    }

    const q = (req.body ?? {}) as Record<string, unknown> & { range?: { from: number; to: number } };
    if (!q.range || typeof q.range.from !== 'number' || typeof q.range.to !== 'number') {
      res.status(400).json({ code: 400, error: '`range` with numeric `from` and `to` is required' });
      return;
    }
    if (!cfg.allowRegexFilters && JSON.stringify(q).includes('"regex"')) {
      // Untrusted regex compiled from a request body is a DoS vector.
      res.status(400).json({ code: 400, error: 'regex filters are disabled' });
      return;
    }
    if (q.tzOffsetMin === undefined) q.tzOffsetMin = cfg.defaultTzOffsetMin;

    const events = await cfg.store.query(q.range);
    const aliases = isAliasCapable(cfg.store) ? await cfg.store.aliases() : [];
    // Built once per query and passed into the analysis, so device-to-user
    // resolution is paid for once rather than per chart.
    const ids = buildIdentityGraph(events, aliases);
    const opts = { allowRegex: cfg.allowRegexFilters };

    switch (kind) {
      case 'segmentation':
        res.json(segmentation(events, q as unknown as SegmentationQuery, ids, opts));
        return;
      case 'funnel':
        res.json(funnel(events, q as unknown as FunnelQuery, ids, opts));
        return;
      case 'retention':
        res.json(retention(events, q as unknown as RetentionQuery, ids, opts));
        return;
      case 'cohort':
        res.json(buildCohort(events, q as unknown as CohortQuery, ids, opts));
        return;
      case 'sessions':
        res.json(sessionStats(events, q as unknown as SessionQuery, ids, opts));
        return;
    }
  }));

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  router.get('/meta', requireQueryAuth, wrap(async (_req, res) => {
    const meta = await cfg.store.meta();
    res.json({
      eventTypes: meta.eventTypes.map((event_type) => ({ event_type })),
      propertyKeys: meta.propertyKeys,
      groupTypes: meta.propertyKeys.filter((p) => p.scope === 'group').map((p) => p.key),
      oldest: meta.oldest,
      newest: meta.newest,
      totalEvents: meta.totalEvents,
    });
  }));

  router.get('/export', requireQueryAuth, wrap(async (req, res) => {
    const from = Number(req.query?.from ?? 0);
    const to = Number(req.query?.to ?? Date.now());
    const events = await cfg.store.query({ from, to });

    // NDJSON rather than a zip: streaming is better when you control both ends,
    // and the output replays straight back into /collect.
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (const ev of events) res.write(JSON.stringify(ev) + '\n');
    res.end();
  }));

  router.get('/stream', requireQueryAuth, (req, res) => {
    if (streams.size >= cfg.maxStreamConnections) {
      res.status(503).json({ code: 503, error: 'too many stream connections' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    streams.add(res);

    // A heartbeat comment defeats proxy idle timeouts.
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        streams.delete(res);
      }
    }, BACKEND_DEFAULTS.heartbeatMs);

    req.on?.('close', () => {
      clearInterval(heartbeat);
      streams.delete(res);
    });
  });

  router.get('/health', wrap(async (_req, res) => {
    const meta = await cfg.store.meta();
    res.json({
      ok: true,
      store: cfg.store.name,
      totalEvents: meta.totalEvents,
      oldest: meta.oldest,
      newest: meta.newest,
      uptimeMs: Date.now() - startedAt,
    });
  }));

  return router as unknown as R;
}

function broadcast(streams: Set<Res>, events: AnalyticsEvent[]): void {
  if (streams.size === 0) return;
  const payload = `event: batch\ndata: ${JSON.stringify({ events, receivedAt: Date.now() })}\n\n`;
  for (const res of streams) {
    try {
      res.write(payload);
    } catch {
      streams.delete(res);
    }
  }
}

export type { Resolved as ResolvedBackendConfig };
