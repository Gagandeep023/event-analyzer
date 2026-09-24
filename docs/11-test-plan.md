# 11. Test plan

Roughly 130 vitest specs. The distribution is deliberately lopsided: `core` carries most of it, because `core` is where a silent wrong number can hide.

A wrong number in analytics is worse than a crash. A crash you notice.

## Distribution

| File | Specs | Focus |
|---|---|---|
| `core/filter.test.ts` | 18 | Every operator, missing properties, type mismatches, dot paths, `*` wildcard |
| `core/funnel.test.ts` | 22 | All three modes, window boundary, exclusions, re-entry, grouping, monotonicity |
| `core/retention.test.ts` | 20 | All three measures against a hand-built fixture, `incomplete` denominators, interval arithmetic |
| `core/sessions.test.ts` | 12 | Derivation with and without `session_id`, gap splitting, stickiness, histogram bins |
| `core/cohort.test.ts` | 10 | did / didNot, frequency bounds, window anchoring, property filters |
| `core/identity.test.ts` | 9 | Union-find merges, canonical key preference, transitive chains, unidentified events |
| `core/time.test.ts` | 11 | Bucket boundaries, DST transitions, non-zero tz offsets, week and month starts |
| `core/properties.test.ts` | 10 | All ten `$` operations, precedence, `$clearAll` dominance, type guards |
| `core/stats.test.ts` | 6 | Percentile interpolation, empty and single-element inputs |
| `sdk/timeline.test.ts` | 9 | Plugin ordering, `null` drops, concurrent same-name registration, teardown |
| `sdk/destination.test.ts` | 14 | Batching, 413 split, 400 partial drop, 429 backoff, retry ceiling, persist and replay |
| `sdk/session.test.ts` | 6 | Timeout boundary, resume from storage, explicit `setSessionId`, `extendSession` |
| `backend/validate.test.ts` | 12 | Every rejection reason, index correctness, partial acceptance, truncation |
| `backend/stores.test.ts` | 8 | Both stores against the same interface suite, eviction, rotation, range index |
| `integration.test.ts` | 7 | SDK to router to store to query, round trip through a real Express instance |
| **Total** | **~130** | |

## Two invariants worth asserting directly

### Funnel monotonicity

For any generated input:

```ts
for (let i = 1; i < result.steps.length; i++) {
  expect(result.steps[i].count).toBeLessThanOrEqual(result.steps[i - 1].count);
}
```

A violation means the walk is double-counting a re-entry. This is the single easiest bug to introduce in `funnel.ts` and the hardest to spot by eye, because the output still looks like a plausible funnel.

### Export round trip

Events written through `/collect`, exported via `/export`, and replayed into a second store must produce byte-identical query results.

This is what makes the "one event shape everywhere" principle from [document 02](02-scope-and-mapping.md) enforceable rather than aspirational. If an internal representation ever diverges from the wire format, this test fails immediately.

## Fixtures

Hand-built and tiny.

A retention fixture of nine users across five days, where the correct answer for all three measures has been worked out on paper, is worth more than ten thousand generated events whose expected output is produced by the same code under test. The second kind of test only proves the code agrees with itself.

Each `core` test file owns a small fixture in a sibling `__fixtures__` directory, written as a plain array of events with a comment block explaining what the correct answers are and why.

### The retention fixture specifically

Nine users, five days, chosen so that all three measures give **different** answers. If `n-day`, `unbounded` and `bracket` produce identical numbers on a fixture, that fixture is not exercising the difference between them, and the most likely real bug (all three code paths accidentally doing the same thing) would pass.

### The timezone fixture

Events placed deliberately either side of midnight in IST but not in UTC, so a bucketing implementation that ignores `tzOffsetMin` puts them in the wrong day and the test catches it. Plus a DST transition fixture for a zone that has one, since "one day" is not always 24 hours.

## What is not tested

Stated so the gaps are deliberate rather than accidental:

- **Frontend components.** No component tests in v0.1. The panels are thin wrappers over `useQuery` and Recharts; the logic worth testing lives in `core` and is tested there. This is a conscious tradeoff, not an oversight, and it is revisited if the panels grow logic of their own.
- **Real browser behaviour.** `localStorage` quota exhaustion, `sendBeacon` during unload, and SPA history interception are tested against fakes. Real-browser verification happens by hand against the demo app.
- **Store performance.** There is no benchmark suite in v0.1. The known scaling limit of `JsonlFileStore` is documented in [document 12](12-risks.md) rather than measured.

## Running

```bash
npm test              # vitest run
npm run test:watch    # vitest
npm run test -- --coverage
```

Coverage is reported but not gated. A coverage threshold on a package where one module deliberately carries 90 percent of the tests produces a number that means nothing.
