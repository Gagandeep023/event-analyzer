# 08. Backend

`src/backend/` is an Express router you mount wherever you like, plus a storage interface with two implementations shipped.

The router owns validation, persistence and querying. It owns **no policy about authentication** beyond an optional shared key, because that belongs to the host application.

```
src/backend/
├── index.ts
├── router.ts            createEventAnalyzerRouter(options)
├── validate.ts          index-addressed validation
├── routes/
│   ├── collect.ts       POST /collect, /identify, /group-identify, /alias
│   ├── query.ts         POST /query/:kind
│   ├── meta.ts          GET  /meta
│   ├── export.ts        GET  /export
│   └── stream.ts        GET  /stream
└── stores/
    ├── EventStore.ts    interface
    ├── MemoryStore.ts   bounded ring buffer
    └── JsonlFileStore.ts  append-only, date-rotated
```

The full HTTP contract is in [document 04](04-api-reference.md). This document covers the implementation.

## Mounting

```ts
import express from 'express';
import { createEventAnalyzerRouter, JsonlFileStore } from '@gagandeep023/event-analyzer/backend';

const app = express();
app.use('/api/events', createEventAnalyzerRouter({
  store: new JsonlFileStore({ dir: './data/events', maxFileMb: 64 }),
  apiKeys: [process.env.EA_WRITE_KEY],   // required on /collect when set
  queryAuth: requireAdmin,               // your middleware, guards /query and /stream
  allowRegexFilters: false,
  defaultTzOffsetMin: 330,               // IST
  maxEventsPerRequest: 500,
}));
```

> **Two different trust levels.**
>
> `/collect` is public by nature: anything running the SDK must reach it, so its key is not a secret.
>
> `/query/*`, `/meta`, `/export` and `/stream` expose every event in the store and must be guarded by real authentication.
>
> The router takes them as separate options so the distinction cannot be collapsed by accident, and it logs a warning at startup when `queryAuth` is omitted. It cannot force the host application to supply one, so the README leads with this rather than burying it.

## Validation

A single malformed event must never cost a caller the other 499 in the batch. Validation returns per-index failures and the route partially accepts.

**Checks applied per event:**

| Check | Rule |
|---|---|
| `event_type` | Present, non-empty string, under 256 characters |
| Identity | At least one of `user_id` / `device_id`, each at least `minIdLength` |
| `time` | Finite number, not before 2000-01-01, not more than 24h in the future, or absent |
| Object depth | Under 40 layers |
| String values | Truncated to 1024 characters with a warning, not rejected |

**Server-side stamping:** `server_received_time`, `time` when absent, `insert_id` when absent, and deduplication against recently seen insert ids via a bounded LRU.

Response shapes are documented in [doc 04](04-api-reference.md#post-collect).

## EventStore

```ts
export interface EventStore {
  append(events: AnalyticsEvent[]): Promise<void>;
  query(range: TimeRange, filters?: Filter[]): Promise<AnalyticsEvent[]>;
  count(range?: TimeRange): Promise<number>;
  meta(): Promise<{
    eventTypes: string[];
    propertyKeys: PropertyRef[];
    oldest: number | null;
    newest: number | null;
  }>;
  clear?(): Promise<void>;
  close?(): Promise<void>;
}
```

| Store | Backing | Good for | Limit |
|---|---|---|---|
| `MemoryStore` | Bounded ring buffer | Tests, demos, development | Evicts oldest past `maxEvents`, lost on restart |
| `JsonlFileStore` | Append-only JSONL, date-rotated | Single-node self-hosting | Full scan per query, comfortable to a few million events |

The interface is exported so SQLite or Postgres can be dropped in without touching the router.

### JsonlFileStore implementation notes

- Keeps an in-memory index of `(file, offset, time)` so a range query reads only the files that overlap the range.
- Caches the parsed result of the most recent query, keyed by range plus a filter hash. This is what makes the dashboard's six simultaneous panel requests cost one disk pass rather than six.
- Rotates by date and by `maxFileMb`, whichever comes first.
- Appends are buffered and fsynced on an interval, not per event.
- A generation counter increments on write and invalidates the `/meta` cache.

## /stream

Server-sent events, the same shape as the `api-gateway` dashboard feed:

- `Content-Type: text/event-stream`
- 15-second heartbeat comment to defeat proxy idle timeouts
- Bounded per-connection buffer that drops oldest rather than growing without limit
- Cleanup on `req.on('close')`
- Connection count capped via `maxStreamConnections`, because an unbounded SSE endpoint is a trivial memory exhaustion target

## Query routing

`POST /query/:kind` dispatches to `core`:

```ts
const HANDLERS = {
  segmentation: (events, q, ids) => segmentation(events, q, ids),
  funnel:       (events, q, ids) => funnel(events, q, ids),
  retention:    (events, q, ids) => retention(events, q, ids),
  cohort:       (events, q, ids) => buildCohort(events, q, ids),
  sessions:     (events, q, ids) => sessionStats(events, q, ids),
};
```

The route reads events from the store for the requested range, builds the identity graph **once**, then calls the handler. The backend never computes a funnel itself; that separation is what keeps `core` independently usable.

Unknown `:kind` returns `404`, not `400`, because the path is wrong rather than the body.
