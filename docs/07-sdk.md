# 07. Capture SDK

`src/sdk/` is the capture client. Runs in a browser or in Node with the same core and different adapters. Zero dependencies, fire-and-forget by default so a tracking call never blocks a user interaction.

```
src/sdk/
├── index.ts
├── client.ts            createClient, the public surface
├── timeline.ts          before -> enrichment -> destination
├── destination.ts       batching, retry, backoff, persistence
├── identify.ts          Identify builder
├── revenue.ts           Revenue builder
├── session.ts           session lifecycle
├── context.ts           platform/os/page context collection
├── transport/
│   ├── fetch.ts         browser default
│   ├── beacon.ts        sendBeacon, for pagehide
│   └── node.ts          node http/https
├── storage/
│   ├── memory.ts
│   └── local.ts         localStorage with quota handling
└── plugins/
    ├── pageViews.ts
    ├── clicks.ts
    └── sessionEvents.ts
```

## Public surface

```ts
import { createClient, Identify, Revenue } from '@gagandeep023/event-analyzer/sdk';

const ea = createClient({
  endpoint: 'https://example.com/api/events/collect',
  apiKey: 'pk_live_...',
});

ea.track('Checkout Started', { cart_value: 4200, items: 3 });
ea.track({
  event_type: 'Plan Upgraded',
  event_properties: { to: 'pro' },
  groups: { org: 'acme' },
});

ea.identify(new Identify().set('plan', 'pro').add('logins', 1));
ea.groupIdentify('org', 'acme', new Identify().set('seats', 40));
ea.revenue(new Revenue().setPrice(29).setQuantity(1).setProductId('pro_monthly'));

ea.setUserId('u_123');         ea.getUserId();
ea.setDeviceId(uuid());        ea.getDeviceId();
ea.setSessionId(Date.now());   ea.getSessionId();
ea.extendSession();
ea.setOptOut(true);            ea.getOptOut();
ea.reset();                    // new device id, clears user id and session

ea.add(plugin);                ea.remove('plugin-name');
await ea.flush();
```

Every tracking call returns `{ promise }` **synchronously**. Ignoring it is the normal path; awaiting it is available for the rare case where you need to know the event landed before navigating away.

```ts
const r = await ea.track('Signup Completed').promise;
// r => { code: 200, message: 'success', event: { ... } }
```

## timeline.ts

```ts
export type PluginType = 'before' | 'enrichment' | 'destination';

export interface Plugin {
  name: string;
  type?: PluginType;                 // defaults to 'enrichment'
  setup?(config: ResolvedSdkConfig, client: Client): Promise<void>;
  execute?(event: AnalyticsEvent): Promise<AnalyticsEvent | null>;
  teardown?(): Promise<void>;
  onSessionIdChanged?(sessionId: number): Promise<void>;
  onIdentityChanged?(identity: Identity): Promise<void>;
  onOptOutChanged?(optOut: boolean): Promise<void>;
  onReset?(): Promise<void>;
}
```

Events pass through `before[]` in registration order, then `enrichment[]`, then fan out to every `destination` in parallel.

Returning `null` at any stage drops the event and resolves its promise with a synthetic result, so a caller awaiting a dropped event never hangs. That detail is easy to miss and produces a hang that is very hard to debug.

**Name locking.** Registration locks the plugin name **synchronously** before awaiting `setup()`. Without that lock, two concurrent `add()` calls with the same name both pass the existence check and install twice, and the event gets enriched twice. This is the one piece of client-side prior art worth copying verbatim.

**Built-in plugins** registered by `createClient`: an `optOut` before-plugin, a `context` enrichment plugin, a `session` enrichment plugin, and the `Destination`.

## destination.ts

The delivery machinery, and the part most likely to lose data if written carelessly.

1. **Stamp on entry.** Every event gets an `insert_id` UUID before it enters the queue. Retries are then idempotent and the server can dedupe.

