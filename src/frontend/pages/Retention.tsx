import React, { useMemo, useState } from 'react';
import type {
  GrowthResult, RetentionMeasure, RetentionQuery, RetentionResult, TimeRange,
} from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, Panel, Segmented } from '../components';
import { Heatmap, StackedBars, TimeSeries } from '../charts';
import { fmt, pct } from '../theme';

const MEASURES: ReadonlyArray<{ value: RetentionMeasure; label: string }> = [
  { value: 'unbounded', label: 'Unbounded' },
  { value: 'n-day', label: 'N-day' },
  { value: 'bracket', label: 'Bracket' },
];

const EXPLAIN: Record<RetentionMeasure, string> = {
  unbounded: 'Returned in this period or any later one. Usually the honest number.',
  'n-day': 'Returned in exactly this period. Understates anyone with a weekly rhythm.',
  bracket: 'Returned inside each window.',
};

export function Retention({
  api, range, tzOffsetMin, startEvent,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  startEvent: string | null;
}): React.ReactElement {
  const [measure, setMeasure] = useState<RetentionMeasure>('unbounded');
  const [interval, setInterval] = useState<'day' | 'week'>('week');

  const body = useMemo<RetentionQuery | null>(() => {
    if (!startEvent) return null;
    return {
      startAction: { event_type: startEvent },
      returnAction: { event_type: '*' },
      measure,
      interval,
      periods: interval === 'week' ? 8 : 14,
      ...(measure === 'bracket'
        ? { brackets: [[0, 0], [1, 1], [2, 3], [4, 7]] as Array<[number, number]> }
        : {}),
      range,
      tzOffsetMin,
    };
  }, [startEvent, measure, interval, range, tzOffsetMin]);

  const state = useQuery<RetentionResult>(api, 'retention', body ?? {}, body !== null);

  const growthState = useQuery<GrowthResult>(api, 'growth', useMemo(
    () => ({ interval, range, tzOffsetMin }), [interval, range, tzOffsetMin]));

  if (!startEvent) {
    return <Panel title="Retention"><p className="ea-empty">No events yet.</p></Panel>;
  }

  return (
    <>
      <div className="ea-section">
        <Panel
          title={`${interval === 'week' ? 'Weekly' : 'Daily'} cohorts · returned after ${startEvent}`}
          aside={
            <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Segmented value={measure} onChange={setMeasure} label="Measure" options={MEASURES} />
              <Segmented
                value={interval}
                onChange={setInterval}
                label="Interval"
                options={[{ value: 'week', label: 'Weekly' }, { value: 'day', label: 'Daily' }]}
              />
            </span>
          }
        >
          <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--ea-muted)' }}>{EXPLAIN[measure]}</p>
          <Async state={state} height={200}>
            {(d) => (
              <TimeSeries
                buckets={d.curve.map((_, i) => i)}
                values={d.curve.map((p) => p.rate * 100)}
                labelFor={(_t, i) => d.curve[i]?.label ?? ''}
                height={180}
                name="Retention"
              />
            )}
          </Async>
        </Panel>
      </div>

      <div className="ea-section">
        <Panel
          title="Growth accounting"
          aside={
            growthState.data ? (
              <span>
                {fmt(growthState.data.totals.newUsers)} new ·{' '}
                {fmt(growthState.data.totals.resurrected)} back ·{' '}
                {fmt(Math.abs(growthState.data.totals.churned))} lost
                {growthState.data.quickRatio !== null
                  ? ` · quick ratio ${growthState.data.quickRatio.toFixed(2)}`
                  : ''}
              </span>
            ) : null
          }
        >
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ea-muted)' }}>
            A flat active-user count can hide heavy churn masked by heavy acquisition.
            This splits each period by where its users came from.
          </p>
          <Async state={growthState} height={220}>
            {(d) => d.points.length === 0
              ? <p className="ea-empty">No activity in this range.</p>
              : <StackedBars data={d.points.map((p) => ({
                  label: p.label,
                  newUsers: p.newUsers,
                  returning: p.returning,
                  resurrected: p.resurrected,
                  churned: p.churned,
                  active: p.active,
                }))} />}
          </Async>
        </Panel>
      </div>

      <Panel
        title="Cohort grid"
        aside={state.data ? `${state.data.totalUsers.toLocaleString()} users · avg ${avgFirst(state.data)}` : null}
      >
        <Async state={state} height={240}>
          {(d) => d.table.length === 0
            ? <p className="ea-empty">No cohorts in this range.</p>
            : <Heatmap data={d} periods={interval === 'week' ? 8 : 10} />}
        </Async>
        <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--ea-muted)' }}>
          Muted cells have not had enough elapsed time to be measured fairly, so they are
          shown as unknown rather than as zero.
        </p>
      </Panel>
    </>
  );
}

function avgFirst(d: RetentionResult): string {
  const p = d.curve[1];
  return p ? pct(p.rate, 0) : '—';
}
