/** Collects platform, page and device context. Browser-aware, Node-safe. */

import type { EventContext } from '../types';
import { isBrowser } from './util';
import { parseCampaign, parseUserAgent, referrerChannel, referrerHost } from './useragent';

export const SDK_VERSION = '0.6.2';
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

    // Parsed here rather than on the server: the raw UA string is useless for
    // grouping, and doing it once at capture keeps every query cheap.
    const agent = parseUserAgent(navigator.userAgent);
    if (agent.browser) ctx.browser = agent.browser;
    if (agent.browser_version) ctx.browser_version = agent.browser_version;
    if (agent.os_name) ctx.os_name = agent.os_name;
    if (agent.os_version) ctx.os_version = agent.os_version;
    if (agent.device_type) ctx.device_type = agent.device_type;

    ctx.page_url = location.href;
    // Path separately, because a URL carrying a query string groups into
    // thousands of distinct "pages" and makes a top-pages table useless.
    ctx.page_path = location.pathname;
    ctx.page_title = document.title;

    if (document.referrer) {
      ctx.referrer = document.referrer;
      const host = referrerHost(document.referrer);
      if (host) ctx.referrer_host = host;
      ctx.referrer_channel = referrerChannel(document.referrer, location.hostname);
    } else {
      ctx.referrer_channel = 'direct';
    }

    Object.assign(ctx, parseCampaign(location.search));

    if (window.screen) ctx.screen = `${window.screen.width}x${window.screen.height}`;
    ctx.viewport = `${window.innerWidth}x${window.innerHeight}`;
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
