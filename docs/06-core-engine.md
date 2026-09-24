# 06. Core engine

`src/core/` is the analysis engine. Pure functions, zero dependencies, no I/O, no clock reads except where a range is left unbounded. Everything takes an event array in and returns a result object out.

That constraint is what makes the module trivially testable and independently useful. Someone can install the package purely for `funnel()` and `retention()`, hand them an array from their own database, and never touch the SDK or the server.

```
src/core/
├── index.ts
├── segmentation.ts   counts over time, grouped and segmented
├── funnel.ts         3 ordering modes, window, exclusions, timing percentiles
├── retention.ts      n-day, unbounded, bracket
├── cohort.ts         did X but not Y
├── sessions.ts       derivation, duration stats, stickiness
├── identity.ts       device to user resolution and aliasing
├── filter.ts         Filter evaluation against an event
├── properties.ts     user-property merge (the $ operations)
├── time.ts           bucketing, calendar arithmetic, labels
└── stats.ts          percentiles, histogram binning
```

Build order is bottom up: `stats`, `time`, `filter`, `properties`, `identity`, then `sessions`, `segmentation`, `cohort`, `funnel`, `retention`.

---

## filter.ts, the shared predicate layer

Everything else builds on this. One small module, heavily tested, because a bug here silently corrupts every chart in the product.

```ts
export function resolveProperty(ev: AnalyticsEvent, ref: PropertyRef): PropertyValue | undefined;
export function evaluateFilter(ev: AnalyticsEvent, f: Filter): boolean;
export function matchesAll(ev: AnalyticsEvent, filters?: Filter[]): boolean;
export function matchesStep(ev: AnalyticsEvent, step: StepSpec): boolean;
```

**Rules:**

- `resolveProperty` walks a dot path and returns `undefined` for any missing segment rather than throwing.
- `exists` and `not_exists` are the only operators for which `undefined` is meaningful. Every other operator returns `false` against `undefined`, so a missing property never accidentally satisfies `neq`.
- Comparison operators coerce number-to-number and string-to-string only. Mixed types return `false` rather than relying on JavaScript's ordering rules, where `"10" < "9"` is true.
- `matchesStep` short-circuits on `event_type: '*'`, which is what makes "any event" work in retention without a special code path.
- `regex` is length capped and compiled in a try/catch. The backend refuses it entirely unless `allowRegexFilters` is on.

---

## identity.ts

Events arrive keyed by `device_id` before login and `user_id` after. Without resolution one person appears as two users and every retention number is wrong.

```ts
export interface IdentityGraph {
  resolve(ev: AnalyticsEvent): string;   // -> canonical user key
  aliasCount: number;
  skipped: number;                       // events with neither identifier
}

export function buildIdentityGraph(
  events: AnalyticsEvent[],
  aliases?: Array<{ user_id: string; global_user_id: string }>,
): IdentityGraph;
```

**Algorithm.** Single pass with union-find. Any event carrying both `user_id` and `device_id` unions those two nodes. Explicit aliases from `POST /alias` are unioned first as seeds.

Canonical key selection prefers a real `user_id` over a `device_id`, so any set that has ever seen a login resolves to the login. Events carrying neither identifier are dropped and counted in `skipped`, which the ingest layer surfaces rather than hiding.

This runs **once per query** and the resulting graph is passed down into every analysis, so resolution cost is paid once rather than per chart. Every analysis function therefore takes an optional `ids?: IdentityGraph` parameter and builds one internally only if not given.

---

## time.ts

```ts
export function bucketStart(t: number, g: Granularity, tzOffsetMin: number): number;
export function bucketRange(range: TimeRange, g: Granularity, tzOffsetMin: number): number[];
export function bucketLabel(t: number, g: Granularity): string;
export function periodsBetween(a: number, b: number, g: Granularity, tzOffsetMin: number): number;
```

> **Timezone is a correctness issue, not a formatting one.**
>
> "Day 1 retention" means a calendar day boundary in *someone's* timezone. Bucketing in UTC when the product's users are in IST shifts every cohort by five and a half hours and quietly changes the numbers.
>
> Every function that buckets takes an explicit `tzOffsetMin`, defaulting to 0. The backend reads it from the query body, the dashboard sends the browser's offset.

