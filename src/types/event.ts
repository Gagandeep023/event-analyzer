/**
 * The event wire format.
 *
 * A trimmed version of the conventional analytics event. Most tools flatten roughly
 * twenty device and geo fields onto the event root; we group them into a single
 * `context` object, which keeps the type readable and the ingest validator simple.
 *
 * This shape is used everywhere: the SDK emits it, the server validates and stores
 * it, and `/export` writes it back out unchanged. An exported file replays straight
 * into `/collect`.
 */

/** Any value that can appear in an event or user property. */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | PropertyValue[]
  | { [key: string]: PropertyValue };

/**
 * Reserved operations for merging user properties, sent as `$`-prefixed keys
 * inside `user_properties`. Keeping the wire format flat means the ingest
 * endpoint never needs a second schema.
 */
export enum IdentifyOperation {
  /** Overwrite the value. */
  SET = '$set',
  /** Write only if the key is absent. */
  SET_ONCE = '$setOnce',
  /** Numeric increment. Numbers only; a non-numeric current value is a no-op. */
  ADD = '$add',
  /** Push to the end of a list. */
  APPEND = '$append',
  /** Unshift to the front of a list. */
  PREPEND = '$prepend',
  /** Unshift only if the value is not already present. */
  PRE_INSERT = '$preInsert',
  /** Push only if the value is not already present. */
  POST_INSERT = '$postInsert',
  /** Delete a value from a list. */
  REMOVE = '$remove',
  /** Delete the key. */
  UNSET = '$unset',
  /** Delete every user property. Invalidates all other operations in the same object. */
  CLEAR_ALL = '$clearAll',
}

/** Every `$` operation, for iteration and validation. */
export const IDENTIFY_OPERATIONS: readonly IdentifyOperation[] = Object.freeze([
  IdentifyOperation.SET,
  IdentifyOperation.SET_ONCE,
  IdentifyOperation.ADD,
  IdentifyOperation.APPEND,
  IdentifyOperation.PREPEND,
  IdentifyOperation.PRE_INSERT,
  IdentifyOperation.POST_INSERT,
  IdentifyOperation.REMOVE,
  IdentifyOperation.UNSET,
  IdentifyOperation.CLEAR_ALL,
]);

/**
 * Order in which operations are applied during a merge.
 *
 * `$clearAll` runs first and invalidates everything else on the same object.
 * `$add` runs last so an increment lands on top of a `$set` in the same payload
 * rather than being overwritten by it.
 */
export const IDENTIFY_MERGE_ORDER: readonly IdentifyOperation[] = Object.freeze([
  IdentifyOperation.CLEAR_ALL,
  IdentifyOperation.UNSET,
  IdentifyOperation.SET_ONCE,
  IdentifyOperation.SET,
  IdentifyOperation.APPEND,
  IdentifyOperation.PREPEND,
  IdentifyOperation.PRE_INSERT,
  IdentifyOperation.POST_INSERT,
  IdentifyOperation.REMOVE,
  IdentifyOperation.ADD,
]);

/**
 * User properties. Keys are either `$` operations carrying a property map, or
 * bare property names, which are treated as `$set`.
 *
 * `$clearAll` is the exception: it carries a sentinel value rather than a map,
 * because it takes no per-property argument. The convention is to send
 * `"-"`. The value is ignored; only the key's presence matters.
 */
export type UserProperties = {
  [K in Exclude<IdentifyOperation, IdentifyOperation.CLEAR_ALL>]?: Record<
    string,
    PropertyValue
  >;
} & {
  [IdentifyOperation.CLEAR_ALL]?: PropertyValue;
} & {
  [key: string]: PropertyValue | Record<string, PropertyValue> | undefined;
};

/** Group properties support a narrower operation set than user properties. */
export type GroupProperties = UserProperties;

/** Operations valid on group properties. Deliberately narrower than user properties. */
export const GROUP_IDENTIFY_OPERATIONS: readonly IdentifyOperation[] = Object.freeze([
  IdentifyOperation.SET,
  IdentifyOperation.SET_ONCE,
  IdentifyOperation.ADD,
  IdentifyOperation.APPEND,
  IdentifyOperation.PREPEND,
  IdentifyOperation.UNSET,
]);

/** Device, platform and page context. Grouped rather than flattened onto the event. */
export interface EventContext {
  /** 'web' | 'node' | 'ios' | 'android' | ... */
  platform?: string;
  app_version?: string;
  os_name?: string;
  os_version?: string;
  device_model?: string;
  device_brand?: string;
  language?: string;
  user_agent?: string;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  referrer?: string;
  /** Referrer hostname, for a top-referrers table. */
  referrer_host?: string;
  /** Coarse channel: direct, internal, search, social, developer, referral. */
  referrer_channel?: string;

  page_url?: string;
  /** Path only. `page_url` carries the query string, which is bad for grouping. */
  page_path?: string;
  page_title?: string;

  /** Parsed from the user agent. */
  browser?: string;
  browser_version?: string;
  device_type?: string;

  /** Viewport and screen, as 'WxH'. */
  viewport?: string;
  screen?: string;

  /** Campaign parameters, flattened: utm_source, utm_medium, gclid, ... */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;

  /** e.g. 'event-analyzer-sdk/0.1.0' */
  library?: string;
  [key: string]: PropertyValue | undefined;
}

/** Revenue fields. `revenue` is computed as `price * quantity` when absent. */
export interface RevenueFields {
  price?: number;
  /** Defaults to 1. */
  quantity?: number;
  revenue?: number;
  product_id?: string;
  revenue_type?: string;
  /** ISO 4217, e.g. 'USD'. */
  currency?: string;
}

/** A single tracked event. */
export interface AnalyticsEvent {
  /** Required. The name of the thing that happened. */
  event_type: string;

  /** Required unless `device_id` is present. At least `minIdLength` characters. */
  user_id?: string;
  /** Required unless `user_id` is present. At least `minIdLength` characters. */
  device_id?: string;

  /** Milliseconds since epoch. The server fills this with receive time if absent. */
  time?: number;

  /**
   * The session's start time in milliseconds. Doubles as the session identifier,
   * which is why no session table is needed anywhere.
   */
  session_id?: number;

  /** Idempotency key. Stamped by the SDK, or by the server, if the caller omits it. */
  insert_id?: string;

  /** Monotonic per-client counter, used to order events sharing a `time`. */
  event_id?: number;

  event_properties?: Record<string, PropertyValue>;
  user_properties?: UserProperties;
  groups?: Record<string, string | string[]>;
  group_properties?: Record<string, PropertyValue>;

  context?: EventContext;
  revenue?: RevenueFields;

  /** Set by the ingest layer, never by a client. */
  server_received_time?: number;
  /** Set by the ingest layer, never by a client. */
  ingest_library?: string;
}

/** A user identification without an accompanying event. */
export interface Identification {
  user_id?: string;
  device_id?: string;
  user_properties?: UserProperties;
  groups?: Record<string, string | string[]>;
  context?: EventContext;
}

/** A group identification. */
export interface GroupIdentification {
  group_type: string;
  group_value: string;
  group_properties?: GroupProperties;
}

/** An explicit user alias, for merges the identity graph cannot infer. */
export interface UserAlias {
  user_id: string;
  global_user_id?: string;
  /** When true, removes the current mapping for `user_id`. */
  unmap?: boolean;
}

/** Resolved identity for a single actor. */
export interface Identity {
  userId?: string;
  deviceId?: string;
  userProperties?: Record<string, PropertyValue>;
}
