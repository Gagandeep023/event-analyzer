# 01. Amplitude API atlas

Complete catalogue of Amplitude's API surface, taken from their published documentation corpus at `amplitude.com/docs/llms-full.txt` on 2026-09-24. That file is 6.3 MB across 725 pages, of which 89 are API references covering roughly 250 distinct endpoints.

This document exists so that [document 02](02-scope-and-mapping.md) can make an informed choice about what to build. It is a reference, not a plan.

---

## 1. Hosts and authentication

The single most confusing thing about Amplitude's API surface is that it is not one API. Seven hostnames, three authentication schemes, and the host you need depends on which product you are talking to.

| Host | Serves | Auth |
|---|---|---|
| `api2.amplitude.com` | HTTP V2, Batch Event Upload, Identify, Group Identify | `api_key` in request body |
| `api.amplitude.com` | User Mapping, Attribution | `api_key` in query string or body |
| `amplitude.com` | Dashboard REST, Export, Taxonomy, Behavioral Cohorts, Chart Annotations, Releases, Lookup Tables, User Privacy | HTTP Basic, `api_key:secret_key` base64 encoded |
| `profile-api.amplitude.com` | User Profile | Secret key |
| `privacy.amplitude.com` | User Privacy v2 | Org-level key |
| `experiment.amplitude.com` | Experiment evaluation and management | Management API key or deployment key |
| `developer-api.amplitude.com` | Developer API | OAuth 2.0 device authorization flow |

### Regional variants

EU data residency swaps nearly every host:

| Default | EU |
|---|---|
| `api2.amplitude.com` | `api.eu.amplitude.com` |
| `api.amplitude.com` | `api.eu.amplitude.com` |
| `amplitude.com` | `analytics.eu.amplitude.com` |

`analytics.amplitude.com` is the browser web app, not an API host, despite appearing in many third-party code samples.

### Key types

| Product | Key | Public | Rotatable |
|---|---|---|---|
| Analytics | Project API Key | yes | yes |
| Analytics | Project Secret Key | no | yes |
| Experiment | Deployment Key (client-side) | yes | yes |
| Experiment | Deployment Key (server-side) | no | yes |
| Experiment | Management API Key | no | yes |
| Data | API Token | no | yes |
| Other | SCIM Key | no | yes |
| Other | Org-level keys | no | contact support |

---

## 2. Ingestion APIs

### 2.1 HTTP V2 API

`POST https://api2.amplitude.com/2/httpapi`, `Content-Type: application/json`.

```json
{
  "api_key": "...",
  "events": [ { "...": "..." } ],
  "options": { "min_id_length": 5 }
}
```

**Required per event:** `event_type`, plus at least one of `user_id` / `device_id`.

**Full event field list:**

| Group | Fields |
|---|---|
| Identity | `user_id`, `device_id` |
| Time | `time` (ms epoch), `session_id` (ms epoch), `event_id`, `insert_id` |
| Payload | `event_properties`, `user_properties`, `groups`, `group_properties` |
| App | `app_version`, `platform`, `os_name`, `os_version`, `language`, `user_agent` |
| Device | `device_brand`, `device_manufacturer`, `device_model`, `carrier` |
| Geo | `country`, `region`, `city`, `dma`, `location_lat`, `location_lng`, `ip` |
| Revenue | `price`, `quantity` (default 1), `revenue`, `productId`, `revenueType`, `currency` (ISO 4217) |
| Ad IDs | `idfa`, `idfv`, `adid`, `android_id`, `android_app_set_id` |
| Governance | `plan: { branch, source, version }`, `ingestion_metadata`, `partner_id`, `$skip_user_properties_sync` |

**Limits**

- String values: 1,024 characters maximum
- Object depth: 40 layers maximum
- Request: under 1 MB, under 2,000 events
- `user_id` / `device_id`: minimum 5 characters, configurable via `options.min_id_length`
- Free plan: 100 batches/second, 1,000 events/second, recommended 10 events per batch
- Growth and Enterprise: 50,000 events/second project ceiling on HTTP V2, 150,000 on the SDK endpoint
- User property updates throttled at 1,800 per user per hour. Event ingestion is not throttled by this.

