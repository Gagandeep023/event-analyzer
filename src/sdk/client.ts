/**
 * The capture client.
 *
 * Fire-and-forget by default: every tracking call returns `{ promise }`
 * synchronously, and ignoring it is the normal path. Awaiting is available for
 * the rare case where you need to know an event landed before navigating away.
 */

import type {
  AnalyticsEvent,
  DeliveryResult,
  EventContext,
  GroupIdentification,
  Identification,
  Identity,
  Logger,
  PropertyValue,
  ResolvedSdkConfig,
  SdkConfig,
  UserProperties,
} from '../types';
import { SDK_DEFAULTS } from '../types';
import { Timeline, type Plugin } from './timeline';
import { Destination } from './destination';
import { Identify, Revenue } from './identify';
import { SessionManager } from './session';
import { collectContext, mergeContext, SDK_LIBRARY } from './context';
import { resolveTransport } from './transport';
import { resolveStorage } from './storage';
import { clicksPlugin, optOutPlugin, pageViewsPlugin, sessionEventsPlugin } from './plugins';
import { createLogger, isBrowser, uuid } from './util';

/** Storage key holding identity and session state across reloads. */
export const IDENTITY_KEY = 'event-analyzer.identity';

interface PersistedIdentity {
  deviceId: string;
  userId?: string;
  sessionId: number;
  lastEventTime: number;
}

/** What a tracking call returns. The promise is optional to await. */
export interface TrackResult {
  promise: Promise<DeliveryResult>;
}

export class Client {
  private config: ResolvedSdkConfig;
  private timeline: Timeline;
  private destination: Destination;
  private session: SessionManager;
  private logger: Logger;

  private deviceId: string;
  private userId?: string;
  private optOut: boolean;
  private eventSeq = 0;
  private ready: Promise<void>;

  constructor(options: SdkConfig) {
    if (!options.endpoint) throw new Error('event-analyzer: `endpoint` is required');

    const logLevel = options.logLevel ?? SDK_DEFAULTS.logLevel;
    this.logger = options.loggerProvider ?? createLogger(logLevel);

    this.config = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      flushIntervalMillis: options.flushIntervalMillis ?? SDK_DEFAULTS.flushIntervalMillis,
      flushQueueSize: options.flushQueueSize ?? SDK_DEFAULTS.flushQueueSize,
      flushMaxRetries: options.flushMaxRetries ?? SDK_DEFAULTS.flushMaxRetries,
      maxBatchSize: options.maxBatchSize ?? SDK_DEFAULTS.maxBatchSize,
      sessionTimeoutMs: options.sessionTimeoutMs ?? SDK_DEFAULTS.sessionTimeoutMs,
      minIdLength: options.minIdLength ?? SDK_DEFAULTS.minIdLength,
      optOut: options.optOut ?? SDK_DEFAULTS.optOut,
      offline: options.offline ?? SDK_DEFAULTS.offline,
      logLevel,
      transport: resolveTransport(options.transport),
      storage: resolveStorage(options.storage),
      autocapture: options.autocapture ?? {},
      loggerProvider: this.logger,
      defaultContext: options.defaultContext ?? {},
    };

    this.optOut = this.config.optOut;
    this.deviceId = options.deviceId ?? uuid();
    this.userId = options.userId;
    this.session = new SessionManager(this.config.sessionTimeoutMs, {
      sessionId: options.sessionId,
    });
    this.session.onChange((id) => void this.timeline.notifySessionId(id));

    this.timeline = new Timeline(this.logger);
    this.destination = new Destination();
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // Restore identity and session before anything is sent, so a returning tab
    // resumes the same session rather than inventing a new one.
    try {
      const saved = await this.config.storage.get<PersistedIdentity>(IDENTITY_KEY);
      if (saved) {
        this.deviceId = saved.deviceId || this.deviceId;
        if (!this.userId && saved.userId) this.userId = saved.userId;
        this.session = new SessionManager(this.config.sessionTimeoutMs, {
          sessionId: saved.sessionId,
          lastEventTime: saved.lastEventTime,
        });
        this.session.onChange((id) => void this.timeline.notifySessionId(id));
      }
    } catch {
      // A missing or corrupt record is not worth failing startup over.
    }

    await this.timeline.register(optOutPlugin(() => this.optOut), this.config, this);
    await this.timeline.register(this.destination, this.config, this);

    const auto = this.config.autocapture;
    if (auto.pageViews) {
      const opts = typeof auto.pageViews === 'object' ? auto.pageViews : {};
      await this.timeline.register(pageViewsPlugin(this, opts), this.config, this);
    }
    if (auto.sessions) {
      await this.timeline.register(sessionEventsPlugin(this), this.config, this);
    }
    if (auto.clicks) {
      const opts = typeof auto.clicks === 'object' ? auto.clicks : {};
      await this.timeline.register(clicksPlugin(this, opts), this.config, this);
    }

