/**
 * The capture client.
 *
 * Runs in a browser or in Node with the same core and different adapters.
 * Zero dependencies, fire-and-forget by default so a tracking call never blocks
 * a user interaction.
 *
 * Implemented in phase 3. See docs/07-sdk.md.
 */

export const SDK_VERSION = '0.1.0';

/** Identifies the client to the server, sent on every event as `context.library`. */
export const SDK_LIBRARY = `event-analyzer-sdk/${SDK_VERSION}`;
