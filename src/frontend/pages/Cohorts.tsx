/**
 * Behavioural cohorts: define "people who did X but not Y", then look at what
 * that group does differently from everyone else.
 *
 * The definition is only half the feature. A cohort that can only report its
 * own size is a counter, so every panel below re-runs a normal analysis with
 * the cohort's resolved user keys passed as `userKeys`. The comparison against
 * the unfiltered population is the part that carries the insight: "readers go
 * to /x far more than visitors do" is a finding, "412 readers" is not.
 */

import React, { useMemo, useState } from 'react';
import type {
  BreakdownResult, CohortQuery, CohortResult, SegmentationResult, TimeRange,
} from '../../types';
import { useMeta, useQuery, type ApiContext } from '../hooks';
import { Async, Panel, Segmented } from '../components';
import { BarList, TimeSeries } from '../charts';
import { fmt, pct, shortDate } from '../theme';

const DAY_MS = 86_400_000;

/** `withinMs` choices, in days. 0 means the whole range. */
const WINDOWS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'Any time' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

const NONE = '__none__';

/**
 * Preferred comparison dimensions, best first.
 *
 * Only ones the collector has actually seen are rendered. Hardcoding a fixed
 * list would put permanently empty panels on the page of any deployment that
 * does not happen to send those keys, which is the same dead-panel trap as
 * charting a property nothing writes.
 */
const PREFERRED: ReadonlyArray<{ scope: 'context' | 'event' | 'user'; key: string; title: string; aside: string }> = [
  { scope: 'context', key: 'page_path', title: 'What the cohort reads', aside: 'share of the cohort, against everyone' },
  { scope: 'context', key: 'referrer_channel', title: 'How the cohort arrives', aside: 'acquisition channel' },
  { scope: 'event', key: 'href_host', title: 'Where the cohort leaves to', aside: 'outbound link hosts' },
  { scope: 'context', key: 'site', title: 'Which site', aside: 'share of the cohort, against everyone' },
  { scope: 'context', key: 'country', title: 'Where the cohort is', aside: 'share of the cohort, against everyone' },
  { scope: 'user', key: 'plan', title: 'Plan', aside: 'share of the cohort, against everyone' },
  { scope: 'user', key: 'signup_source', title: 'How the cohort signed up', aside: 'share of the cohort, against everyone' },
  { scope: 'context', key: 'platform', title: 'Platform', aside: 'share of the cohort, against everyone' },
  { scope: 'context', key: 'browser', title: 'Browser', aside: 'share of the cohort, against everyone' },
  { scope: 'event', key: 'page', title: 'Page', aside: 'share of the cohort, against everyone' },
];
const MAX_DIMENSIONS = 4;

/**
 * Below this many cohort members in a row, the lift against the population is
 * noise and is not shown. Two people who both happen to be in Brazil produce a
 * "12.6x" that means nothing, and a number on screen reads as a finding
 * whether or not it deserves to.
 */
const MIN_USERS_FOR_LIFT = 5;

/**
 * A cohort definition without its window.
 *
 * The range is deliberately absent: whoever applies the cohort re-evaluates it
 * against the range they are showing, so membership and analysis always agree.
 */
export type CohortDef = Omit<CohortQuery, 'range' | 'tzOffsetMin'>;

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="ea-kpi">
      <span className="ea-kpi-label">{label}</span>
      <span className="ea-kpi-value">{value}</span>
      {hint ? <span className="ea-kpi-delta ea-flat">{hint}</span> : null}
    </div>
  );
}

/**
 * One breakdown run twice: once inside the cohort, once across everybody.
 *
 * Share is the honest comparison rather than raw counts, since the cohort is
 * by construction smaller than the population and would lose every bar.
 */
