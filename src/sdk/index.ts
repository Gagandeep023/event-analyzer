/**
 * The capture client.
 *
 * Runs in a browser or in Node with the same core and different adapters. Zero
 * dependencies, fire-and-forget by default so a tracking call never blocks a
 * user interaction.
 *
 *   import { createClient, Identify, Revenue } from '@gagandeep023/event-analyzer/sdk';
 *
 *   const ea = createClient({ endpoint: '/api/events/collect' });
 *   ea.track('Checkout Started', { cart_value: 4200 });
 */

export { SDK_VERSION, SDK_LIBRARY, collectContext, mergeContext } from './context';
export { Client, createClient, IDENTITY_KEY, type TrackResult } from './client';
export { Identify, Revenue } from './identify';
export { Timeline, type Plugin, type PluginType, type DestinationPlugin } from './timeline';
export { Destination, QUEUE_KEY, rejectedIndices } from './destination';
export { SessionManager, isNewSession, type SessionState } from './session';
export {
  fetchTransport,
  beaconTransport,
  nodeTransport,
  resolveTransport,
} from './transport';
export { memoryStorage, localStorageAdapter, resolveStorage } from './storage';
export {
  optOutPlugin,
  pageViewsPlugin,
  sessionEventsPlugin,
  clicksPlugin,
  type TrackLike,
} from './plugins';
export { uuid, createLogger, isBrowser, chunk } from './util';