**Responses**

`200 OK`

```json
{ "code": 200, "events_ingested": 12, "payload_size_bytes": 4096,
  "server_upload_time": 1396381378123 }
```

`400 Bad Request`, with errors addressed **by event index**:

```json
{ "code": 400, "error": "...", "missing_field": "...",
  "events_with_invalid_fields":     { "time": [2, 5] },
  "events_with_missing_fields":     { "event_type": [0] },
  "events_with_invalid_id_lengths": { "user_id": [7] },
  "silenced_events": [9],
  "throttled_events": [11],
  "eps_threshold": 0,
  "exceeded_daily_quota_devices": { "device_x": 1 },
  "silenced_devices": ["device_y"],
  "throttled_devices": { "device_z": 2 } }
```

`413 Payload Too Large`: split the batch and retry.
`429 Too Many Requests`: pause 30 seconds, then retry. Body lists `throttled_devices`, `throttled_users`, `exceeded_daily_quota_devices`, `exceeded_daily_quota_users`.
`500`, `502`, `503`, `504`: retry. `insert_id` prevents duplication.
`403 Forbidden`: WAF block or sanctioned region.

> The index-addressed `400` is the most valuable design detail in this API. It lets a client drop only the poison events and retry the rest, instead of losing the batch.

### 2.2 Batch Event Upload API

`POST https://api2.amplitude.com/batch`

Identical payload shape to HTTP V2. Differs only in throttling posture:

- Request size limit 20 MB (versus 1 MB)
- Still 2,000 events per batch
- Throttles at 1,000 events/second or 500,000 events/day per device
- Intended for server-side bulk loads where per-device throughput is high

Response bodies: `SuccessSummary`, `InvalidRequestError`, `SilencedDeviceID`, `PayloadTooLargeError`, `TooManyRequestsForDeviceError`.

### 2.3 Identify API

`POST https://api2.amplitude.com/identify`, body `form-data` or `x-www-form-urlencoded`.

| Parameter | Description |
|---|---|
| `api_key` | Project API key |
| `identification` | A single JSON object or an array of them |

Identification object keys: `user_id` (required unless `device_id`), `device_id` (required unless `user_id`), `user_properties`, `groups`, plus the same app/device/geo context fields as HTTP V2.

**Behaviours worth knowing:**

- Calls do **not** count as events. No effect on active-user or new-user definitions, no monthly event volume cost, and they do not appear in Redshift exports.
- Updates are not retroactive. They apply only to future events.
- You can set properties on a user who has never been seen. The values do not appear until that user's next event.
- Changing `user_id` from an existing value creates a new user. Changing it from null does not.
- Dates are compared as strings, so ISO 8601 (`YYYY-MM-DDTHH:mm:ss`) is required for comparisons to work.
- Rate limited at 1,800 property updates per user per hour. Excess updates are dropped; events keep flowing.

**User property operations**, sent as reserved `$`-prefixed keys inside `user_properties`:

| Operation | Effect |
|---|---|
| `$set` | Overwrite the value |
| `$setOnce` | Write only if the key is absent |
| `$add` | Numeric increment. Numbers only. |
| `$append` | Push to the end of a list |
| `$prepend` | Unshift to the front of a list |
| `$preInsert` | Unshift only if the value is not already present |
| `$postInsert` | Push only if the value is not already present |
| `$remove` | Delete a value from a list |
| `$unset` | Delete the key |
| `$clearAll` | Delete every user property |

### 2.4 Group Identify API

`POST https://api2.amplitude.com/groupidentify`

Identification keys: `group_type` (string), `group_value` (string), `group_properties` (object).

Supports `$set`, `$setOnce`, `$add`, `$append`, `$prepend`, `$unset`. Note this is a **narrower** operation set than user properties: no `$preInsert`, `$postInsert`, `$remove` or `$clearAll`.

Limits: 5 unique group types, 10 total groups per event, 1,024 group identifies per request, 1,024 group properties per request, 1 MB per request.

