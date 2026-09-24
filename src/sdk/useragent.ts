/**
 * Minimal user-agent parsing.
 *
 * Deliberately small and conservative rather than a full UA database. It
 * recognises the browsers and platforms that make up almost all real traffic
 * and returns `undefined` rather than guessing when it does not recognise
 * something. A wrong browser label is worse than a missing one, because a
 * missing one is visible in the chart as "unknown" and a wrong one is not.
 *
 * Order matters throughout: Edge claims to be Chrome, Chrome claims to be
 * Safari, and every one of them claims to be Mozilla.
 */

export interface ParsedAgent {
  browser?: string;
  browser_version?: string;
  os_name?: string;
  os_version?: string;
  device_type?: 'desktop' | 'mobile' | 'tablet' | 'bot';
}

const BROWSERS: ReadonlyArray<[string, RegExp]> = [
  // Most specific first; each of these also matches the ones below it.
  ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Opera', /OPR\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari/],
];

const OSES: ReadonlyArray<[string, RegExp]> = [
  ['iOS', /(?:iPhone|iPad|iPod).*?OS ([\d_]+)/],
  ['Android', /Android ([\d.]+)/],
  ['Windows', /Windows NT ([\d.]+)/],
  ['macOS', /Mac OS X ([\d_]+)/],
  ['Linux', /Linux/],
];

const WINDOWS_NAMES: Record<string, string> = {
  '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7',
};

const BOT = /bot|crawler|spider|crawling|headlesschrome|puppeteer|playwright|lighthouse|pingdom|curl|wget/i;

export function parseUserAgent(ua: string | undefined): ParsedAgent {
  if (!ua) return {};
  const out: ParsedAgent = {};

  if (BOT.test(ua)) out.device_type = 'bot';

  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      out.browser = name;
      // Major version only. Nobody segments by Chrome 131.0.6778.86.
      if (m[1]) out.browser_version = m[1].split(/[._]/)[0];
      break;
    }
  }

  for (const [name, re] of OSES) {
    const m = re.exec(ua);
    if (m) {
      out.os_name = name;
      if (m[1]) {
        const v = m[1].replace(/_/g, '.');
        out.os_version = name === 'Windows' ? (WINDOWS_NAMES[v] ?? v) : v.split('.').slice(0, 2).join('.');
      }
      break;
    }
  }

  if (out.device_type !== 'bot') {
    out.device_type = /iPad|Tablet|PlayBook|Silk|(?=.*Android)(?!.*Mobile)/i.test(ua)
      ? 'tablet'
      : /Mobi|iPhone|iPod|Android|IEMobile|BlackBerry/i.test(ua)
        ? 'mobile'
        : 'desktop';
  }

  return out;
}

/** UTM and click-id parameters, the ones every attribution report expects. */
export const CAMPAIGN_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ref',
] as const;

export function parseCampaign(search: string | undefined): Record<string, string> {
  if (!search) return {};
  const out: Record<string, string> = {};
  try {
    const params = new URLSearchParams(search);
    for (const key of CAMPAIGN_KEYS) {
      const v = params.get(key);
      if (v) out[key] = v.slice(0, 128);
    }
  } catch {
    // A malformed query string is not worth failing a page view over.
  }
  return out;
}

/**
 * Classifies a referrer into a channel.
 *
 * Coarse on purpose: "search", "social", "referral", "direct". Anything finer
 * is a marketing-attribution product, which this is not.
 */
export function referrerChannel(referrer: string | undefined, ownHost: string | undefined): string {
  if (!referrer) return 'direct';
  let host: string;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return 'direct';
  }
  if (ownHost && host === ownHost.replace(/^www\./, '')) return 'internal';
  if (/google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|brave/.test(host)) return 'search';
  if (/twitter|x\.com|facebook|linkedin|reddit|instagram|t\.co|news\.ycombinator|mastodon|bsky/.test(host)) return 'social';
  if (/github|gitlab|npmjs/.test(host)) return 'developer';
  return 'referral';
}

/** Host of a referrer, for a "top referrers" table. */
export function referrerHost(referrer: string | undefined): string | undefined {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