Week buckets start Monday. Month buckets start on the 1st. DST transitions mean "one day" is not always 24 hours, which is why `periodsBetween` does calendar arithmetic rather than dividing by 86,400,000. A fixed offset still cannot express a timezone whose offset changes mid-range; that limitation is documented rather than hidden.

---

## segmentation.ts

```ts
export function segmentation(
  events: AnalyticsEvent[],
  q: SegmentationQuery,
  ids?: IdentityGraph,
): SegmentationResult;
```

**Algorithm.** Filter to range and segment. For each configured event spec, bucket matching events by `bucketStart`.

- `totals` counts events.
- `uniques` counts distinct resolved user keys per bucket, using a `Set` per bucket.
- `average` divides one by the other, returning 0 rather than `NaN` for empty buckets.

When `groupBy` is set the series fans out one per distinct group value, ranked by total, truncated to `limitGroups`, with the tail summed into an `Other` series so the totals still reconcile.

Empty buckets are emitted as zeros rather than omitted, so the chart draws a continuous line instead of interpolating across a gap.

---

## funnel.ts

```ts
export function funnel(events: AnalyticsEvent[], q: FunnelQuery, ids?: IdentityGraph): FunnelResult;
```

**Algorithm.** Group events by resolved user key and sort each user's events by `(time, event_id)`. For each user, attempt to walk the steps.

1. Find the earliest event matching step 0 that also satisfies `segment`. That timestamp opens the conversion window; the deadline is `t0 + conversionWindowMs`.

2. **`ordered`**: scan forward for step 1, then step 2, each after the previous match and before the deadline. Unrelated events between steps are allowed.

3. **`sequential`**: same scan, but the very next event after each match must be the next step. Any other event between two steps fails the attempt. This is Amplitude's meaning of the word, not the intuitive one.

4. **`unordered`**: require that every step has at least one match within the window, in any order. Depth reached is the number of distinct steps matched.

5. **Exclusions**: if any event matching an exclusion spec falls between the first and last matched step, the attempt is truncated at the step preceding the exclusion.

6. **Re-entry**: if an attempt fails at step *k*, restart from the user's next step-0 match after `t0`. A user's recorded depth is the maximum across all attempts.

> Re-entry matters more than it looks. Without it, a user who abandons once and succeeds an hour later reads as a drop-off, and a funnel over any reasonably long window understates conversion badly.

Step counts are the number of users reaching depth at least *k*, so counts are **monotonically non-increasing by construction**. This is asserted as a property in the test suite, because a violation means the walk is double-counting a re-entry, which is the easiest bug to introduce here and the hardest to spot by eye.

Per-hop timing samples are collected from the best attempt only, then reduced through `percentile()`.

`groupBy` partitions users by the group value on their step-0 event and recurses, which keeps group results internally consistent with the ungrouped total.

`countBy: 'totals'` counts completed attempts rather than users, so one user converting three times contributes three. Exposed because it is the correct denominator for transactional funnels such as checkout.

---

## retention.ts

```ts
export function retention(events: AnalyticsEvent[], q: RetentionQuery, ids?: IdentityGraph): RetentionResult;
```

**Shared setup.** For each resolved user, find the first event matching `startAction` and satisfying `segment`. That event's bucket is the user's cohort. Collect every subsequent event matching `returnAction`, convert each to a period offset via `periodsBetween`, and reduce to a sorted set of integers.

From there the three measures differ only in how that set is read.

| Measure | Retained in period N when | Use for |
|---|---|---|
| `n-day` | The return set contains exactly `N` | Products with a daily habit loop |
| `unbounded` | The return set contains any value `>= N` | Irregular usage, most B2B |
| `bracket` | The return set intersects `[lo, hi]` for that bracket | Custom windows |

Amplitude's own research found `n-day` understates returning users by roughly 3.5x against `unbounded`. Most reimplementations ship only `n-day` and are quietly wrong.

