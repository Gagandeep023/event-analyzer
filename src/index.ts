/**
 * @gagandeep023/event-analyzer
 *
 * Self-hosted product analytics. Event capture SDK, Express ingestion, a
 * zero-dependency analysis engine, and a React dashboard.
 *
 * The root export carries `types` and `core` only. `backend` and `frontend` have
 * peer dependencies and are reachable through their own subpaths, so a consumer
 * who installed neither is never asked to resolve express or react.
 *
 *   import { funnel }   from '@gagandeep023/event-analyzer/core';
 *   import { createClient } from '@gagandeep023/event-analyzer/sdk';
 *   import { createEventAnalyzerRouter } from '@gagandeep023/event-analyzer/backend';
 *   import { EventAnalyzerDashboard } from '@gagandeep023/event-analyzer/frontend';
 */

export * from './types';
export * from './core';

export const VERSION = '0.5.1';
