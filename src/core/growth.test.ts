import { describe, it, expect } from 'vitest';
import { growth } from './growth';
import { activity, DAY_LABELS } from './activity';
import { parseUserAgent, referrerChannel, referrerHost, parseCampaign } from '../sdk/useragent';
import { buildIdentityGraph } from './identity';
import { ev, day, daysRange, T0, DAY } from './__fixtures__';
import type { AnalyticsEvent } from '../types';

/**
 * Four users over five daily periods:
 *   steady   d0 d1 d2 d3 d4   never leaves
 *   newcomer       d2 d3      first seen on d2
 *   leaver   d0 d1            gone after d1
 *   sleeper  d0       d3      dormant d1-d2, back on d3
 */
function fixture(): AnalyticsEvent[] {
  const plan: Record<string, number[]> = {
    steady: [0, 1, 2, 3, 4],
    newcomer: [2, 3],
    leaver: [0, 1],
    sleeper: [0, 3],
  };
  const out: AnalyticsEvent[] = [];
  for (const [user, days] of Object.entries(plan)) {
    for (const d of days) out.push(ev({ type: 'Active', user, t: day(d, 9) }));
  }
  return out;
}

const run = (events: AnalyticsEvent[], over = {}) =>
  growth(events, { interval: 'day', range: daysRange(5), ...over }, buildIdentityGraph(events));

describe('growth accounting', () => {
  it('produces one point per period', () => {
    expect(run(fixture()).points).toHaveLength(5);
  });

  it('counts a user as new only in the period they first appear', () => {
    const p = run(fixture()).points;
    expect(p[0]!.newUsers).toBe(3);   // steady, leaver, sleeper
    expect(p[2]!.newUsers).toBe(1);   // newcomer
    expect(p[3]!.newUsers).toBe(0);
  });

  it('counts consecutive activity as returning', () => {
    const p = run(fixture()).points;
    // d1: steady and leaver were both active on d0.
    expect(p[1]!.returning).toBe(2);
  });

  it('counts a comeback after a real gap as resurrected', () => {
    // sleeper was dormant on d1 and d2, so d3 is a resurrection.
    expect(run(fixture()).points[3]!.resurrected).toBe(1);
  });

  it('does not call a one-period gap a resurrection', () => {
    // An irregular user is not a comeback; inflating that flatters the number.
    const events = [
      ev({ type: 'Active', user: 'gappy', t: day(0, 9) }),
      ev({ type: 'Active', user: 'gappy', t: day(2, 9) }),
    ];
    const p = run(events, { dormantAfter: 3 }).points;
    expect(p[2]!.resurrected).toBe(0);
    expect(p[2]!.returning).toBe(1);
  });

  it('reports churn as a negative number', () => {
    const p = run(fixture()).points;
    // leaver was active on d1 and not on d2. sleeper too.
    expect(p[2]!.churned).toBeLessThan(0);
  });

  it('active equals new + returning + resurrected', () => {
    for (const p of run(fixture()).points) {
      expect(p.active).toBe(p.newUsers + p.returning + p.resurrected);
    }
  });

  it('net change is new + resurrected minus churn', () => {
    for (const p of run(fixture()).points) {
      expect(p.netChange).toBe(p.newUsers + p.resurrected + p.churned);
    }
  });

  it('computes a quick ratio above 1 when growth outpaces churn', () => {
    const r = run(fixture());
    expect(r.quickRatio).not.toBeNull();
    expect(r.quickRatio!).toBeGreaterThan(0);
  });

  it('reports null quick ratio when nobody churned', () => {
    // Active in every period, so there is never a period they were present in
    // and then absent from. A user seen only on day 0 DOES churn on day 1.
    const events = [0, 1, 2, 3, 4].map((d) => ev({ type: 'Active', user: 'a', t: day(d, 9) }));
    const r = run(events);
    expect(r.totals.churned).toBe(0);
    expect(r.quickRatio).toBeNull();
  });

  it('does not miscount pre-existing users as new in the first period', () => {
    // 'veteran' was first seen before the range; the range must not relabel them.
    const events = [
      ev({ type: 'Active', user: 'veteran', t: day(-30, 9) }),
      ev({ type: 'Active', user: 'veteran', t: day(0, 9) }),
    ];
    expect(run(events).points[0]!.newUsers).toBe(0);
    expect(run(events).points[0]!.active).toBe(1);
  });
});

