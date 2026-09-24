/**
 * Horizontal bar list and vertical bar chart.
 *
 * Horizontal for anything labelled with an event name, because event names are
 * long and vertical bars force truncation or rotated labels. Vertical only for
 * genuinely short categorical labels such as duration buckets.
 */

import React from 'react';
import { T, fmt } from '../theme';

export interface BarDatum { label: string; value: number; hint?: string; }

export function BarList({
  data, max, format = fmt, onSelect,
}: {
  data: BarDatum[];
  max?: number;
  format?: (v: number) => string;
  onSelect?: (label: string) => void;
}): React.ReactElement {
  const peak = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="ea-bars">
      {data.map((d) => {
        const row = (
          <>
            <span className="ea-bar-name" title={d.label}>{d.label}</span>
            <span className="ea-bar-track">
              <span className="ea-bar-fill" style={{ width: `${Math.max(2, (d.value / peak) * 100)}%` }} />
            </span>
            <span className="ea-bar-value">{d.hint ?? format(d.value)}</span>
          </>
        );
        return onSelect ? (
          <button type="button" key={d.label} className="ea-bar-row"
                  style={{ border: 'none', background: 'none', textAlign: 'left', width: '100%' }}
                  onClick={() => onSelect(d.label)}>
            {row}
          </button>
        ) : (
          <div className="ea-bar-row" key={d.label}>{row}</div>
        );
      })}
    </div>
  );
}

/** Vertical bars. Used for the session-length distribution. */
export function BarChart({
  data, height = 200, format = fmt,
}: {
  data: BarDatum[];
  height?: number;
  format?: (v: number) => string;
}): React.ReactElement {
  const [hover, setHover] = React.useState<number | null>(null);
  const peak = Math.max(1, ...data.map((d) => d.value));
  const PAD_B = 34;
  const PAD_T = 8;
  const plotH = height - PAD_B - PAD_T;
  const slot = 100 / Math.max(1, data.length);

  return (
    <div className="ea-chart">
      <svg viewBox={`0 0 100 ${height}`} height={height} preserveAspectRatio="none"
           role="img" aria-label="Distribution">
        {data.map((d, i) => {
          const h = Math.max(1, (d.value / peak) * plotH);
          const w = slot * 0.62;
          const x = i * slot + (slot - w) / 2;
          return (
            <rect key={d.label} x={x} y={PAD_T + plotH - h} width={w} height={h} rx={1.2}
                  fill={hover === i ? T.accent : 'oklch(0.55 0.13 250 / 0.55)'}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          );
        })}
      </svg>
      {/* Labels sit outside the stretched SVG so they are not distorted by
          preserveAspectRatio="none". */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.length}, 1fr)`, marginTop: -26 }}>
        {data.map((d, i) => (
          <div key={d.label} style={{
            fontSize: 10, fontFamily: 'var(--ea-mono)', color: hover === i ? T.ink : T.faint,
            textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {hover === i ? format(d.value) : d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
