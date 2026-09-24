/** Collects platform, page and device context. Browser-aware, Node-safe. */

import type { EventContext } from '../types';
import { isBrowser } from './util';

export const SDK_VERSION = '0.1.0';
export const SDK_LIBRARY = `event-analyzer-sdk/${SDK_VERSION}`;

/** Ambient context for the current host. Never throws. */
export function collectContext(): EventContext {
  const ctx: EventContext = { library: SDK_LIBRARY };

  if (!isBrowser()) {
    ctx.platform = 'node';
    const proc = (globalThis as { process?: { version?: string; platform?: string } }).process;
    if (proc?.version) {
      ctx.os_name = 'node';
      ctx.os_version = proc.version.replace(/^v/, '');
    }
    return ctx;
  }

  ctx.platform = 'web';
  try {
    ctx.user_agent = navigator.userAgent;
    ctx.language = navigator.language;
    ctx.page_url = location.href;
    ctx.page_title = document.title;
    if (document.referrer) ctx.referrer = document.referrer;
  } catch {
    // A locked-down environment can throw on these; context is best effort.
  }
  return ctx;
}

/** Merges ambient context under caller-supplied values, which always win. */
export function mergeContext(
  ambient: EventContext,
  defaults: Record<string, unknown>,
  explicit?: EventContext,
): EventContext {
  return { ...ambient, ...(defaults as EventContext), ...(explicit ?? {}) };
}
