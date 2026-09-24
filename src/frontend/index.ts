/**
 * React dashboard.
 *
 *   import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
 *   import '@gagandeep023/event-analyzer/frontend/styles.css';
 *
 *   <EventAnalyzerDashboard baseUrl="/api/events" />
 *
 * Requires `react`, `react-dom` and `recharts` as peer dependencies.
 */

export const FRONTEND_VERSION = '0.1.0';

export {
  EventAnalyzerDashboard,
  type EventAnalyzerDashboardProps,
  type PanelKey,
} from './EventAnalyzerDashboard';

export {
  useQuery, useMeta, useEventStream, useRange,
  type ApiContext, type QueryState, type StreamState, type Fetcher,
} from './hooks';

export {
  StatTile, RangePicker, Toggle, Empty, Loading, ErrorBox, Panel,
  num, pct, duration, shortDate,
} from './components';

export {
  EventsPanel, FunnelPanel, RetentionPanel, SessionsPanel, CohortPanel, LivePanel,
} from './panels';
