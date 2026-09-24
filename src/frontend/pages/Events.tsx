import React, { useMemo, useState } from 'react';
import type { EventsResult, TimeRange } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel } from '../components';
import { Donut } from '../charts';
import { ago, fmt, pct } from '../theme';

export function Events({
  api, range, tzOffsetMin,
}: { api: ApiContext; range: TimeRange; tzOffsetMin: number }): React.ReactElement {
  const [query, setQuery] = useState('');

  // Search is applied client-side so typing does not refetch on every keystroke.
  const body = useMemo(() => ({ range, tzOffsetMin, limit: 200, compare: true }), [range, tzOffsetMin]);
  const state = useQuery<EventsResult>(api, 'events', body);

  const rows = useMemo(() => {
    const all = state.data?.events ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((e) => e.event_type.toLowerCase().includes(q)) : all;
  }, [state.data, query]);

  return (
    <>
      <div className="ea-grid ea-section" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <Panel title="All events" aside={state.data ? `${state.data.distinctTypes} types · ${fmt(state.data.totalEvents)} events` : null}>
          <input
            className="ea-input"
            placeholder="Filter events…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter events"
          />
          <Async state={state} height={280}>
            {() => rows.length === 0 ? (
              <p className="ea-empty">
                {query ? <>No events match &ldquo;{query}&rdquo;.</> : 'No events in this range.'}
              </p>
            ) : (
              <table className="ea-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th className="r">Count</th>
                    <th className="r">Users</th>
                    <th className="r">Share</th>
                    <th className="r">Change</th>
                    <th className="r">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr key={e.event_type}>
                      <td className="mono">{e.event_type}</td>
                      <td className="r">{e.count.toLocaleString()}</td>
                      <td className="r">{e.users.toLocaleString()}</td>
                      <td className="r muted">{pct(e.share, 1)}</td>
                      <td className="r"><Delta change={e.change} /></td>
                      <td className="r muted">{ago(e.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Async>
        </Panel>

        <Panel title="Share of volume">
          <Async state={state} height={200}>
            {(d) => <Donut data={d.events.map((e) => ({ label: e.event_type, value: e.count }))} />}
          </Async>
        </Panel>
      </div>
    </>
  );
}