### 2.5 User Mapping (Aliasing) API

`POST https://api.amplitude.com/usermap`

| Parameter | Description |
|---|---|
| `api_key` | API key for any project in the org |
| `mapping` | A single JSON object or an array |

Mapping keys: `user_id` (required), `global_user_id` (required unless unmapping), `unmap` (boolean).

**Semantics:** mapping User 1 into User 2 makes User 2's event stream contain both users' events. User 1 retains only its own. User properties are **not** merged; they stay attached to the originating `user_id`.

Limits: 2,000 requests per batch, 1 MB, 50 events/second over a 30-second window (1,500 alias calls per 30s window).

### 2.6 Attribution API

`POST https://api.amplitude.com/attribution`

Arguments: `api_key`, `event` (JSON).

Event keys: `event_type` (required, conventionally prefixed `[YOUR COMPANY]`), `platform` (required, `ios` or `android`), one of `idfa`/`idfv` for iOS or `adid`/`android_app_set_id` for Android, optional `android_id`, `user_properties`, `time`.

Unmatched attribution events are held for up to 72 hours waiting for a matching user, then dropped.

### 2.7 AI Feedback API

`POST https://amplitude.com/api/1/ai-feedback/ingest`. Narrow, newer endpoint for thumbs up/down signals on AI features.

---

## 3. Dashboard REST API (query)

All `GET`, all HTTP Basic auth, all against `amplitude.com`. Time zone matches the project's configured time zone.

### 3.1 Endpoint list

| Endpoint | Returns |
|---|---|
| `GET /api/2/events/segmentation` | Event counts over time, grouped and segmented |
| `GET /api/2/funnels` | Conversion, drop-off, transition time distributions |
| `GET /api/2/retention` | Retention curve plus per-cohort table |
| `GET /api/2/sessions/length` | Session length histogram |
| `GET /api/2/sessions/average` | Average session length over time |
| `GET /api/2/sessions/peruser` | Average sessions per user |
| `GET /api/2/users` | Active and new user counts |
| `GET /api/2/composition` | User breakdown by a property |
| `GET /api/2/events/list` | Every event type in the project |
| `GET /api/2/useractivity` | One user's raw event stream |
| `GET /api/2/usersearch` | Find a user by user id, device id or Amplitude id |
| `GET /api/2/realtime` | Active users in recent minutes |
| `GET /api/2/revenue/ltv` | Revenue lifetime value curves |
| `GET /api/3/chart/:chart_id/csv` | Results of a saved chart |

### 3.2 Rate limiting: the cost model

```
cost = (number of days) * (number of conditions) * (cost for the query type)
```

Conditions are segments plus conditions within segments. Each group-by counts as 4 segments. Cohorts, `WHERE` clauses, and who-performed filters are conditions; event property filters are not.

| Query type | Cost |
|---|---|
| Event Segmentation | 1 per event, +4 per group-by per event |
| Funnel Analysis | 2 × number of events, +4 per group-by per event |
| Retention Analysis | 8 |
| User Sessions | 4 |
| Everything else | 1 |

Concurrent limit: 5 concurrent requests across all REST endpoints, or 1,000 cost within a five minute window. Rate limit: 108,000 cost per hour. User Activity and User Search have their own pool: 10 concurrent, 360 queries per hour.

### 3.3 The three shared query primitives

Every query endpoint composes from the same three parameters. This is the cleanest idea in the API.

**`e`:** an event, with optional filters and group-by

```json
{
  "event_type": "CompletedProfile",
  "filters": [
    { "subprop_type": "event",
      "subprop_key": "EmailVerified",
      "subprop_op": "is",
      "subprop_value": ["true"] },
    { "subprop_type": "user",
      "subprop_key": "gp:SignUpDate",
      "subprop_op": "is",
      "subprop_value": ["2021-08-18"] }
  ],
  "group_by": [ { "type": "user", "value": "platform" } ]
}
```

Filter operators: `is`, `is not`, `contains`, `does not contain`, `less`, `less or equal`, `greater`, `greater or equal`, `set is`, `set is not`.

