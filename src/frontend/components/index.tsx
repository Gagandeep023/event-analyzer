/** Shared presentational pieces. */

import React from 'react';

export function StatTile({
  label, value, hint,
}: { label: string; value: string; hint?: string }): React.ReactElement {
  return (
    <div className="ea-tile">
      <div className="ea-tile-label">{label}</div>
      <div className="ea-tile-value">{value}</div>
      {hint ? <div className="ea-tile-hint">{hint}</div> : null}
    </div>
  );
}

export function RangePicker({
  days, onChange, options = [7, 30, 90],
}: { days: number; onChange: (d: number) => void; options?: number[] }): React.ReactElement {
  return (
    <div className="ea-range" role="group" aria-label="Time range">
      {options.map((d) => (
        <button
          key={d}
          type="button"
          className={`ea-chip${d === days ? ' ea-chip-on' : ''}`}
          aria-pressed={d === days}
          onClick={() => onChange(d)}
        >
          {d}d
        </button>
      ))}
    </div>
  );
}

export function Toggle<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}): React.ReactElement {
  return (
    <div className="ea-range" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`ea-chip${o.value === value ? ' ea-chip-on' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Explicit empty state.
 *
 * "No events yet" with the exact curl to send one beats an empty chart, which
 * is indistinguishable from a broken chart.
 */
export function Empty({
  title, hint, curl,
}: { title: string; hint?: string; curl?: string }): React.ReactElement {
  return (
    <div className="ea-empty">
      <p className="ea-empty-title">{title}</p>
      {hint ? <p className="ea-empty-hint">{hint}</p> : null}
      {curl ? <pre className="ea-empty-curl">{curl}</pre> : null}
    </div>
  );
}

export function Loading(): React.ReactElement {
  return <div className="ea-loading" role="status">Loading…</div>;
}

export function ErrorBox({ message }: { message: string }): React.ReactElement {
  return (
    <div className="ea-error" role="alert">
      <strong>Query failed.</strong> {message}
    </div>
  );
}

export function Panel({
  title, actions, children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="ea-panel">
      <header className="ea-panel-head">
        <h2 className="ea-panel-title">{title}</h2>
        {actions ? <div className="ea-panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Numbers that line up in a column. */
export function num(n: number): string {
  return n.toLocaleString();
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function shortDate(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}
