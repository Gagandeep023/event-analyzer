/**
 * What people actually press.
 *
 * Page views tell you where someone went; clicks tell you what they reached
 * for. Every panel here is one breakdown query against a property the click
 * autocapture plugin records.
 */

import React, { useMemo, useState } from 'react';
import type { BreakdownResult, PropertyRef, TimeRange } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel, Segmented } from '../components';
import { Donut } from '../charts';
import { pct } from '../theme';

const CLICK_EVENT = 'Element Clicked';

function ClickTable({
  api, range, tzOffsetMin, property, heading, rankBy, filterNotSet = true, mono = true,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  property: PropertyRef;
  heading: string;
  rankBy: 'users' | 'events';
  filterNotSet?: boolean;
  mono?: boolean;
}) {
  const body = useMemo(() => ({
    property,
    event: { event_type: CLICK_EVENT },
    range,
    tzOffsetMin,
    limit: 12,
    rankBy,
    compare: true,
  }), [property, range, tzOffsetMin, rankBy]);

  const state = useQuery<BreakdownResult>(api, 'breakdown', body);

  return (
    <Async state={state} height={180}>
      {(d) => {
        const rows = filterNotSet ? d.rows.filter((r) => r.value !== '(not set)') : d.rows;
        if (rows.length === 0) {
          return (
            <p className="ea-empty">
              Nothing recorded yet. Click capture needs{' '}
              <code>autocapture: {'{ clicks: true }'}</code> on the site.
            </p>
          );
        }
        return (
          <table className="ea-table">
            <thead>
              <tr>
                <th>{heading}</th>
                <th className="r">Clicks</th>
                <th className="r">People</th>
                <th className="r">Share</th>
                <th className="r">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.value}>
                  <td className={mono ? 'mono' : ''} title={r.value}>
                    <span style={{
                      display: 'inline-block', maxWidth: 340, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
                    }}>
                      {r.value}
                    </span>
                  </td>
                  <td className="r">{r.events.toLocaleString()}</td>
                  <td className="r muted">{r.users.toLocaleString()}</td>
                  <td className="r muted">{pct(r.share, 0)}</td>
                  <td className="r"><Delta change={r.change} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      }}
    </Async>
  );
}

export function Clicks({
  api, range, tzOffsetMin,
}: { api: ApiContext; range: TimeRange; tzOffsetMin: number }): React.ReactElement {
  const [rankBy, setRankBy] = useState<'events' | 'users'>('events');

  const internalVsExternal = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    property: { scope: 'event', key: 'external' },
    event: { event_type: CLICK_EVENT },
    range, tzOffsetMin, limit: 4, rankBy: 'events',
  }), [range, tzOffsetMin]));

  const common = { api, range, tzOffsetMin, rankBy };

  return (
    <>
      <div className="ea-section">
        <Panel
          title="What people press"
          aside={
            <Segmented
              value={rankBy} onChange={setRankBy} label="Rank by"
              options={[{ value: 'events', label: 'Clicks' }, { value: 'users', label: 'People' }]}
            />
          }
        >
          <ClickTable {...common} heading="Label" mono={false}
                      property={{ scope: 'event', key: 'text' }} />
        </Panel>
      </div>

      <div className="ea-section">
        <Panel title="Where those clicks go" aside="destination of every link pressed">
          <ClickTable {...common} heading="Destination"
                      property={{ scope: 'event', key: 'href' }} />
        </Panel>
      </div>

      <div className="ea-grid ea-section">
        <Panel title="Clicks by page" aside="which page the click happened on">
          <ClickTable {...common} heading="Page"
                      property={{ scope: 'context', key: 'page_path' }} />
        </Panel>

        <Panel title="Internal vs external">
          <Async state={internalVsExternal} height={160}>
            {(d) => {
              const rows = d.rows.filter((r) => r.value !== '(not set)');
              if (rows.length === 0) return <p className="ea-empty">No link clicks recorded.</p>;
              return (
                <Donut
                  size={140}
                  data={rows.map((r) => ({
                    label: r.value === 'true' ? 'Left the site' : 'Stayed on site',
                    value: r.events,
                  }))}
                />
              );
            }}
          </Async>
        </Panel>
      </div>

      <div className="ea-grid ea-section">
        <Panel title="Outbound hosts" aside="where people leave to">
          <ClickTable {...common} heading="Host"
                      property={{ scope: 'event', key: 'href_host' }} />
        </Panel>

        <Panel title="Element type" aside="tag pressed">
          <ClickTable {...common} heading="Tag"
                      property={{ scope: 'event', key: 'tag' }} filterNotSet={false} />
        </Panel>
      </div>
    </>
  );
}

/** The event name the click autocapture plugin emits. */
export function clickEventName(): string {
  return CLICK_EVENT;
}
