/**
 * The analysis engine.
 *
 * Pure functions, zero dependencies, no I/O, no clock reads. Events in, results
 * out. That constraint is what makes this module trivially testable and usable
 * standalone against an array from any database, with no server involved.
 *
 *   import { funnel, retention } from '@gagandeep023/event-analyzer/core';
 *
 * Every analysis accepts an optional pre-built `IdentityGraph`. Build it once
 * per query and pass it down, so device-to-user resolution is paid for once
 * rather than per chart.
 */

export const CORE_VERSION = '0.6.1';

// Predicates and property access
export {
  resolveProperty,
  evaluateFilter,
  matchesAll,
  matchesStep,
  stepLabel,
  MAX_REGEX_LENGTH,
  _clearRegexCache,
} from './filter';

// Identity resolution
export {
  buildIdentityGraph,
  groupByUser,
  byTime,
  userSetMatcher,
  type IdentityGraph,
} from './identity';

// User property merging
export {
  mergeUserProperties,
  latestUserProperties,
  asPropertyCarrier,
} from './properties';

// Time bucketing
export {
  bucketStart,
  bucketRange,
  bucketLabel,
  periodsBetween,
  periodLabel,
  addPeriods,
  inRange,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_WEEK,
} from './time';

// Statistics
export {
  percentile,
  percentileOf,
  median,
  mean,
  histogram,
  binLabel,
  durationLabel,
  countDistinct,
  ratio,
  ascending,
} from './stats';

// The five analyses
export { segmentation, OTHER_GROUP_LABEL, DEFAULT_LIMIT_GROUPS } from './segmentation';
export { funnel, MAX_FUNNEL_ATTEMPTS } from './funnel';
export { retention } from './retention';
export { buildCohort } from './cohort';
export { eventStats, DEFAULT_EVENT_LIMIT } from './events';
export { breakdown, DEFAULT_BREAKDOWN_LIMIT, OTHER_ROW, UNKNOWN_VALUE } from './breakdown';
export { growth, retentionRatio, DEFAULT_DORMANT_AFTER } from './growth';
export { activity, DAY_LABELS } from './activity';
export {
  deriveSessions,
  sessionStats,
  stickiness,
  DEFAULT_SESSION_TIMEOUT_MS,
  type DeriveOptions,
} from './sessions';
