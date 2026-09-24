/**
 * Who the visitors are.
 *
 * Every panel is the same breakdown query pointed at a different property, so
 * adding a dimension is a one-line change rather than a new analysis.
 */

import React, { useMemo, useState } from 'react';
import type { ActivityResult, BreakdownResult, PropertyRef, TimeRange } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel, Segmented } from '../components';
import { ActivityGrid, BarList, Donut } from '../charts';
import { fmt, pct } from '../theme';

interface Dimension {
  key: string;
  label: string;
  property: PropertyRef;
  chart: 'bars' | 'donut';
}

const DIMENSIONS: Dimension[] = [
  { key: 'browser', label: 'Browser', property: { scope: 'context', key: 'browser' }, chart: 'donut' },
  { key: 'os', label: 'Operating system', property: { scope: 'context', key: 'os_name' }, chart: 'donut' },
  { key: 'device', label: 'Device', property: { scope: 'context', key: 'device_type' }, chart: 'donut' },
  { key: 'country', label: 'Country', property: { scope: 'context', key: 'country' }, chart: 'bars' },
  { key: 'language', label: 'Language', property: { scope: 'context', key: 'language' }, chart: 'bars' },
  { key: 'site', label: 'Site', property: { scope: 'context', key: 'site' }, chart: 'donut' },
];

function BreakdownPanel({
  api, range, tzOffsetMin, dim, rankBy,
}: {
  api: ApiContext; range: TimeRange; tzOffsetMin: number; dim: Dimension; rankBy: 'users' | 'events';
}) {
  const body = useMemo(
    () => ({ property: dim.property, range, tzOffsetMin, limit: 8, rankBy, compare: true }),
    [dim.property, range, tzOffsetMin, rankBy],
  );
  const state = useQuery<BreakdownResult>(api, 'breakdown', body);

  return (
    <Panel title={dim.label} aside={state.data ? `${state.data.distinctValues} values` : null}>
      <Async state={state} height={170}>
        {(d) => d.rows.length === 0
          ? <p className="ea-empty">Not captured in this range.</p>
          : dim.chart === 'donut'
            ? <Donut data={d.rows.map((r) => ({ label: r.value, value: rankBy === 'users' ? r.users : r.events }))} size={144} />
            : (
              <table className="ea-table">
                <thead>
                  <tr><th>{dim.label}</th><th className="r">Users</th><th className="r">Share</th><th className="r">Change</th></tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.value}>
                      <td className="mono">{r.value}</td>
                      <td className="r">{r.users.toLocaleString()}</td>
                      <td className="r muted">{pct(r.share, 0)}</td>
                      <td className="r"><Delta change={r.change} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </Async>
    </Panel>
  );
}

export function Audience({
  api, range, tzOffsetMin,
}: { api: ApiContext; range: TimeRange; tzOffsetMin: number }): React.ReactElement {
  const [rankBy, setRankBy] = useState<'users' | 'events'>('users');

  const activityState = useQuery<ActivityResult>(api, 'activity', useMemo(
    () => ({ range, tzOffsetMin, countBy: 'uniques' }), [range, tzOffsetMin]));

  return (
    <>
      <div className="ea-section">
        <Panel
          title="When people are here"
          aside={
            <Segmented
              value={rankBy} onChange={setRankBy} label="Rank by"
              options={[{ value: 'users', label: 'Users' }, { value: 'events', label: 'Events' }]}
            />
          }
        >
          <Async state={activityState} height={200}>
            {(d) => d.peak === 0
              ? <p className="ea-empty">No activity in this range.</p>
              : <ActivityGrid data={d} />}
          </Async>
        </Panel>
      </div>

      <div className="ea-grid ea-section">
        {DIMENSIONS.map((dim) => (
          <BreakdownPanel key={dim.key} api={api} range={range} tzOffsetMin={tzOffsetMin}
                          dim={dim} rankBy={rankBy} />
        ))}
      </div>
    </>
  );
}

/** Reused by the Pages view for its bar tables. */
export function BreakdownTable({
  rows, metric = 'users',
}: {
  rows: BreakdownResult['rows'];
  metric?: 'users' | 'events';
}): React.ReactElement {
  if (rows.length === 0) return <p className="ea-empty">Nothing captured in this range.</p>;
  return (
    <BarList
      data={rows.map((r) => ({
        label: r.value,
        value: metric === 'users' ? r.users : r.events,
        hint: `${fmt(metric === 'users' ? r.users : r.events)} · ${pct(r.share, 0)}`,
      }))}
    />
  );
}
