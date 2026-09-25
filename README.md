<h1 align="center">Event Analyzer</h1>

<p align="center">
  <strong>Self-hosted product analytics you install with npm.</strong><br>
  Funnels, retention and cohorts on your own server. Zero runtime dependencies.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@gagandeep023/event-analyzer"><img alt="npm" src="https://img.shields.io/npm/v/@gagandeep023/event-analyzer?color=64ffda&label=npm"></a>
  <img alt="dependencies" src="https://img.shields.io/badge/runtime%20deps-0-64ffda">
  <img alt="tests" src="https://img.shields.io/badge/tests-472-64ffda">
  <img alt="types" src="https://img.shields.io/badge/types-included-64ffda">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-64ffda">
</p>

<p align="center">
  <a href="https://analytics.gagandeep023.com"><strong>Live demo and guide →</strong></a>
</p>

---

```bash
npm i @gagandeep023/event-analyzer
```

Nothing else is installed. `express`, `react` and `react-dom` are **optional**
peers, so pulling this in for the analysis engine alone adds exactly one package
to your tree. Charts are hand-rolled SVG; there is no charting library.

---

## Why this exists

Hosted analytics gives you good tooling and takes your users' behaviour off your
server in exchange. This gives you the tooling and keeps the data on disk.

| | |
|---|---|
| **The data stays yours** | Events land as JSONL on your own disk. Nothing is sent anywhere else. |
| **No consent banner** | No third-party cookies, no cross-site tracking, nothing to disclose. |
| **Nothing to outgrow** | Storage is an interface. Start on a file, move to SQLite or Postgres without touching the router. |
| **Correct, not just present** | All three retention measures, incomplete cohorts flagged, partial batch acceptance. Details below. |

---

## Four pieces, use any of them

```
  ./sdk        capture      browser + node, batching, retry, offline queue
  ./backend    collect      express router, validation, pluggable storage
  ./core       analyse      9 analyses: funnels, retention, cohorts, sessions,
                            events, segments, breakdowns, growth, activity
  ./frontend   render       react dashboard: 9 pages, SVG charts, no chart lib
```

### Capture

```ts
import { createClient, Identify, Revenue } from '@gagandeep023/event-analyzer/sdk';

const ea = createClient({
  endpoint: '/api/events/collect',
  apiKey: import.meta.env.VITE_EA_WRITE_KEY,
  autocapture: { pageViews: true, sessions: true },
});

ea.track('Checkout Started', { cart_value: 4200, items: 3 });
ea.identify(new Identify().set('plan', 'pro').add('logins', 1));
ea.revenue(new Revenue().setPrice(29).setProductId('pro_monthly'));
```

Fire-and-forget by default; the promise is there when you need it.

```ts
const { code } = await ea.track('Signup Completed').promise;
```

### Collect

```ts
import express from 'express';
import { createEventAnalyzerRouter, JsonlFileStore }
  from '@gagandeep023/event-analyzer/backend';

app.use('/api/events', createEventAnalyzerRouter(express, {
  store: new JsonlFileStore({ dir: './data/events' }),
  apiKeys: [process.env.EA_WRITE_KEY],   // public: guards /collect
  queryAuth: requireOwner,               // yours:  guards /query and /stream
}));
```

`express` is **passed in, not imported**. That is what keeps it an optional peer:
installing this package for `core` alone never pulls express into your graph.

### Analyse

`core` is pure. Events in, results out, no I/O. Useful on its own against an
array from any database, with no server involved.

```ts
import { funnel, retention, buildIdentityGraph } from '@gagandeep023/event-analyzer/core';

const ids = buildIdentityGraph(events);   // build once, pass into every analysis

funnel(events, {
  steps: [{ event_type: 'Signed Up' }, { event_type: 'Plan Upgraded' }],
  order: 'ordered',
  conversionWindowMs: 30 * 86_400_000,
  countBy: 'uniques',
  range: { from, to },
}, ids);
```

### Render

```tsx
import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
import '@gagandeep023/event-analyzer/frontend/styles.css';

<EventAnalyzerDashboard baseUrl="/api/events" fetcher={authedFetch} />
```

---

## What you actually get to look at

Eight dashboard pages, all from the same event stream:

