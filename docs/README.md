# event-analyzer docs

Design and planning documentation for `@gagandeep023/event-analyzer`, a self-hosted product analytics package.

Read in order. Documents 01 and 02 establish what exists and what we are choosing to build. Documents 03 through 09 are the implementation contract. Documents 10 through 12 are the build plan.

| # | Document | What it covers |
|---|---|---|
| 01 | [Amplitude API atlas](01-amplitude-api-atlas.md) | Every Amplitude API, catalogued from their full docs corpus. 89 references, ~250 endpoints. |
| 02 | [Scope and mapping](02-scope-and-mapping.md) | Which of those we build, which we skip, and the filter used to decide. |
| 03 | [Architecture](03-architecture.md) | Module layout, dependency direction, package configuration. |
| 04 | [API reference](04-api-reference.md) | Our HTTP surface. Every endpoint, request and response, in full. |
| 05 | [Type contract](05-types.md) | The shared type definitions every module agrees on. |
| 06 | [Core engine](06-core-engine.md) | The analysis algorithms: funnels, retention, cohorts, sessions, segmentation. |
| 07 | [Capture SDK](07-sdk.md) | Client API, plugin pipeline, delivery and retry. |
| 08 | [Backend](08-backend.md) | Express router, validation, storage adapters. |
| 09 | [Frontend](09-frontend.md) | React dashboard and its panels. |
| 10 | [Build plan](10-build-plan.md) | Five phases with explicit done criteria. |
| 11 | [Test plan](11-test-plan.md) | ~130 specs and the two invariants worth asserting. |
| 12 | [Risks and open questions](12-risks.md) | Known weaknesses and decisions still outstanding. |

## Source material

The Amplitude research in document 01 was taken from `https://amplitude.com/docs/llms-full.txt`, their complete documentation corpus, retrieved 2026-09-24. That file contains 725 pages, of which 89 are API references. Where this documentation quotes a limit, a default or a field name, it comes from that corpus rather than from recollection.

The SDK architecture notes in documents 06 and 07 were taken from reading `github.com/amplitude/Amplitude-TypeScript` at `main`, which is the open-source reference implementation of their client. Their analysis engine is not open source, so documents 04 and 06 reimplement it from documented semantics.

## Status

Planning complete. No code written yet. Build starts at [phase 1](10-build-plan.md#phase-1-scaffold-and-types).
