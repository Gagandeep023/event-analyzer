/**
 * Deterministic synthetic event generator.
 *
 * Seeded, so every run produces identical data and demo screenshots stay
 * stable. Models a small SaaS, deliberately imperfect so the charts show
 * something worth looking at.
 */

import type { AnalyticsEvent } from '../src/types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Linear congruential generator. Reproducible across runs and platforms. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface SeedOptions {
  users?: number;
  days?: number;
  seed?: number;
  /** End of the generated window. Defaults to now. */
  until?: number;
}

export interface SeedResult {
  events: AnalyticsEvent[];
  /** Deliberately malformed events, to exercise the index-addressed 400 path. */
  malformed: unknown[];
}

const PLANS = ['free', 'free', 'free', 'pro', 'enterprise'];
const PLATFORMS = ['web', 'web', 'web', 'ios', 'android'];
const COUNTRIES = ['India', 'United States', 'Germany', 'Brazil', 'Japan'];

export function generate(options: SeedOptions = {}): SeedResult {
  const userCount = options.users ?? 2000;
  const days = options.days ?? 90;
  const rand = lcg(options.seed ?? 20260101);
  const until = options.until ?? Date.now();
  const start = until - days * DAY;

  const events: AnalyticsEvent[] = [];
  let seq = 0;

  const push = (
    userKey: { user?: string; device: string },
    type: string,
    at: number,
    extra: Partial<AnalyticsEvent> = {},
  ) => {
    const sessionStart = at - Math.floor(rand() * 5 * MINUTE);
    events.push({
      event_type: type,
      user_id: userKey.user,
      device_id: userKey.device,
      time: Math.round(at),
      session_id: Math.round(sessionStart),
      event_id: seq++,
      ...extra,
      context: {
        platform: PLATFORMS[Math.floor(rand() * PLATFORMS.length)]!,
        country: COUNTRIES[Math.floor(rand() * COUNTRIES.length)]!,
        app_version: '2.4.1',
        ...extra.context,
      },
    });
  };

  for (let i = 0; i < userCount; i++) {
    const user = `u_${String(i).padStart(5, '0')}`;
    // Two device ids before login, so the identity union-find has real work.
    const anonDevice = `d_anon_${String(i).padStart(5, '0')}`;
    const device = `d_${String(i).padStart(5, '0')}`;
    const plan = PLANS[Math.floor(rand() * PLANS.length)]!;

    const signupDay = Math.floor(rand() * days);
    const signupAt = start + signupDay * DAY + (8 + rand() * 10) * HOUR;

    // Pre-login browsing on an anonymous device.
    push({ device: anonDevice }, 'Page Viewed', signupAt - 20 * MINUTE, {
      event_properties: { page: '/pricing' },
    });

    push({ user, device: anonDevice }, 'Signed Up', signupAt, {
      user_properties: { $set: { plan }, $setOnce: { signup_source: rand() < 0.4 ? 'blog' : 'direct' } },
    });

    // Funnel: roughly 60 / 35 / 12 percent, so the drop-off bars are legible.
    const created = rand() < 0.6;
    if (!created) continue;
    const createdAt = signupAt + (5 + rand() * 120) * MINUTE;
    push({ user, device }, 'Project Created', createdAt, {
      event_properties: { template: rand() < 0.5 ? 'blank' : 'starter' },
    });

    const invited = rand() < 0.58;
    if (invited) {
      push({ user, device }, 'Teammate Invited', createdAt + (1 + rand() * 48) * HOUR, {
        event_properties: { count: 1 + Math.floor(rand() * 4) },
      });
    }

    const upgraded = invited && rand() < 0.34;
    if (upgraded) {
      const price = plan === 'enterprise' ? 199 : 29;
      push({ user, device }, 'Plan Upgraded', createdAt + (2 + rand() * 20) * DAY, {
        event_properties: { to: plan },
        revenue: { price, quantity: 1, revenue: price, product_id: `${plan}_monthly`, currency: 'USD' },
        user_properties: { $set: { plan }, $add: { upgrades: 1 } },
      });
    }

    // Return visits, with a weekly rhythm so the daily and weekly retention
    // intervals look different and the three measures visibly disagree.
    const stickiness = upgraded ? 0.7 : invited ? 0.4 : 0.18;
    for (let d = signupDay + 1; d < days; d++) {
      const weekday = (d % 7) < 5 ? 1 : 0.4;
      if (rand() > stickiness * weekday) continue;

      const visitAt = start + d * DAY + (9 + rand() * 9) * HOUR;
      const burst = 1 + Math.floor(rand() * 6);
      for (let b = 0; b < burst; b++) {
        push({ user, device }, rand() < 0.6 ? 'Page Viewed' : 'Project Opened', visitAt + b * (1 + rand() * 6) * MINUTE, {
          event_properties: { page: rand() < 0.5 ? '/dashboard' : '/projects' },
        });
      }
    }
  }

  events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  // A small tail of malformed events, so the demo exercises the index-addressed
  // 400 path rather than leaving it to the tests alone.
  const malformed: unknown[] = [
    { user_id: 'u_00001' },
    { event_type: 'No Identity' },
    { event_type: 'Bad Time', user_id: 'u_00002', time: 'yesterday' },
    { event_type: 'Short Id', user_id: 'ab' },
  ];

  return { events, malformed };
}

/** Summary line printed by the demo server on startup. */
export function describeSeed(result: SeedResult): string {
  const types = new Map<string, number>();
  for (const ev of result.events) types.set(ev.event_type, (types.get(ev.event_type) ?? 0) + 1);
  const parts = [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type} ${n}`);
  return `${result.events.length} events, ${parts.join(', ')}`;
}
