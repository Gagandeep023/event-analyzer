// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Cohorts } from './pages/Cohorts';

/**
 * The page's job is comparison, so the tests are about what it refuses to
 * claim: dimensions nothing has recorded, and lift from a sample too small to
 * support it.
 */
function fetcher({
  propertyKeys = [] as Array<{ scope: string; key: string }>,
  cohortUsers = ['u1'] as string[],
  cohortRows = [] as Array<{ value: string; users: number; share: number }>,
  overallRows = [] as Array<{ value: string; users: number; share: number }>,
}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    if (url.includes('/meta')) {
      body = {
        eventTypes: [{ event_type: 'Post Opened' }],
        propertyKeys: propertyKeys.map((k) => ({ ...k, types: ['string'], sampleValues: [] })),
        groupTypes: [], oldest: 0, newest: 1, totalEvents: 1,
      };
    } else if (url.includes('/query/cohort')) {
      body = {
        userIds: cohortUsers, size: cohortUsers.length,
        totalUsersInRange: 100, share: cohortUsers.length / 100, definition: {},
      };
    } else if (url.includes('/query/breakdown')) {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { userKeys?: string[] };
      const rows = sent.userKeys ? cohortRows : overallRows;
      body = { rows, total: 0, otherCount: 0, distinctValues: rows.length };
    } else {
      body = { series: [], buckets: [], granularity: 'day' };
    }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const api = (f: typeof fetch) => ({ baseUrl: '/api/events', fetcher: f });
const range = { from: 0, to: 86_400_000 };
const props = { range, tzOffsetMin: 0, eventTypes: ['Post Opened', 'Page Viewed'] };

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

describe('Cohorts page', () => {
  it('only renders comparison dimensions the collector has actually seen', async () => {
    render(<Cohorts api={api(fetcher({
      propertyKeys: [{ scope: 'context', key: 'site' }],
      cohortRows: [{ value: 'blog', users: 9, share: 0.9 }],
      overallRows: [{ value: 'blog', users: 50, share: 0.5 }],
    }))} {...props} />);

    await waitFor(() => expect(screen.getByText('Which site')).toBeDefined());
    // page_path was never recorded, so its panel must not appear at all.
    expect(screen.queryByText('What the cohort reads')).toBeNull();
  });

  it('says so plainly when there is nothing to compare on', async () => {
    render(<Cohorts api={api(fetcher({ propertyKeys: [] }))} {...props} />);
    await waitFor(() => {
      expect(screen.getByText(/none of the usual ones have been recorded/i)).toBeDefined();
    });
  });

  it('shows lift when the sample supports it', async () => {
    render(<Cohorts api={api(fetcher({
      propertyKeys: [{ scope: 'context', key: 'site' }],
      cohortUsers: Array.from({ length: 20 }, (_, i) => `u${i}`),
      cohortRows: [{ value: 'blog', users: 20, share: 0.9 }],
      overallRows: [{ value: 'blog', users: 50, share: 0.3 }],
    }))} {...props} />);
    await waitFor(() => expect(screen.getByText(/3\.0x/)).toBeDefined());
  });

  it('withholds lift when the cohort row is too small to mean anything', async () => {
    render(<Cohorts api={api(fetcher({
      propertyKeys: [{ scope: 'context', key: 'site' }],
      cohortUsers: ['u1', 'u2'],
      // Same 3x ratio as above, but off two people.
      cohortRows: [{ value: 'blog', users: 2, share: 0.9 }],
      overallRows: [{ value: 'blog', users: 50, share: 0.3 }],
    }))} {...props} />);
    await waitFor(() => expect(screen.getByText(/2 users/)).toBeDefined());
    expect(screen.queryByText(/3\.0x/)).toBeNull();
  });

  it('writes one user, not 1 users', async () => {
    render(<Cohorts api={api(fetcher({
      propertyKeys: [{ scope: 'context', key: 'site' }],
      cohortRows: [{ value: 'blog', users: 1, share: 1 }],
      overallRows: [{ value: 'blog', users: 50, share: 0.5 }],
    }))} {...props} />);
    await waitFor(() => expect(screen.getByText(/1 user ·/)).toBeDefined());
  });
});
