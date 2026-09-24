# 05. Type contract

`src/types/` contains zero runtime code. Every other module imports from here; nothing here imports from anywhere else. This is the contract the whole package agrees on, and changing it after phase 1 ripples through every module, which is why it is settled first.

```
src/types/
├── event.ts      AnalyticsEvent, EventContext, IdentifyOperation, UserProperties
├── ingest.ts     IngestPayload, IngestResponse, RejectionMap
├── filter.ts     Filter, PropertyRef, StepSpec, TimeRange, Granularity
├── query.ts      the five query and result pairs
├── config.ts     SdkConfig, BackendConfig, ResolvedSdkConfig
└── index.ts      barrel
```

## event.ts

A trimmed version of Amplitude's wire event. Amplitude flattens roughly twenty device and geo fields onto the event root; we group them into a single `context` object, which keeps the type readable and the ingest validator simple.

```ts
export interface AnalyticsEvent {
  /** Required. The name of the thing that happened. */
  event_type: string;

  /** At least one of user_id / device_id is required. Min 5 chars by default. */
  user_id?: string;
  device_id?: string;

  /** Milliseconds since epoch. Server fills it with receive time if absent. */
  time?: number;

  /** Session start time in ms. Doubles as the session identifier. */
  session_id?: number;

  /** Idempotency key. Stamped by the SDK if the caller omits it. */
  insert_id?: string;

  /** Monotonic per-client counter, used to order events with identical `time`. */
  event_id?: number;

  event_properties?: Record<string, PropertyValue>;
  user_properties?: UserProperties;
  groups?: Record<string, string | string[]>;
  group_properties?: Record<string, PropertyValue>;

  context?: EventContext;
  revenue?: RevenueFields;

  /** Set by the ingest layer, never by the client. */
  server_received_time?: number;
  ingest_library?: string;
}

export type PropertyValue =
  | string | number | boolean | null
  | PropertyValue[]
  | { [k: string]: PropertyValue };

export interface EventContext {
  platform?: string;        // 'web' | 'node' | 'ios' | ...
  app_version?: string;
  os_name?: string;
  os_version?: string;
  device_model?: string;
  device_brand?: string;
  language?: string;
  user_agent?: string;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  referrer?: string;
  page_url?: string;
  page_title?: string;
  library?: string;         // 'event-analyzer-sdk/0.1.0'
}

export interface RevenueFields {
  price?: number;
  quantity?: number;        // defaults to 1
  revenue?: number;         // computed as price * quantity when absent
  product_id?: string;
  revenue_type?: string;
  currency?: string;        // ISO 4217
}
```

### Identify operations

Reserved `$`-prefixed keys inside `user_properties`, merged on the server. Keeping the wire format flat means the ingest endpoint never needs a second schema.

```ts
export enum IdentifyOperation {
  SET         = '$set',         // overwrite
  SET_ONCE    = '$setOnce',     // write only if the key is absent
  ADD         = '$add',         // numeric increment; numbers only
  APPEND      = '$append',      // push to end of list
  PREPEND     = '$prepend',     // unshift to front of list
  PRE_INSERT  = '$preInsert',   // unshift only if value not already present
  POST_INSERT = '$postInsert',  // push only if value not already present
  REMOVE      = '$remove',      // delete a value from a list
  UNSET       = '$unset',       // delete the key
  CLEAR_ALL   = '$clearAll',    // delete every user property
}

export type UserProperties =
  & Partial<Record<IdentifyOperation, Record<string, PropertyValue>>>
  & Record<string, PropertyValue>;   // bare keys are treated as $set
```

**Merge precedence:** `$clearAll` first and it invalidates every other operation on the same object. Then `$unset`, `$setOnce` (skipped where the key exists), `$set`, the list operations, and finally `$add`.

`$add` runs last so an increment lands on top of a `$set` in the same payload rather than being overwritten by it.

## filter.ts

```ts
export type PropertyScope = 'event' | 'user' | 'context' | 'group';

export interface PropertyRef {
  scope: PropertyScope;
  key: string;              // dot path, e.g. 'plan.tier'
}

export type FilterOp =
  | 'eq' | 'neq' | 'contains' | 'not_contains'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'exists' | 'not_exists'
  | 'regex';

export interface Filter {
  property: PropertyRef;
  op: FilterOp;
  value?: PropertyValue | PropertyValue[];
}

/** One step in a funnel, or the start/return action of a retention query. */
export interface StepSpec {
  event_type: string | '*';   // '*' matches any event
  filters?: Filter[];
  label?: string;
}

export interface TimeRange { from: number; to: number; }   // ms epoch, [from, to)

export type Granularity = 'hour' | 'day' | 'week' | 'month';
```

## query.ts

Every query type carries its own `range` and optional `segment`. Results are plain JSON, directly renderable by Recharts without a transform step.

```ts
export interface SegmentationQuery {
  events: StepSpec[];
  countBy: 'uniques' | 'totals' | 'average';
  granularity: Granularity;
  groupBy?: PropertyRef;
  segment?: Filter[];
  range: TimeRange;
  limitGroups?: number;       // default 10, remainder folded into 'Other'
  tzOffsetMin?: number;
}

export interface SegmentationResult {
  series: Array<{
    label: string;
    points: Array<{ t: number; value: number }>;
    total: number;
  }>;
  buckets: number[];
  granularity: Granularity;
}
```

