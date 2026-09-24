# 01. Prior art and the contracts worth keeping

This package is not novel in what it measures. Funnels, retention and behavioural
cohorts are a settled problem, and the hosted tools that solved them converged on
a set of contracts worth adopting rather than reinventing.

This document records those contracts and why they are shaped the way they are.
It exists so the rest of the design can reference "the convention" without
hand-waving.

---

## 1. The ingestion contract

Every serious event pipeline lands on roughly the same wire event.

**Required:** an event name, plus at least one identifier. Anonymous traffic is
keyed by a device identifier; known traffic by a user identifier; and events
carrying both are what let the two be stitched together later.

**Everything else is optional** and falls into four groups: a timestamp and
session marker, free-form event and user properties, an account or group
association, and ambient context about the device and page.

### Limits that exist for good reasons

| Limit | Typical value | Why |
|---|---|---|
| String value length | 1,024 chars | Stops a stack trace being sent as a property value |
| Object depth | 40 layers | Bounds recursive traversal during validation and analysis |
| Events per request | 500 to 2,000 | Keeps one bad batch from monopolising a worker |
| Request body | 1 to 20 MB | Same |
| Identifier minimum length | 5 chars | Rejects `null`, `0`, `-` and other accidental identifiers |

### Index-addressed rejection

The single most valuable detail in the whole contract: when a batch is partly
invalid, the response names failures **by their index in the submitted array**.

```json
{ "code": 200, "events_ingested": 497, "events_rejected": 3,
  "rejected": { "events_with_missing_fields": { "event_type": [12] },
                "events_with_invalid_id_lengths": { "user_id": [40, 41] } } }
```

Without it a client has two bad options: drop the whole batch, or retry it
forever. With it, the client drops exactly the poison events and retries the
rest. This package implements it in [document 04](04-api-reference.md).

### Idempotency

Every event carries a client-generated deduplication key. That one field is what
makes retry-on-timeout safe: the client cannot know whether a request that timed
out was received, so it must retry, and the key is what stops the retry from
double-counting.

A corollary this package takes seriously: **a batch rejected purely as duplicates
is a success, not an error.** Returning a client error there tells the caller its
retry failed when in fact the data arrived.

---

## 2. The query contract

The cleanest idea in the space: every analysis composes from the same three
primitives.

| Primitive | Meaning |
|---|---|
| **Event** | An event name plus optional property filters and a group-by |
| **Segment** | A user-level filter, either on user properties or on behaviour |
| **Group-by** | A property to split the result along |

Learn those once and every chart type becomes a different arrangement of them.
This package restates them as typed `StepSpec`, `Filter[]` and `PropertyRef` in
[document 05](05-types.md).

Behavioural segments ("users who did X at least N times in the last M days") are
the piece most reimplementations omit, and the piece analysts reach for most.

---

## 3. Funnel semantics, and the naming trap

Three ordering modes, and the names are genuinely counter-intuitive:

| Mode | Meaning |
|---|---|
| `ordered` | Steps in the given order. Other events **may** occur between them. |
| `unordered` | All steps occur in the window, order irrelevant. |
| `sequential` | Steps in the given order with **no other event** between them. |

Intuition says `sequential` is the plain in-order mode. It is not; `ordered` is.
`sequential` is the strict adjacency variant, and it is far more restrictive than
the name suggests.

This package keeps these exact words. A same-word-different-meaning collision is
worse than an awkward word, because a query migrated from another tool would
silently mean something else.

Two more details that decide whether the numbers are right:

- **The conversion window bounds the whole funnel**, not each hop. Three hops of
  five days each do not fit in a seven-day window.
- **The segment filter applies to the first step only.** Applying it to every
  step is a common reimplementation bug, and it silently zeroes funnels whose
  later events do not carry the segmented property.

---

## 4. Retention, where most reimplementations go wrong

Three distinct measures, and shipping only the first is the usual failure:

| Measure | A user is retained in period N when |
|---|---|
| **N-day** | They returned on **exactly** day N |
| **Unbounded** | They returned on day N **or any day after** |
| **Bracket** | They returned within a caller-defined `[lo, hi]` window |

