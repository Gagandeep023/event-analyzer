/**
 * Design tokens.
 *
 * Exported as values because the SVG charts are hand-rolled and need the same
 * colours the stylesheet uses. Keep these and the CSS custom properties in
 * `EventAnalyzerDashboard.css` in step: the CSS is the source of truth for
 * anything a host might restyle, this is the source for anything drawn.
 */

export const T = {
  bg: '#FAFAF8',
  surface: '#FFFFFF',
  border: '#ECEAE5',
  borderSoft: '#F1F0EC',
  borderStrong: '#DAD7D0',
  rowDivider: '#F6F5F2',
  activeNav: '#EFEEE9',
  rowHover: '#FCFCFA',

  ink: '#1C1B19',
  ink2: '#3A3934',
  ink3: '#55534D',
  muted: '#6B6962',
  faint: '#9A978F',

  comparison: '#C9C6BE',
  accent: 'oklch(0.55 0.13 250)',
  accentLink: 'oklch(0.5 0.13 250)',
  accentArea: 'oklch(0.55 0.13 250 / 0.07)',
  accentBar: 'oklch(0.55 0.13 250 / 0.55)',
  accentBarStrong: 'oklch(0.55 0.13 250 / 0.85)',
  positive: 'oklch(0.5 0.13 150)',
  negative: 'oklch(0.52 0.15 28)',
  live: 'oklch(0.62 0.14 150)',
} as const;

/**
 * Categorical palette for breakdowns.
 *
 * One accent carries the primary series everywhere else; a pie of six slices is
 * the one place that cannot work. These are held at the same lightness and
 * chroma so no slice shouts louder than another.
 */
export const CATEGORICAL = [
  'oklch(0.55 0.13 250)',
  'oklch(0.6 0.12 190)',
  'oklch(0.62 0.13 150)',
  'oklch(0.68 0.12 90)',
  'oklch(0.62 0.14 40)',
  'oklch(0.55 0.12 320)',
  'oklch(0.6 0.1 280)',
  'oklch(0.66 0.08 220)',
] as const;

/** Compact number: 1.2k, 48k, 1.4M. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const n = Math.abs(v);
  if (n >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return Math.round(v / 1e3) + 'k';
  if (n >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

export function pct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * Signed percentage for a delta.
 *
 * Returns null below the noise floor so a 0.3% wiggle renders neutral instead
 * of being dressed up as a trend.
 */
export function delta(change: number | null | undefined): { text: string; dir: 'up' | 'down' | 'flat' } {
  if (change === null || change === undefined || !Number.isFinite(change)) {
    return { text: 'new', dir: 'flat' };
  }
  const p = change * 100;
  if (Math.abs(p) < 1) return { text: `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`, dir: 'flat' };
  return { text: `${p >= 0 ? '+' : ''}${p.toFixed(p >= 100 ? 0 : 1)}%`, dir: p >= 0 ? 'up' : 'down' };
}

export function shortDate(t: number): string {
  const d = new Date(t);
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}

export function clockTime(t: number): string {
  return new Date(t).toTimeString().slice(0, 8);
}

export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Relative "last seen", the way a table wants it. */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
