/**
 * React dashboard.
 *
 *   import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
 *   import '@gagandeep023/event-analyzer/frontend/styles.css';
 *
 *   <EventAnalyzerDashboard baseUrl="/api/events" />
 *
 * Requires `react` and `react-dom` as peer dependencies. Charts are hand-rolled
 * SVG, so there is no charting library to install.
 */

export const FRONTEND_VERSION = '0.5.0';

export {
  EventAnalyzerDashboard,
  type EventAnalyzerDashboardProps,
  type PageKey,
  type RangeKey,
} from './EventAnalyzerDashboard';

export { Overview, type Metric, type OverviewProps } from './pages/Overview';
export { Events } from './pages/Events';
export { Audience, BreakdownTable } from './pages/Audience';
export { Pages } from './pages/Pages';
export { Clicks } from './pages/Clicks';
export { Funnels, type FunnelDef } from './pages/Funnels';
export { Retention } from './pages/Retention';
export { Live } from './pages/Live';

export { TimeSeries, Donut, BarList, BarChart, Heatmap, ActivityGrid, StackedBars } from './charts';
export type { TimeSeriesProps, DonutProps, DonutSlice, BarDatum, GrowthBar } from './charts';

export { Panel, Segmented, Delta, Empty, Loading, ErrorBox, Async } from './components';

export {
  useQuery, useMeta, useEventStream, useRange,
  type ApiContext, type QueryState, type StreamState, type LiveEvent, type Fetcher,
} from './hooks';

export { T, CATEGORICAL, fmt, pct, delta, shortDate, clockTime, duration, ago } from './theme';