These disagree enormously. On this package's own demo dataset, N-day reports
roughly **a third** of what unbounded reports for the same users and the same
events. A product measured with N-day alone looks like it is bleeding users when
it may simply have a weekly rather than daily rhythm.

### The incompleteness problem

A cohort that started yesterday cannot fairly be measured at Day 30. It has not
had thirty days to return.

The naive implementation counts it in the denominator anyway, and the retention
curve dives toward zero at the right-hand edge. That cliff is an artifact of the
query window, not a fact about the product, and it has misled plenty of people.

The correct handling, adopted here: **each period carries its own denominator**,
computed from only the cohorts with a full N periods of observable data, plus an
`incomplete` flag so the renderer can show uncertainty rather than the engine
hiding it.

---

## 5. Sessions without a session table

A session identifier that is also the session's **start timestamp** is a small
idea with outsized payoff:

- Sessions are recoverable with `GROUP BY (user, session_id)`. No session table.
- Session start time is readable straight off the identifier.
- Session start and end markers can be **derived** rather than emitted, so they
  cost no event volume and cannot drift out of sync with the data.

Inactivity timeout is conventionally 30 minutes on web and 5 on mobile.

Session-length histogram bins are non-linear by convention, roughly
`0-3s, 3-10s, 10-30s, 30-60s, 1-3m, 3-10m, 10-30m, 30-60m, 1h-1d`, because
session length is heavily right-skewed. Linear bins produce one useless spike at
the left and nothing else.

---

## 6. User property merge operations

Properties are merged server-side through a small set of named operations, sent
as reserved keys alongside the values:

| Operation | Effect |
|---|---|
| `set` | Overwrite |
| `setOnce` | Write only if absent |
| `add` | Numeric increment |
| `append` / `prepend` | List append / prepend |
| `preInsert` / `postInsert` | Insert only if not already present |
| `remove` | Remove a value from a list |
| `unset` | Delete the key |
| `clearAll` | Delete every property |

**Precedence matters and is easy to get wrong.** `clearAll` dominates everything
in its own payload. `add` must be applied **last**, so an increment lands on top
of a `set` in the same payload rather than being overwritten by it.

Group properties conventionally take a narrower set: no insert operations, no
`remove`, no `clearAll`.

---

## 7. Client delivery behaviour

The reference behaviour every robust capture client implements, and the reason
each one exists:

| Behaviour | Why |
|---|---|
| Stamp the dedup key on entry | Makes every later retry idempotent |
| Scheduled flush, not per-event | One request per batch, not per event |
| **Longest timeout wins** when rescheduling | Otherwise steady traffic shortens a 30s throttle backoff back to the flush interval and hammers a server that said stop |
| Split on payload-too-large | A 2,000-event batch that is too big is two 1,000-event batches that fit |
| Drop only named indices on validation failure | See index-addressed rejection above |
| Bounded retries | Bounded memory against a server that is down for a week |
| Persist the queue, replay on start | The entire offline story, in about ten lines |
| Flush via beacon on page hide | A normal request is cancelled by navigation; a beacon is not |

---

## 8. What this package does differently

Recorded here so the divergences are deliberate rather than accidental.

| Convention | This package | Why |
|---|---|---|
| Autocapture partly on by default | **Everything off** | Capturing tracking a developer did not ask for is how people ship surprise data collection |
| Query parameters in the URL | **JSON request bodies** | A funnel spec is a nested object; flattening it is lossy and unreadable |
| Export as a zipped archive | **NDJSON stream** | Streaming is better when you control both ends, and the output replays straight back into the collector |
| Separate annotation and release resources | **One resource** | Same concept, different metadata |
| Flush every 1s | **Every 5s** | A self-hosted collector is not billing per request; fewer, larger batches are cheaper for everyone |
| Dozens of endpoints across several hosts | **Eleven, one mount point** | Most of that surface exists to serve multi-tenancy, not analysis |

The last row is the governing principle, and it is expanded in
[document 02](02-scope-and-mapping.md): build what exists because analytics is
hard, skip what exists because selling analytics is hard.
