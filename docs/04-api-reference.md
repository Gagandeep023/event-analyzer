# 04. HTTP API reference

The complete HTTP surface of `@gagandeep023/event-analyzer`. Eleven endpoints in v0.1.

All paths are relative to wherever the router is mounted. Examples assume `/api/events`.

```ts
import express from 'express';
import { createEventAnalyzerRouter, JsonlFileStore } from '@gagandeep023/event-analyzer/backend';

const app = express();
app.use('/api/events', createEventAnalyzerRouter({
  store: new JsonlFileStore({ dir: './data/events', maxFileMb: 64 }),
  apiKeys: [process.env.EA_WRITE_KEY],
  queryAuth: requireAdmin,
  allowRegexFilters: false,
  defaultTzOffsetMin: 330,
  maxEventsPerRequest: 500,
}));
```

## Endpoint index

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/collect` | write key | Ingest a batch of events |
| `POST` | `/identify` | write key | Update user properties without emitting an event |
| `POST` | `/group-identify` | write key | Update group properties |
| `POST` | `/alias` | write key | Merge one user key into another |
| `POST` | `/query/segmentation` | query auth | Event counts over time |
| `POST` | `/query/funnel` | query auth | Conversion and drop-off |
| `POST` | `/query/retention` | query auth | Retention curve and cohort table |
| `POST` | `/query/cohort` | query auth | Users matching a behavioural definition |
| `POST` | `/query/sessions` | query auth | Session stats and stickiness |
| `GET` | `/meta` | query auth | Discovered event types and property keys |
| `GET` | `/export` | query auth | Raw events as an NDJSON stream |
| `GET` | `/stream` | query auth | Live event feed over SSE |
| `GET` | `/health` | none | Store reachability and counts |

## Two trust levels

`/collect`, `/identify`, `/group-identify` and `/alias` are **public by nature**. Anything running the SDK must reach them, so the write key is not a secret; it is a cheap filter against casual noise.

`/query/*`, `/meta`, `/export` and `/stream` expose **every event in the store** and must be guarded by real authentication. They are configured through a separate `queryAuth` middleware option so the distinction cannot be collapsed by accident. The router logs a warning at startup when `queryAuth` is omitted.

---

# Ingestion

## `POST /collect`

Ingest a batch of events.

**Headers:** `Content-Type: application/json`, `X-EA-Key: <write key>` when `apiKeys` is configured.

### Request

```json
{
  "events": [
    {
      "event_type": "Checkout Started",
      "user_id": "u_10231",
      "device_id": "d_9f2ac41e",
      "time": 1758700000000,
      "session_id": 1758699400000,
      "insert_id": "5f0a2c1e-1f3b-4c8a-9a11-6b2d7f0e4a33",
      "event_properties": { "cart_value": 4200, "items": 3 },
      "user_properties": { "$set": { "plan": "pro" }, "$add": { "checkouts": 1 } },
      "groups": { "org": "acme" },
      "context": {
        "platform": "web",
        "app_version": "2.4.1",
        "os_name": "Chrome",
        "os_version": "141",
        "language": "en-IN",
        "page_url": "https://example.com/checkout",
        "referrer": "https://google.com",
        "library": "event-analyzer-sdk/0.1.0"
      },
      "revenue": {
        "price": 29, "quantity": 1, "product_id": "pro_monthly",
        "revenue_type": "purchase", "currency": "USD"
      }
    }
  ]
}
```

### Field rules

| Field | Required | Rule |
|---|---|---|
| `event_type` | yes | Non-empty string, under 256 characters |
| `user_id` / `device_id` | one of | At least `minIdLength` characters, default 5 |
| `time` | no | Finite ms epoch, not before 2000-01-01, not more than 24h in the future. Server fills it when absent. |
| `session_id` | no | Ms epoch marking session start |
| `insert_id` | no | Idempotency key. Server generates one when absent. |
| `event_properties` | no | Object, depth under 40, string values truncated at 1024 with a warning |
| `user_properties` | no | Object, may use the `$` operations |
| `groups` | no | `Record<string, string \| string[]>` |
| `context` | no | See the context block above |
| `revenue` | no | `revenue` computed as `price * quantity` when absent |

### Response: 200, full or partial success

```json
{
  "code": 200,
  "events_ingested": 497,
  "events_rejected": 3,
  "payload_size_bytes": 84213,
  "server_upload_time": 1758700000123,
  "rejected": {
    "events_with_missing_fields":     { "event_type": [12] },
    "events_with_invalid_id_lengths": { "user_id": [40, 41] }
  }
}
```

Partial success is still success. A single malformed event never costs the caller the other 499.

### Response: 400, nothing acceptable

```json
{
  "code": 400,
  "error": "no valid events in batch",
  "events_with_missing_fields":     { "event_type": [0, 1] },
  "events_with_invalid_fields":     { "time": [2] },
  "events_with_invalid_id_lengths": { "device_id": [3] }
}
```

### Other responses

| Code | Meaning | Client action |
|---|---|---|
| `401` | Missing or wrong `X-EA-Key` | Fix the key. Do not retry. |
| `413` | Body exceeds `maxBodyBytes` | Split the batch in half and retry both |
| `429` | Rate limited | Back off 30s |
| `500` | Store write failed | Retry with the same `insert_id` |

### Amplitude compatibility mode

When `amplitudeCompat: true` is set on the router, `/collect` additionally accepts Amplitude's own payload shape: `{ api_key, events, options }` with flat device and geo fields on each event. Incoming events are normalised into our shape (flat fields folded into `context`, revenue fields folded into `revenue`) before validation. This makes the package a drop-in for a codebase already sending to Amplitude.

---

## `POST /identify`

Update user properties without emitting an event. Like Amplitude's Identify API, these calls do not count as events and have no effect on active-user counts.

```json
{
  "identification": [
    {
      "user_id": "u_10231",
      "user_properties": {
        "$set":      { "plan": "pro", "seats": 12 },
        "$setOnce":  { "signup_source": "blog" },
        "$add":      { "logins": 1 },
        "$append":   { "features_used": "export" },
        "$unset":    { "trial_ends": "-" }
      }
    }
  ]
}
```

### Supported operations

| Operation | Effect | Notes |
|---|---|---|
| `$set` | Overwrite | Bare keys outside any operation are treated as `$set` |
| `$setOnce` | Write only if absent | |
| `$add` | Numeric increment | Non-numeric current value is a no-op, never `NaN` |
| `$append` | Push to end of list | Scalar current value is promoted to a single-element array |
| `$prepend` | Unshift to front | Same promotion rule |
| `$preInsert` | Unshift if not present | Set semantics |
| `$postInsert` | Push if not present | Set semantics |
| `$remove` | Delete a value from a list | |
| `$unset` | Delete the key | |
| `$clearAll` | Delete every user property | Invalidates all other operations in the same object |

### Merge precedence

Applied in this order: `$clearAll`, `$unset`, `$setOnce`, `$set`, list operations, `$add`.

`$add` runs last so an increment lands on top of a `$set` in the same payload rather than being overwritten by it.

**Response:** `{ "code": 200, "identifications_applied": 1 }`

---

## `POST /group-identify`

```json
{
  "identification": [
    {
      "group_type": "org",
      "group_value": "acme",
      "group_properties": { "$set": { "seats": 40, "plan": "enterprise" } }
    }
  ]
}
```

Supports `$set`, `$setOnce`, `$add`, `$append`, `$prepend`, `$unset`. Deliberately narrower than user properties, matching Amplitude.

Limits: 5 group types, 10 groups per event.

---

## `POST /alias`

Merge one user key into another, for cases where the union-find resolution in `core/identity.ts` cannot infer the link from event data alone.

```json
{ "mapping": [ { "user_id": "u_10231", "global_user_id": "u_primary_88", "unmap": false } ] }
```

Aliases are stored alongside events and seeded into the identity graph at query time.

---

# Query

All query endpoints are `POST` with a JSON body. Funnel and retention specifications are nested objects; flattening them into a query string would be lossy and unreadable.

## Shared request shapes

Every query composes from the same primitives, a typed restatement of Amplitude's `e` / `s` / `g` triple.

```ts
interface TimeRange { from: number; to: number; }   // ms epoch, [from, to)

type Granularity = 'hour' | 'day' | 'week' | 'month';

type PropertyScope = 'event' | 'user' | 'context' | 'group';

interface PropertyRef { scope: PropertyScope; key: string; }   // key is a dot path

type FilterOp =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'exists' | 'not_exists'
  | 'regex';

interface Filter { property: PropertyRef; op: FilterOp; value?: unknown; }

interface StepSpec {
  event_type: string | '*';     // '*' matches any event
  filters?: Filter[];
  label?: string;
}
```

Every query body also accepts `tzOffsetMin`, falling back to the router's `defaultTzOffsetMin`, then to 0.

### Filter semantics

- `exists` and `not_exists` are the only operators for which a missing property is meaningful. Every other operator returns `false` against `undefined`, so a missing property never accidentally satisfies `neq`.
- Comparison operators coerce number-to-number and string-to-string only. Mixed types return `false` rather than relying on JavaScript ordering.
- `regex` is length capped, compiled in a try/catch, and rejected outright when `allowRegexFilters` is `false`, which is the default. Untrusted regex from a request body is a denial-of-service vector.

---

## `POST /query/segmentation`

Event counts over time, optionally grouped and segmented.

### Request

```json
{
  "events": [ { "event_type": "Checkout Started", "label": "Checkouts" } ],
  "countBy": "uniques",
  "granularity": "day",
  "groupBy": { "scope": "context", "key": "platform" },
  "segment": [
    { "property": { "scope": "user", "key": "plan" }, "op": "eq", "value": "pro" }
  ],
  "limitGroups": 10,
  "range": { "from": 1756080000000, "to": 1758758400000 },
  "tzOffsetMin": 330
}
```

`countBy` is `uniques` (distinct resolved users), `totals` (event count), or `average` (totals divided by uniques, returning 0 rather than `NaN` for empty buckets).

### Response

```json
{
  "series": [
    { "label": "web",    "points": [ { "t": 1756080000000, "value": 412 } ], "total": 9821 },
    { "label": "ios",    "points": [ { "t": 1756080000000, "value": 190 } ], "total": 4133 },
    { "label": "Other",  "points": [ { "t": 1756080000000, "value":  22 } ], "total":  501 }
  ],
  "buckets": [1756080000000, 1756166400000],
  "granularity": "day"
}
```

Groups are ranked by total and truncated to `limitGroups`, with the tail summed into an `Other` series so totals still reconcile. Empty buckets are emitted as zeros rather than omitted, so the chart draws a continuous line.

---

## `POST /query/funnel`

### Request

```json
{
  "steps": [
    { "event_type": "Signed Up" },
    { "event_type": "Project Created" },
    { "event_type": "Teammate Invited" },
    { "event_type": "Plan Upgraded" }
  ],
  "order": "ordered",
  "conversionWindowMs": 2592000000,
  "exclusions": [ { "event_type": "Account Deleted" } ],
  "countBy": "uniques",
  "groupBy": { "scope": "context", "key": "platform" },
  "segment": [],
  "range": { "from": 1756080000000, "to": 1758758400000 }
}
```

### Ordering modes

Amplitude's vocabulary, kept verbatim. Note that `sequential` is **not** the intuitive plain in-order mode.

| Mode | Meaning |
|---|---|
| `ordered` | Steps in the given order. Other events are permitted between them. |
| `unordered` | All steps occur within the window, in any order. |
| `sequential` | Steps in the given order with **no other event** between two steps. |

`conversionWindowMs` bounds the whole funnel, not each hop. Default 2,592,000,000 ms (30 days).

`segment` applies to the **first step only**, matching Amplitude. This trips people up, so it is stated in the response metadata too.

### Response

```json
{
  "totalEntered": 12840,
  "totalConverted": 1502,
  "overallConversion": 0.117,
  "medianTotalTimeMs": 385200000,
  "steps": [
    { "index": 0, "label": "Signed Up", "event_type": "Signed Up",
      "count": 12840, "conversionFromStart": 1.0, "conversionFromPrevious": 1.0,
      "dropOff": 0, "dropOffRate": 0,
      "medianTimeFromPreviousMs": null, "p90TimeFromPreviousMs": null },
    { "index": 1, "label": "Project Created", "event_type": "Project Created",
      "count": 7704, "conversionFromStart": 0.6, "conversionFromPrevious": 0.6,
      "dropOff": 5136, "dropOffRate": 0.4,
      "medianTimeFromPreviousMs": 166444, "p90TimeFromPreviousMs": 921003 }
  ],
  "groups": { "web": { "...": "a nested FunnelResult" } }
}
```

Step counts are the number of users reaching depth at least *k*, so counts are monotonically non-increasing by construction. That invariant is asserted in the test suite.

`countBy: "totals"` counts completed attempts rather than users, so one user converting three times contributes three. This is the correct denominator for transactional funnels such as checkout.

---

## `POST /query/retention`

### Request

```json
{
  "startAction":  { "event_type": "Signed Up" },
  "returnAction": { "event_type": "*" },
  "measure": "unbounded",
  "interval": "day",
  "periods": 30,
  "segment": [],
  "range": { "from": 1750982400000, "to": 1758758400000 }
}
```

For bracket retention, replace `periods` with `brackets`:

```json
{ "measure": "bracket", "brackets": [[0, 0], [1, 7], [8, 14], [15, 30]] }
```

### The three measures

| `measure` | A user counts as retained in period N when | Use for |
|---|---|---|
| `n-day` | They returned on **exactly** day N | Products with a daily habit loop |
| `unbounded` | They returned on day N **or any day after** | Irregular usage, most B2B |
| `bracket` | They returned within `[lo, hi]` | Custom windows |

Amplitude's own research found `n-day` understates returning users by roughly 3.5x against `unbounded`. Shipping only `n-day` is the most common way a retention implementation is quietly wrong.

### Response

```json
{
  "measure": "unbounded",
  "interval": "day",
  "totalUsers": 27584,
  "curve": [
    { "period": 0, "label": "Day 0",  "cohortSize": 27584, "retained": 27584, "rate": 1.0,
      "incomplete": false },
    { "period": 1, "label": "Day 1",  "cohortSize": 27584, "retained": 19310, "rate": 0.700,
      "incomplete": false },
    { "period": 30,"label": "Day 30", "cohortSize": 12864, "retained": 1561,  "rate": 0.121,
      "incomplete": true }
  ],
  "table": [
    { "cohortStart": 1750982400000, "cohortLabel": "2025-06-27", "cohortSize": 12864,
      "cells": [
        { "period": 0, "retained": 12864, "rate": 1.0,   "incomplete": false },
        { "period": 1, "retained": 9061,  "rate": 0.704, "incomplete": false }
      ] }
  ]
}
```

### The correctness rule

A cohort is only eligible for period N if the range actually extends N periods past that cohort's start. Counting a cohort that started yesterday in the denominator of Day 30 retention drives the whole curve toward zero.

Each curve point therefore carries **its own** `cohortSize`, computed from only those cohorts with a full N periods of observable data, and an `incomplete` flag. The renderer greys incomplete cells rather than the engine silently dropping them. Both the behaviour and the field name are taken from Amplitude.

Period 0 is always 1.0 by definition, since the start event is itself in the window, and is included so the curve has an anchor.

---

## `POST /query/cohort`

Users matching a behavioural definition.

```json
{
  "did": [
    { "step": { "event_type": "Project Created" }, "atLeast": 3 },
    { "step": { "event_type": "Teammate Invited" } }
  ],
  "didNot": [ { "event_type": "Plan Upgraded" } ],
  "withinMs": 1209600000,
  "userFilters": [
    { "property": { "scope": "user", "key": "plan" }, "op": "eq", "value": "free" }
  ],
  "range": { "from": 1756080000000, "to": 1758758400000 }
}
```

`withinMs` is measured from each user's own first matching event, not from the range start.

### Response

```json
{
  "size": 431,
  "totalUsersInRange": 12840,
  "share": 0.0336,
  "userIds": ["u_10231", "u_10444"],
  "definition": { "...": "the query echoed back" }
}
```

The user key list is returned so a cohort can be fed straight back into another query as a segment. That reuse is the entire point of the feature.

---

## `POST /query/sessions`

```json
{
  "segment": [],
  "granularity": "day",
  "range": { "from": 1756080000000, "to": 1758758400000 }
}
```

### Response

```json
{
  "totalSessions": 48211,
  "totalUsers": 12840,
  "medianDurationMs": 184000,
  "p90DurationMs": 1420000,
  "meanEventsPerSession": 7.3,
  "durationHistogram": [
    { "bucketLabel": "0-3s",    "lowerMs": 0,    "upperMs": 3000,  "count": 4120 },
    { "bucketLabel": "3-10s",   "lowerMs": 3000, "upperMs": 10000, "count": 2261 }
  ],
  "stickiness": {
    "dau": 1840, "wau": 6120, "mau": 12840,
    "dauOverMau": 0.143, "dauOverWau": 0.301
  },
  "sessionsOverTime": [ { "t": 1756080000000, "sessions": 1622, "users": 890 } ]
}
```

### Session derivation

Sessions are **derived, never stored**. A session is the group of one user's events sharing a `session_id`. Where `session_id` is absent, as with a server-side SDK or a raw HTTP client, sessions are reconstructed by splitting each user's sorted event stream wherever the inter-event gap exceeds `sessionTimeoutMs`.

Histogram bins are Amplitude's defaults, in milliseconds:

```
[0,3k) [3k,10k) [10k,30k) [30k,60k) [60k,180k) [180k,600k) [600k,1.8M) [1.8M,3.6M) [3.6M,86.4M)
```

Session length caps at one day. The bins are deliberately non-linear because session length is heavily right-skewed and linear bins produce one useless spike.

`dau`, `wau` and `mau` are distinct resolved users in trailing 1, 7 and 30 day windows ending at `range.to`.

---

# Utility

## `GET /meta`

Everything the dashboard needs to build a query without free-text entry.

```json
{
  "eventTypes": [
    { "event_type": "Signed Up", "count": 12840, "firstSeen": 1750982400000, "lastSeen": 1758758400000 }
  ],
  "propertyKeys": [
    { "scope": "event",   "key": "cart_value", "types": ["number"], "sampleValues": [4200, 890] },
    { "scope": "user",    "key": "plan",       "types": ["string"], "sampleValues": ["free", "pro"] },
    { "scope": "context", "key": "platform",   "types": ["string"], "sampleValues": ["web", "ios"] }
  ],
  "groupTypes": ["org"],
  "oldest": 1750982400000,
  "newest": 1758758400000,
  "totalEvents": 431022
}
```

Results are cached for the lifetime of the store's generation counter and invalidated on write.

## `GET /export`

Raw events as an NDJSON stream, one JSON object per line.

```
GET /export?from=1756080000000&to=1758758400000
Content-Type: application/x-ndjson
Transfer-Encoding: chunked
```

Optional `filters` as a URL-encoded JSON array. Optional `gzip=1` for `Content-Encoding: gzip`.

NDJSON rather than a zipped archive, because streaming is strictly better when you control both ends and because the output replays directly into `/collect`. That round trip is asserted in the test suite: events collected, exported, and replayed into a second store must produce byte-identical query results.

## `GET /stream`

Server-sent events, live.

```
GET /stream
Content-Type: text/event-stream

event: batch
data: {"events":[{...}],"receivedAt":1758700000123}

: heartbeat
```

- 15-second heartbeat comment to defeat proxy idle timeouts
- Bounded per-connection buffer that drops oldest rather than growing without limit
- Connection count capped and configurable, because an unbounded SSE endpoint is a trivial memory exhaustion target
- Cleanup on `req.on('close')`
- Optional `?types=A,B` filter

## `GET /health`

Unauthenticated, cheap, suitable for a load balancer probe.

```json
{
  "ok": true,
  "store": "JsonlFileStore",
  "totalEvents": 431022,
  "oldest": 1750982400000,
  "newest": 1758758400000,
  "uptimeMs": 82910022
}
```

---

# Error format

Every error response uses the same envelope.

```json
{ "code": 400, "error": "human readable summary", "details": { } }
```

| Code | When |
|---|---|
| `400` | Malformed body, invalid query specification, rejected regex filter |
| `401` | Missing or invalid write key on an ingestion endpoint |
| `403` | `queryAuth` middleware rejected the request |
| `404` | Unknown query kind |
| `413` | Body exceeds `maxBodyBytes` |
| `429` | Rate limited |
| `500` | Store failure or an unexpected error, logged with a correlation id |

The only endpoint whose error body deviates is `/collect`, which returns the index-addressed rejection map described above.
