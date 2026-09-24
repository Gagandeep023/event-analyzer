/**
 * Test fixture helpers.
 *
 * Fixtures here are hand-built and tiny. A retention fixture of nine users
 * across five days, whose correct answer for all three measures was worked out
 * on paper, is worth more than ten thousand generated events whose expected
 * output is produced by the same code under test. The second kind of test only
 * proves the code agrees with itself.
 */

import type { AnalyticsEvent, PropertyValue } from '../../types';

/** 2026-01-01T00:00:00Z. All fixtures are relative to this. */
export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** `T0` plus n days. */
export function day(n: number, hours = 0): number {
  return T0 + n * DAY + hours * HOUR;
}

export interface EventSpec {
  type: string;
  user?: string;
  device?: string;
  t?: number;
  session?: number;
  props?: Record<string, PropertyValue>;
  userProps?: Record<string, PropertyValue>;
  context?: Record<string, PropertyValue>;
  groups?: Record<string, string | string[]>;
  eventId?: number;
}

/** Builds one event. Keeps fixture arrays readable. */
export function ev(spec: EventSpec): AnalyticsEvent {
  const out: AnalyticsEvent = { event_type: spec.type };
  if (spec.user !== undefined) out.user_id = spec.user;
  if (spec.device !== undefined) out.device_id = spec.device;
  if (spec.t !== undefined) out.time = spec.t;
  if (spec.session !== undefined) out.session_id = spec.session;
  if (spec.props) out.event_properties = spec.props;
  if (spec.userProps) out.user_properties = spec.userProps;
  if (spec.context) out.context = spec.context;
  if (spec.groups) out.groups = spec.groups;
  if (spec.eventId !== undefined) out.event_id = spec.eventId;
  return out;
}

/** A range wide enough to cover every fixture in this directory. */
export function wideRange(days = 400) {
  return { from: T0 - DAY, to: T0 + days * DAY };
}

/** A range covering exactly `[0, days)` from T0. */
export function daysRange(days: number) {
  return { from: T0, to: T0 + days * DAY };
}

/**
 * The retention fixture: nine users across five days, chosen so that all three
 * measures give DIFFERENT answers.
 *
 * If n-day, unbounded and bracket agree on a fixture, that fixture is not
 * exercising the difference between them, and the most likely real bug (all
 * three code paths accidentally doing the same thing) would pass.
 *
 * Every user starts on day 0. Return days, excluding day 0:
 *
 *   u1  1, 2, 3, 4      returns every day
 *   u2  1               day 1 only
 *   u3  2               day 2 only
 *   u4  3               day 3 only
 *   u5  4               day 4 only
 *   u6  1, 4            days 1 and 4
 *   u7  2, 3            days 2 and 3
 *   u8  (none)          never returns
 *   u9  4               day 4 only
 *
 * Worked out on paper, with a cohort of 9:
 *
 *   n-day       d1: u1,u2,u6           = 3
 *               d2: u1,u3,u7           = 3
 *               d3: u1,u4,u7           = 3
 *               d4: u1,u5,u6,u9        = 4
 *   unbounded   d1: everyone except u8 = 8
 *               d2: u1,u3,u4,u5,u6,u7,u9 = 7
 *               d3: u1,u4,u5,u6,u7,u9  = 6
 *               d4: u1,u5,u6,u9        = 4
 *   bracket     [1,2]: u1,u2,u3,u6,u7  = 5
 *               [3,4]: u1,u4,u5,u6,u7,u9 = 6
 */
export const RETENTION_RETURN_DAYS: Record<string, number[]> = {
  u1: [1, 2, 3, 4],
  u2: [1],
  u3: [2],
  u4: [3],
  u5: [4],
  u6: [1, 4],
  u7: [2, 3],
  u8: [],
  u9: [4],
};

export function retentionFixture(): AnalyticsEvent[] {
  const out: AnalyticsEvent[] = [];
  for (const [user, returns] of Object.entries(RETENTION_RETURN_DAYS)) {
    out.push(ev({ type: 'Signed Up', user, t: day(0, 9) }));
    for (const d of returns) {
      out.push(ev({ type: 'Opened App', user, t: day(d, 10) }));
    }
  }
  return out;
}
