# event-analyzer guide

Self-hosted product analytics. Capture SDK, Express ingestion, a zero-dependency
analysis engine, and a React dashboard.

```bash
npm i @gagandeep023/event-analyzer
```

Nothing is installed alongside it. `express`, `react`, `react-dom` and `recharts`
are optional peers, so installing this package for its analysis engine alone
pulls in nothing.

---

## 1. Capture

```ts
import { createClient, Identify, Revenue } from '@gagandeep023/event-analyzer/sdk';

const ea = createClient({
  endpoint: 'https://example.com/api/events/collect',
  apiKey: process.env.EA_WRITE_KEY,
});

ea.track('Checkout Started', { cart_value: 4200, items: 3 });

ea.setUserId('u_10231');
ea.identify(new Identify().set('plan', 'pro').add('logins', 1));
ea.revenue(new Revenue().setPrice(29).setProductId('pro_monthly'));
```

Every tracking call returns `{ promise }` synchronously. Ignoring it is the
normal path; await it when you need to know the event landed before navigating
away.

```ts
const result = await ea.track('Signup Completed').promise;
// { code: 200, message: 'success', event: { ... } }
```

### Configuration

| Option | Default | Notes |
|---|---|---|
| `endpoint` | required | Where batches are POSTed |
| `apiKey` | none | Sent as `X-EA-Key`. Not a secret. |
| `flushIntervalMillis` | `5000` | |
| `flushQueueSize` | `30` | Flush immediately at this depth |
| `flushMaxRetries` | `5` | Then the event is dropped |
| `sessionTimeoutMs` | `1800000` | 30 minutes |
| `transport` | `auto` | `fetch`, `beacon`, `node`, or your own |
| `storage` | `auto` | `localStorage` in a browser, memory in Node |
| `optOut` | `false` | Drops everything at the `before` stage |
| `offline` | `false` | Queue but never flush |
| `autocapture` | all off | See below |

### Autocapture

Everything defaults to **off**.

```ts
createClient({
  endpoint,
  autocapture: {
    pageViews: true,
    sessions: true,
    clicks: { cssSelectorAllowlist: ['a', 'button', '[data-ea-track]'] },
  },
});
```

Click capture records tag name, the matched selector, text truncated to 128
characters, and `data-ea-*` attributes. It never records input values and never
reads anything inside a password field.

### Node

```ts
const ea = createClient({
  endpoint: process.env.EA_ENDPOINT!,
  apiKey: process.env.EA_WRITE_KEY,
  transport: 'node',
  storage: 'memory',
});
process.on('beforeExit', () => ea.flush());
```

### Plugins

```ts
await ea.add({
  name: 'tenant',
  execute: (event) => ({
    ...event,
    event_properties: { ...event.event_properties, tenant: currentTenant() },
  }),
});
```

Three types run in order: `before`, `enrichment` (the default), `destination`.
Returning `null` drops the event.

---

## 2. Serve

```ts
import express from 'express';
import { createEventAnalyzerRouter, JsonlFileStore } from '@gagandeep023/event-analyzer/backend';

const app = express();

app.use('/api/events', createEventAnalyzerRouter(express, {
  store: new JsonlFileStore({ dir: './data/events' }),
  apiKeys: [process.env.EA_WRITE_KEY!],
  queryAuth: requireAdmin,
  defaultTzOffsetMin: 330,
}));
```

> **`express` is passed in, not imported.** That is what keeps it an optional
> peer: installing this package for `core` alone never pulls express into your
> dependency graph.

### Two trust levels

`/collect`, `/identify`, `/group-identify` and `/alias` are public by nature.
Anything running the SDK must reach them, so `apiKeys` is a filter against
casual noise, not a secret.

`/query/*`, `/meta`, `/export` and `/stream` expose **every event in the store**
and must be guarded by `queryAuth`. The router warns at startup when it is
missing, but it cannot supply one for you.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/collect` | Ingest a batch |
| `POST` | `/identify` | User properties, no event emitted |
| `POST` | `/group-identify` | Group properties |
| `POST` | `/alias` | Merge one user key into another |
| `POST` | `/query/segmentation` | Counts over time |
| `POST` | `/query/funnel` | Conversion and drop-off |
| `POST` | `/query/retention` | Curve plus cohort table |
| `POST` | `/query/cohort` | Users matching a behavioural definition |
| `POST` | `/query/sessions` | Session stats and stickiness |
| `GET` | `/meta` | Discovered event types and property keys |
| `GET` | `/export` | Raw events as NDJSON |
| `GET` | `/stream` | Live feed over SSE |
| `GET` | `/health` | Unauthenticated probe |

### Partial acceptance

One malformed event costs you one event. The response names failures by index:

```json
{ "code": 200, "events_ingested": 497, "events_rejected": 3,
  "rejected": { "events_with_missing_fields": { "event_type": [12] },
                "events_with_invalid_id_lengths": { "user_id": [40, 41] } } }
