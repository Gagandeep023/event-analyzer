/**
 * Diverging stacked bars for growth accounting.
 *
 * New and resurrected sit above the axis, churn below, so whether a period
 * actually grew is legible at a glance rather than something to compute from
 * four numbers.
 */

import React, { useState } from 'react';
import { fmt } from '../theme';

export interface GrowthBar {
  label: string;
  newUsers: number;
  returning: number;
  resurrected: number;
  churned: number;
  active: number;
}

const UP = 'oklch(0.55 0.13 250)';
const RETURN = 'oklch(0.55 0.13 250 / 0.42)';
const RESURRECT = 'oklch(0.62 0.13 150)';
const DOWN = 'oklch(0.52 0.15 28 / 0.75)';

export function StackedBars({ data, height = 220 }: { data: GrowthBar[]; height?: number }): React.ReactElement {
  const [hover, setHover] = useState<number | null>(null);

  const maxUp = Math.max(1, ...data.map((d) => d.returning + d.newUsers + d.resurrected));
  const maxDown = Math.max(1, ...data.map((d) => Math.abs(d.churned)));
  const span = maxUp + maxDown;

  const PAD_B = 22;
  const plotH = height - PAD_B;
  const zeroY = (maxUp / span) * plotH;
  const slot = 100 / Math.max(1, data.length);
  const w = slot * 0.66;

  const scale = (v: number) => (v / span) * plotH;
  const shown = hover !== null ? data[hover] : null;

  return (
    <div className="ea-chart">
      <svg viewBox={`0 0 100 ${height}`} height={height} preserveAspectRatio="none" role="img"
           aria-label="Growth accounting">
        <line x1={0} x2={100} y1={zeroY} y2={zeroY} stroke="var(--ea-border-strong)" strokeWidth={0.4} />
        {data.map((d, i) => {
          const x = i * slot + (slot - w) / 2;
          const ret = scale(d.returning);
          const nw = scale(d.newUsers);
          const res = scale(d.resurrected);
          const ch = scale(Math.abs(d.churned));
          const dim = hover !== null && hover !== i ? 0.4 : 1;
          let y = zeroY;
          const stack: Array<[number, number, string]> = [];
          y -= ret; stack.push([y, ret, RETURN]);
          y -= nw; stack.push([y, nw, UP]);
          y -= res; stack.push([y, res, RESURRECT]);
          return (
            <g key={d.label} opacity={dim}
               onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {stack.map(([yy, hh, fill], k) => hh > 0.4 ? (
                <rect key={k} x={x} y={yy} width={w} height={hh} fill={fill} />
              ) : null)}
              {ch > 0.4 ? <rect x={x} y={zeroY} width={w} height={ch} fill={DOWN} /> : null}
              <rect x={x} y={0} width={w} height={plotH} fill="transparent" />
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.length}, 1fr)`, marginTop: -18 }}>
        {data.map((d, i) => (
          <div key={d.label} style={{
            fontSize: 10, fontFamily: 'var(--ea-mono)', textAlign: 'center',
            color: hover === i ? 'var(--ea-ink)' : 'var(--ea-faint)',
            overflow: 'hidden', whiteSpace: 'nowrap',
          }}>
            {data.length > 10 && i % 2 ? '' : d.label.slice(5)}
          </div>
        ))}
      </div>

      <p className="ea-actfoot">
        {shown
          ? `${shown.label}: ${fmt(shown.newUsers)} new, ${fmt(shown.returning)} returning, ${fmt(shown.resurrected)} back, ${fmt(Math.abs(shown.churned))} lost`
          : 'New and returning above the line, churn below.'}
      </p>
    </div>
  );
}
