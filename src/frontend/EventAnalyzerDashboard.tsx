/**
 * The dashboard.
 *
 * Takes a base URL and a fetch wrapper. Knows nothing about the host
 * application's routing, auth or styling beyond the CSS custom properties it
 * exposes for theming.
 */

import React, { useMemo, useRef, useState } from 'react';
import type { ApiContext } from './hooks';
import { useMeta } from './hooks';
import { ErrorBox, Loading } from './components';
import {
  CohortPanel, EventsPanel, FunnelPanel, LivePanel, RetentionPanel, SessionsPanel,
} from './panels';

export type PanelKey = 'live' | 'events' | 'funnel' | 'retention' | 'sessions' | 'cohort';

const PANEL_LABELS: Record<PanelKey, string> = {
  live: 'Live',
  events: 'Events',
  funnel: 'Funnel',
  retention: 'Retention',
  sessions: 'Sessions',
  cohort: 'Cohort',
};

const DEFAULT_PANELS: PanelKey[] = ['events', 'funnel', 'retention', 'sessions', 'cohort', 'live'];

export interface EventAnalyzerDashboardProps {
  /** Where the router is mounted, e.g. `/api/events`. */
  baseUrl: string;
  /** Inject an authenticated wrapper here. Defaults to `window.fetch`. */
  fetcher?: typeof fetch;
  /** Minutes east of UTC. Defaults to the browser's own offset. */
  tzOffsetMin?: number;
  /** Which panels to show, in order. */
  panels?: PanelKey[];
  /** Heading shown above the tabs. Pass null to omit it. */
  title?: string | null;
}

export function EventAnalyzerDashboard({
  baseUrl,
  fetcher,
  tzOffsetMin,
  panels = DEFAULT_PANELS,
  title = 'Event Analyzer',
}: EventAnalyzerDashboardProps): React.ReactElement {
  const [active, setActive] = useState<PanelKey>(panels[0] ?? 'events');
  const tabsRef = useRef<HTMLDivElement>(null);

  const api: ApiContext = useMemo(
    () => ({ baseUrl: baseUrl.replace(/\/$/, ''), fetcher: fetcher ?? fetch.bind(globalThis) }),
    [baseUrl, fetcher],
  );

  const offset = tzOffsetMin ?? -new Date().getTimezoneOffset();
  const { data: meta, error, loading } = useMeta(api);

  const onTabKeyDown = (e: React.KeyboardEvent): void => {
    const i = panels.indexOf(active);
    if (e.key === 'ArrowRight') setActive(panels[(i + 1) % panels.length]!);
    else if (e.key === 'ArrowLeft') setActive(panels[(i - 1 + panels.length) % panels.length]!);
    else return;
    e.preventDefault();
  };

  const props = { api, meta, tzOffsetMin: offset };

  return (
    <div className="ea-root">
      <header className="ea-head">
        {title ? <h1 className="ea-title">{title}</h1> : null}
        {meta ? (
          <p className="ea-sub">
            {meta.totalEvents.toLocaleString()} events
            {meta.eventTypes.length > 0 ? ` · ${meta.eventTypes.length} types` : ''}
          </p>
        ) : null}
      </header>

      <div className="ea-tabs" role="tablist" aria-label="Panels" ref={tabsRef} onKeyDown={onTabKeyDown}>
        {panels.map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            id={`ea-tab-${key}`}
            aria-selected={key === active}
            aria-controls={`ea-panel-${key}`}
            tabIndex={key === active ? 0 : -1}
            className={`ea-tab${key === active ? ' ea-tab-on' : ''}`}
            onClick={() => setActive(key)}
          >
            {PANEL_LABELS[key]}
          </button>
        ))}
      </div>

      <div id={`ea-panel-${active}`} role="tabpanel" aria-labelledby={`ea-tab-${active}`}>
        {error ? <ErrorBox message={error} /> : null}
        {loading && !meta ? <Loading /> : null}

        {active === 'live' ? <LivePanel {...props} /> : null}
        {active === 'events' ? <EventsPanel {...props} /> : null}
        {active === 'funnel' ? <FunnelPanel {...props} /> : null}
        {active === 'retention' ? <RetentionPanel {...props} /> : null}
        {active === 'sessions' ? <SessionsPanel {...props} /> : null}
        {active === 'cohort' ? <CohortPanel {...props} /> : null}
      </div>
    </div>
  );
}
