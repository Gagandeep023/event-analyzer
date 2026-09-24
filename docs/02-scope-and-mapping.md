# 02. Scope and mapping

[Document 01](01-prior-art.md) records the contracts worth adopting. This document decides how much surface to build around them.

## The filter

A hosted analytics platform's API surface is that large because it is a multi-tenant SaaS with enterprise provisioning obligations, data residency law, partner integrations, and usually a separate experimentation product. A self-hosted single-tenant package inherits none of that. Cloning that whole surface would be copying an org chart, not a product.

So every API gets one question:

> **Does this exist because analytics is hard, or because selling analytics to enterprises is hard?**

The first kind we build. The second kind we skip, and the README says so plainly rather than leaving a reader to discover the gap.

## Verdict by API

Legend: **v0.1** ships first, **v0.2** and **v0.3** are scheduled, **skip** is a deliberate no.

### Ingestion

| Reference capability | Verdict | Our equivalent, or the reason not |
|---|---|---|
| HTTP V2 | **v0.1** | `POST /collect`, same payload family, index-addressed errors |
| Batch Event Upload | **v0.1** | Folded into `/collect`. Two endpoints differing only in throttle policy is a SaaS billing artifact. |
| Identify | **v0.1** | `POST /identify`, all ten `$` operations |
| Group Identify | **v0.1** | `POST /group-identify` |
| User Mapping (aliasing) | **v0.1** | Resolved at query time by `core/identity.ts` union-find, plus an explicit `POST /alias` for server-side merges |
| Attribution | **skip** | Exists to receive IDFA/ADID from mobile measurement partners. No self-hosted deployment has partners. |
| AI Feedback | **skip** | It is just an event. `track('AI Feedback', { rating })` covers it. |

### Query

| Reference capability | Verdict | Our equivalent, or the reason not |
|---|---|---|
| Dashboard REST: `events/segmentation` | **v0.1** | `POST /query/segmentation` |
| Dashboard REST: `funnels` | **v0.1** | `POST /query/funnel`, all three modes |
| Dashboard REST: `retention` | **v0.1** | `POST /query/retention`, all three measures, `incomplete` flag included |
| Dashboard REST: `sessions/*` (3 endpoints) | **v0.1** | One `POST /query/sessions` returning histogram, averages and stickiness together |
| Dashboard REST: `users`, `composition` | **v0.1** | Expressible through `/query/segmentation` with a group-by |
| Dashboard REST: `events/list` | **v0.1** | `GET /meta`, which also returns discovered property keys |
| Dashboard REST: `realtime` | **v0.1** | `GET /stream` as SSE, which is live rather than polled |
| Export | **v0.1** | `GET /export`, NDJSON stream rather than a zip. Streaming is strictly better when you control both ends. |
| Dashboard REST: `useractivity`, `usersearch` | **v0.2** | `GET /user/:key` and `GET /users/search` |
| Dashboard REST: `revenue/ltv` | **v0.2** | Revenue fields are captured from v0.1, so this is analysis only |
| Dashboard REST: `chart/:id/csv` | **skip** | Requires a saved-chart concept we do not have |

### Audiences, governance, privacy

| Reference capability | Verdict | Our equivalent, or the reason not |
|---|---|---|
| Behavioral Cohorts | **v0.2** | `core/cohort.ts` exists in v0.1. Saved-cohort CRUD and reuse-as-segment lands in v0.2. |
| Chart Annotations + Releases | **v0.2** | Merged into one `/annotations` resource. Two APIs for "draw a line on a chart" is not a distinction worth keeping. |
| Taxonomy | **v0.3** | Real value, large surface. A tracking plan as a checked-in JSON file validated at ingest beats five CRUD resources for a self-hosted tool. |
| Lookup Table | **v0.3** | Genuinely useful enrichment. Deferred on effort, not merit. |
| User Privacy + CCPA DSAR | **v0.3** | Reduces to delete-by-user-key and export-by-user-key when you own the store. Worth doing properly, not worth an async request/poll/download dance. |
| Channel Classifier | **skip** | Marketing attribution modelling. A different product. |
| User Profile | **skip** | Recommendations and propensity scores are an ML product bolted onto analytics. |

### Platform

| Reference capability | Verdict | Reason |
|---|---|---|
| Session Replay | **skip** | DOM recording, storage and playback is a larger engineering project than this entire package. |
| Event Streaming Metrics | **skip** | Observability for a vendor's own outbound connectors. |
| SCIM, User Management, Audit Logs | **skip** | Multi-tenant identity and RBAC. The host application already owns auth; we take a middleware and get out of the way. |
| Experiment (evaluation + management) | **skip** | Feature flagging is a separate product on a separate host and should stay a separate package. |
| Developer API | **skip** | OAuth device flow for third-party app authorization against a SaaS. |

## The shape that falls out

Eleven endpoints in v0.1, against roughly forty in a hosted platform covering the same functional ground. The reduction is not aggressive. It comes almost entirely from three sources.

**1. Endpoints that differ only by quota.** HTTP V2 and Batch take the same payload and differ only in throttling. Segmentation, composition and active-user counts are the same computation with different defaults. Three session endpoints are three views of one derivation.

**2. Endpoints that exist because the store is not yours.** Asynchronous cohort export (request, poll status, download file) and DSAR output paging are shapes you need when the data sits behind someone else's warehouse. When the store is a file on your own disk, the answer is a streaming response.

**3. Endpoints that are a different product.** Experiment, Session Replay, User Profile recommendations, SCIM.

## Design principles carried over

These are the ideas from prior art worth keeping, and they constrain every later document.

1. **One event shape everywhere.** Ingest, store and export all speak the same object. No internal representation that differs from the wire format, so an exported file replays straight back into `/collect`.

2. **Composable query primitives.** The event / segment / group-by triple, restated as typed `StepSpec` / `Filter[]` / `PropertyRef`. Learn it once, use it across all five analyses.

3. **Idempotency at the edge.** `insert_id` stamped on entry makes every retry safe and dedup trivial.

4. **Partial acceptance.** One bad event in a batch of five hundred costs you one event, and the response says exactly which index failed and why.

5. **Sessions derived, never stored.** `session_id` as a start timestamp removes an entire table and an entire class of drift bug.

6. **Flag incompleteness, do not hide it.** Retention cells carry `incomplete`; the renderer greys them rather than the engine silently dropping them.

7. **Analysis is a pure function.** Events in, result out, no I/O. This is what makes the engine independently useful and exhaustively testable, and it is the part of the package genuinely worth publishing.

## Things we deliberately do differently

| Convention | This package | Why |
|---|---|---|
| Autocapture partly on by default | Everything off by default | Capturing tracking a developer did not ask for is how people ship surprise data collection. For a self-hosted tool the honest default is nothing. |
| Query parameters in the URL query string | JSON request bodies on `POST` | Funnel specs are nested objects with step filters and exclusions. Flattening them into a query string is lossy and unreadable. |
| Export as a zipped archive | NDJSON stream | Streaming is better when you control both ends, and it makes round-trip replay trivial. |
| Session start and end derived server-side | Same | This one they got right. |
| Separate Annotations and Releases APIs | One `/annotations` resource | Same concept with different metadata. |
| `flushIntervalMillis` 1,000 | 5,000 | A self-hosted collector is not billing per request. Fewer, larger batches are cheaper for everyone. |