2. **Scheduled flush.** Queue depth reaching `flushQueueSize` flushes immediately. Otherwise a timer fires at `flushIntervalMillis`.

3. **Longest timeout wins.** A new schedule replaces the pending one only when its timeout is **longer**. Without this rule, steady traffic keeps rescheduling a 30-second throttle backoff down to 5 seconds and the client hammers a server that has already said stop.

4. **Response handling.**

   | Response | Action |
   |---|---|
   | `2xx` | Resolve the batch |
   | `400` | Read the index-addressed error body, drop only the named events with their own failure result, requeue the rest |
   | `413` | Split the batch in half and requeue both halves |
   | `429` | Back off to `throttleTimeout` (30s) |
   | `5xx` or network failure | Requeue with `attempts` incremented |

5. **Retry ceiling.** At `flushMaxRetries` the event resolves with a synthetic `500 max retries exceeded` and is removed. Bounded memory even against a server that has been down for a week.

6. **Persistence.** The unsent queue is written to storage after each enqueue and replayed on `setup()`. That is the entire offline story, and it is why a browser tab closing mid-batch does not lose events.

7. **Page unload.** A `pagehide` listener flushes through the beacon transport, which survives navigation where `fetch` does not.

## session.ts

```ts
export const isNewSession = (timeoutMs: number, lastEventTime: number, now = Date.now()) =>
  now - lastEventTime > timeoutMs;
```

`session_id` is the session's **start time in milliseconds**, not a UUID.

That single choice removes the need for any session table anywhere. Sessions are recoverable with `GROUP BY (user_key, session_id)`, and session start time is readable straight off the identifier.

Last event time is persisted alongside the queue so a returning tab resumes the same session rather than inventing a new one.

## identify.ts and revenue.ts

```ts
new Identify()
  .set('plan', 'pro')          .setOnce('signup_source', 'blog')
  .add('logins', 1)            .append('features_used', 'export')
  .prepend('recent', 'v2')     .preInsert('tags', 'beta')
  .postInsert('tags', 'pro')   .remove('tags', 'trial')
  .unset('trial_ends')         .clearAll();

new Revenue()
  .setPrice(29).setQuantity(2).setRevenueType('purchase')
  .setProductId('pro_monthly').setCurrency('USD')
  .setEventProperties({ campaign: 'launch' });
```

Both are chainable builders producing plain objects.

Validation happens at call time and **logs a warning rather than throwing**, because an analytics bug must never break the host application. `add()` with a non-number is rejected at the call site. Once `clearAll()` is called, every other operation on that instance is ignored.

## Autocapture

Browser only, **everything off by default**.

```ts
createClient({
  endpoint,
  autocapture: {
    pageViews: true,          // SPA history changes included
    sessions: true,           // emits Session Start / Session End
    clicks: { cssSelectorAllowlist: ['a', 'button', '[data-ea-track]'] },
  },
});
```

Many tools default several of these on, which is convenient and also how people end up shipping tracking they did not know about. For a self-hosted tool the honest default is to capture nothing until asked.

`clicks` records tag name, the allowlisted selector that matched, text content truncated to 128 characters, and any `data-ea-*` attributes. It **never** records input values and **never** reads anything inside a `password` field.

The framing worth keeping in the README: autocapture is a convenience with a privacy cost, and the default should reflect that.

## Node usage

```ts
import { createClient } from '@gagandeep023/event-analyzer/sdk';

const ea = createClient({
  endpoint: process.env.EA_ENDPOINT,
  apiKey: process.env.EA_WRITE_KEY,
  transport: 'node',
  storage: 'memory',
  flushIntervalMillis: 10_000,
});

ea.track({ event_type: 'Invoice Generated', user_id: 'u_123',
           event_properties: { amount: 4200 } });

process.on('beforeExit', () => ea.flush());
```

Server-side capture has no session concept unless you supply `session_id` yourself; `core/sessions.ts` reconstructs sessions from inter-event gaps in that case.
