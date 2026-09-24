/**
 * The five query and result pairs.
 *
 * Results are plain JSON, directly renderable by Recharts without a transform step.
 */

import type {
  Filter,
  Granularity,
  Interval,
  PropertyRef,
  StepSpec,
  TimeRange,
  TzOffsetMin,
} from './filter';

/** Fields every query carries. */
export interface BaseQuery {
  range: TimeRange;
  /** Minutes east of UTC. Falls back to the router default, then to 0. */
  tzOffsetMin?: TzOffsetMin;
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * `uniques` counts distinct resolved users, `totals` counts events, and
 * `average` is totals divided by uniques, returning 0 rather than NaN for
 * empty buckets.
 */
export type CountBy = 'uniques' | 'totals' | 'average';

export interface SegmentationQuery extends BaseQuery {
  events: StepSpec[];
  countBy: CountBy;
  granularity: Granularity;
  groupBy?: PropertyRef;
  segment?: Filter[];
  /** Default 10. The tail beyond this is summed into an `Other` series. */
  limitGroups?: number;
}

export interface SeriesPoint {
  t: number;
  value: number;
}

export interface Series {
  label: string;
  points: SeriesPoint[];
  total: number;
}

export interface SegmentationResult {
  series: Series[];
  /** Shared x-axis. Bucket start times, including empty buckets. */
  buckets: number[];
  granularity: Granularity;
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

/**
 * Amplitude's vocabulary, kept verbatim so a migrated query means the same thing.
 *
 * - `ordered`    steps in the given order, other events permitted between them
 * - `unordered`  all steps within the window, in any order
 * - `sequential` steps in the given order with NO other event between two steps
 *
 * Note that `sequential` is not the intuitive plain in-order mode. `ordered` is.
 */
export type FunnelOrder = 'ordered' | 'unordered' | 'sequential';

export const FUNNEL_ORDERS: readonly FunnelOrder[] = Object.freeze([
  'ordered', 'unordered', 'sequential',
]);

/** Thirty days, matching Amplitude's default conversion window. */
export const DEFAULT_CONVERSION_WINDOW_MS = 2_592_000_000;

export interface FunnelQuery extends BaseQuery {
  /** Two to eight steps. */
  steps: StepSpec[];
  order: FunnelOrder;
  /** Bounds the whole funnel, not each hop. */
  conversionWindowMs: number;
  /** Firing one of these between two steps truncates the attempt. */
  exclusions?: StepSpec[];
  /** `totals` counts completed attempts rather than users. */
  countBy: Exclude<CountBy, 'average'>;
  groupBy?: PropertyRef;
  /** Applies to the FIRST step only, matching Amplitude. */
  segment?: Filter[];
}

export interface FunnelStepResult {
  index: number;
  label: string;
  event_type: string;
  count: number;
  /** 0..1 */
  conversionFromStart: number;
  /** 0..1 */
  conversionFromPrevious: number;
  dropOff: number;
  /** 0..1 */
  dropOffRate: number;
  /** Null when no user reached this step. */
  medianTimeFromPreviousMs: number | null;
  p90TimeFromPreviousMs: number | null;
}

export interface FunnelResult {
  /** Counts are monotonically non-increasing by construction. */
  steps: FunnelStepResult[];
  totalEntered: number;
  totalConverted: number;
  overallConversion: number;
  medianTotalTimeMs: number | null;
  groups?: Record<string, FunnelResult>;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * - `n-day`     returned on exactly day N
 * - `unbounded` returned on day N or any day after
 * - `bracket`   returned within a caller-defined `[lo, hi]` window
 *
 * Amplitude's own research found `n-day` understates returning users by roughly
 * 3.5x against `unbounded`. Shipping only `n-day` is the usual way a retention
 * implementation is quietly wrong.
 */
export type RetentionMeasure = 'n-day' | 'unbounded' | 'bracket';

export const RETENTION_MEASURES: readonly RetentionMeasure[] = Object.freeze([
  'n-day', 'unbounded', 'bracket',
]);

/** Inclusive `[lo, hi]` period bounds. */
export type RetentionBracket = [number, number];

export interface RetentionQuery extends BaseQuery {
  /** Use `{ event_type: '*' }` for "any event". */
  startAction: StepSpec;
  returnAction: StepSpec;
  measure: RetentionMeasure;
  interval: Interval;
  /** Used by `n-day` and `unbounded`. */
  periods: number;
  /** Required when `measure` is `bracket`. */
  brackets?: RetentionBracket[];
  /** Applies to the START action only, matching Amplitude. */
  segment?: Filter[];
}

export interface RetentionCell {
  period: number;
  retained: number;
  /** 0..1 */
  rate: number;
  /**
   * True when the cohort has not had enough elapsed time to be fairly measured
   * at this period. The renderer greys these rather than the engine dropping them.
   */
  incomplete: boolean;
}

export interface RetentionCurvePoint extends RetentionCell {
  label: string;
  /** Each point carries its OWN denominator: only cohorts with full observation. */
  cohortSize: number;
}

export interface RetentionCohortRow {
  cohortStart: number;
  cohortLabel: string;
  cohortSize: number;
  /** Cells exist only where observable, producing the triangular staircase. */
  cells: RetentionCell[];
}

export interface RetentionResult {
  measure: RetentionMeasure;
  interval: Interval;
  totalUsers: number;
  curve: RetentionCurvePoint[];
  table: RetentionCohortRow[];
}

// ---------------------------------------------------------------------------
// Cohort
// ---------------------------------------------------------------------------

export interface CohortClause {
  step: StepSpec;
  atLeast?: number;
  atMost?: number;
}

export interface CohortQuery extends BaseQuery {
  did: CohortClause[];
  didNot?: StepSpec[];
  /** Measured from each user's own first matching event, not from `range.from`. */
  withinMs?: number;
  /** Matched against each user's merged latest user properties. */
  userFilters?: Filter[];
}

export interface CohortResult {
  /** Returned so a cohort can be fed back into another query as a segment. */
  userIds: string[];
  size: number;
  totalUsersInRange: number;
  /** size / totalUsersInRange */
  share: number;
  definition: CohortQuery;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionQuery extends BaseQuery {
  segment?: Filter[];
  granularity: Granularity;
}

/** A derived session. Never stored; always computed from `session_id` or gaps. */
export interface Session {
  userKey: string;
  /** Session start in ms. Doubles as the identifier. */
  sessionId: number;
  start: number;
  end: number;
  /** Zero for single-event sessions. */
  durationMs: number;
  eventCount: number;
  eventTypes: string[];
}

export interface HistogramBin {
  bucketLabel: string;
  lowerMs: number;
  upperMs: number;
  count: number;
}

export interface Stickiness {
  dau: number;
  wau: number;
  mau: number;
  dauOverMau: number;
  dauOverWau: number;
}

export interface SessionResult {
  totalSessions: number;
  totalUsers: number;
  medianDurationMs: number;
  p90DurationMs: number;
  meanEventsPerSession: number;
  durationHistogram: HistogramBin[];
  stickiness: Stickiness;
  sessionsOverTime: Array<{ t: number; sessions: number; users: number }>;
}

/**
 * Amplitude's default session-length bin edges, in milliseconds.
 *
 * Deliberately non-linear: session length is heavily right-skewed and linear
 * bins produce one useless spike. Session length caps at one day.
 */
export const SESSION_BIN_EDGES: readonly number[] = Object.freeze([
  0, 3_000, 10_000, 30_000, 60_000, 180_000, 600_000, 1_800_000, 3_600_000, 86_400_000,
]);

/** Maximum session length, one day. */
export const MAX_SESSION_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The five analyses reachable through `POST /query/:kind`. */
export type QueryKind = 'segmentation' | 'funnel' | 'retention' | 'cohort' | 'sessions';

export const QUERY_KINDS: readonly QueryKind[] = Object.freeze([
  'segmentation', 'funnel', 'retention', 'cohort', 'sessions',
]);

export interface QueryMap {
  segmentation: { query: SegmentationQuery; result: SegmentationResult };
  funnel: { query: FunnelQuery; result: FunnelResult };
  retention: { query: RetentionQuery; result: RetentionResult };
  cohort: { query: CohortQuery; result: CohortResult };
  sessions: { query: SessionQuery; result: SessionResult };
}

export type AnyQuery = QueryMap[QueryKind]['query'];
export type AnyResult = QueryMap[QueryKind]['result'];
