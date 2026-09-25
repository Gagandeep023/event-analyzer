import React, { useMemo, useState } from 'react';
import type { FunnelQuery, FunnelResult, TimeRange } from '../../types';
import { DEFAULT_CONVERSION_WINDOW_MS } from '../../types';
import { useQuery, type ApiContext } from '../hooks';
import { Async, CohortNote, Panel, Segmented } from '../components';
import { duration, fmt, pct } from '../theme';

export interface FunnelDef { name: string; steps: string[]; }

export function Funnels({
  api, range, tzOffsetMin, funnels, userKeys, cohortPending, cohortLabel,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  funnels: FunnelDef[];
  /**
   * Restricts every query on this page to a cohort.
   *
   * `pending` means a cohort is applied but its membership has not resolved
   * yet. The queries are held rather than run unfiltered, because showing
   * everybody under a heading that says "filtered" is worse than showing a
   * spinner.
   */
  userKeys?: string[];
  cohortPending?: boolean;
  cohortLabel?: string | null;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  const [order, setOrder] = useState<FunnelQuery['order']>('ordered');
  const def = funnels[selected];

  const body = useMemo<FunnelQuery | null>(() => {
    if (!def || def.steps.length < 2 || cohortPending) return null;
    return {
      ...(userKeys ? { userKeys } : {}),
      steps: def.steps.map((event_type) => ({ event_type })),
      order,
      conversionWindowMs: DEFAULT_CONVERSION_WINDOW_MS,
      countBy: 'uniques',
      range,
      tzOffsetMin,
    };
  }, [def, order, range, tzOffsetMin, userKeys, cohortPending]);

  const state = useQuery<FunnelResult>(api, 'funnel', body ?? {}, body !== null);

  if (funnels.length === 0) {
    return (
      <Panel title="Funnels">
        <p className="ea-empty">
          Not enough distinct event types yet. A funnel needs at least two.
        </p>
      </Panel>
    );
  }

  return (
    <>
      {cohortLabel ? <CohortNote label={cohortLabel} /> : null}
      <div className="ea-split">
      <div className="ea-list">
        {funnels.map((f, i) => (
          <button key={f.name} type="button" aria-pressed={i === selected} onClick={() => setSelected(i)}>
            <span className="n">{f.name}</span>
            <span className="m">{f.steps.length} steps</span>
          </button>
        ))}
      </div>

      <Panel
        title={def?.name ?? 'Funnel'}
        aside={
          <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Segmented
              value={order}
              onChange={setOrder}
              label="Step ordering"
              options={[
                { value: 'ordered', label: 'In order' },
                { value: 'unordered', label: 'Any order' },
                { value: 'sequential', label: 'Strict' },
              ]}
            />
            {state.data ? <span>Overall {pct(state.data.overallConversion, 1)}</span> : null}
          </span>
        }
      >
        <Async state={state} height={260}>
          {(d) => {
            const worst = d.steps.slice(1).reduce(
              (acc, s) => (s.dropOffRate > (acc?.dropOffRate ?? -1) ? s : acc),
              null as FunnelResult['steps'][number] | null,
            );
            const before = worst ? d.steps[worst.index - 1] : null;
            return (
              <>
                {d.steps.map((s) => (
                  <div className="ea-funnel-row" key={s.index}>
                    <span className="ea-funnel-n">{String(s.index + 1).padStart(2, '0')}</span>
                    <div>
                      <div className="ea-funnel-name">
                        <span>{s.label}</span>
                        {s.index > 0 ? (
                          <span className={`ea-funnel-drop${s.dropOffRate > 0.5 ? ' bad' : ''}`}>
                            &minus;{pct(s.dropOffRate, 0)} from previous
                            {s.medianTimeFromPreviousMs !== null
                              ? ` · median ${duration(s.medianTimeFromPreviousMs)}`
                              : ''}
                          </span>
                        ) : null}
                      </div>
                      <div className="ea-funnel-track">
                        <span
                          className="ea-funnel-fill"
                          style={{ width: `${Math.max(1, s.conversionFromStart * 100)}%` }}
                        />
                      </div>
                    </div>
                    <div className="ea-funnel-pct">
                      <div className="p">{pct(s.conversionFromStart, 0)}</div>
                      <div className="u">{fmt(s.count)}</div>
                    </div>
                  </div>
                ))}
                {worst && before ? (
                  <p className="ea-funnel-foot">
                    Biggest drop-off: <strong>{before.label} &rarr; {worst.label}</strong>{' '}
                    ({pct(worst.dropOffRate, 0)} lost).
                  </p>
                ) : null}
              </>
            );
          }}
        </Async>
      </Panel>
      </div>
    </>
  );
}