**`s`:** segment definitions, a user-level filter

```json
[ { "prop": "country",  "op": "is", "values": ["United States"] },
  { "prop": "gp:gender","op": "is", "values": ["female"] } ]
```

**`s`:** the "who performed" behavioural variant

```json
[ { "type": "event",
    "event_type": "signup - end signup",
    "op": ">=", "value": 1,
    "filters": [],
    "time_type": "allTime",
    "time_value": 30 } ]
```

`time_type` is one of `forEachInterval`, `currentInterval`, `allTime`. Behavioral cohorts are referenced as a segment with `"prop": "userdata_cohort"` and the cohort id as the value.

**`g`:** the property to group by. Available only when there is a single segment. Maximum two.

### 3.4 Reserved values

| Value | Meaning |
|---|---|
| `_active` | Any active event |
| `_all` | Any event |
| `_new` | New users (retention start action only) |
| `ce:name` | A custom event |
| `revenue_amount` | Revenue |
| `verified_revenue` | Verified revenue |
| `unverified_revenue` | Unverified revenue |
| `gp:` prefix | Custom **user** property. Event properties take no prefix. |

Event types and property names must be URL encoded.

### 3.5 Event Segmentation

| Parameter | Description |
|---|---|
| `e` | Required. Up to two, second via `e2`. |
| `m` | Metric. `uniques`, `totals`, `pct_dau`, `average`; or with a group-by, `histogram`, `sums`, `value_avg`; or `formula`. Default `uniques`. |
| `n` | User type, `any` or `active` |
| `start`, `end` | Required. `YYYYMMDD`. |
| `i` | Interval. `-300000` realtime, `-3600000` hourly, `1` daily, `7` weekly, `30` monthly. Default 1. |
| `s` | Segment definitions |
| `g` | Group-by, up to two, second via `g2` |
| `limit` | Group-by values returned. Default 100, max 1000. |
| `formula` | Required when `m=formula`, e.g. `UNIQUES(A)/UNIQUES(B)` |
| `rollingWindow`, `rollingAverage` | Rolling computations |

Data retention by interval: realtime shows 2 days, hourly 7 days, daily 365 days.

Response: `series` (array per group, each an array of values per day), `seriesLabels`, `seriesCollapsed`, `xValues` (`YYYY-MM-DD`).

### 3.6 Funnel Analysis

| Parameter | Description |
|---|---|
| `e` | Required. One per funnel step. |
| `start`, `end` | Required. `YYYYMMDD`. |
| `mode` | `ordered`, `unordered`, or `sequential`. Default `ordered`. |
| `n` | `new` or `active`. Default `active`. |
| `i` | Interval, as above |
| `s` | Segment definitions |
| `g` | Group-by. Limit one. |
| `cs` | Conversion window in **seconds**. Default 2,592,000 (30 days). Rounds down to the nearest day in `unordered` mode. |
| `limit` | Default 100, max 1000 |

> **Naming trap.** Intuition says "sequential" is the plain in-order mode. It is not.
> - `ordered` = in the given order, other events permitted between steps
> - `unordered` = all steps, any order
> - `sequential` = in the given order with **no other events** between steps

Response fields: `stepByStep` (fraction from previous step), `cumulative` (fraction of total), `cumulativeRaw` (user counts), `medianTransTimes` and `avgTransTimes` (ms per step), `dayFunnels`, `dayMedianTransTimes`, `dayAvgTransTimes`, `stepTransTimeDistribution`, `stepPrevStepCountDistribution`, `bins`, `events`, `meta`.

### 3.7 Retention Analysis

| Parameter | Description |
|---|---|
| `se` | Required. Start action. Supports `_new` and `_active`. |
| `re` | Required. Return action. Supports `_all` and `_active`. |
| `start`, `end` | Required. `YYYYMMDD`. |
| `rm` | `n-day`, `rolling`, or `bracket`. `rolling` means unbounded. Default `n-day`. |
| `rb` | Required when `rm=bracket`. Bracket bounds, e.g. `[[0,5]]` for Day 0 to Day 4. |
| `i` | 1 daily, 7 weekly, 30 monthly. Default 1. |
| `s` | Segment definitions |
| `g` | Group-by. Limit one. |

