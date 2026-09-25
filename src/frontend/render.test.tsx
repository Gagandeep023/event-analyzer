// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EventAnalyzerDashboard } from './EventAnalyzerDashboard';

/** Minimal fake backend: meta plus whatever a page asks for. */
function fakeFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/meta')
      ? { eventTypes: [{ event_type: 'Signed Up' }, { event_type: 'Page Viewed' }], propertyKeys: [], groupTypes: [], oldest: 0, newest: 1, totalEvents: 2 }
      : url.includes('/query/events')
        ? { events: [{ event_type: 'Page Viewed', count: 10, users: 4, firstSeen: 0, lastSeen: Date.now(), share: 1 }], totalEvents: 10, totalUsers: 4, distinctTypes: 1 }
        : url.includes('/query/segmentation')
          ? { series: [{ label: 'x', points: [{ t: 0, value: 3 }], total: 3 }], buckets: [0], granularity: 'day' }
          : url.includes('/query/sessions')
            ? { totalSessions: 5, totalUsers: 4, medianDurationMs: 1000, p90DurationMs: 2000, meanEventsPerSession: 2, durationHistogram: [], stickiness: { dau: 1, wau: 2, mau: 4, dauOverMau: 0.25, dauOverWau: 0.5 }, sessionsOverTime: [] }
            : { steps: [], totalEntered: 0, totalConverted: 0, overallConversion: 0, medianTotalTimeMs: null, curve: [], table: [], totalUsers: 0, measure: 'unbounded', interval: 'week' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // ResizeObserver drives the chart width; jsdom has none.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

describe('EventAnalyzerDashboard', () => {
  it('renders the shell without crashing', async () => {
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fakeFetch()} />);
    expect(screen.getByText('Event Analyzer')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeDefined();
  });

  it('shows every navigation section', () => {
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fakeFetch()} />);
    for (const label of ['Overview', 'Events', 'Funnels', 'Cohorts', 'Retention', 'Live']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('reports collector health once meta resolves', async () => {
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fakeFetch()} />);
    await waitFor(() => expect(screen.getByText(/collector · healthy/)).toBeDefined());
  });

  it('surfaces an unreachable collector rather than rendering empty panels', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={failing} />);
    await waitFor(() => expect(screen.getByText(/collector · unreachable/)).toBeDefined());
  });

  it('honours a restricted page list', () => {
    render(<EventAnalyzerDashboard baseUrl="/api/events" fetcher={fakeFetch()} pages={['events']} />);
    expect(screen.getByRole('heading', { name: 'Events' })).toBeDefined();
    expect(screen.queryByText('Retention')).toBeNull();
  });
});
