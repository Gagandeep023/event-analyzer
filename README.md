# @gagandeep023/event-analyzer

Self-hosted product analytics as an npm package. Event capture SDK, Express ingestion, a zero-dependency analysis engine that computes funnels, retention and cohorts, and a React dashboard.

Modelled on Amplitude's documented semantics, built from scratch, with no runtime dependencies.

> **Status: planning.** No code written yet. The complete design lives in [`docs/`](docs/). Build starts at [phase 1](docs/10-build-plan.md#phase-1-scaffold-and-types).

## What it will do

```ts
// Capture
import { createClient } from '@gagandeep023/event-analyzer/sdk';
const ea = createClient({ endpoint: '/api/events/collect' });
ea.track('Checkout Started', { cart_value: 4200 });

// Serve
import { createEventAnalyzerRouter, JsonlFileStore } from '@gagandeep023/event-analyzer/backend';
app.use('/api/events', createEventAnalyzerRouter({
  store: new JsonlFileStore({ dir: './data/events' }),
  queryAuth: requireAdmin,
}));

// Analyse, with no server at all
import { funnel, retention } from '@gagandeep023/event-analyzer/core';
const result = retention(myEvents, { measure: 'unbounded', interval: 'day', periods: 30, /* ... */ });

// Render
import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
<EventAnalyzerDashboard baseUrl="/api/events" />
```

## Documentation

| # | Document | Covers |
|---|---|---|
| 01 | [Amplitude API atlas](docs/01-amplitude-api-atlas.md) | Every Amplitude API, catalogued from their full docs corpus |
| 02 | [Scope and mapping](docs/02-scope-and-mapping.md) | What we build, what we skip, and why |
| 03 | [Architecture](docs/03-architecture.md) | Modules, dependency direction, package configuration |
| 04 | [API reference](docs/04-api-reference.md) | Our HTTP surface, in full |
| 05 | [Type contract](docs/05-types.md) | Shared types every module agrees on |
| 06 | [Core engine](docs/06-core-engine.md) | The analysis algorithms |
| 07 | [Capture SDK](docs/07-sdk.md) | Client API, plugin pipeline, delivery |
| 08 | [Backend](docs/08-backend.md) | Router, validation, storage |
| 09 | [Frontend](docs/09-frontend.md) | Dashboard and panels |
| 10 | [Build plan](docs/10-build-plan.md) | Five phases with done criteria |
| 11 | [Test plan](docs/11-test-plan.md) | ~130 specs and two invariants |
| 12 | [Risks and open questions](docs/12-risks.md) | Known weaknesses, decisions outstanding |

## Design in one paragraph

Amplitude publishes roughly 250 API endpoints across seven hosts. Most of that surface exists because Amplitude is a multi-tenant SaaS with enterprise provisioning, data residency law and a separate experimentation product. The filter applied here is one question: does this exist because analytics is hard, or because selling analytics to enterprises is hard? The first kind we build; the second kind we skip and say so. That reduces to eleven endpoints in v0.1 covering the same functional ground as about forty of theirs.

## Three things it gets right that most clones get wrong

**All three retention measures.** `n-day`, `unbounded` and `bracket`. Amplitude's own research found `n-day` understates returning users by roughly 3.5x against `unbounded`. Shipping only `n-day` is the usual way a retention implementation is quietly wrong.

**Incomplete cohorts are flagged, not hidden.** A cohort that started yesterday cannot fairly be measured at Day 30. Every retention cell carries an `incomplete` flag and every curve point carries its own denominator, so the tail is greyed rather than drawn as a cliff that is an artifact of the query window.

**Partial batch acceptance.** One malformed event in a batch of five hundred costs you one event. The `400` body addresses failures by event index, so the client drops only the poison and retries the rest.

## Security note

`/collect` is public by nature; anything running the SDK must reach it. `/query/*`, `/meta`, `/export` and `/stream` expose **every event in the store** and must be guarded by real authentication via the `queryAuth` option. The router warns at startup when it is missing, but it cannot supply one for you.

## License

MIT