**The three measures:**

| Measure | A user is retained in period N when |
|---|---|
| `n-day` | They returned on **exactly** day N |
| `rolling` (unbounded) | They returned on day N **or any day after** |
| `bracket` | They returned within the bracket `[lo, hi]` |

Amplitude's own research found N-day understates returning users by roughly 3.5x versus unbounded.

Response: `series.dates`, `series.values` keyed by cohort date, `combined` (deduplicated aggregate across cohorts), `seriesMeta`.

Each cell is `{ count, outof, incomplete }`:
- `count`: users retained in that interval
- `outof`: cohort size, users who performed the start action on that date
- `incomplete`: **whether users on that date have had enough time to be retained**

> The `incomplete` flag is the correct answer to the biggest correctness trap in retention. A cohort that started yesterday cannot fairly be measured at Day 30. Amplitude flags rather than excludes, leaving the decision to the renderer. We adopt both the behaviour and the field name.

Index convention in the response arrays: index 0 is the total user count, index 1 is Day 0 retention, index 2 is Day 1 retention, and so on. Element N+1 corresponds to N intervals out.

### 3.8 Session endpoints

**Session length distribution** takes `timeHistogramConfigBinTimeUnit` (`hours`, `minutes`, `seconds`), `timeHistogramConfigBinMin`, `timeHistogramConfigBinMax`, `timeHistogramConfigBinSize`.

Default bins, in milliseconds:

```
[0, 3000) [3000, 10000) [10000, 30000) [30000, 60000)
[60000, 180000) [180000, 600000) [600000, 1800000)
[1800000, 3600000) [3600000, 86400000)
```

Session lengths cap at one day (86,400,000 ms). The default bins are deliberately non-linear because session length is heavily right-skewed and linear bins produce one useless spike.

Response: `series` (counts per bucket), `xValues` (labels like `"0s-60s"`).

### 3.9 Export API

`GET https://amplitude.com/api/2/export?start=YYYYMMDDTHH&end=YYYYMMDDTHH`

Returns a zipped archive of JSON files, potentially several per hour.

- Date range refers to `server_upload_time`, not event time
- Events are timestamped UTC
- Data is available roughly 2 hours after receipt
- 4 GB size limit, returns 400 above it
- 365 day maximum span
- 404 when the range has no data
- Does not support cross-project views

---

## 4. Governance APIs

| API | Surface | Purpose |
|---|---|---|
| **Taxonomy** | `/api/2/taxonomy/{category,event,event-property,user-property,group-property}` with full CRUD plus restore | The tracking plan as code. Largest API in the corpus at 70 KB of docs. |
| **Lookup Table** | `/api/2/lookup_table`, `/api/3/lookup_table` (+ `/csv`) | Join a CSV onto a property at query time, e.g. SKU to product category |
| **Channel Classifier** | `/api/2/channel-classifiers`, `GET`/`POST`/`PATCH` by name | Rules mapping UTM combinations to marketing channels |
| **Chart Annotations** | `/api/3/annotations`, `/api/3/annotation-categories`, full CRUD | Dated markers drawn on charts |
| **Releases** | `POST /api/2/release` | Version markers with start and end windows |

Release parameters: `version` and `release_start` and `title` required; `release_end`, `description`, `platforms`, `created_by`, `chart_visibility` optional. Timestamps are UTC `yyyy-MM-dd HH:mm:ss`.

---

## 5. Audience APIs

### Behavioral Cohorts

| Endpoint | Purpose |
|---|---|
| `GET /api/3/cohorts` | List all cohorts. Optional `includeSyncInfo`. |
| `GET /api/3/cohorts/{id}` | One cohort. `props=1` includes user properties, `propKeys` narrows them. |
| `GET /api/5/cohorts/request-status/:request_id` | Poll an async export |
| `GET /api/5/cohorts/request/:id/file` | Download the finished export |
| `GET /api/3/cohorts/usage` | Usage stats |
| `POST /api/3/cohorts/upload` | Create a cohort from a user list |
| `POST /api/3/cohorts/membership` | Membership operations |

