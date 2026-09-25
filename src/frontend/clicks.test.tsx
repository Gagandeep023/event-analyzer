// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Clicks } from './pages/Clicks';

/**
 * An empty Clicks page has two very different causes, and the copy has to tell
 * them apart. Advising someone to switch on an option they already switched on
 * sends them hunting a bug that is not there.
 */
function fetcherWith(eventTypes: string[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/meta')
      ? {
          eventTypes: eventTypes.map((event_type) => ({ event_type })),
          propertyKeys: [], groupTypes: [], oldest: 0, newest: 1, totalEvents: 1,
        }
      // Every breakdown comes back empty: the window is quiet either way.
      : { rows: [], total: 0, otherCount: 0, distinctValues: 0 };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const range = { from: 0, to: 86_400_000 };

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

describe('Clicks empty states', () => {
  it('tells you to enable capture only when no click has ever arrived', async () => {
    render(
      <Clicks
        api={{ baseUrl: '/api/events', fetcher: fetcherWith(['Page Viewed']) }}
        range={range}
        tzOffsetMin={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Capture is off until asked for/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/wider window/i)).toBeNull();
  });

  it('does not blame configuration once clicks are known to arrive', async () => {
    render(
      <Clicks
        api={{ baseUrl: '/api/events', fetcher: fetcherWith(['Page Viewed', 'Element Clicked']) }}
        range={range}
        tzOffsetMin={0}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByText(/wider window/i).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Capture is off until asked for/i)).toBeNull();
  });
});
