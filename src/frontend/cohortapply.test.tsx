// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EventAnalyzerDashboard } from './EventAnalyzerDashboard';

/**
 * Applying a cohort on one page and reading it on another.
 *
 * The case worth protecting is a cohort that WAS populated and then empties
 * because the range narrowed. An empty `userKeys` means "everyone" to the
 * engine, so falling through would show the whole population under a banner
 * saying the page is filtered.
 */
function backend() {
  const calls: Array<{ kind: string; userKeys?: string[] }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = {};
    if (url.includes('/meta')) {
      body = {
        eventTypes: [{ event_type: 'Signed Up' }, { event_type: 'Plan Upgraded' }],
        propertyKeys: [{ scope: 'context', key: 'site', types: ['string'], sampleValues: [] }],
        groupTypes: [], oldest: 0, newest: Date.now(), totalEvents: 10,
      };
    } else if (url.includes('/query/')) {
      const kind = url.split('/query/')[1]!;
      const q = JSON.parse(String(init?.body ?? '{}')) as {
        range?: { from: number; to: number }; userKeys?: string[];
      };
      calls.push({ kind, userKeys: q.userKeys });
      if (kind === 'cohort') {
        // Populated over a wide window, empty once the window is a day.
        const span = (q.range?.to ?? 0) - (q.range?.from ?? 0);
        const ids = span > 2 * 86_400_000 ? ['u:a', 'u:b'] : [];
        body = { userIds: ids, size: ids.length, totalUsersInRange: 50, share: ids.length / 50, definition: {} };
      } else if (kind === 'funnel') {
        body = { steps: [], totalEntered: 0, totalConverted: 0, overallConversion: 0,
                 medianTotalTimeMs: null };
      } else if (kind === 'breakdown') {
        body = { rows: [], total: 0, otherCount: 0, distinctValues: 0 };
      } else {
        body = { series: [], buckets: [], granularity: 'day', points: [], curve: [], table: [],
                 totals: { newUsers: 0, resurrected: 0, churned: 0 }, quickRatio: null };
      }
    }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

async function applyCohort(calls: Array<{ kind: string; userKeys?: string[] }>) {
  fireEvent.click(screen.getByRole('button', { name: 'Cohorts' }));
  await waitFor(() => expect(screen.getByText('Define the cohort')).toBeDefined());
  await waitFor(() => expect(calls.some((c) => c.kind === 'cohort')).toBe(true));
  const apply = await screen.findByRole('button', { name: /Apply to Retention and Funnels/i });
  fireEvent.click(apply);
}

describe('applying a cohort across pages', () => {
  it('carries the cohort into the funnel query', async () => {
    const { fetcher, calls } = backend();
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fetcher} defaultRange="30d" />);
    await applyCohort(calls);

    fireEvent.click(screen.getByRole('button', { name: 'Funnels' }));
    await waitFor(() => expect(screen.getByText(/Filtered to/)).toBeDefined());
    await waitFor(() => {
      expect(calls.some((c) => c.kind === 'funnel' && c.userKeys?.length === 2)).toBe(true);
    });
  });

  it('refuses to show everyone when the cohort empties', async () => {
    const { fetcher, calls } = backend();
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fetcher} defaultRange="30d" />);
    await applyCohort(calls);

    fireEvent.click(screen.getByRole('button', { name: 'Funnels' }));
    await waitFor(() => expect(screen.getByText(/Filtered to/)).toBeDefined());

    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '24h' }));

    await waitFor(() => expect(screen.getByText(/has no members in this range/i)).toBeDefined());
    // The critical part: no unfiltered funnel query may be issued.
    expect(calls.some((c) => c.kind === 'funnel' && !c.userKeys)).toBe(false);
  });
});