Upload parameters: `name`, `app_id`, `id_type` (`BY_AMP_ID` or `BY_USER_ID`), optional `cg`.

Export is asynchronous: request, poll status, download file. This shape exists because the data sits behind Amplitude's warehouse.

### User Profile

`GET https://profile-api.amplitude.com/v1/userprofile`

Parameters: `user_id` or `device_id`, plus `get_recs`, `rec_id`, `rec_type`, `get_amp_props`, `get_cohort_ids`, `get_computations`, `comp_id`.

Returns user properties, cohort memberships, recommendations, and propensity scores (`score` raw, `pct` percentile).

---

## 6. Privacy APIs

| API | Surface |
|---|---|
| **User Privacy** | `POST /api/2/deletions/users`, `GET /api/2/deletions/users?start_day=&end_day=` |
| **User Privacy v2** | `POST`/`GET /api/user-deletions/org/{orgId}/requests` on `privacy.amplitude.com` |
| **CCPA DSAR** | `POST /api/2/dsar/requests`, `GET /api/2/dsar/requests/{id}`, `GET /api/2/dsar/requests/{id}/outputs/{output_id}` |

DSAR follows the same asynchronous request, poll, fetch-numbered-outputs pattern as cohort export.

---

## 7. Operations and administration

| API | Surface |
|---|---|
| **Event Streaming Metrics** | `GET /api/2/event-streaming/delivery-metrics-summary` |
| **Session Replay** | `GET /api/1/session-replays`, `GET /api/1/session-replays/files` |
| **Audit Logs** | Org-level change history |
| **SCIM** | `/scim/1/Users`, `/scim/1/Groups`, full CRUD plus `PATCH` |
| **User Management** | `/apis/user-management/roles`, `/groups`, `/project-role-assignments`, `/effective-access` |

---

## 8. Developer API

Host `developer-api.amplitude.com`. The only surface using OAuth.

| Group | Endpoints |
|---|---|
| Auth | `POST /v1/auth/device-authorization`, `POST /v1/auth/token` |
| Projects | `GET /v1/context`, `GET /v1/projects` |
| Analytics | list charts, get chart, query chart, check recent event ingestion |
| Destinations | create, get, update, list, test connection, list partner types, generate Snowflake RSA key pair |
| Feature flags | create, get, list, update, archive |
| Taxonomy | events, event properties, user properties, each with full CRUD |
| Skills | `GET /v1/skills`, get a skill document |

---

## 9. Experiment APIs

Effectively a separate product on `experiment.amplitude.com`.

| API | Endpoints |
|---|---|
| **Evaluation** | `GET /v1/flags`, `GET /v1/vardata` |
| **Management: experiments** | `/api/1/experiments` with variants, deployments, cohorts, users, versions, bulk delete |
| **Management: flags** | `/api/1/flags`, same sub-resource shape as experiments |
| **Management: deployments** | `GET`/`POST`/`PATCH /api/1/deployments` |
| **Management: holdouts** | `GET`/`POST`/`PATCH /api/1/holdouts` |
| **Management: mutexes** | `GET`/`POST`/`PATCH /api/1/mutexes`, plus slot patching |
| **Management: versions** | `GET /api/1/versions` |

---

## 10. Client SDK architecture

From reading `github.com/amplitude/Amplitude-TypeScript` at `main`. A pnpm monorepo managed with Lerna and Nx.

**Core packages:** `analytics-core` (the engine), `analytics-types`, and three thin host adapters: `analytics-browser`, `analytics-node`, `analytics-react-native`.

**Plugin packages (17):** autocapture-browser, element-selector, babel-plugin-autocapture-transformer, page-view-tracking-browser, page-url-enrichment-browser, web-attribution-browser, event-property-attribution-browser, network-capture-browser, web-vitals-browser, session-replay-browser, session-replay-react-native, experiment-browser, experiment-react-native, global-user-properties, custom-enrichment-browser, stub-browser, gtm-snippet.