    if (isBrowser()) {
      // `pagehide` survives navigation where an in-flight fetch does not.
      window.addEventListener('pagehide', () => void this.flush());
    }
  }

  // -------------------------------------------------------------------------
  // Tracking
  // -------------------------------------------------------------------------

  track(
    eventTypeOrEvent: string | AnalyticsEvent,
    eventProperties?: Record<string, PropertyValue>,
    overrides?: Partial<AnalyticsEvent>,
  ): TrackResult {
    const partial: AnalyticsEvent =
      typeof eventTypeOrEvent === 'string'
        ? { event_type: eventTypeOrEvent, event_properties: eventProperties }
        : { ...eventTypeOrEvent };

    return { promise: this.enqueue({ ...partial, ...overrides }) };
  }

  identify(identify: Identify | UserProperties): TrackResult {
    const props = identify instanceof Identify ? identify.build() : identify;
    return { promise: this.enqueue({ event_type: '$identify', user_properties: props }) };
  }

  groupIdentify(
    groupType: string,
    groupValue: string,
    identify: Identify | UserProperties,
  ): TrackResult {
    const props = identify instanceof Identify ? identify.build() : identify;
    return {
      promise: this.enqueue({
        event_type: '$groupidentify',
        groups: { [groupType]: groupValue },
        group_properties: props as Record<string, PropertyValue>,
      }),
    };
  }

  revenue(revenue: Revenue): TrackResult {
    return {
      promise: this.enqueue({
        event_type: 'Revenue',
        revenue: revenue.build(),
        event_properties: revenue.eventProperties(),
      }),
    };
  }

  setGroup(groupType: string, groupValue: string | string[]): TrackResult {
    return { promise: this.enqueue({ event_type: '$identify', groups: { [groupType]: groupValue } }) };
  }

  /**
   * Stamps and queues an event.
   *
   * Everything mutable is snapshotted SYNCHRONOUSLY, before any await. Reading
   * identity or opt-out after the microtask resumes would let a `setUserId`
   * that happened later retroactively attribute an event that was anonymous
   * when it occurred, and would let a `setOptOut(false)` resurrect an event
   * that was dropped when it was tracked.
   */
  private enqueue(partial: AnalyticsEvent): Promise<DeliveryResult> {
    const optedOutNow = this.optOut;
    const now = partial.time ?? Date.now();

    const event: AnalyticsEvent = {
      ...partial,
      time: now,
      session_id: partial.session_id ?? this.session.touch(now),
      insert_id: partial.insert_id ?? uuid(),
      event_id: partial.event_id ?? this.eventSeq++,
      context: mergeContext(collectContext(), this.config.defaultContext, partial.context),
      ingest_library: SDK_LIBRARY,
    };
    const userId = partial.user_id ?? this.userId;
    if (userId !== undefined) event.user_id = userId;
    event.device_id = partial.device_id ?? this.deviceId;

    if (optedOutNow) {
      return Promise.resolve({ code: 0, message: 'opted out', event });
    }

    void this.persistIdentity();
    return this.ready.then(() => this.timeline.push(event));
  }

  // -------------------------------------------------------------------------
  // Identity and session
  // -------------------------------------------------------------------------

  setUserId(userId: string | undefined): void {
    this.userId = userId;
    void this.persistIdentity();
    void this.timeline.notifyIdentity(this.getIdentity());
  }

  getUserId(): string | undefined {
    return this.userId;
  }

  setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
    void this.persistIdentity();
    void this.timeline.notifyIdentity(this.getIdentity());
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  setSessionId(sessionId: number): void {
    this.session.set(sessionId);
    void this.persistIdentity();
  }

  getSessionId(): number {
    return this.session.current();
  }

  /** Pushes the session timeout forward without recording an event. */
  extendSession(): void {
    this.session.extend();
    void this.persistIdentity();
  }

  getIdentity(): Identity {
    return { userId: this.userId, deviceId: this.deviceId };
  }

  setOptOut(optOut: boolean): void {
    this.optOut = optOut;
    void this.timeline.notifyOptOut(optOut);
  }

  getOptOut(): boolean {
    return this.optOut;
  }

  /** New device id, cleared user id, fresh session. */
  async reset(): Promise<void> {
    this.deviceId = uuid();
    this.userId = undefined;
    this.session.reset();
    this.eventSeq = 0;
    await this.persistIdentity();
    await this.timeline.notifyReset();
  }

  private async persistIdentity(): Promise<void> {
    const state = this.session.state();
    try {
      await this.config.storage.set<PersistedIdentity>(IDENTITY_KEY, {
        deviceId: this.deviceId,
        userId: this.userId,
        sessionId: state.sessionId,
        lastEventTime: state.lastEventTime,
      });
    } catch {
      // Storage is best effort; losing it costs session continuity, not events.
    }
  }

  // -------------------------------------------------------------------------
  // Plugins and lifecycle
  // -------------------------------------------------------------------------

  async add(plugin: Plugin): Promise<void> {
    await this.ready;
    await this.timeline.register(plugin, this.config, this);
  }

  async remove(name: string): Promise<void> {
    await this.ready;
    await this.timeline.deregister(name);
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.timeline.flush();
  }

  /** Queue depth. Diagnostic hook. */
  pending(): number {
    return this.destination.pending();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.timeline.teardown();
  }

  /** The resolved configuration, after defaults. */
  getConfig(): ResolvedSdkConfig {
    return this.config;
  }
}

/** Creates a client. The usual entry point. */
export function createClient(options: SdkConfig): Client {
  return new Client(options);
}

/** Helpers for callers building payloads by hand. */
export function toIdentification(client: Client, props: UserProperties): Identification {
  return { user_id: client.getUserId(), device_id: client.getDeviceId(), user_properties: props };
}

export function toGroupIdentification(
  groupType: string,
  groupValue: string,
  props: Record<string, PropertyValue>,
): GroupIdentification {
  return { group_type: groupType, group_value: groupValue, group_properties: props };
}

export type { EventContext };
