/** Shared presentational pieces. */

import React from 'react';
import { delta as fmtDelta } from '../theme';

export function Panel({
  title, aside, children, style,
}: {
  /** A node, not just a string: the Live panel puts a status dot in its title. */
  title?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <section className="ea-panel" style={style}>
      {title || aside ? (
        <header className="ea-panel-head">
          {title ? <h2 className="ea-panel-title">{title}</h2> : <span />}
          {aside ? <div className="ea-panel-aside">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}): React.ReactElement {
  return (
    <div className="ea-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value}
                onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A delta chip.
 *
 * Anything under one percent renders neutral. Dressing a 0.3% wiggle in green
 * invites someone to read a trend that is not there.
 */
export function Delta({ change }: { change: number | null | undefined }): React.ReactElement {
  const d = fmtDelta(change);
  const cls = d.dir === 'up' ? 'ea-up' : d.dir === 'down' ? 'ea-down' : 'ea-flat';
  return <span className={`ea-kpi-delta ${cls}`}>{d.text}</span>;
}

export function Empty({ title, hint, curl }: { title: string; hint?: string; curl?: string }): React.ReactElement {
  return (
    <div className="ea-empty">
      <p style={{ margin: 0, color: 'var(--ea-ink-3)' }}>{title}</p>
      {hint ? <p style={{ margin: '6px 0 0', fontSize: 13 }}>{hint}</p> : null}
      {curl ? <p style={{ margin: '12px 0 0' }}><code>{curl}</code></p> : null}
    </div>
  );
}

export function Loading({ height = 120 }: { height?: number }): React.ReactElement {
  return <div className="ea-skeleton" style={{ height }} role="status" aria-label="Loading" />;
}

export function ErrorBox({ message }: { message: string }): React.ReactElement {
  return (
    <div className="ea-error" role="alert">
      <strong>Query failed.</strong> {message}
    </div>
  );
}

/** Wraps a panel body in the three states every query has. */
export function Async<T>({
  state, children, empty, height,
}: {
  state: { data: T | null; error: string | null; loading: boolean };
  children: (data: T) => React.ReactNode;
  empty?: React.ReactNode;
  height?: number;
}): React.ReactElement {
  if (state.error) return <ErrorBox message={state.error} />;
  if (!state.data && state.loading) return <Loading height={height} />;
  if (!state.data) return <>{empty ?? <Empty title="No data yet." />}</>;
  return <>{children(state.data)}</>;
}


/**
 * Says, on the page being filtered, that it is being filtered.
 *
 * A cohort applied from another page is invisible state: without this the
 * numbers simply look different, and a smaller retention curve reads as a
 * regression rather than as a narrower question.
 */
export function CohortNote({ label }: { label: string }): React.ReactElement {
  return (
    <p className="ea-cohort-note-bar">
      Filtered to <strong>{label}</strong>
    </p>
  );
}