```

A batch rejected purely as duplicates returns `200` with `events_ingested: 0`.
A duplicate is a successful no-op, not an error: it is exactly the
retry-after-timeout case `insert_id` exists for.

### Storage

```ts
interface EventStore {
  append(events: AnalyticsEvent[]): Promise<void>;
  query(range: TimeRange, filters?: Filter[]): Promise<AnalyticsEvent[]>;
  count(range?: TimeRange): Promise<number>;
  meta(): Promise<StoreMeta>;
}
```

`MemoryStore` for tests and demos, `JsonlFileStore` for single-node
self-hosting. The interface is exported so SQLite or Postgres can drop in.

### Migrating from Amplitude

```ts
createEventAnalyzerRouter(express, { store, amplitudeCompat: true });
```

`/collect` then also accepts Amplitude's payload shape: flat device and geo
fields fold into `context`, `productId`/`revenueType` fold into `revenue`. Point
an existing Amplitude SDK at this URL and it works.

---

## 3. Analyse

`core` is pure: events in, results out, no I/O. Useful on its own against an
array from any database.

```ts
import { funnel, retention, buildIdentityGraph } from '@gagandeep023/event-analyzer/core';

const ids = buildIdentityGraph(events);   // build once, pass into every analysis

const conversion = funnel(events, {
  steps: [{ event_type: 'Signed Up' }, { event_type: 'Plan Upgraded' }],
  order: 'ordered',
  conversionWindowMs: 30 * 86_400_000,
  countBy: 'uniques',
  range: { from, to },
}, ids);
```

### Funnel modes

Amplitude's vocabulary, kept verbatim so a migrated query means the same thing.

| Mode | Meaning |
|---|---|
| `ordered` | In order. Other events permitted between steps. |
| `unordered` | All steps, any order. |
| `sequential` | In order with **no other event** between two steps. |

`sequential` is not the intuitive plain in-order mode. `ordered` is.

The conversion window bounds the **whole funnel**, not each hop. The segment
filter applies to the **first step only**.

### Retention measures

| Measure | Retained in period N when |
|---|---|
| `n-day` | Returned on **exactly** period N |
| `unbounded` | Returned on period N **or any period after** |
| `bracket` | Returned within a custom `[lo, hi]` |

Amplitude's own research found `n-day` understates returning users by roughly
3.5x against `unbounded`. On this package's own demo data the gap is about 3x.
Shipping only `n-day` is the usual way a retention implementation is quietly
wrong.

Every curve point carries its **own** `cohortSize`, computed from only those
cohorts with a full N periods of observable data, plus an `incomplete` flag. A
cohort that started yesterday cannot fairly be measured at Day 30, and counting
it in the denominator would drive the whole curve toward zero.

### Timezones

Bucketing is a correctness decision, not a formatting one. "Day 1 retention"
means a calendar day boundary in someone's timezone, and bucketing in UTC when
users are in IST shifts every cohort by five and a half hours.

Every query accepts `tzOffsetMin`. The model is a fixed offset, so it cannot
express a zone whose offset changes partway through a range.

### Sessions

Derived, never stored. A session is one user's events sharing a `session_id`,
which is itself the session's start timestamp. Where `session_id` is absent, as
with a server-side SDK, sessions are reconstructed from inactivity gaps.

---

## 4. Render

```tsx
import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
import '@gagandeep023/event-analyzer/frontend/styles.css';

<EventAnalyzerDashboard
  baseUrl="/api/events"
  fetcher={authedFetch}
  panels={['events', 'funnel', 'retention', 'sessions', 'cohort', 'live']}
/>
```

Theme by overriding custom properties on `.ea-root`:

```css
.ea-root {
  --ea-bg: #0a0a0a;
  --ea-surface: #121212;
  --ea-accent: #64ffda;
  --ea-radius: 10px;
}
```

---

## 5. Try it

```bash
git clone https://github.com/Gagandeep023/event-analyzer.git
cd event-analyzer && npm i
npm run demo
```

Seeds 90 days of deterministic synthetic data and prints a curl command for
every endpoint.

---

## Known limits

- `JsonlFileStore` scans the files overlapping a range on every query. Fine to a
  few million events; a SQLite store is the v0.2 answer.
- A fixed `tzOffsetMin` cannot express a DST transition mid-range.
- `/export` materialises the range before streaming it, so keep export windows
  bounded.
- Journey paths, taxonomy validation and lookup tables are not in v0.1.

## License

MIT
