/**
 * The plugin pipeline.
 *
 * Events pass through `before[]` in registration order, then `enrichment[]`,
 * then fan out to every `destination` in parallel.
 */

import type { AnalyticsEvent, DeliveryResult, Identity, Logger, ResolvedSdkConfig } from '../types';
import { uuid } from './util';

export type PluginType = 'before' | 'enrichment' | 'destination';

export interface Plugin {
  name: string;
  /** Defaults to `enrichment`. */
  type?: PluginType;
  setup?(config: ResolvedSdkConfig, client: unknown): Promise<void> | void;
  /** Returning null drops the event. */
  execute?(event: AnalyticsEvent): Promise<AnalyticsEvent | null> | AnalyticsEvent | null;
  teardown?(): Promise<void> | void;
  flush?(): Promise<void>;
  onSessionIdChanged?(sessionId: number): Promise<void> | void;
  onIdentityChanged?(identity: Identity): Promise<void> | void;
  onOptOutChanged?(optOut: boolean): Promise<void> | void;
  onReset?(): Promise<void> | void;
}

/** A destination reports delivery rather than transforming. */
export interface DestinationPlugin extends Plugin {
  type: 'destination';
  deliver(event: AnalyticsEvent): Promise<DeliveryResult>;
}

function isDestination(p: Plugin): p is DestinationPlugin {
  return p.type === 'destination';
}

export class Timeline {
  private plugins: Plugin[] = [];
  /**
   * Names locked synchronously, before `setup()` is awaited.
   *
   * Without this, two concurrent `add()` calls with the same name both pass the
   * existence check and install twice, and every event gets enriched twice.
   */
  private locked = new Set<string>();

  constructor(private logger: Logger) {}

  async register(plugin: Plugin, config: ResolvedSdkConfig, client: unknown): Promise<void> {
    if (!plugin.name) plugin.name = uuid();
    if (this.locked.has(plugin.name)) {
      this.logger.warn(`plugin "${plugin.name}" is already registered, skipping`);
      return;
    }
    this.locked.add(plugin.name);
    plugin.type = plugin.type ?? 'enrichment';

    try {
      await plugin.setup?.(config, client);
    } catch (err) {
      this.logger.error(`plugin "${plugin.name}" failed during setup`, err);
      this.locked.delete(plugin.name);
      return;
    }
    this.plugins.push(plugin);
  }

  async deregister(name: string): Promise<void> {
    this.locked.delete(name);
    const i = this.plugins.findIndex((p) => p.name === name);
    if (i === -1) return;
    const [plugin] = this.plugins.splice(i, 1);
    try {
      await plugin?.teardown?.();
    } catch (err) {
      this.logger.error(`plugin "${name}" failed during teardown`, err);
    }
  }

  has(name: string): boolean {
    return this.locked.has(name);
  }

  count(): number {
    return this.plugins.length;
  }

  destinations(): DestinationPlugin[] {
    return this.plugins.filter(isDestination);
  }

  /**
   * Runs one event through the pipeline.
   *
   * A dropped event resolves with a synthetic result rather than hanging, so a
   * caller awaiting `track(...).promise` is never left waiting forever.
   */
  async push(event: AnalyticsEvent): Promise<DeliveryResult> {
    let current: AnalyticsEvent | null = event;

    for (const stage of ['before', 'enrichment'] as const) {
      for (const plugin of this.plugins) {
        if ((plugin.type ?? 'enrichment') !== stage) continue;
        if (!plugin.execute) continue;
        try {
          current = await plugin.execute(current!);
        } catch (err) {
          this.logger.error(`plugin "${plugin.name}" threw, dropping event`, err);
          current = null;
        }
        if (current === null) {
          return { code: 0, message: `dropped by ${plugin.name}`, event };
        }
      }
    }

    const sinks = this.destinations();
    if (sinks.length === 0) {
      return { code: 0, message: 'no destination registered', event: current! };
    }

    const results = await Promise.all(
      sinks.map((d) =>
        d.deliver(current!).catch((err): DeliveryResult => {
          this.logger.error(`destination "${d.name}" threw`, err);
          return { code: 500, message: String(err), event: current! };
        }),
      ),
    );
    // The first destination is the primary one; its result is what callers see.
    return results[0]!;
  }

  async flush(): Promise<void> {
    await Promise.all(this.destinations().map((d) => d.flush?.()));
  }

  async notifySessionId(id: number): Promise<void> {
    await this.each((p) => p.onSessionIdChanged?.(id));
  }

  async notifyIdentity(identity: Identity): Promise<void> {
    await this.each((p) => p.onIdentityChanged?.(identity));
  }

  async notifyOptOut(optOut: boolean): Promise<void> {
    await this.each((p) => p.onOptOutChanged?.(optOut));
  }

  async notifyReset(): Promise<void> {
    await this.each((p) => p.onReset?.());
  }

  async teardown(): Promise<void> {
    await this.each((p) => p.teardown?.());
    this.plugins = [];
    this.locked.clear();
  }

  private async each(fn: (p: Plugin) => Promise<void> | void): Promise<void> {
    for (const plugin of [...this.plugins]) {
      try {
        await fn(plugin);
      } catch (err) {
        this.logger.error(`plugin "${plugin.name}" threw during a lifecycle hook`, err);
      }
    }
  }
}
