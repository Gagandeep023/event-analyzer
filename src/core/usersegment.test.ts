import { describe, it, expect } from 'vitest';
import { buildCohort } from './cohort';
import { segmentation } from './segmentation';
import { breakdown } from './breakdown';
import { eventStats } from './events';
import { retention } from './retention';
import { sessionStats } from './sessions';
import { growth } from './growth';
import { activity } from './activity';
import { funnel } from './funnel';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange, wideRange } from './__fixtures__';

/**
 * `userKeys` is how a cohort is reused as a segment: run `cohort`, feed its
 * `userIds` into the next query. Before this existed the cohort result was a
 * dead end, because `segment` filters address properties and cannot express
 * "this person is one of these users".
 */
const FIXTURE = [
  // amy qualifies: she reads a post.
  ev({ type: 'Post Opened', user: 'amy', t: day(0), context: { page_path: '/a' } }),
  ev({ type: 'Page Viewed', user: 'amy', t: day(1), context: { page_path: '/a' } }),
  ev({ type: 'Page Viewed', user: 'amy', t: day(2), context: { page_path: '/a' } }),
  // ben never reads a post, so he must vanish from a post-reader cohort.
  ev({ type: 'Page Viewed', user: 'ben', t: day(0), context: { page_path: '/b' } }),
  ev({ type: 'Page Viewed', user: 'ben', t: day(1), context: { page_path: '/b' } }),
];

const range = wideRange();

function postReaders(source = FIXTURE) {
  return buildCohort(source, { range, did: [{ step: { event_type: 'Post Opened' } }] });
}

describe('cohort reuse via userKeys', () => {
  it('selects only the qualifying users', () => {
    const c = postReaders();
    expect(c.userIds).toEqual(['amy']);
    expect(c.size).toBe(1);
    expect(c.totalUsersInRange).toBe(2);
  });

  it('narrows every analysis to the cohort', () => {
    const userKeys = postReaders().userIds;
    const base = { range, tzOffsetMin: 0 };

    // Page breakdown: ben's page disappears entirely.
    const all = breakdown(FIXTURE, { ...base, property: { scope: 'context', key: 'page_path' } });
    const only = breakdown(FIXTURE, {
      ...base, property: { scope: 'context', key: 'page_path' }, userKeys,
    });
    expect(all.rows.map((r) => r.value).sort()).toEqual(['/a', '/b']);
    expect(only.rows.map((r) => r.value)).toEqual(['/a']);

    // Event stats, sessions and growth all drop to the single user.
    expect(eventStats(FIXTURE, { ...base, userKeys }).totalUsers).toBe(1);
    expect(sessionStats(FIXTURE, { ...base, granularity: 'day', userKeys }).totalUsers).toBe(1);
    expect(growth(FIXTURE, { ...base, interval: 'day', userKeys }).points.every(
      (p) => p.active <= 1,
    )).toBe(true);

    // Activity and segmentation count only cohort events.
    const act = activity(FIXTURE, { ...base, countBy: 'totals', userKeys });
    expect(act.byDay.reduce((a, b) => a + b, 0)).toBe(3);

    const seg = segmentation(FIXTURE, {
      ...base, granularity: 'day', events: [{ event_type: '*' }], countBy: 'totals', userKeys,
    });
    expect(seg.series[0]!.total).toBe(3);
  });

  it('leaves every analysis untouched when the list is absent or empty', () => {
    const base = { range, tzOffsetMin: 0 };
    const full = eventStats(FIXTURE, base).totalUsers;
    expect(eventStats(FIXTURE, { ...base, userKeys: [] }).totalUsers).toBe(full);
    expect(eventStats(FIXTURE, { ...base, userKeys: undefined }).totalUsers).toBe(full);
  });

  it('keeps pre-login events, matching the resolved key not the raw user_id', () => {
    // The same person: anonymous on day 0, logged in from day 1.
    const source = [
      ev({ type: 'Page Viewed', device: 'dev-1', t: day(0), context: { page_path: '/pre' } }),
      ev({ type: 'Post Opened', user: 'amy', device: 'dev-1', t: day(1) }),
      ev({ type: 'Page Viewed', user: 'amy', device: 'dev-1', t: day(2), context: { page_path: '/post' } }),
    ];
    const graph = buildIdentityGraph(source);
    const c = buildCohort(source, { range, did: [{ step: { event_type: 'Post Opened' } }] }, graph);
    expect(c.size).toBe(1);

    // The anonymous day-0 page view must survive the cohort filter. Matching on
    // the raw user_id would drop it, because that event has no user_id at all.
    const pages = breakdown(source, {
      range, tzOffsetMin: 0, property: { scope: 'context', key: 'page_path' }, userKeys: c.userIds,
    }, graph);
    // `Post Opened` carries no page_path, hence the `(not set)` bucket; what
    // matters is that the anonymous `/pre` view survived.
    const values = pages.rows.map((r) => r.value).filter((v) => v !== '(not set)');
    expect(values.sort()).toEqual(['/post', '/pre']);
  });

  it('narrows retention and funnels too', () => {
    const userKeys = postReaders().userIds;
    const r = retention(FIXTURE, {
      range: daysRange(5), tzOffsetMin: 0,
      startAction: { event_type: '*' }, returnAction: { event_type: '*' },
      interval: 'day', periods: 2, measure: 'n-day', userKeys,
    });
    expect(r.table.reduce((n, row) => n + row.cohortSize, 0)).toBe(1);

    const f = funnel(FIXTURE, {
      range, tzOffsetMin: 0,
      steps: [{ event_type: 'Post Opened' }, { event_type: 'Page Viewed' }],
      order: 'ordered', countBy: 'uniques',
      conversionWindowMs: 7 * 86_400_000,
      userKeys,
    });
    expect(f.totalEntered).toBe(1);
  });
});