```ts
export type FunnelOrder = 'ordered' | 'unordered' | 'sequential';
// Amplitude's vocabulary, kept verbatim:
//   ordered    = in order, other events allowed between steps
//   unordered  = all steps, any order
//   sequential = in order, NO other event between steps

export interface FunnelQuery {
  steps: StepSpec[];              // 2..8 steps
  order: FunnelOrder;
  conversionWindowMs: number;     // bounds the whole funnel (default 30d)
  exclusions?: StepSpec[];
  countBy: 'uniques' | 'totals';
  groupBy?: PropertyRef;
  segment?: Filter[];             // applies to the FIRST step only
  range: TimeRange;
  tzOffsetMin?: number;
}

export interface FunnelStepResult {
  index: number;
  label: string;
  event_type: string;
  count: number;
  conversionFromStart: number;      // 0..1
  conversionFromPrevious: number;   // 0..1
  dropOff: number;
  dropOffRate: number;
  medianTimeFromPreviousMs: number | null;
  p90TimeFromPreviousMs: number | null;
}

export interface FunnelResult {
  steps: FunnelStepResult[];
  totalEntered: number;
  totalConverted: number;
  overallConversion: number;
  medianTotalTimeMs: number | null;
  groups?: Record<string, FunnelResult>;
}
```

```ts
export type RetentionMeasure = 'n-day' | 'unbounded' | 'bracket';

export interface RetentionQuery {
  startAction: StepSpec;          // { event_type: '*' } for "any event"
  returnAction: StepSpec;
  measure: RetentionMeasure;
  interval: 'day' | 'week' | 'month';
  periods: number;                     // n-day / unbounded
  brackets?: Array<[number, number]>;  // bracket only, inclusive
  segment?: Filter[];                  // applies to the START action only
  range: TimeRange;
  tzOffsetMin?: number;
}

export interface RetentionCell {
  period: number;
  retained: number;
  rate: number;
  incomplete: boolean;
}

export interface RetentionResult {
  measure: RetentionMeasure;
  interval: 'day' | 'week' | 'month';
  totalUsers: number;
  /** Aggregate curve. Each point carries its OWN denominator. */
  curve: Array<RetentionCell & { label: string; cohortSize: number }>;
  /** One row per cohort bucket. Renders as the triangular heatmap. */
  table: Array<{
    cohortStart: number;
    cohortLabel: string;
    cohortSize: number;
    cells: RetentionCell[];
  }>;
}
```

```ts
export interface CohortQuery {
  did: Array<{ step: StepSpec; atLeast?: number; atMost?: number }>;
  didNot?: StepSpec[];
  withinMs?: number;              // relative to each user's first matching event
  userFilters?: Filter[];         // matched against latest merged user properties
  range: TimeRange;
}

export interface CohortResult {
  userIds: string[];
  size: number;
  totalUsersInRange: number;
  share: number;
  definition: CohortQuery;
}

export interface SessionQuery {
  segment?: Filter[];
  granularity: Granularity;
  range: TimeRange;
  tzOffsetMin?: number;
}

export interface SessionResult {
  totalSessions: number;
  totalUsers: number;
  medianDurationMs: number;
  p90DurationMs: number;
  meanEventsPerSession: number;
  durationHistogram: Array<{ bucketLabel: string; lowerMs: number; upperMs: number; count: number }>;
  stickiness: { dau: number; wau: number; mau: number; dauOverMau: number; dauOverWau: number };
  sessionsOverTime: Array<{ t: number; sessions: number; users: number }>;
}
```

## config.ts

Defaults mirror Amplitude's where they are sensible and diverge where self-hosting changes the tradeoff.

| Option | Type | Default | Notes |
|---|---|---|---|
| `endpoint` | string | required | Where the SDK POSTs batches |
| `apiKey` | string | optional | Sent as `X-EA-Key`, not in the body |
| `flushIntervalMillis` | number | `5000` | Amplitude uses 1,000. A self-hosted collector is not billing per request, so fewer and larger batches are cheaper for everyone. |
| `flushQueueSize` | number | `30` | Flush immediately at this depth |
| `flushMaxRetries` | number | `5` | Then the event is dropped with a synthetic 500 |
| `sessionTimeoutMs` | number | `1800000` | 30 minutes |
| `minIdLength` | number | `5` | Validated on both sides |
| `maxBatchSize` | number | `500` | Events per HTTP request |
| `transport` | Transport | `auto` | fetch, beacon, or node http |
| `storage` | Storage | `auto` | localStorage in a browser, memory in Node |
| `optOut` | boolean | `false` | Drops everything at the `before` stage |
| `offline` | boolean | `false` | Queue but never flush |
| `autocapture` | object | all `false` | Browser only. See doc 07. |
| `logLevel` | enum | `warn` | none, error, warn, debug |

### Backend config

| Option | Type | Default | Notes |
|---|---|---|---|
| `store` | `EventStore` | required | See doc 08 |
| `apiKeys` | `string[]` | `[]` | When set, `/collect` requires `X-EA-Key` |
| `queryAuth` | middleware | none | Guards `/query/*`, `/meta`, `/export`, `/stream`. Warns at startup when absent. |
| `allowRegexFilters` | boolean | `false` | Untrusted regex is a DoS vector |
| `defaultTzOffsetMin` | number | `0` | Per-query override available |
| `maxEventsPerRequest` | number | `500` | |
| `maxBodyBytes` | number | `5_000_000` | |
| `maxStreamConnections` | number | `50` | |
| `amplitudeCompat` | boolean | `false` | Accept Amplitude's payload shape on `/collect` |
