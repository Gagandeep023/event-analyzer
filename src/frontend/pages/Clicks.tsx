/**
 * What people actually press.
 *
 * Page views tell you where someone went; clicks tell you what they reached
 * for. Every panel here is one breakdown query against a property the click
 * autocapture plugin records.
 */

import React, { useMemo, useState } from 'react';
import type { BreakdownResult, PropertyRef, TimeRange } from '../../types';
import { useMeta, useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel, Segmented } from '../components';
import { Donut } from '../charts';
import { pct } from '../theme';

const CLICK_EVENT = 'Element Clicked';

/**
 * Two different empty states that look identical from inside one panel.
 *
 * `captured` is whether the collector has EVER seen a click event, which is the
 * only way the dashboard can tell "capture is not switched on" from "capture is
 * on and this window is quiet". Telling someone to enable an option they have
 * already enabled sends them looking for a bug that is not there.
 */
function NoClicks({ captured }: { captured: boolean | null }) {
  if (captured === false) {
    return (
      <p className="ea-empty">
        No clicks have ever reached the collector. Capture is off until asked for:
        set <code>autocapture: {'{ clicks: true }'}</code> in the SDK on your site.
      </p>
    );
  }
  return (
    <p className="ea-empty">
      No clicks recorded in this range. Try a wider window, or check that the site
      sending them has been deployed since capture was switched on.
    </p>
  );
}

function ClickTable({
  api, range, tzOffsetMin, property, heading, rankBy, captured, filterNotSet = true, mono = true,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  property: PropertyRef;
  heading: string;
  rankBy: 'users' | 'events';
  captured: boolean | null;
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
        if (rows.length === 0) return <NoClicks captured={captured} />;
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

  // null while /meta is in flight, so a slow load never accuses the caller of
  // a misconfiguration it has not confirmed.
  const meta = useMeta(api);
  const captured = meta.data
    ? meta.data.eventTypes.some((e) => e.event_type === CLICK_EVENT)
    : null;

  const internalVsExternal = useQuery<BreakdownResult>(api, 'breakdown', useMemo(() => ({
    property: { scope: 'event', key: 'external' },
    event: { event_type: CLICK_EVENT },
    range, tzOffsetMin, limit: 4, rankBy: 'events',
  }), [range, tzOffsetMin]));

  const common = { api, range, tzOffsetMin, rankBy, captured };

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
              if (rows.length === 0) return <NoClicks captured={captured} />;
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
