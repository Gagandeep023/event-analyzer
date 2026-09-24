/**
 * Donut breakdown.
 *
 * A pie answers one question well: what share does each slice hold. Anything
 * more (trend, comparison) belongs in a different chart, so this stays
 * deliberately plain and leans on the legend for the numbers.
 */

import React, { useMemo, useState } from 'react';
import { CATEGORICAL, fmt, pct } from '../theme';

export interface DonutSlice { label: string; value: number; }

export interface DonutProps {
  data: DonutSlice[];
  size?: number;
  /** Ring thickness as a fraction of the radius. */
  thickness?: number;
  /** Slices beyond this are folded into "Other". */
  limit?: number;
}

export function Donut({ data, size = 168, thickness = 0.38, limit = 7 }: DonutProps): React.ReactElement {
  const [active, setActive] = useState<number | null>(null);

  const slices = useMemo(() => {
    const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
    if (sorted.length <= limit) return sorted;
    const head = sorted.slice(0, limit);
    const tail = sorted.slice(limit);
    return [...head, { label: 'Other', value: tail.reduce((n, d) => n + d.value, 0) }];
  }, [data, limit]);

  const total = slices.reduce((n, d) => n + d.value, 0);
  const r = size / 2;
  const inner = r * (1 - thickness);

  if (total === 0) {
    return <div className="ea-empty">No data in this range.</div>;
  }

  // One path per slice, as an annular sector.
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${(r + rad * Math.cos(a)).toFixed(2)},${(r + rad * Math.sin(a)).toFixed(2)}`;
    // A full circle cannot be drawn as one arc; nudge it closed.
    const end = sweep >= Math.PI * 2 - 1e-6 ? a1 - 1e-4 : a1;
    const d = [
      `M${p(r, a0)}`,
      `A${r},${r} 0 ${large} 1 ${p(r, end)}`,
      `L${p(inner, end)}`,
      `A${inner},${inner} 0 ${large} 0 ${p(inner, a0)}`,
      'Z',
    ].join(' ');
    return { d, slice: s, color: CATEGORICAL[i % CATEGORICAL.length]!, share: s.value / total, i };
  });

  const shown = active !== null ? arcs[active] : null;

  return (
    <div className="ea-donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown">
        {arcs.map((a) => (
          <path
            key={a.slice.label}
            d={a.d}
            fill={a.color}
            opacity={active === null || active === a.i ? 1 : 0.35}
            onMouseEnter={() => setActive(a.i)}
            onMouseLeave={() => setActive(null)}
          />
        ))}
        <text x={r} y={r - 4} textAnchor="middle" fontSize={20} fontWeight={500}
              fill="#1C1B19" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {shown ? pct(shown.share, 0) : fmt(total)}
        </text>
        <text x={r} y={r + 15} textAnchor="middle" fontSize={11} fill="#6B6962">
          {shown ? shown.slice.label.slice(0, 16) : 'total'}
        </text>
      </svg>

      <div className="ea-donut-legend">
        {arcs.map((a) => (
          <div className="row" key={a.slice.label}
               onMouseEnter={() => setActive(a.i)} onMouseLeave={() => setActive(null)}>
            <span className="sw" style={{ background: a.color }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.slice.label}
            </span>
            <span className="v">{fmt(a.slice.value)} · {pct(a.share, 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
