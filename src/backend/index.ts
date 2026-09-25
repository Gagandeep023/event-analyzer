/**
 * Express router and storage adapters.
 *
 * `express` is passed into the factory rather than imported, so installing this
 * package for its analysis engine alone never pulls express into the graph.
 *
 *   import express from 'express';
 *   import { createEventAnalyzerRouter, JsonlFileStore }
 *     from '@gagandeep023/event-analyzer/backend';
 *
 *   app.use('/api/events', createEventAnalyzerRouter(express, {
 *     store: new JsonlFileStore({ dir: './data/events' }),
 *     queryAuth: requireAdmin,
 *   }));
 */

export const BACKEND_VERSION = '0.5.2';

export { createEventAnalyzerRouter, type ExpressLike } from './router';
export {
  validateBatch,
  toRejectionMap,
  normalizeFlatEvent,
  MAX_EVENT_TYPE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_OBJECT_DEPTH,
  MIN_EVENT_TIME,
  MAX_CLOCK_SKEW_MS,
  type ValidateOptions,
} from './validate';
export {
  deriveMeta,
  withinRange,
  isAliasCapable,
  type EventStore,
  type StoreMeta,
  type AliasCapableStore,
} from './stores/EventStore';
export { MemoryStore, type MemoryStoreOptions } from './stores/MemoryStore';
export { JsonlFileStore, type JsonlFileStoreOptions } from './stores/JsonlFileStore';