function CompareBreakdown({
  api, range, tzOffsetMin, userKeys, propertyKey, scope, title, aside,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  userKeys: string[];
  propertyKey: string;
  scope: 'context' | 'event' | 'user';
  title: string;
  aside?: string;
}) {
  const base = useMemo(() => ({
    property: { scope, key: propertyKey }, range, tzOffsetMin, limit: 8, rankBy: 'users' as const,
  }), [scope, propertyKey, range, tzOffsetMin]);

  const inCohort = useQuery<BreakdownResult>(
    api, 'breakdown', useMemo(() => ({ ...base, userKeys }), [base, userKeys]), userKeys.length > 0,
  );
  const overall = useQuery<BreakdownResult>(api, 'breakdown', base);

  return (
    <Panel title={title} aside={aside}>
      <Async state={inCohort} height={200}>
        {(d) => {
          const rows = d.rows.filter((r) => r.value !== '(not set)');
          if (rows.length === 0) {
            return <p className="ea-empty">Nothing recorded for this cohort in this range.</p>;
          }
          const everyone = new Map(
            (overall.data?.rows ?? []).map((r) => [r.value, r.share]),
          );
          return (
            <BarList
              format={(v) => pct(v, 0)}
              max={1}
              data={rows.map((r) => {
                const all = everyone.get(r.value);
                const lift = all && all > 0 ? r.share / all : null;
                const people = `${fmt(r.users)} ${r.users === 1 ? 'user' : 'users'}`;
                const showLift = lift !== null
                  && lift >= 1.15
                  && r.users >= MIN_USERS_FOR_LIFT;
                return {
                  label: r.value,
                  value: r.share,
                  hint: all === undefined
                    ? people
                    : `${people} · ${pct(all, 0)} overall${
                      showLift ? ` · ${lift.toFixed(1)}x` : ''}`,
                };
              })}
            />
          );
        }}
      </Async>
    </Panel>
  );
}