The structural lesson: small core, everything optional is a plugin.

### Plugin contract

```ts
type PluginType = 'before' | 'enrichment' | 'destination';

interface PluginBase {
  name?: string;
  type?: PluginType;
  setup?(config, client): Promise<void>;
  teardown?(): Promise<void>;
  onIdentityChanged?(identity): Promise<void>;
  onSessionIdChanged?(sessionId: number): Promise<void>;
  onOptOutChanged?(optOut: boolean): Promise<void>;
  onReset?(): Promise<void>;
}

BeforePlugin      → execute?(event): Promise<Event | null>   // null drops the event
EnrichmentPlugin  → execute?(event): Promise<Event | null>   // default type
DestinationPlugin → execute(event): Promise<Result>          // terminal, + optional flush()
```

`Timeline` runs `before[]` then `enrichment[]` then fans out to `destination[]`. Registration locks the plugin name synchronously before awaiting `setup()`, closing a time-of-check-to-time-of-use window where two concurrent `add()` calls with the same name would both install.

### Delivery, from `plugins/destination.ts`

- Every event receives an `insert_id` UUID on entry if absent, making retries idempotent
- Queue of `Context { event, attempts, callback, timeout }`
- `retryTimeout = 1000`, `throttleTimeout = 30000`
- Flush is scheduled, not immediate. A new schedule replaces the pending one **only when its timeout is longer**, so a throttle backoff is never shortened by ordinary traffic.
- Events exceeding `flushMaxRetries` resolve with a synthetic `500 MAX_RETRIES_EXCEEDED`
- The unsent queue persists to `storageProvider` and replays on `setup()`. That is the entire offline story.
- Request bodies are gzip compressed when the target is an Amplitude host

### Sessions

The whole of `session.ts`:

```ts
export const isNewSession = (sessionTimeout, lastEventTime = Date.now()) =>
  Date.now() - lastEventTime > sessionTimeout;
```

- `session_id` is the session's **start time** as a millisecond Unix timestamp, not a UUID
- Default timeout: 30 minutes web, 5 minutes mobile
- All events sharing `(user_id, session_id)` form one session
- `Start Session` and `End Session` are **derived server-side from session_id**, not emitted as events, so they cost no event volume. `End Session` materialises at the start of the next session.

### Browser SDK configuration defaults

| Option | Default |
|---|---|
| `flushIntervalMillis` | 1,000 |
| `flushQueueSize` | 30 |
| `flushMaxRetries` | 5 |
| `minIdLength` | 5 |
| `sessionTimeout` | 1,800,000 |
| `transport` | `fetch` (also `xhr`, `beacon`) |
| `serverUrl` | `https://api2.amplitude.com/2/httpapi` |
| `identityStorage` | `cookie` (also `localStorage`, `sessionStorage`, `none`) |
| `logLevel` | `Warn` |
| `useBatch` | `false` |
| `offline` | `false` |

### Autocapture

```js
autocapture: {
  attribution, pageViews, sessions, formInteractions, fileDownloads,
  elementInteractions, frustrationInteractions, pageUrlEnrichment,
  networkTracking, webVitals
}
```

Each is `true`, `false`, or a configuration object. `frustrationInteractions` covers rage clicks, dead clicks, error clicks and thrashed cursor. Element interactions use a `cssSelectorAllowlist` plus a `data-amp-track` attribute prefix.

---

## 11. Primary sources

- Docs corpus: `https://amplitude.com/docs/llms-full.txt` (725 pages, retrieved 2026-09-24)
- Docs index: `https://amplitude.com/docs/llms.txt`
- HTTP V2: `https://amplitude.com/docs/apis/analytics/http-v2`
- Dashboard REST: `https://amplitude.com/docs/apis/analytics/dashboard-rest`
- Browser SDK 2: `https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2`
- Sessions: `https://amplitude.com/docs/data/sources/instrument-track-sessions`
- Reference implementation: `https://github.com/amplitude/Amplitude-TypeScript`
- N-day retention study: `https://amplitude.com/press/1trillion-events-amplitude20`
