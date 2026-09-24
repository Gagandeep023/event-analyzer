# 09. Frontend

One React component, six panels, Recharts for drawing. Self-contained: it takes a base URL and a fetch wrapper and knows nothing about the host application's routing, auth or styling beyond a handful of CSS custom properties it exposes for theming.

```
src/frontend/
├── index.ts
├── EventAnalyzerDashboard.tsx      shell, tab state, shared range picker
├── EventAnalyzerDashboard.css      themed via CSS custom properties
├── panels/
│   ├── LivePanel.tsx        SSE feed, events per second, newest first
│   ├── EventsPanel.tsx      segmentation line chart + event table
│   ├── FunnelPanel.tsx      step builder + drop-off bars + timing
│   ├── RetentionPanel.tsx   measure toggle + curve + cohort heatmap
│   ├── SessionsPanel.tsx    duration histogram + stickiness tiles
│   └── CohortPanel.tsx      definition builder + resulting user list
├── components/
│   ├── RangePicker.tsx
│   ├── StepBuilder.tsx      event + filter picker, driven by /meta
│   ├── FilterRow.tsx
│   └── StatTile.tsx
└── hooks/
    ├── useQuery.ts          POST /query/:kind, abortable, deduped
    ├── useMeta.ts           GET /meta, cached for the session
    └── useEventStream.ts    SSE with reconnect and backoff
```

## Usage

```tsx
import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
import '@gagandeep023/event-analyzer/frontend/styles.css';

<EventAnalyzerDashboard
  baseUrl="/api/events"
  fetcher={authedFetch}          // optional; defaults to window.fetch
  tzOffsetMin={-new Date().getTimezoneOffset()}
  defaultRange={{ days: 30 }}
  panels={['live','events','funnel','retention','sessions','cohort']}
/>
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `baseUrl` | string | required | Where the router is mounted |
| `fetcher` | `typeof fetch` | `window.fetch` | Inject an authenticated wrapper here |
| `tzOffsetMin` | number | browser offset | Sent with every query |
| `defaultRange` | `{ days }` or `TimeRange` | 30 days | Per-panel override available |
| `panels` | string[] | all six | Order is respected |
| `theme` | `'dark' \| 'light' \| 'auto'` | `'auto'` | Reads `prefers-color-scheme` on auto |

## Theming

The stylesheet defines everything through CSS custom properties on `.ea-root`, so a host can restyle without overriding selectors:

```css
.ea-root {
  --ea-bg: #0a0a0a;
  --ea-surface: #121212;
  --ea-line: #262626;
  --ea-text: #e8e8e8;
  --ea-text-dim: #9a9a9a;
  --ea-accent: #64ffda;
  --ea-warn: #e8b45c;
  --ea-crit: #f07c7c;
  --ea-radius: 10px;
  --ea-font: inherit;
}
```

Defaults match the dark palette already used across the portfolio, so a later integration needs no restyling.

## Rendering decisions that matter

**The retention heatmap is a table, not a chart.** Cohort grids are tabular data. Forcing them into a charting library produces something that cannot be read or copied. Semi-transparent accent background scaled by rate, `tabular-nums` for alignment, and cells flagged `incomplete` rendered at reduced opacity with the raw counts still legible.

**Funnel bars are horizontal.** Step labels are event names and event names are long. Vertical bars force truncation or rotated labels; horizontal bars give the label a full line.

**Every panel owns its own range.** Tempting to share one global range, but funnel and retention want different defaults (30 days versus 90) and forcing one range makes both worse. The shell holds a default; each panel can diverge.

**Empty states are explicit.** "No events yet" with the exact curl to send one beats an empty chart, which is indistinguishable from a broken chart.

**The step builder reads `/meta`.** Picking event types and property keys from discovered data rather than free text removes the most common source of an empty result: a typo in an event name.

**Queries are abortable and deduped.** Changing the range fires six panel queries. `useQuery` aborts the previous request for the same key and collapses identical in-flight requests, so dragging a date picker does not queue thirty requests.

## Panel detail

| Panel | Primary chart | Secondary |
|---|---|---|
| Live | Events-per-second sparkline | Newest-first event list, expandable rows |
| Events | Multi-series line chart | Sortable table of event types with totals |
| Funnel | Horizontal drop-off bars | Per-hop median and p90 timing, group-by tabs |
| Retention | Curve line chart | Triangular cohort heatmap table, measure toggle |
| Sessions | Duration histogram | DAU/WAU/MAU stat tiles, sessions-over-time line |
| Cohort | Definition builder | Resulting user list with a "use as segment" action |

## Accessibility notes

- Tabs are a real `role="tablist"` with arrow key navigation.
- The heatmap table carries `scope` attributes on headers and a caption naming the measure and interval.
- Charts get an adjacent visually-hidden data table, so the numbers are reachable without reading a canvas.
- Focus is visible everywhere; `prefers-reduced-motion` disables chart entry animation.