export function Cohorts({
  api, range, tzOffsetMin, eventTypes, appliedLabel, onApply, onClear,
}: {
  api: ApiContext;
  range: TimeRange;
  tzOffsetMin: number;
  eventTypes: string[];
  /** Label of the cohort currently applied elsewhere, if any. */
  appliedLabel?: string | null;
  onApply?: (label: string, def: CohortDef) => void;
  onClear?: () => void;
}): React.ReactElement {
  const meta = useMeta(api);

  /**
   * Only dimensions the collector has actually recorded. An unseen key would
   * render a panel that can never fill, no matter how much traffic arrives.
   */
  const dimensions = useMemo(() => {
    const seen = new Set(
      (meta.data?.propertyKeys ?? []).map((k) => `${k.scope}:${k.key}`),
    );
    return PREFERRED.filter((d) => seen.has(`${d.scope}:${d.key}`)).slice(0, MAX_DIMENSIONS);
  }, [meta.data]);

  const [did, setDid] = useState('');
  const [didNot, setDidNot] = useState(NONE);
  const [atLeast, setAtLeast] = useState('1');
  const [windowDays, setWindowDays] = useState('0');

  // The first discovered event type is a better default than an empty page.
  const didEvent = did || eventTypes[0] || '';

  // The range-free definition is what travels to other pages.
  const definition = useMemo<CohortDef | null>(() => {
    if (!didEvent) return null;
    const d: CohortDef = {
      did: [{
        step: { event_type: didEvent },
        ...(Number(atLeast) > 1 ? { atLeast: Number(atLeast) } : {}),
      }],
    };
    if (didNot !== NONE) d.didNot = [{ event_type: didNot }];
    if (Number(windowDays) > 0) d.withinMs = Number(windowDays) * DAY_MS;
    return d;
  }, [didEvent, didNot, atLeast, windowDays]);

  const cohortQuery = useMemo<CohortQuery | null>(
    () => (definition ? { ...definition, range, tzOffsetMin } : null),
    [definition, range, tzOffsetMin],
  );

  const label = useMemo(() => {
    const times = Number(atLeast) > 1 ? ` ${atLeast}x` : '';
    const not = didNot !== NONE ? ` not ${didNot}` : '';
    const win = Number(windowDays) > 0 ? ` in ${windowDays}d` : '';
    return `${didEvent}${times}${not}${win}`;
  }, [didEvent, atLeast, didNot, windowDays]);

  const isApplied = appliedLabel !== null && appliedLabel === label;

  const cohort = useQuery<CohortResult>(
    api, 'cohort', cohortQuery ?? {}, cohortQuery !== null,
  );

  const userKeys = cohort.data?.userIds ?? [];

  // Activity over time, cohort against everyone, so the shapes can be compared.
  const segBase = useMemo(() => ({
    events: [{ event_type: '*' as const }],
    countBy: 'uniques' as const,
    granularity: 'day' as const,
    range,
    tzOffsetMin,
  }), [range, tzOffsetMin]);

  const cohortSeries = useQuery<SegmentationResult>(
    api, 'segmentation', useMemo(() => ({ ...segBase, userKeys }), [segBase, userKeys]),
    userKeys.length > 0,
  );

  if (eventTypes.length === 0) {
    return (
      <Panel title="Cohorts">
        <p className="ea-empty">
          No event types yet. A cohort is defined by something people did, so
          there is nothing to define one from until events arrive.
        </p>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Define the cohort"
        aside="people who did this, and did not do that"
      >
        <div className="ea-cohort-builder">
          <label>
            <span>Did</span>
            <select value={didEvent} onChange={(e) => setDid(e.target.value)}>
              {eventTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label>
            <span>At least</span>
            <select value={atLeast} onChange={(e) => setAtLeast(e.target.value)}>
              {['1', '2', '3', '5', '10'].map((n) => (
                <option key={n} value={n}>{n === '1' ? 'once' : `${n} times`}</option>
              ))}
            </select>
          </label>

          <label>
            <span>But not</span>
            <select value={didNot} onChange={(e) => setDidNot(e.target.value)}>
              <option value={NONE}>(nothing)</option>
              {eventTypes.filter((t) => t !== didEvent).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Within</span>
            <select value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
              {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
          </label>
        </div>
        <p className="ea-cohort-note">
          The window is measured from each person&rsquo;s own first matching event,
          not from the start of the range.
        </p>
      </Panel>

      <div className="ea-section">
        <Async state={cohort} height={120}>
          {(c) => (
            <>
              <div className="ea-kpis ea-kpis-3">
                <Kpi label="In this cohort" value={fmt(c.size)} hint="resolved users" />
                <Kpi label="Share of everyone" value={pct(c.share, 1)}
                     hint={`of ${fmt(c.totalUsersInRange)} users in range`} />
                <Kpi label="Everyone else" value={fmt(c.totalUsersInRange - c.size)} />
              </div>
              {onApply && c.size > 0 ? (
                <div className="ea-cohort-apply">
                  {isApplied ? (
                    <>
                      <span className="ea-cohort-applied">
                        Applied to Retention and Funnels
                      </span>
                      <button type="button" className="ea-btn-outline" onClick={onClear}>
                        Clear
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ea-btn-primary"
                      onClick={() => definition && onApply(label, definition)}
                    >
                      Apply to Retention and Funnels
                    </button>
                  )}
                </div>
              ) : null}

              {c.size === 0 ? (
                <p className="ea-empty">
                  Nobody matches this definition in this range. Try a wider window,
                  a lower threshold, or dropping the exclusion.
                </p>
              ) : null}
            </>
          )}
        </Async>
      </div>

      {userKeys.length > 0 ? (
        <>
          <div className="ea-section">
            <Panel title="When the cohort is active" aside="daily unique members">
              <Async state={cohortSeries} height={200}>
                {(d) => (
                  <TimeSeries
                    buckets={d.buckets}
                    values={d.series[0]?.points.map((p) => p.value) ?? []}
                    labelFor={(t) => shortDate(t)}
                    name="Cohort members"
                    height={200}
                  />
                )}
              </Async>
            </Panel>
          </div>

          {dimensions.length > 0 ? (
            <div className="ea-grid ea-section">
              {dimensions.map((d) => (
                <CompareBreakdown
                  key={`${d.scope}:${d.key}`}
                  api={api} range={range} tzOffsetMin={tzOffsetMin} userKeys={userKeys}
                  scope={d.scope} propertyKey={d.key}
                  title={d.title} aside={d.aside}
                />
              ))}
            </div>
          ) : (
            <div className="ea-section">
              <Panel title="Nothing to compare on yet">
                <p className="ea-empty">
                  Comparing a cohort against everyone needs a property to split by,
                  and none of the usual ones have been recorded yet. Send some
                  context with your events, a page path or a referrer, and the
                  panels appear here.
                </p>
              </Panel>
            </div>
          )}

        </>
      ) : null}
    </>
  );
}
