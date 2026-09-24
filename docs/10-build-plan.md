# 10. Build plan

Five phases. Each ends at a state that is committable, testable and not a half-finished refactor.

Phases 1 and 2 are the substance. If the work stopped after phase 2 there would still be something worth publishing.

---

## Phase 1: Scaffold and types

Repository, git remote on `github.com-personal`, `package.json`, tsup, tsconfig, vitest, eslint, LICENSE, `.npmignore`, README skeleton. Then all of `src/types`.

Nothing else compiles until the types are settled, and changing them later ripples through every module. This is why they come first rather than growing organically.

**Deliverables**
- Repository initialised, first commit, remote added
- Six build entries producing output
- Every type in [document 05](05-types.md)

**Done when:** `npm run build` emits six entries with `.js`, `.mjs` and `.d.ts` each, and `npm test` runs cleanly with zero specs.

---

## Phase 2: The analysis engine

All of `src/core`, built bottom up: `stats`, `time`, `filter`, `properties`, `identity`, then `sessions`, `segmentation`, `cohort`, `funnel`, `retention`.

Tests written alongside each file, not after. This is roughly 120 of the 130 specs and the bulk of the thinking.

**Deliverables**
- Every function in [document 06](06-core-engine.md)
- Hand-built fixtures with paper-verified expected output
- The funnel monotonicity property test
- `core` importable and usable with no other part of the package

**Done when:** every analysis runs against a hand-built fixture whose correct answer was worked out on paper, all three retention measures visibly disagree on the same fixture, and the monotonicity property holds across generated inputs.

---

## Phase 3: Capture SDK

Timeline, `Identify`, `Revenue`, session manager, transports, storage, then the destination with its full retry matrix. Autocapture plugins last, since they are additive and browser-only.

**Deliverables**
- Everything in [document 07](07-sdk.md)
- A fake transport for testing all four response paths

**Done when:** the fake transport proves batching, `400` partial drop, `413` split, `429` backoff, the retry ceiling, and queue replay after a simulated restart.

---

## Phase 4: Ingestion and query server

Validation, both stores, the router, all query routes, `/meta`, `/export` and SSE. Then `examples/seed.ts` and `examples/server.ts`, at which point the whole pipeline is exercisable by hand.

**Deliverables**
- Everything in [documents 04](04-api-reference.md) and [08](08-backend.md)
- Deterministic seed generator
- Runnable example server

**Done when:** the integration test drives SDK to router to store to query in one process, the export round trip produces identical query results, and `npm run demo` serves real numbers.

---

## Phase 5: Dashboard, docs, publish

Six panels, shared components, theming. Then README, `GUIDE.md`, and `npm publish --access public`.

**Deliverables**
- Everything in [document 09](09-frontend.md)
- README with the two-trust-levels warning up front
- `GUIDE.md` shipped in the tarball

**Done when:** a clean clone reaches a working dashboard in three commands, and the published tarball contains `dist` and `GUIDE.md` and nothing else.

---

## Dependencies between phases

```
Phase 1 ──┬─→ Phase 2 ──→ Phase 4 ──→ Phase 5
          └─→ Phase 3 ──────┘
```

Phases 3 and 4 have no dependency on each other beyond `types`, so either order works. Phase 2 blocks phase 4. Phase 5 blocks nothing and can start as soon as phase 4 serves data.

## Acceptance test for v0.1.0

The definition of "independent of the rest of the project". On a clean machine with no other repository present:

```bash
git clone git@github.com-personal:Gagandeep023/event-analyzer.git
cd event-analyzer && npm i
npm test          # ~130 vitest specs, all green
npm run build     # dist/ with 6 entries
npm run demo      # seeds events, serves API + dashboard on :4800
```

### examples/seed.ts

A deterministic generator, seeded so every run produces identical data and demo screenshots stay stable. It models a small SaaS: roughly 2,000 users over 90 days with signup, activation, invite, upgrade and churn behaviours, deliberately imperfect so the charts show something worth looking at.

- **A real funnel with real drop-off.** `Signed Up` to `Project Created` to `Teammate Invited` to `Plan Upgraded`, converting at roughly 60 / 35 / 12 percent, so the drop-off bars are legible instead of uniform.
- **Retention that actually decays**, with a weekly usage rhythm so the weekly interval looks different from the daily one and the three measures visibly disagree. That disagreement is the whole reason to ship all three.
- **Sessions of varied length**, right-skewed, so the non-linear histogram bins earn themselves.
- **Two device ids per user before login**, so the identity union-find has something to resolve and the demo proves it works.
- **A small tail of malformed events** fed to `/collect`, so the index-addressed 400 path is exercised by the demo and not only by the tests.

### examples/server.ts

About forty lines: an Express app mounting the router with `JsonlFileStore`, serving the built demo app, and printing the curl commands for `/collect` and each query endpoint on startup.

It doubles as the copy-paste integration example in the README, so the documentation cannot drift from something that runs.

## After v0.1.0

Consumers are separate work against the published tarball. Wiring this into the portfolio is a route file mounting the router, a page rendering the dashboard, an entry in `packages.json`, a sitemap line, and a blog post. None of that belongs in this repository and none of it blocks v0.1.0.

Scheduled package work, from [document 02](02-scope-and-mapping.md):

| Version | Adds |
|---|---|
| v0.2 | SQLite store, saved cohorts, annotations, revenue LTV, user activity and search |
| v0.3 | Taxonomy validation at ingest, lookup tables, privacy delete and export by user key |
