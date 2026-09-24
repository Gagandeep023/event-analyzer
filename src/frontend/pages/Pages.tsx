/**
 * Where people land and where they come from.
 *
 * Page paths rather than full URLs: a URL carrying a query string groups into
 * thousands of distinct "pages" and makes the table useless.
 */

import React, { useMemo } from 'react';
import type { BreakdownResult, TimeRange } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel } from '../components';
import { Donut } from '../charts';
import { BreakdownTable } from './Audience';
import { fmt, pct } from '../theme';

export function Pages({
  api, range, tzOffsetMin, pageEvent,
}: {
  api: ApiContext; range: TimeRange; tzOffsetMin: number; pageEvent: string | null;
}): React.ReactElement {
  const base = useMemo(() => ({ range, tzOffsetMin, limit: 12, compare: true }), [range, tzOffsetMin]);

  const pages = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    ...base,
    property: { scope: 'context', key: 'page_path' },
    ...(pageEvent ? { event: { event_type: pageEvent } } : {}),
  }), [base, pageEvent]));

  const referrers = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    ...base, property: { scope: 'context', key: 'referrer_host' },
  }), [base]));

  const channels = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    ...base, property: { scope: 'context', key: 'referrer_channel' }, limit: 8,
  }), [base]));

  const campaigns = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    ...base, property: { scope: 'context', key: 'utm_source' }, limit: 8,
  }), [base]));

  return (
    <>
      <div className="ea-section">
        <Panel
          title="Top pages"
          aside={pages.data ? `${pages.data.distinctValues} paths · ${fmt(pages.data.totalUsers)} people` : null}
        >
          <Async state={pages} height={220}>
            {(d) => d.rows.length === 0 ? (
              <p className="ea-empty">
                No page paths captured. Page views need <code>autocapture: {'{ pageViews: true }'}</code>.
              </p>
            ) : (
              <table className="ea-table">
                <thead>
                  <tr><th>Path</th><th className="r">Users</th><th className="r">Views</th><th className="r">Share</th><th className="r">Change</th></tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.value}>
                      <td className="mono">{r.value}</td>
                      <td className="r">{r.users.toLocaleString()}</td>
                      <td className="r muted">{r.events.toLocaleString()}</td>
                      <td className="r muted">{pct(r.share, 0)}</td>
                      <td className="r"><Delta change={r.change} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Async>
        </Panel>
      </div>

      <div className="ea-grid ea-section">
        <Panel title="Traffic channels">
          <Async state={channels} height={170}>
            {(d) => d.rows.length === 0
              ? <p className="ea-empty">Nothing captured in this range.</p>
              : <Donut data={d.rows.map((r) => ({ label: r.value, value: r.users }))} size={144} />}
          </Async>
        </Panel>

        <Panel title="Top referrers">
          <Async state={referrers} height={170}>
            {(d) => <BreakdownTable rows={d.rows} />}
          </Async>
        </Panel>
      </div>

      <Panel title="Campaigns" aside="utm_source">
        <Async state={campaigns} height={140}>
          {(d) => d.rows.filter((r) => r.value !== '(not set)').length === 0
            ? <p className="ea-empty">No campaign parameters seen. Links with <code>?utm_source=</code> appear here.</p>
            : <BreakdownTable rows={d.rows.filter((r) => r.value !== '(not set)')} />}
        </Async>
      </Panel>
    </>
  );
}