describe('activity matrix', () => {
  it('is 7 days by 24 hours, Monday first', () => {
    const r = activity([], { range: daysRange(7) }, buildIdentityGraph([]));
    expect(r.cells).toHaveLength(7);
    expect(r.cells[0]).toHaveLength(24);
    expect(DAY_LABELS[0]).toBe('Mon');
  });

  it('places an event in the right day and hour', () => {
    // T0 is 2026-01-01, a Thursday -> index 3.
    const at = T0 + 14 * 3_600_000;
    expect(new Date(T0).getUTCDay()).toBe(4);
    const events = [ev({ type: 'X', user: 'a', t: at })];
    const r = activity(events, { range: daysRange(7) }, buildIdentityGraph(events));
    expect(r.cells[3]![14]).toBe(1);
    expect(r.busiest).toMatchObject({ day: 3, hour: 14, value: 1 });
  });

  it('shifts into the caller timezone', () => {
    // 19:00 UTC is 00:30 next day in IST, so it moves a day and an hour.
    const at = T0 + 19 * 3_600_000;
    const events = [ev({ type: 'X', user: 'a', t: at })];
    const utc = activity(events, { range: daysRange(7) }, buildIdentityGraph(events));
    const ist = activity(events, { range: daysRange(7), tzOffsetMin: 330 }, buildIdentityGraph(events));
    expect(utc.busiest!.hour).toBe(19);
    expect(ist.busiest!.day).toBe(4);
    expect(ist.busiest!.hour).toBe(0);
  });

  it('counts uniques by default and totals on request', () => {
    const events = [
      ev({ type: 'X', user: 'a', t: T0 + 3_600_000 }),
      ev({ type: 'X', user: 'a', t: T0 + 3_600_000 + 60_000 }),
    ];
    const u = activity(events, { range: daysRange(7) }, buildIdentityGraph(events));
    const t = activity(events, { range: daysRange(7), countBy: 'totals' }, buildIdentityGraph(events));
    expect(u.peak).toBe(1);
    expect(t.peak).toBe(2);
  });

  it('margins sum to the grid', () => {
    const events = [
      ev({ type: 'X', user: 'a', t: T0 + 3_600_000 }),
      ev({ type: 'X', user: 'b', t: T0 + DAY + 7_200_000 }),
    ];
    const r = activity(events, { range: daysRange(7) }, buildIdentityGraph(events));
    const grid = r.cells.flat().reduce((n, v) => n + v, 0);
    expect(r.byDay.reduce((n, v) => n + v, 0)).toBe(grid);
    expect(r.byHour.reduce((n, v) => n + v, 0)).toBe(grid);
  });
});

describe('user agent parsing', () => {
  const UA = {
    chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    headless: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0.0.0 Safari/537.36',
  };

  it('does not mistake Edge for Chrome', () => {
    // Edge's UA contains "Chrome/". Order of the matchers is what saves this.
    expect(parseUserAgent(UA.edge).browser).toBe('Edge');
    expect(parseUserAgent(UA.chrome).browser).toBe('Chrome');
  });

  it('does not mistake Chrome for Safari', () => {
    expect(parseUserAgent(UA.safari).browser).toBe('Safari');
    expect(parseUserAgent(UA.chrome).browser).not.toBe('Safari');
  });

  it('keeps only the major version', () => {
    expect(parseUserAgent(UA.chrome).browser_version).toBe('131');
  });

  it('reads the operating system', () => {
    expect(parseUserAgent(UA.chrome).os_name).toBe('macOS');
    expect(parseUserAgent(UA.edge).os_name).toBe('Windows');
    expect(parseUserAgent(UA.firefox).os_name).toBe('Linux');
    expect(parseUserAgent(UA.iphone).os_name).toBe('iOS');
  });

  it('names Windows by its marketing version', () => {
    expect(parseUserAgent(UA.edge).os_version).toBe('10/11');
  });

  it('classifies device type', () => {
    expect(parseUserAgent(UA.chrome).device_type).toBe('desktop');
    expect(parseUserAgent(UA.iphone).device_type).toBe('mobile');
  });

  it('flags bots and headless browsers', () => {
    expect(parseUserAgent(UA.bot).device_type).toBe('bot');
    expect(parseUserAgent(UA.headless).device_type).toBe('bot');
  });

  it('returns nothing rather than guessing on an unknown agent', () => {
    // A wrong label is worse than a missing one: missing shows as "unknown".
    expect(parseUserAgent('some-internal-tool/1.0').browser).toBeUndefined();
    expect(parseUserAgent(undefined)).toEqual({});
  });
});

describe('referrer classification', () => {
  it('classifies the common channels', () => {
    expect(referrerChannel(undefined, 'example.com')).toBe('direct');
    expect(referrerChannel('https://www.google.com/', 'example.com')).toBe('search');
    expect(referrerChannel('https://news.ycombinator.com/x', 'example.com')).toBe('social');
    expect(referrerChannel('https://github.com/x', 'example.com')).toBe('developer');
    expect(referrerChannel('https://someblog.dev/post', 'example.com')).toBe('referral');
  });

  it('treats the site own host as internal', () => {
    expect(referrerChannel('https://example.com/a', 'example.com')).toBe('internal');
    expect(referrerChannel('https://www.example.com/a', 'example.com')).toBe('internal');
  });

  it('survives a malformed referrer', () => {
    expect(referrerChannel('not a url', 'example.com')).toBe('direct');
    expect(referrerHost('not a url')).toBeUndefined();
  });

  it('strips www from the host', () => {
    expect(referrerHost('https://www.example.com/a?b=1')).toBe('example.com');
  });
});

describe('campaign parsing', () => {
  it('extracts utm and click ids', () => {
    const out = parseCampaign('?utm_source=hn&utm_medium=social&gclid=abc&other=ignored');
    expect(out).toEqual({ utm_source: 'hn', utm_medium: 'social', gclid: 'abc' });
  });

  it('returns nothing for an empty or malformed query', () => {
    expect(parseCampaign(undefined)).toEqual({});
    expect(parseCampaign('')).toEqual({});
  });
});