### The correctness trap

A cohort is only eligible for period N if the range actually extends N periods past the cohort start. Counting a cohort that started yesterday in the denominator of Day 30 retention drives the whole curve toward zero.

Each curve point therefore uses **its own denominator**: only cohorts with a full N periods of observable data. `cohortSize` is reported per point, not once, and each cell carries an `incomplete` flag so the dashboard can grey out the under-observed tail rather than drawing a cliff that is an artifact of the query window.

Both the behaviour and the field name are taken from Amplitude, which gets this right.

Period 0 is always 1.0 by definition, since the start event is itself in the window, and is included so the curve has an anchor.

The `table` output is the triangular cohort grid: one row per cohort bucket, cells only where observable, which is what produces the staircase edge in the heatmap.

---

## cohort.ts

```ts
export function buildCohort(events: AnalyticsEvent[], q: CohortQuery, ids?: IdentityGraph): CohortResult;
```

**Algorithm.** Group by resolved user. For each user:

1. Establish an anchor as the earliest event matching any `did` spec.
2. When `withinMs` is set, restrict evaluation to `[anchor, anchor + withinMs)`.
3. A user qualifies when every `did` clause is satisfied within its frequency bounds (`atLeast` / `atMost`), no `didNot` spec matches inside the window, and the user's merged latest user properties satisfy `userFilters`.

Returns the user key list so a cohort can be fed straight back into another query as a segment. That reuse is the entire point of the feature.

---

## sessions.ts

```ts
export function deriveSessions(events: AnalyticsEvent[], ids?: IdentityGraph): Session[];
export function sessionStats(events: AnalyticsEvent[], q: SessionQuery, ids?: IdentityGraph): SessionResult;
export function stickiness(events: AnalyticsEvent[], range: TimeRange, ids?: IdentityGraph): Stickiness;

export interface Session {
  userKey: string;
  sessionId: number;      // session start, ms
  start: number;
  end: number;
  durationMs: number;     // end - start; zero for single-event sessions
  eventCount: number;
  eventTypes: string[];
}
```

Sessions are **derived, never stored**. A session is the group of one user's events sharing a `session_id`.

Where `session_id` is absent, as with a server-side SDK or a raw HTTP client, sessions are reconstructed by splitting each user's sorted event stream wherever the inter-event gap exceeds `sessionTimeoutMs`. Both paths are tested.

Start and end session markers are never emitted as events, so they cost nothing and cannot drift out of sync with the data.

`stickiness` computes DAU, WAU and MAU as distinct resolved users in trailing 1, 7 and 30 day windows ending at `range.to`, plus the DAU/MAU and DAU/WAU ratios.

Duration histogram bins are Amplitude's defaults, in milliseconds:

```
[0,3k) [3k,10k) [10k,30k) [30k,60k) [60k,180k) [180k,600k) [600k,1.8M) [1.8M,3.6M) [3.6M,86.4M)
```

Session length caps at one day. The bins are deliberately non-linear because session length is heavily right-skewed and linear bins produce a single useless spike.

---

## stats.ts and properties.ts

```ts
// stats.ts: linear interpolation between ranks, the common p50/p90 convention
export function percentile(sorted: number[], p: number): number | null;
export function median(values: number[]): number | null;
export function histogram(values: number[], edges: number[]): Bin[];
```

```ts
// properties.ts: applies the $ operations in documented precedence
export function mergeUserProperties(
  current: Record<string, PropertyValue>,
  incoming: UserProperties,
): Record<string, PropertyValue>;

export function latestUserProperties(
  events: AnalyticsEvent[],
  ids?: IdentityGraph,
): Map<string, Record<string, PropertyValue>>;
```

`mergeUserProperties` is pure and never mutates its input.

- `$add` against a non-numeric current value is a no-op rather than producing `NaN`.
- `$append` against a scalar promotes it to a single-element array first.
- `$clearAll` is applied first and invalidates every other operation on the same object.

`percentile` returns `null` for an empty array rather than `NaN` or `0`, so an empty funnel hop renders as "no data" instead of "zero milliseconds".
