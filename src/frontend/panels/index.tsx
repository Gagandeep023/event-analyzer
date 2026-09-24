/** The six dashboard panels. */

import React, { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type {
  CohortResult, FunnelResult, MetaResponse, RetentionMeasure, RetentionResult,
  SegmentationResult, SessionResult,
} from '../../types';
import { useEventStream, useQuery, useRange, type ApiContext } from '../hooks';
import {
  Empty, ErrorBox, Loading, Panel, RangePicker, StatTile, Toggle,
  duration, num, pct, shortDate,
} from '../components';

const COLORS = ['var(--ea-accent)', '#7aa2f7', '#e8b45c', '#f07c7c', '#9d7cd8', '#7dcfff'];

const COLLECT_CURL = `curl -X POST <baseUrl>/collect \\
  -H 'Content-Type: application/json' \\
  -d '{"events":[{"event_type":"Demo","user_id":"demo_user"}]}'`;

interface PanelProps {
  api: ApiContext;
  meta: MetaResponse | null;
  tzOffsetMin: number;
}

function useDefaultEvent(meta: MetaResponse | null): string {
  return meta?.eventTypes[0]?.event_type ?? '';
}

// ---------------------------------------------------------------------------

export function EventsPanel({ api, meta, tzOffsetMin }: PanelProps): React.ReactElement {
  const [days, setDays] = useState(30);
  const fallback = useDefaultEvent(meta);
  const [eventType, setEventType] = useState('');
  const range = useRange(days);
  const chosen = eventType || fallback;

  const body = useMemo(() => ({
    events: chosen ? [{ event_type: chosen }] : [],
    countBy: 'uniques',
    granularity: days > 45 ? 'week' : 'day',
    range,
    tzOffsetMin,
  }), [chosen, days, range, tzOffsetMin]);

  const { data, error, loading } = useQuery<SegmentationResult>(api, 'segmentation', body, Boolean(chosen));

  const rows = useMemo(() => {
    if (!data) return [];
    return data.buckets.map((t, i) => {
      const row: Record<string, number | string> = { t, label: shortDate(t) };
      for (const s of data.series) row[s.label] = s.points[i]?.value ?? 0;
      return row;
    });
  }, [data]);

  return (
    <Panel
      title="Events"
      actions={
        <>
          <select
            className="ea-select"
            value={chosen}
            onChange={(e) => setEventType(e.target.value)}
            aria-label="Event type"
          >
            {(meta?.eventTypes ?? []).map((e) => (
              <option key={e.event_type} value={e.event_type}>{e.event_type}</option>
            ))}
          </select>
          <RangePicker days={days} onChange={setDays} />
        </>
      }
    >
      {error ? <ErrorBox message={error} /> : null}
      {loading && !data ? <Loading /> : null}
      {!chosen ? <Empty title="No events yet" hint="Send one to get started." curl={COLLECT_CURL} /> : null}

      {data && chosen ? (
        <>
          <div className="ea-chart">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="eaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--ea-accent)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--ea-accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--ea-line)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--ea-text-dim)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--ea-text-dim)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} />
                {data.series.map((s, i) => (
                  <Area
                    key={s.label}
                    type="monotone"
                    dataKey={s.label}
                    stroke={COLORS[i % COLORS.length]}
                    fill={i === 0 ? 'url(#eaFill)' : 'none'}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="ea-tiles">
            {data.series.map((s) => (
              <StatTile key={s.label} label={s.label} value={num(s.total)} hint="unique users" />
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function FunnelPanel({ api, meta, tzOffsetMin }: PanelProps): React.ReactElement {
  const [days, setDays] = useState(30);
  const range = useRange(days);
  // Default to the first four discovered event types, which on seeded data is
  // exactly the signup funnel.
  const steps = useMemo(
    () => (meta?.eventTypes ?? []).slice(0, 4).map((e) => ({ event_type: e.event_type })),
    [meta],
  );

  const body = useMemo(() => ({
    steps,
    order: 'ordered',
    conversionWindowMs: 2_592_000_000,
    countBy: 'uniques',
    range,
    tzOffsetMin,
  }), [steps, range, tzOffsetMin]);

  const { data, error, loading } = useQuery<FunnelResult>(api, 'funnel', body, steps.length >= 2);

  return (
    <Panel title="Funnel" actions={<RangePicker days={days} onChange={setDays} />}>
      {error ? <ErrorBox message={error} /> : null}
      {loading && !data ? <Loading /> : null}
      {steps.length < 2 ? <Empty title="Need at least two event types" hint="Send a few more events." /> : null}

      {data ? (
        <>
          <div className="ea-tiles">
            <StatTile label="Entered" value={num(data.totalEntered)} />
            <StatTile label="Converted" value={num(data.totalConverted)} />
            <StatTile label="Overall" value={pct(data.overallConversion)} />
            <StatTile label="Median time" value={duration(data.medianTotalTimeMs)} />
          </div>

          {/* Horizontal bars: event names are long, and vertical bars force
              truncation or rotated labels. */}
          <div className="ea-funnel">
            {data.steps.map((s, i) => (
              <div key={s.index} className="ea-funnel-row">
                <div className="ea-funnel-label" title={s.label}>{s.label}</div>
                <div className="ea-funnel-track">
                  <div
                    className="ea-funnel-bar"
                    style={{
                      width: `${Math.max(data.totalEntered ? (s.count / data.totalEntered) * 100 : 0, 0.5)}%`,
                      background: COLORS[i % COLORS.length],
                    }}
                  />
                  <span className="ea-funnel-count">{num(s.count)}</span>
                </div>
                <div className="ea-funnel-meta">
                  <span>{pct(s.conversionFromPrevious)}</span>
                  {s.index > 0 ? <span className="ea-drop">−{num(s.dropOff)}</span> : null}
                  <span className="ea-dim">{duration(s.medianTimeFromPreviousMs)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

const MEASURES: ReadonlyArray<{ value: RetentionMeasure; label: string }> = [
  { value: 'unbounded', label: 'Unbounded' },
  { value: 'n-day', label: 'N-day' },
  { value: 'bracket', label: 'Bracket' },
];

export function RetentionPanel({ api, meta, tzOffsetMin }: PanelProps): React.ReactElement {
  const [measure, setMeasure] = useState<RetentionMeasure>('unbounded');
  const [days, setDays] = useState(90);
  const range = useRange(days);
  const startEvent = useDefaultEvent(meta);

  const body = useMemo(() => ({
    startAction: { event_type: startEvent },
    returnAction: { event_type: '*' },
    measure,
    interval: 'day',
    periods: 14,
    ...(measure === 'bracket' ? { brackets: [[0, 0], [1, 7], [8, 14], [15, 30]] } : {}),
    range,
    tzOffsetMin,
  }), [startEvent, measure, range, tzOffsetMin]);

  const { data, error, loading } = useQuery<RetentionResult>(api, 'retention', body, Boolean(startEvent));

  const curve = useMemo(
    () => (data?.curve ?? []).map((p) => ({ ...p, ratePct: p.rate * 100 })),
    [data],
  );

  return (
    <Panel
      title="Retention"
      actions={
        <>
          <Toggle value={measure} options={MEASURES} onChange={setMeasure} label="Retention measure" />
          <RangePicker days={days} onChange={setDays} options={[30, 90, 180]} />
        </>
      }
    >
      {error ? <ErrorBox message={error} /> : null}
      {loading && !data ? <Loading /> : null}
      {!startEvent ? <Empty title="No events yet" curl={COLLECT_CURL} /> : null}

      {data ? (
        <>
          <p className="ea-note">
            {measure === 'unbounded'
              ? 'Returned on this period or any period after. Usually the honest number.'
              : measure === 'n-day'
                ? 'Returned on exactly this period. Understates returning users, often by 3x or more.'
                : 'Returned within each custom window.'}
          </p>

          <div className="ea-chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={curve} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--ea-line)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--ea-text-dim)" fontSize={11} tickLine={false} />
                <YAxis
                  stroke="var(--ea-text-dim)" fontSize={11} tickLine={false} axisLine={false}
                  domain={[0, 100]} tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => `${Number(v ?? 0).toFixed(1)}%`} />
                <Line type="monotone" dataKey="ratePct" stroke="var(--ea-accent)" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* A cohort grid is tabular data. Forcing it into a charting library
              produces something that cannot be read or copied. */}
          <div className="ea-scroll">
            <table className="ea-heatmap">
              <caption className="ea-sr">
                {`${measure} retention by ${data.interval} cohort`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Cohort</th>
                  <th scope="col">Users</th>
                  {(data.curve ?? []).map((p) => (
                    <th key={p.period} scope="col">{p.label.replace('Day ', 'D')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.table.slice(-14).map((row) => (
                  <tr key={row.cohortStart}>
                    <th scope="row">{row.cohortLabel}</th>
                    <td className="ea-numcell">{num(row.cohortSize)}</td>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.period}
                        className={`ea-cell${cell.incomplete ? ' ea-cell-incomplete' : ''}`}
                        style={{ background: `color-mix(in srgb, var(--ea-accent) ${Math.round(cell.rate * 70)}%, transparent)` }}
                        title={cell.incomplete ? 'Not enough elapsed time to measure fairly' : undefined}
                      >
                        {(cell.rate * 100).toFixed(0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ea-legend">Dimmed cells have not had enough elapsed time to be measured fairly.</p>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function SessionsPanel({ api, tzOffsetMin }: PanelProps): React.ReactElement {
  const [days, setDays] = useState(30);
  const range = useRange(days);
  const body = useMemo(
    () => ({ granularity: days > 45 ? 'week' : 'day', range, tzOffsetMin }),
    [days, range, tzOffsetMin],
  );
  const { data, error, loading } = useQuery<SessionResult>(api, 'sessions', body);

  return (
    <Panel title="Sessions" actions={<RangePicker days={days} onChange={setDays} />}>
      {error ? <ErrorBox message={error} /> : null}
      {loading && !data ? <Loading /> : null}

      {data ? (
        <>
          <div className="ea-tiles">
            <StatTile label="Sessions" value={num(data.totalSessions)} />
            <StatTile label="Median length" value={duration(data.medianDurationMs)} />
            <StatTile label="p90 length" value={duration(data.p90DurationMs)} />
            <StatTile label="Events / session" value={data.meanEventsPerSession.toFixed(1)} />
            <StatTile label="DAU" value={num(data.stickiness.dau)} />
            <StatTile
              label="DAU / MAU"
              value={pct(data.stickiness.dauOverMau)}
              hint={`${num(data.stickiness.mau)} monthly`}
            />
          </div>

          {/* Bins are non-linear because session length is right-skewed; linear
              bins produce one useless spike. */}
          <div className="ea-chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.durationHistogram} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--ea-line)" vertical={false} />
                <XAxis dataKey="bucketLabel" stroke="var(--ea-text-dim)" fontSize={10} tickLine={false} />
                <YAxis stroke="var(--ea-text-dim)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--ea-surface-2)' }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {data.durationHistogram.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function CohortPanel({ api, meta, tzOffsetMin }: PanelProps): React.ReactElement {
  const [days, setDays] = useState(90);
  const range = useRange(days);
  const types = (meta?.eventTypes ?? []).map((e) => e.event_type);
  const [did, setDid] = useState('');
  const [didNot, setDidNot] = useState('');

  const didEvent = did || types[0] || '';
  const didNotEvent = didNot || types[types.length - 1] || '';

  const body = useMemo(() => ({
    did: didEvent ? [{ step: { event_type: didEvent } }] : [],
    didNot: didNotEvent ? [{ event_type: didNotEvent }] : [],
    range,
    tzOffsetMin,
  }), [didEvent, didNotEvent, range, tzOffsetMin]);

  const { data, error, loading } = useQuery<CohortResult>(api, 'cohort', body, Boolean(didEvent));

  return (
    <Panel title="Cohort" actions={<RangePicker days={days} onChange={setDays} options={[30, 90, 180]} />}>
      {error ? <ErrorBox message={error} /> : null}

      <div className="ea-builder">
        <label className="ea-field">
          <span>Did</span>
          <select className="ea-select" value={didEvent} onChange={(e) => setDid(e.target.value)}>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="ea-field">
          <span>But not</span>
          <select className="ea-select" value={didNotEvent} onChange={(e) => setDidNot(e.target.value)}>
            <option value="">(nothing)</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {loading && !data ? <Loading /> : null}

      {data ? (
        <>
          <div className="ea-tiles">
            <StatTile label="Cohort size" value={num(data.size)} />
            <StatTile label="Of all users" value={pct(data.share)} hint={`${num(data.totalUsersInRange)} total`} />
          </div>
          {data.size === 0 ? (
            <Empty title="No users match" hint="Try a different combination." />
          ) : (
            <div className="ea-scroll">
              <ul className="ea-userlist">
                {data.userIds.slice(0, 60).map((id) => <li key={id}><code>{id}</code></li>)}
              </ul>
              {data.userIds.length > 60 ? (
                <p className="ea-legend">{num(data.userIds.length - 60)} more not shown.</p>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function LivePanel({ api }: PanelProps): React.ReactElement {
  const { events, connected, perSecond } = useEventStream(api, true);
  const spark = useMemo(() => perSecond.map((v, i) => ({ i, v })), [perSecond]);

  return (
    <Panel
      title="Live"
      actions={
        <span className={`ea-dot${connected ? ' ea-dot-on' : ''}`}>
          {connected ? 'connected' : 'disconnected'}
        </span>
      }
    >
      <div className="ea-chart">
        <ResponsiveContainer width="100%" height={90}>
          <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <Area type="monotone" dataKey="v" stroke="var(--ea-accent)" fill="var(--ea-accent)" fillOpacity={0.15} strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {events.length === 0 ? (
        <Empty title="Waiting for events" hint="Nothing has arrived since this panel opened." curl={COLLECT_CURL} />
      ) : (
        <div className="ea-scroll">
          <table className="ea-table">
            <thead>
              <tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">User</th></tr>
            </thead>
            <tbody>
              {events.slice(0, 50).map((ev, i) => (
                <tr key={`${ev.insert_id ?? i}`}>
                  <td className="ea-dim">{new Date(ev.time ?? 0).toLocaleTimeString()}</td>
                  <td>{ev.event_type}</td>
                  <td className="ea-dim"><code>{ev.user_id ?? ev.device_id ?? '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: 'var(--ea-surface)',
  border: '1px solid var(--ea-line)',
  borderRadius: 8,
  color: 'var(--ea-text)',
  fontSize: 12,
};
