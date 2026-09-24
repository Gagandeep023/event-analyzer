import React, { useMemo } from 'react';
import type { EventsResult, FunnelQuery, FunnelResult, SegmentationResult, SessionResult } from '../../types';
import { DEFAULT_CONVERSION_WINDOW_MS } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Delta, Panel } from '../components';
import { BarList, Donut, TimeSeries } from '../charts';
import { fmt, pct, shortDate } from '../theme';

export type Metric = 'users' | 'events' | 'sessions';

const METRIC_LABEL: Record<Metric, string> = {
  users: 'Active users',
  events: 'Events',
  sessions: 'Sessions',
};

export interface OverviewProps {
  api: ApiContext;
  range: { from: number; to: number };
  granularity: 'hour' | 'day';
  tzOffsetMin: number;
  metric: Metric;
  onMetric: (m: Metric) => void;
  funnelSteps: string[];
  onOpenFunnel: () => void;
  onOpenEvents: () => void;
  breakdownKey: { scope: 'event' | 'user' | 'context' | 'group'; key: string } | null;
}

export function Overview(props: OverviewProps): React.ReactElement {
  const { api, range, granularity, tzOffsetMin, metric, onMetric } = props;

  const seriesBody = useMemo(() => ({
    events: [{ event_type: '*', label: METRIC_LABEL[metric] }],
    countBy: metric === 'users' ? 'uniques' : 'totals',
    granularity,
    range,
    tzOffsetMin,
    compare: true,
  }), [metric, granularity, range, tzOffsetMin]);

  const series = useQuery<SegmentationResult>(api, 'segmentation', seriesBody, metric !== 'sessions');
  const sessions = useQuery<SessionResult>(api, 'sessions', useMemo(
    () => ({ granularity, range, tzOffsetMin }), [granularity, range, tzOffsetMin]));
  const events = useQuery<EventsResult>(api, 'events', useMemo(
    () => ({ range, tzOffsetMin, limit: 6, compare: true }), [range, tzOffsetMin]));

  const funnelBody = useMemo<FunnelQuery | null>(() => {
    if (props.funnelSteps.length < 2) return null;
    return {
      steps: props.funnelSteps.map((event_type) => ({ event_type })),
      order: 'ordered',
      conversionWindowMs: DEFAULT_CONVERSION_WINDOW_MS,
      countBy: 'uniques',
      range,
      tzOffsetMin,
    };
  }, [props.funnelSteps, range, tzOffsetMin]);
  const funnel = useQuery<FunnelResult>(api, 'funnel', funnelBody ?? {}, funnelBody !== null);

  const breakdown = useQuery<SegmentationResult>(api, 'segmentation', useMemo(() => ({
    events: [{ event_type: '*' }],
    countBy: 'uniques',
    granularity,
    range,
    tzOffsetMin,
    groupBy: props.breakdownKey,
    limitGroups: 8,
  }), [granularity, range, tzOffsetMin, props.breakdownKey]), props.breakdownKey !== null);

  // KPI values. Sessions come from their own analysis; the rest from the series.
  const kpis = useMemo(() => {
    const total = series.data?.series.reduce((n, s) => n + s.total, 0) ?? 0;
    const change = series.data?.previous?.delta[0]?.change ?? null;
    const conv = funnel.data?.overallConversion ?? null;
    return [
      { key: 'users' as Metric, label: 'Active users', value: metric === 'users' ? total : null, change },
      { key: 'events' as Metric, label: 'Events', value: events.data?.totalEvents ?? null, change: null },
      { key: 'sessions' as Metric, label: 'Sessions', value: sessions.data?.totalSessions ?? null, change: null },
      { key: null, label: 'Signup conversion', value: conv, change: null, isPct: true },
    ];
  }, [series.data, events.data, sessions.data, funnel.data, metric]);

  const worstStep = useMemo(() => {
    const steps = funnel.data?.steps;
    if (!steps || steps.length < 2) return null;
    let worst = steps[1]!;
    for (const s of steps.slice(1)) if (s.dropOffRate > worst.dropOffRate) worst = s;
    const prev = steps[worst.index - 1];
    return prev ? { from: prev.label, to: worst.label, lost: worst.dropOffRate } : null;
  }, [funnel.data]);

  const label = (t: number) => granularity === 'hour'
    ? `${String(new Date(t).getHours()).padStart(2, '0')}:00`
    : shortDate(t);

  return (
    <>
      <p className="ea-summary">
        {series.data?.previous?.delta[0]?.change != null ? (
          <>Active users are <b>{series.data.previous.delta[0].change >= 0 ? 'up' : 'down'}{' '}
            {Math.abs(series.data.previous.delta[0].change * 100).toFixed(0)}%</b> versus the previous period. </>
        ) : (
          <>Collecting across this range. </>
        )}
        {funnel.data && worstStep ? (
          <>Signup conversion is holding at <b>{pct(funnel.data.overallConversion, 0)}</b>; the biggest
            drop-off is <b>{worstStep.from} &rarr; {worstStep.to}</b> ({pct(worstStep.lost, 0)} lost).</>
        ) : null}
      </p>

      <div className="ea-kpis ea-section">
        {kpis.map((k) => (
          <button
            key={k.label}
            type="button"
            className="ea-kpi"
            aria-pressed={k.key !== null && k.key === metric}
            onClick={() => (k.key ? onMetric(k.key) : props.onOpenFunnel())}
          >
            <span className="ea-kpi-label">{k.label}</span>
            <span className="ea-kpi-value">
              {k.value === null ? '—' : k.isPct ? pct(k.value, 1) : fmt(k.value)}
            </span>
            {k.change !== null ? <Delta change={k.change} /> : <span className="ea-kpi-delta ea-flat">&nbsp;</span>}
          </button>
        ))}
      </div>

      <div className="ea-section">
        <Panel
          title={`${METRIC_LABEL[metric]} by ${granularity === 'hour' ? 'hour' : 'day'}`}
          aside={
            <span className="ea-legend">
              <span><i />This period</span>
              <span><i className="dash" />Previous</span>
            </span>
          }
        >
          {metric === 'sessions' ? (
            <Async state={sessions} height={240}>
              {(d) => (
                <TimeSeries
                  buckets={d.sessionsOverTime.map((p) => p.t)}
                  values={d.sessionsOverTime.map((p) => p.sessions)}
                  labelFor={label}
                  name="Sessions"
                />
              )}
            </Async>
          ) : (
            <Async state={series} height={240}>
              {(d) => (
                <TimeSeries
                  buckets={d.buckets}
                  values={d.series[0]?.points.map((p) => p.value) ?? []}
                  previous={d.previous?.series[0]?.points.map((p) => p.value)}
                  labelFor={label}
                  name={METRIC_LABEL[metric]}
                />
              )}
            </Async>
          )}
        </Panel>
      </div>

      <div className="ea-grid ea-section">
        <Panel title="Top events" aside={<button className="ea-link" onClick={props.onOpenEvents}>All events &rarr;</button>}>
          <Async state={events} height={160} empty={<p className="ea-empty">No events in this range.</p>}>
            {(d) => d.events.length === 0
              ? <p className="ea-empty">No events in this range.</p>
              : <BarList data={d.events.map((e) => ({ label: e.event_type, value: e.count }))} />}
          </Async>
        </Panel>

        <Panel title="Signup funnel" aside={<button className="ea-link" onClick={props.onOpenFunnel}>Open funnel &rarr;</button>}>
          {funnelBody === null ? (
            <p className="ea-empty">Not enough event types yet to build a funnel.</p>
          ) : (
            <Async state={funnel} height={160}>
              {(d) => (
                <BarList
                  data={d.steps.map((s) => ({
                    label: s.label,
                    value: s.count,
                    hint: `${pct(s.conversionFromStart, 0)} · ${fmt(s.count)}`,
                  }))}
                  max={d.totalEntered}
                />
              )}
            </Async>
          )}
        </Panel>
      </div>

      {props.breakdownKey ? (
        <div className="ea-grid ea-section">
          <Panel title={`Users by ${props.breakdownKey.key}`}>
            <Async state={breakdown} height={170}>
              {(d) => <Donut data={d.series.map((s) => ({ label: s.label, value: s.total }))} />}
            </Async>
          </Panel>
          <Panel title="Sessions" aside={sessions.data ? `${fmt(sessions.data.totalUsers)} people` : null}>
            <Async state={sessions} height={170}>
              {(d) => (
                <BarList
                  data={[
                    { label: 'median length', value: d.medianDurationMs, hint: fmtMs(d.medianDurationMs) },
                    { label: 'p90 length', value: d.p90DurationMs, hint: fmtMs(d.p90DurationMs) },
                    { label: 'events / session', value: d.meanEventsPerSession, hint: d.meanEventsPerSession.toFixed(1) },
                    { label: 'DAU / MAU', value: d.stickiness.dauOverMau, hint: pct(d.stickiness.dauOverMau, 0) },
                  ]}
                  max={Math.max(1, d.p90DurationMs)}
                />
              )}
            </Async>
          </Panel>
        </div>
      ) : null}
    </>
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  return `${(s / 60).toFixed(1)}m`;
}
