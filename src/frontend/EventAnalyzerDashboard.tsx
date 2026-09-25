/**
 * The dashboard shell.
 *
 * Sidebar, header, and nine pages. Takes a base URL and a fetch wrapper; knows
 * nothing about the host application's routing, auth or styling beyond the CSS
 * custom properties it exposes.
 */

import React, { useMemo, useState } from 'react';
import type { MetaResponse } from '../types';
import { useMeta, type ApiContext, type Fetcher } from './hooks';
import { ErrorBox, Loading } from './components';
import { Overview, type Metric } from './pages/Overview';
import { Events } from './pages/Events';
import { Audience } from './pages/Audience';
import { Pages } from './pages/Pages';
import { Clicks } from './pages/Clicks';
import { Funnels, type FunnelDef } from './pages/Funnels';
import { Cohorts } from './pages/Cohorts';
import { Retention } from './pages/Retention';
import { Live } from './pages/Live';
import { fmt } from './theme';

export type PageKey =
  | 'overview' | 'audience' | 'pages' | 'clicks' | 'events'
  | 'funnels' | 'cohorts' | 'retention' | 'live';

export type RangeKey = '24h' | '7d' | '30d' | '90d';

const RANGES: ReadonlyArray<{ value: RangeKey; label: string; days: number }> = [
  { value: '24h', label: '24h', days: 1 },
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
  { value: '90d', label: '90d', days: 90 },
];

const PAGES: ReadonlyArray<{ key: PageKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'audience', label: 'Audience' },
  { key: 'pages', label: 'Pages' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'events', label: 'Events' },
  { key: 'funnels', label: 'Funnels' },
  { key: 'cohorts', label: 'Cohorts' },
  { key: 'retention', label: 'Retention' },
  { key: 'live', label: 'Live' },
];

export interface EventAnalyzerDashboardProps {
  /** Where the router is mounted, e.g. `/api/events`. */
  baseUrl: string;
  /** Inject an authenticated wrapper. Defaults to `window.fetch`. */
  fetcher?: Fetcher;
  /** Minutes east of UTC. Defaults to the viewer's own offset. */
  tzOffsetMin?: number;
  /** Shown in the sidebar footer. */
  projectName?: string;
  /** Which pages to show, in order. */
  pages?: PageKey[];
  defaultRange?: RangeKey;
  /**
   * Named funnels. When omitted, one is inferred from the most common event
   * types so the page is useful before anything is configured.
   */
  funnels?: FunnelDef[];
  /** Property to break users down by on Overview. Set null to hide the donut. */
  breakdownBy?: { scope: 'event' | 'user' | 'context' | 'group'; key: string } | null;
}