| Page | Answers |
|---|---|
| **Overview** | Is the product healthy, and where is the biggest drop-off |
| **Audience** | Who is visiting: browser, OS, device, language, and *when* they are here |
| **Pages** | Top paths, traffic channels, referrers, campaigns |
| **Clicks** | What people press, where it takes them, and from which page |
| **Events** | Every event type with counts, unique users, share and change |
| **Funnels** | Step conversion, drop-off, median time per hop, three ordering modes |
| **Retention** | Three measures, cohort grid, plus growth accounting |
| **Live** | Throughput and the raw feed as the collector receives it |

The SDK parses browser, OS and device from the user agent at capture time, pulls
UTM parameters off the URL, and classifies the referrer into a channel, so those
breakdowns work without any extra configuration.

## Three things most reimplementations get wrong

**1. Retention is three different questions.**

| Measure | Retained in period N when | Good for |
|---|---|---|
| `n-day` | Returned on **exactly** day N | Daily habit loops |
| `unbounded` | Returned on day N **or any day after** | Irregular use, most B2B |
| `bracket` | Returned within a custom `[lo, hi]` | Onboarding windows |

They disagree enormously. On this package's own demo data, `n-day` reports about
**a third** of what `unbounded` reports for the same users. Ship only `n-day` and
a healthy weekly-rhythm product looks like it is bleeding users.

**2. A young cohort cannot be measured at Day 30.**

It has not had thirty days to return. Count it in the denominator anyway and your
curve dives at the right-hand edge, which is an artifact of your date range, not a
fact about your product.

Every curve point here carries **its own** `cohortSize`, computed from only the
cohorts with a full N periods of observable data, plus an `incomplete` flag so the
renderer can show uncertainty instead of the engine hiding it.

**3. One bad event should cost you one event.**

`/collect` accepts partially. The response names failures **by array index**, so
the client drops exactly the poison and retries the rest:

```json
{ "code": 200, "events_ingested": 497, "events_rejected": 3,
  "rejected": { "events_with_missing_fields": { "event_type": [12] } } }
```

A batch rejected purely as duplicates returns `200`, not an error. That is the
retry-after-timeout case `insert_id` exists for, and reporting failure there tells
the caller its retry failed when the data actually arrived.

---

## Funnel modes: read this once

```
ordered      steps in order, other events allowed between   ← the intuitive one
unordered    all steps, any order
sequential   steps in order, NO other event between them    ← stricter than it sounds
```

`sequential` is **not** the plain in-order mode. `ordered` is. These names are the
established convention and are kept verbatim, because a same-word-different-meaning
collision is worse than an awkward word.

The conversion window bounds the **whole funnel**, not each hop. The segment filter
applies to the **first step only**.

---

## Security: two trust levels

`/collect`, `/identify`, `/group-identify` and `/alias` are **public by nature**.
Anything running the SDK must reach them, so the write key ships in your client
bundle and is not a secret.

`/query/*`, `/meta`, `/export` and `/stream` expose **every event in the store**
and need real authentication via `queryAuth`. The router warns at startup when it
is missing, but it cannot supply one for you.

Other defaults chosen on the cautious side:

- **Autocapture is entirely off.** Capturing tracking you did not ask for is how
  people ship surprise data collection.
- **Regex filters are refused** unless enabled. Untrusted regex compiled from a
  request body is a denial-of-service vector.
- **Click capture never reads input values** and never touches a password field.

---

## Documentation

| | |
|---|---|
| [**GUIDE.md**](GUIDE.md) | Usage: capture, serve, analyse, render. Ships in the tarball. |
| [docs/](docs/) | Design: 12 documents covering architecture, API, algorithms, tests, risks |
| [Live guide](https://analytics.gagandeep023.com) | The same material, rendered, with a working dashboard behind it |

---

## Try it

```bash
git clone https://github.com/Gagandeep023/event-analyzer.git
cd event-analyzer && npm i
npm run demo     # seeds 90 days of data, prints a curl for every endpoint
```

---

## Known limits

- `JsonlFileStore` scans the files overlapping a range per query. Comfortable to a
  few million events; a SQLite store is the v0.2 answer.
- A fixed `tzOffsetMin` cannot express a DST transition mid-range.
- `/export` materialises the range before streaming, so keep export windows bounded.
- Journey paths, taxonomy validation and lookup tables are not in v0.1.

## License

MIT
