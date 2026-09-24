/**
 * Ingest validation.
 *
 * A single malformed event must never cost a caller the other 499 in the batch,
 * so failures are addressed by index and the route partially accepts.
 */

import type {
  AnalyticsEvent,
  PropertyValue,
  RejectionMap,
  ValidationIssue,
  ValidationResult,
} from '../types';

export const MAX_EVENT_TYPE_LENGTH = 256;
export const MAX_STRING_LENGTH = 1024;
export const MAX_OBJECT_DEPTH = 40;

/** Earliest plausible event time: 2000-01-01. */
export const MIN_EVENT_TIME = Date.UTC(2000, 0, 1);
/** How far into the future a client clock may drift before we reject it. */
export const MAX_CLOCK_SKEW_MS = 86_400_000;

export interface ValidateOptions {
  minIdLength?: number;
  now?: number;
  /** Recently seen insert ids, for deduplication. Mutated as events are accepted. */
  seen?: Set<string>;
  generateInsertId?: () => string;
}

/** Truncates over-long strings in place rather than rejecting the event. */
function truncateStrings(value: PropertyValue, depth = 0): PropertyValue {
  if (depth > MAX_OBJECT_DEPTH) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v, depth + 1);
    return out;
  }
  return value;
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_OBJECT_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const v of value) max = Math.max(max, depthOf(v, depth + 1));
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = depth;
    for (const v of Object.values(value)) max = Math.max(max, depthOf(v, depth + 1));
    return max;
  }
  return depth;
}

/**
 * Validates a batch, returning accepted events with server fields stamped in,
 * plus one issue per rejection, each carrying the offending event's index.
 */
export function validateBatch(
  raw: unknown[],
  opts: ValidateOptions = {},
): ValidationResult {
  const minIdLength = opts.minIdLength ?? 5;
  const now = opts.now ?? Date.now();
  const seen = opts.seen;
  const newId = opts.generateInsertId ?? (() => `${now}-${Math.random().toString(36).slice(2)}`);

  const accepted: AnalyticsEvent[] = [];
  const issues: ValidationIssue[] = [];

  raw.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      issues.push({ index, field: 'event', kind: 'invalid', message: 'not an object' });
      return;
    }
    const ev = { ...(candidate as AnalyticsEvent) };

    if (typeof ev.event_type !== 'string' || ev.event_type.length === 0) {
      issues.push({ index, field: 'event_type', kind: 'missing', message: 'required, non-empty string' });
      return;
    }
    if (ev.event_type.length > MAX_EVENT_TYPE_LENGTH) {
      issues.push({ index, field: 'event_type', kind: 'invalid', message: `longer than ${MAX_EVENT_TYPE_LENGTH}` });
      return;
    }

    const hasUser = typeof ev.user_id === 'string' && ev.user_id.length > 0;
    const hasDevice = typeof ev.device_id === 'string' && ev.device_id.length > 0;
    if (!hasUser && !hasDevice) {
      issues.push({ index, field: 'user_id', kind: 'missing', message: 'one of user_id or device_id is required' });
      return;
    }
    if (hasUser && ev.user_id!.length < minIdLength) {
      issues.push({ index, field: 'user_id', kind: 'invalid_id_length', message: `shorter than ${minIdLength}` });
      return;
    }
    if (hasDevice && ev.device_id!.length < minIdLength) {
      issues.push({ index, field: 'device_id', kind: 'invalid_id_length', message: `shorter than ${minIdLength}` });
      return;
    }

    if (ev.time !== undefined) {
      if (typeof ev.time !== 'number' || !Number.isFinite(ev.time)) {
        issues.push({ index, field: 'time', kind: 'invalid', message: 'not a finite number' });
        return;
      }
      if (ev.time < MIN_EVENT_TIME || ev.time > now + MAX_CLOCK_SKEW_MS) {
        issues.push({ index, field: 'time', kind: 'invalid', message: 'outside the plausible window' });
        return;
      }
    } else {
      ev.time = now;
    }

    for (const field of ['event_properties', 'user_properties', 'group_properties'] as const) {
      const value = ev[field];
      if (value !== undefined && depthOf(value) > MAX_OBJECT_DEPTH) {
        issues.push({ index, field, kind: 'invalid', message: `deeper than ${MAX_OBJECT_DEPTH} layers` });
        return;
      }
    }

    // Over-long strings are truncated with a warning, not rejected.
    if (ev.event_properties) {
      ev.event_properties = truncateStrings(ev.event_properties) as Record<string, PropertyValue>;
    }

    if (!ev.insert_id) ev.insert_id = newId();
    if (seen) {
      if (seen.has(ev.insert_id)) {
        issues.push({ index, field: 'insert_id', kind: 'duplicate', message: 'seen recently' });
        return;
      }
      seen.add(ev.insert_id);
    }

    ev.server_received_time = now;
    accepted.push(ev);
  });

  return { accepted, issues };
}

/** Turns issues into the index-addressed body a client can act on. */
export function toRejectionMap(issues: readonly ValidationIssue[]): RejectionMap {
  const out: RejectionMap = {};
  const push = (bucket: 'events_with_missing_fields' | 'events_with_invalid_fields' | 'events_with_invalid_id_lengths', field: string, index: number) => {
    const map = out[bucket] ?? (out[bucket] = {});
    (map[field] ?? (map[field] = [])).push(index);
  };

  for (const issue of issues) {
    switch (issue.kind) {
      case 'missing':
        push('events_with_missing_fields', issue.field, issue.index);
        break;
      case 'invalid':
        push('events_with_invalid_fields', issue.field, issue.index);
        break;
      case 'invalid_id_length':
        push('events_with_invalid_id_lengths', issue.field, issue.index);
        break;
      case 'duplicate':
        (out.duplicate_events ?? (out.duplicate_events = [])).push(issue.index);
        break;
    }
  }
  return out;
}

/**
 * Normalises Amplitude's own payload shape into ours.
 *
 * Flat device and geo fields fold into `context`, revenue fields fold into
 * `revenue`. This is what makes the package a drop-in for a codebase already
 * sending to Amplitude.
 */
export function normalizeAmplitudeEvent(raw: Record<string, unknown>): AnalyticsEvent {
  const CONTEXT_KEYS = [
    'platform', 'app_version', 'os_name', 'os_version', 'device_model', 'device_brand',
    'language', 'user_agent', 'ip', 'country', 'region', 'city', 'carrier', 'dma',
  ] as const;
  const REVENUE_KEYS: Record<string, string> = {
    price: 'price', quantity: 'quantity', revenue: 'revenue',
    productId: 'product_id', revenueType: 'revenue_type', currency: 'currency',
  };

  const out: Record<string, unknown> = {};
  const context: Record<string, unknown> = { ...(raw.context as object ?? {}) };
  const revenue: Record<string, unknown> = { ...(raw.revenue as object ?? {}) };

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if ((CONTEXT_KEYS as readonly string[]).includes(key)) {
      context[key] = value;
    } else if (REVENUE_KEYS[key] !== undefined) {
      revenue[REVENUE_KEYS[key]!] = value;
    } else if (key !== 'context' && key !== 'revenue') {
      out[key] = value;
    }
  }
  if (Object.keys(context).length > 0) out.context = context;
  if (Object.keys(revenue).length > 0) out.revenue = revenue;
  // The result still goes through validateBatch, which enforces event_type.
  return out as unknown as AnalyticsEvent;
}
