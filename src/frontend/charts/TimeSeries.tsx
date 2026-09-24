/**
 * Area + line time series with an optional dashed comparison line.
 *
 * Hand-rolled SVG rather than a charting library, for three reasons: the hover
 * behaviour here is specific (invisible hit columns, a crosshair, a tooltip that
 * flips near the right edge), the output has to match a design exactly, and it
 * keeps the package free of a charting dependency.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { T, fmt } from '../theme';

export interface TimeSeriesProps {
  buckets: number[];
  values: number[];
  /** Same length as `values`, drawn dashed. */
  previous?: number[];
  labelFor: (t: number, i: number) => string;
  height?: number;
  /** Tooltip heading, e.g. the metric name. */
  name?: string;
}

const PAD_L = 42;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

export function TimeSeries({
  buckets, values, previous, labelFor, height = 240, name,
}: TimeSeriesProps): React.ReactElement {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(720);

  // Measure once mounted, then on resize. ResizeObserver keeps the SVG honest
  // inside a flexible grid without a layout library.
  React.useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { max, pts, prevPts, plotW, plotH } = useMemo(() => {
    const all = previous ? [...values, ...previous] : values;
    const peak = Math.max(1, ...all);
    // 1.08 headroom so the peak never touches the top edge.
    const m = peak * 1.08;
    const pw = Math.max(1, width - PAD_L - PAD_R);
    const ph = Math.max(1, height - PAD_T - PAD_B);
    const x = (i: number) => PAD_L + (values.length <= 1 ? pw / 2 : (i / (values.length - 1)) * pw);
    const y = (v: number) => PAD_T + ph - (v / m) * ph;
    return {
      max: m,
      plotW: pw,
      plotH: ph,
      pts: values.map((v, i) => [x(i), y(v)] as const),
      prevPts: previous?.map((v, i) => [x(i), y(v)] as const),
    };
  }, [values, previous, width, height]);

  const line = (p: ReadonlyArray<readonly [number, number]>) =>
    p.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const area = pts.length
    ? `${line(pts)} L${pts[pts.length - 1]![0].toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${pts[0]![0].toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`
    : '';

  const onMove = useCallback((e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
    const i = Math.round(rel * (values.length - 1));
    setHover(Math.min(values.length - 1, Math.max(0, i)));
  }, [values.length]);

  // Five evenly spaced x labels, always including both ends.
  const tickIdx = useMemo(() => {
    const n = values.length;
    if (n <= 5) return values.map((_, i) => i);
    return [0, 1, 2, 3, 4].map((k) => Math.round((k / 4) * (n - 1)));
  }, [values.length]);

  const hv = hover !== null ? values[hover] : null;
  const hp = hover !== null && previous ? previous[hover] : null;
  const hx = hover !== null ? pts[hover]?.[0] ?? 0 : 0;
  const flip = hx > PAD_L + plotW * 0.75;

  return (
    <div className="ea-chart" ref={wrap}>
      <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img"
           aria-label={`${name ?? 'Value'} over time`}>
        {[1, 0.5, 0].map((f) => {
          const y = PAD_T + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={width - PAD_R} y1={y} y2={y} stroke={T.borderSoft} strokeWidth={1} />
              <text className="ea-axis" x={PAD_L - 8} y={y + 4} textAnchor="end">{fmt(max * f)}</text>
            </g>
          );
        })}

        {prevPts && prevPts.length > 1 ? (
          <path d={line(prevPts)} fill="none" stroke={T.comparison} strokeWidth={1.5} strokeDasharray="4 4" />
        ) : null}

        {pts.length > 1 ? <path d={area} fill={T.accentArea} /> : null}
        {pts.length > 1 ? (
          <path d={line(pts)} fill="none" stroke={T.accent} strokeWidth={2}
                strokeLinejoin="round" strokeLinecap="round" />
        ) : null}

        {tickIdx.map((i) => (
          <text key={i} className="ea-axis" y={height - 6}
                x={pts[i]?.[0] ?? 0}
                textAnchor={i === 0 ? 'start' : i === values.length - 1 ? 'end' : 'middle'}>
            {labelFor(buckets[i] ?? 0, i)}
          </text>
        ))}

        {hover !== null && pts[hover] ? (
          <g>
            <line x1={hx} x2={hx} y1={PAD_T} y2={PAD_T + plotH} stroke={T.borderStrong} strokeWidth={1} />
            <circle cx={hx} cy={pts[hover]![1]} r={4.5} fill="#fff" stroke={T.accent} strokeWidth={2} />
          </g>
        ) : null}

        {/* One invisible hit area; the index is derived from the x position. */}
        <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="transparent"
              onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>

      {hover !== null && hv !== null && hv !== undefined ? (
        <div className="ea-tip" style={{
          left: flip ? hx - 12 : hx + 12,
          top: (pts[hover]?.[1] ?? 0) - 12,
          transform: flip ? 'translate(-100%, -100%)' : 'translate(0, -100%)',
        }}>
          <div className="d">{labelFor(buckets[hover] ?? 0, hover)}</div>
          <div className="v">{fmt(hv)}</div>
          {hp !== null && hp !== undefined ? <div className="p">prev {fmt(hp)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
