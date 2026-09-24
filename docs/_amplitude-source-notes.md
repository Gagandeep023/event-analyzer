# Amplitude: Developer Research Reference

Compiled 2026-09-24. Source material: Amplitude Docs + the open-source `amplitude/Amplitude-TypeScript` monorepo (read at `main`).

---

## 1. Repository map (github.com/amplitude)

152 public repos. The ones that matter for a reimplementation:

| Repo | Stars | Lang | Why it matters |
|---|---|---|---|
| [Amplitude-TypeScript](https://github.com/amplitude/Amplitude-TypeScript) | 181 | TS | **The reference implementation.** Browser + Node + RN SDKs, plugin system, transport, storage. |
| [Amplitude-JavaScript](https://github.com/amplitude/Amplitude-JavaScript) | 324 | JS | Legacy v1 SDK (maintenance mode). |
| [Amplitude-Node](https://github.com/amplitude/Amplitude-Node) | 73 | TS | Legacy server SDK; superseded by `analytics-node` in the TS monorepo. |
| [Amplitude-Swift](https://github.com/amplitude/Amplitude-Swift) | 82 | Swift | Same core architecture, different host. |
| [Amplitude-Kotlin](https://github.com/amplitude/Amplitude-Kotlin) | 50 | Kotlin | Same. |
| [Amplitude-Python](https://github.com/amplitude/Amplitude-Python) | 37 | Python | Simplest read of the ingestion contract. |
| [analytics-go](https://github.com/amplitude/analytics-go) | 13 | Go | Same. |
| [experiment-js-client](https://github.com/amplitude/experiment-js-client) | 18 | TS | Feature flags / A-B side, separate product. |
| [wizard](https://github.com/amplitude/wizard) | 30 | TS | CLI that auto-instruments an app. Interesting DX idea. |
| [redux-query](https://github.com/amplitude/redux-query) | 1098 | JS | Unrelated to analytics. |

### Amplitude-TypeScript monorepo layout (`packages/`)

Core:
- `analytics-core` — the engine. Timeline, plugins, transport, storage, identify, revenue, session.
- `analytics-types` — shared type surface.
- `analytics-browser`, `analytics-node`, `analytics-react-native` — host adapters.

Plugins (this is the whole extensibility story, each is its own package):
- `plugin-autocapture-browser`, `element-selector`, `babel-plugin-autocapture-transformer`
- `plugin-page-view-tracking-browser`, `plugin-page-url-enrichment-browser`
- `plugin-web-attribution-browser`, `plugin-event-property-attribution-browser`
- `plugin-network-capture-browser`, `plugin-web-vitals-browser`
- `plugin-session-replay-browser`, `session-replay-browser`
- `plugin-experiment-browser`, `plugin-global-user-properties`, `plugin-custom-enrichment-browser`
- `gtm-snippet`, `segment-session-replay-plugin`, `targeting`, `unified`

Tooling: pnpm workspaces, Lerna + Nx, Jest, Playwright (e2e), size-limit, ESLint/Prettier.

**Takeaway:** core stays small; everything optional is a plugin. Worth copying.

---

## 2. The ingestion contract (HTTP API v2)

`POST https://api2.amplitude.com/2/httpapi` (EU: `api.eu.amplitude.com`), `Content-Type: application/json`.

```json
{
  "api_key": "…",
  "events": [ { "…event…" } ],
  "options": { "min_id_length": 5 }
}
```

### Event fields

Required: `event_type`, plus **at least one of** `user_id` / `device_id` (min 5 chars, configurable).

Identity & time: `user_id`, `device_id`, `time` (ms epoch), `session_id` (ms epoch), `event_id`, `insert_id` (dedup key).

Payload: `event_properties`, `user_properties`, `groups` (max 5 types / 10 values), `group_properties`.

Context: `app_version`, `platform`, `os_name`, `os_version`, `device_brand`, `device_manufacturer`, `device_model`, `carrier`, `language`, `user_agent`, `ip`.

Geo: `country`, `region`, `city`, `dma`, `location_lat`, `location_lng`.

Revenue: `price`, `quantity` (default 1), `revenue`, `productId`, `revenueType`, `currency` (ISO 4217).

Device ads: `idfa`, `idfv`, `adid`, `android_id`, `android_app_set_id`.

Governance: `plan: { branch, source, version }`, `ingestion_metadata`, `partner_id`, `$skip_user_properties_sync`.

### Limits
- String values: 1,024 chars max. Object depth: 40 layers.
- Request: < 1 MB, < 2,000 events. Recommended ≤ 10 events/batch on free tier.
- Free: 100 batches/sec, 1,000 events/sec. Enterprise: 50k events/sec (HTTP v2), 150k (SDK endpoint).
- User-property updates throttled at 1,800/user/hour. Event ingestion is not.

### Responses
- `200` → `{ code, events_ingested, payload_size_bytes, server_upload_time }`
- `400` invalid → body names the offending fields **by event index**: `eventsWithInvalidFields`, `eventsWithMissingFields`, `eventsWithInvalidIdLengths`, `silencedEvents`, `throttledEvents`
- `413` too large → split the batch in half and retry
- `429` throttled → back off 30s; body lists `throttledDevices` / `throttledUsers`
- `500/502/503/504` → retry, `insert_id` guarantees dedup

**Takeaway:** the 400 body being index-addressed is what lets the SDK drop only the bad events and retry the rest. Good design; worth copying.

---

## 3. Client architecture (analytics-core)

### Timeline + plugin pipeline

Every event flows through an ordered pipeline. Three plugin types (`types/plugin.ts`):

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

BeforePlugin      → execute?(event): Promise<Event | null>   // may drop by returning null
EnrichmentPlugin  → execute?(event): Promise<Event | null>   // default type
DestinationPlugin → execute(event): Promise<Result>          // terminal; + optional flush()
```

`Timeline` runs `before[]` → `enrichment[]` → `destination[]` (destinations in parallel). Returning `null` at any stage drops the event. Registration locks the plugin name synchronously to close a TOCTOU window across `await setup()`.

### Destination: batching and retry

From `plugins/destination.ts`:
- Every event gets an `insert_id` (UUID) on entry if absent.
- Queue of `Context { event, attempts, callback, timeout }`.
- Flush is *scheduled*, not immediate: `schedule(flushIntervalMillis)`. A new schedule only replaces the existing one if its timeout is **longer**, so a throttle backoff is never shortened by normal traffic.
- `retryTimeout = 1000`, `throttleTimeout = 30000`.
- Events exceeding `flushMaxRetries` are fulfilled with a synthetic `500 MAX_RETRIES_EXCEEDED`.
- Unsent events are persisted to `storageProvider` and replayed on `setup()`. This is the offline story.
- Body gzip-compressed when hitting Amplitude's own URLs.

### Identify operations

Server-side merge ops, encoded as reserved `$`-prefixed keys in `user_properties`:

`$set`, `$setOnce`, `$add` (numbers only), `$append`, `$prepend`, `$preInsert`, `$postInsert`, `$remove`, `$unset`, `$clearAll`.

`preInsert`/`postInsert` are set-semantics (insert only if absent); `append`/`prepend` are list-semantics. `$clearAll` invalidates every other op on the same object.

### Sessions

`session.ts` is literally this:

```ts
export const isNewSession = (sessionTimeout, lastEventTime = Date.now()) =>
  Date.now() - lastEventTime > sessionTimeout;
```

- `session_id` = the session's start time as a ms Unix timestamp. Not a UUID.
- Default timeout: 30 min web, 5 min mobile.
- All events sharing `(user_id, session_id)` are one session.
- `Start Session` / `End Session` are **derived server-side from session_id**, not sent as events, so they cost no event volume. `End Session` is materialized at the start of the *next* session.

### Config surface worth mirroring

`flushIntervalMillis` (1000), `flushQueueSize` (30), `flushMaxRetries` (5), `minIdLength` (5), `optOut`, `serverUrl`, `serverZone`, `sessionTimeout` (1.8e6), `transport` ('fetch' | 'xhr' | 'beacon'), `useBatch`, `offline`, `storageProvider`, `identityStorage` ('cookie' | 'localStorage' | 'sessionStorage' | 'none'), `loggerProvider`, `logLevel`, `cookieOptions`, `instanceName`.

### Client API

```
init(apiKey, userId?, options?)
track(eventType | event, eventProperties?, eventOptions?)
identify(Identify)            groupIdentify(type, name, Identify)
revenue(Revenue)              setGroup(type, value)
setUserId / getUserId         setDeviceId / getDeviceId
setSessionId / getSessionId   extendSession()
setIdentity / getIdentity     reset()
setOptOut / getOptOut         flush()
add(plugin) / remove(name)    createInstance()
```

Every call returns `{ promise }` resolving to `{ code, message, event }`. Nice touch: fire-and-forget by default, awaitable when you need it.

### Autocapture (browser)

`autocapture: { attribution, pageViews, sessions, formInteractions, fileDownloads, elementInteractions, frustrationInteractions, pageUrlEnrichment, networkTracking, webVitals }` — each `true|false` or a config object. `frustrationInteractions` covers rage clicks, dead clicks, error clicks, thrashed cursor. Element interactions use a `cssSelectorAllowlist` + `data-amp-track` attribute prefix.

---

## 4. Analysis semantics (the part that is not open source)

### Funnels
- Ordering modes: **This order** (sequence, other events allowed between), **Any order** (all steps, sequence irrelevant), **Exact order** (sequence, no other events between).
- Exclusion events remove a user who fires them between steps.
- Segment filters apply **only to the starting event**, not to return steps.
- Conversion window bounds the whole funnel, not per-step.
- "Conversion Drivers" (what separates converters from droppers) is a paid tier feature.

### Retention (three distinct measures, commonly confused)
- **N-day**: returned *exactly* on day N.
- **Unbounded (return on or after)**: returned on day N *or any day after*. Amplitude's own research says N-day undercounts returning users by ~3.5x versus this.
- **Bracket**: user-defined buckets, e.g. Day 0 / Day 1-7 / Day 8-14. Percentage returning within each bracket.
- Inputs are a **start action** and a **return action** (either can be "any event"); intervals are day / week / month.
- Segment filter applies only to the start action.

### Other chart types
Event segmentation, behavioral cohorts (users who did X but not Y in window W), pathfinder / user journeys, stickiness (DAU/MAU), lifecycle, revenue LTV.

---

## 5. Design lessons to carry into our package

1. **Small core, everything else a plugin.** `before` / `enrichment` / `destination` with `execute(event) => Event | null` is a clean, tiny contract.
2. **`insert_id` on every event at the edge.** Makes retries idempotent for free.
3. **Index-addressed 400 responses.** Lets a client drop poison events without losing the batch.
4. **`session_id` = session start timestamp.** No separate session table needed; sessions are derivable by `GROUP BY (user_id, session_id)`.
5. **Derive session start/end rather than emitting them.** Cheaper and always consistent.
6. **Schedule-with-longest-timeout-wins.** Small trick that makes backoff actually stick under load.
7. **Persist the unsent queue, replay on setup.** The entire offline story in ~10 lines.
8. **Ship all three retention measures.** Most clones ship only N-day and are quietly wrong.
9. **Identify ops as reserved `$` keys** keeps the wire format flat and the merge server-side.

---

## 6. Primary sources

- Docs hub: https://amplitude.com/docs
- SDK index: https://amplitude.com/docs/sdks
- Browser SDK 2: https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2
- HTTP API v2: https://amplitude.com/docs/apis/analytics/http-v2
- Sessions: https://amplitude.com/docs/data/sources/instrument-track-sessions
- Funnels: https://amplitude.com/docs/analytics/charts/funnel-analysis/funnel-analysis-build
- Retention: https://amplitude.com/docs/analytics/charts/retention-analysis/retention-analysis-build
- TS API reference: https://amplitude.github.io/Amplitude-TypeScript/
- Monorepo: https://github.com/amplitude/Amplitude-TypeScript
