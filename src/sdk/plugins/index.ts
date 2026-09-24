/**
 * Built-in plugins.
 *
 * Autocapture defaults to off. Amplitude defaults several capture modes on,
 * which is convenient and also how people ship tracking they did not know
 * about. For a self-hosted tool the honest default is to capture nothing until
 * asked.
 */

import type { AnalyticsEvent, ClickAutocaptureOptions, PageViewAutocaptureOptions } from '../../types';
import type { Plugin } from '../timeline';

/** Tracking surface the autocapture plugins need from the client. */
export interface TrackLike {
  track(eventType: string, props?: Record<string, unknown>): unknown;
}

/** Drops every event while opt-out is set. Registered as a `before` plugin. */
export function optOutPlugin(isOptedOut: () => boolean): Plugin {
  return {
    name: 'opt-out',
    type: 'before',
    execute(event: AnalyticsEvent) {
      return isOptedOut() ? null : event;
    },
  };
}

/** Page views, including SPA history changes. */
export function pageViewsPlugin(
  client: TrackLike,
  options: PageViewAutocaptureOptions = {},
): Plugin {
  const eventType = options.eventType ?? 'Page Viewed';
  const trackHistory = options.trackHistoryChanges !== false;
  let lastUrl = '';
  let detach: (() => void) | null = null;

  const emit = (): void => {
    if (typeof location === 'undefined') return;
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    client.track(eventType, {
      page_url: location.href,
      page_path: location.pathname,
      page_title: typeof document !== 'undefined' ? document.title : undefined,
    });
  };

  return {
    name: 'page-views',
    setup() {
      if (typeof window === 'undefined') return;
      emit();
      if (!trackHistory) return;

      const push = history.pushState;
      const replace = history.replaceState;
      history.pushState = function (...args: Parameters<typeof push>) {
        push.apply(this, args);
        emit();
      };
      history.replaceState = function (...args: Parameters<typeof replace>) {
        replace.apply(this, args);
        emit();
      };
      window.addEventListener('popstate', emit);

      detach = () => {
        history.pushState = push;
        history.replaceState = replace;
        window.removeEventListener('popstate', emit);
      };
    },
    teardown() {
      detach?.();
      detach = null;
    },
  };
}

/** Emits `Session Started` whenever the session id rotates. */
export function sessionEventsPlugin(client: TrackLike): Plugin {
  return {
    name: 'session-events',
    onSessionIdChanged(sessionId: number) {
      client.track('Session Started', { session_id: sessionId });
    },
  };
}

const DEFAULT_CLICK_SELECTORS = ['a', 'button', '[role="button"]', '[data-ea-track]'];
const DEFAULT_MAX_TEXT = 128;

/**
 * Click capture.
 *
 * Records tag name, the allowlisted selector that matched, truncated text, and
 * any `data-ea-*` attributes. Never records input values, and never reads
 * anything inside a password field.
 */
export function clicksPlugin(client: TrackLike, options: ClickAutocaptureOptions = {}): Plugin {
  const selectors = options.cssSelectorAllowlist ?? DEFAULT_CLICK_SELECTORS;
  const maxText = options.maxTextLength ?? DEFAULT_MAX_TEXT;
  let handler: ((e: Event) => void) | null = null;

  return {
    name: 'clicks',
    setup() {
      if (typeof document === 'undefined') return;

      handler = (e: Event) => {
        const target = e.target;
        if (!(target instanceof Element)) return;

        let matched: { el: Element; selector: string } | null = null;
        for (const selector of selectors) {
          const el = target.closest(selector);
          if (el) {
            matched = { el, selector };
            break;
          }
        }
        if (!matched) return;

        // Never capture anything from a password field or its surroundings.
        const input = matched.el.querySelector('input[type="password"]');
        if (input || (matched.el as HTMLInputElement).type === 'password') return;

        const props: Record<string, unknown> = {
          tag: matched.el.tagName.toLowerCase(),
          selector: matched.selector,
        };
        const id = matched.el.getAttribute('id');
        if (id) props.element_id = id;

        const text = (matched.el.textContent ?? '').trim();
        if (text) props.text = text.slice(0, maxText);

        for (const attr of Array.from(matched.el.attributes)) {
          if (attr.name.startsWith('data-ea-')) {
            props[attr.name.replace('data-ea-', '')] = attr.value;
          }
        }
        client.track('Element Clicked', props);
      };

      document.addEventListener('click', handler, true);
    },
    teardown() {
      if (handler && typeof document !== 'undefined') {
        document.removeEventListener('click', handler, true);
      }
      handler = null;
    },
  };
}