export function EventAnalyzerDashboard({
  baseUrl,
  fetcher,
  tzOffsetMin,
  projectName,
  pages = [
    'overview', 'audience', 'pages', 'clicks', 'events',
    'funnels', 'cohorts', 'retention', 'live',
  ],
  defaultRange = '7d',
  funnels,
  breakdownBy = { scope: 'context', key: 'site' },
}: EventAnalyzerDashboardProps): React.ReactElement {
  const [page, setPage] = useState<PageKey>(pages[0] ?? 'overview');
  const [rangeKey, setRangeKey] = useState<RangeKey>(defaultRange);
  const [metric, setMetric] = useState<Metric>('users');

  const api: ApiContext = useMemo(
    () => ({ baseUrl: baseUrl.replace(/\/$/, ''), fetcher: fetcher ?? fetch.bind(globalThis) }),
    [baseUrl, fetcher],
  );

  const offset = tzOffsetMin ?? -new Date().getTimezoneOffset();
  const days = RANGES.find((r) => r.value === rangeKey)?.days ?? 7;
  const range = useMemo(() => {
    const to = Date.now();
    return { from: to - days * 86_400_000, to };
  }, [days]);
  const granularity = days <= 1 ? ('hour' as const) : ('day' as const);

  const meta = useMeta(api);
  const eventTypes = useMemo(
    () => (meta.data?.eventTypes ?? []).map((e) => e.event_type),
    [meta.data],
  );

  // Without a configured funnel, the first few discovered event types are a
  // better default than an empty panel.
  const resolvedFunnels: FunnelDef[] = useMemo(() => {
    if (funnels && funnels.length) return funnels;
    if (eventTypes.length < 2) return [];
    return [{ name: 'Discovered flow', steps: eventTypes.slice(0, 4) }];
  }, [funnels, eventTypes]);

  const subtitle = SUBTITLES[page](meta.data, rangeKey);
  const showRange = page !== 'retention' && page !== 'live';

  return (
    <div className="ea">
      <aside className="ea-side">
        <div className="ea-logo">
          <span className="ea-logo-mark" aria-hidden />
          <span className="ea-logo-text">Event Analyzer</span>
        </div>

        <nav className="ea-nav" aria-label="Sections">
          {pages.map((key) => {
            const item = PAGES.find((p) => p.key === key);
            if (!item) return null;
            return (
              <button
                key={key}
                type="button"
                aria-current={page === key ? 'page' : undefined}
                onClick={() => setPage(key)}
              >
                <span>{item.label}</span>
                {key === 'live' ? <span className="ea-live-dot" aria-hidden /> : null}
              </button>
            );
          })}
        </nav>

        <div className="ea-side-foot">
          <span className="k">Project</span>
          <span className="v">{projectName ?? 'this deployment'}</span>
          <span className="s">
            {meta.error ? 'collector · unreachable' : meta.data ? 'collector · healthy' : 'collector · …'}
          </span>
        </div>
      </aside>

      <main className="ea-main">
        <header className="ea-head">
          <div>
            <h1 className="ea-title">{PAGES.find((p) => p.key === page)?.label}</h1>
            <p className="ea-subtitle">{subtitle}</p>
          </div>
          {showRange ? (
            <div className="ea-seg" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <button key={r.value} type="button" aria-pressed={r.value === rangeKey}
                        onClick={() => setRangeKey(r.value)}>
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {meta.error ? <ErrorBox message={meta.error} /> : null}
        {meta.loading && !meta.data ? <Loading height={260} /> : null}

        {page === 'overview' ? (
          <Overview
            api={api}
            range={range}
            granularity={granularity}
            tzOffsetMin={offset}
            metric={metric}
            onMetric={setMetric}
            funnelSteps={resolvedFunnels[0]?.steps ?? []}
            onOpenFunnel={() => setPage('funnels')}
            onOpenEvents={() => setPage('events')}
            breakdownKey={breakdownBy}
          />
        ) : null}

        {page === 'audience' ? <Audience api={api} range={range} tzOffsetMin={offset} /> : null}

        {page === 'pages' ? (
          <Pages api={api} range={range} tzOffsetMin={offset}
                 pageEvent={eventTypes.find((t) => /page|view/i.test(t)) ?? null} />
        ) : null}

        {page === 'clicks' ? <Clicks api={api} range={range} tzOffsetMin={offset} /> : null}

        {page === 'events' ? <Events api={api} range={range} tzOffsetMin={offset} /> : null}

        {page === 'funnels' ? (
          <Funnels api={api} range={range} tzOffsetMin={offset} funnels={resolvedFunnels} />
        ) : null}

        {page === 'cohorts' ? (
          <Cohorts api={api} range={range} tzOffsetMin={offset} eventTypes={eventTypes} />
        ) : null}

        {page === 'retention' ? (
          <Retention api={api} range={range} tzOffsetMin={offset} startEvent={eventTypes[0] ?? null} />
        ) : null}

        {page === 'live' ? <Live api={api} /> : null}
      </main>
    </div>
  );
}

const SUBTITLES: Record<PageKey, (meta: MetaResponse | null, range: RangeKey) => string> = {
  overview: () => 'How the product is doing, at a glance.',
  audience: () => 'Who is visiting, on what, and when.',
  pages: () => 'Where people land and where they came from.',
  clicks: () => 'What people press, and where it takes them.',
  cohorts: () => 'Define a group by what they did, then see what they do differently.',
  events: (meta, range) =>
    `${meta ? fmt(meta.eventTypes.length) : '—'} tracked events · last ${range}`,
  funnels: () => 'Where people progress and where they drop.',
  retention: () => 'Share of each cohort that came back.',
  live: () => 'Events as the collector receives them.',
};
