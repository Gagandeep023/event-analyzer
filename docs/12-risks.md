# 12. Risks and open questions

## Known risks

### Full-scan query cost

`JsonlFileStore` reads and parses every event in range for every query, and the dashboard fires six queries at once.

Comfortable at a few million events, unpleasant beyond that. Mitigated by the range index (only files overlapping the range are read) and the single-pass result cache (six panel requests cost one disk pass).

The real answer is a SQLite store, which the `EventStore` interface already accommodates and which is the obvious v0.2 addition.

### Timezone correctness

Every bucketing decision is a correctness decision, not a formatting one, and DST makes "one day" not always 24 hours.

Handled by threading an explicit `tzOffsetMin` everywhere and testing boundaries directly, including a DST transition.

**Remaining limitation:** a fixed offset cannot express a timezone whose offset changes partway through the queried range. A 90-day range spanning a DST change will bucket some days against the wrong offset. This is documented rather than hidden, and the fix (accepting an IANA zone name and using `Intl`) is a v0.2 candidate.

### Query endpoints leak everything

An unguarded `/query` or `/stream` hands over every event in the store, including user ids and any PII in event properties.

The router takes `queryAuth` as a separate option from the ingest key and warns loudly at startup when it is missing, but it cannot force the host application to supply one.

The README leads with this rather than burying it.

### Regex filters as a denial-of-service vector

A `regex` filter arriving in a query body is untrusted input compiled into a matcher. Catastrophic backtracking will hang the event loop.

Length capped, compiled in a try/catch, and `allowRegexFilters` defaults to `false`.

### Autocapture and PII

Click capture that reads text content will eventually read something private.

Everything defaults off, input values are never captured, password fields are excluded unconditionally, and text is truncated to 128 characters.

The honest framing is that autocapture is a convenience with a privacy cost, and the default should reflect that. This is a deliberate divergence from Amplitude, which defaults several capture modes on.

### Scope drift toward Amplitude

[Document 01](01-amplitude-api-atlas.md) lists a great deal that could be built. The discipline is the filter in [document 02](02-scope-and-mapping.md): analytics-is-hard, not selling-analytics-is-hard.

Taxonomy and lookup tables are the two skipped items most likely to be genuinely missed, which is why both are scheduled for v0.3 rather than dismissed.

### Memory during large exports

`/export` streams, but `store.query()` currently materialises the full result array before the route serialises it. A 4 GB range would exhaust memory.

v0.1 caps export ranges and documents the cap. A streaming `EventStore.scan()` method returning an async iterator is the proper fix and is scheduled alongside the SQLite store.

---

## Open questions

These need answering before or during phase 1, because they affect the type contract and are expensive to change later.

### 1. Does `/collect` accept Amplitude's exact payload shape as an alias?

Accepting `{ api_key, events }` with flat device and geo fields would make the package a **drop-in replacement** for any codebase already sending to Amplitude. Point the existing SDK at a different URL and it works.

The cost is a compatibility shim in the validator and a second shape to keep working forever.

**Current lean:** yes, behind an `amplitudeCompat: true` flag that defaults to `false`. It is the single strongest adoption argument the package has, and gating it behind a flag keeps the default surface clean.

**Decide before:** `validate.ts` is written, in phase 4.

### 2. ~~Does the root `.` export re-export `core`, or stay empty?~~ CLOSED

**Resolved in phase 1: re-export `types` and `core` only.**

`backend` and `frontend` carry peer dependencies, so pulling them into the root
export would ask a consumer who installed neither to resolve express or react.
They stay reachable only through their own subpaths.

Verified against a real consumer install: all six subpaths resolve under both
`require()` and `import()`.

### 3. SQLite in v0.2 as a peer dependency or a separate package?

A separate `@gagandeep023/event-analyzer-sqlite` keeps the zero-dependency promise of the main package completely intact and lets the store evolve on its own release cycle.

A peer dependency is simpler for the user but means the main package's README has to explain an optional native dependency.

**Current lean:** separate package. The zero-dependency claim is worth protecting, and the `EventStore` interface already makes this clean.

**Decide before:** v0.2 planning. Does not block v0.1.

### 4. Confirm journey paths stay cut from v0.1

Path trees are the most implementation work for the least demo payoff, and rendering them well needs a Sankey that Recharts does not ship.

**Current lean:** cut from v0.1, revisit in v0.2 alongside a decision about whether to take a charting dependency for it.

---

## Decisions already closed

Recorded so they are not relitigated mid-build.

| Decision | Outcome |
|---|---|
| Repository location | Standalone at `Gagandeep023/event-analyzer/`, not inside the portfolio |
| Package name | `@gagandeep023/event-analyzer`, scoped only (unscoped is taken) |
| Runtime dependencies | Zero. Express, React and Recharts are optional peers. |
| Query transport | `POST` with a JSON body, not `GET` with query parameters |
| Funnel mode vocabulary | Amplitude's exact words: `ordered`, `unordered`, `sequential` |
| Retention measures | All three shipped in v0.1, with the `incomplete` flag |
| Autocapture defaults | Everything off |
| Root export surface | `types` and `core` only, never `backend` or `frontend` |
| Portfolio integration | Separate work, after publish, against the tarball |
