/**
 * Session lifecycle.
 *
 * `session_id` is the session's start time in milliseconds, not a UUID. That one
 * choice removes the need for a session table anywhere: sessions are recoverable
 * with `GROUP BY (user_key, session_id)`, and the start time is readable
 * straight off the identifier.
 */

/** True when enough time has passed since the last event to start a new session. */
export function isNewSession(
  timeoutMs: number,
  lastEventTime: number,
  now: number = Date.now(),
): boolean {
  return now - lastEventTime > timeoutMs;
}

export interface SessionState {
  sessionId: number;
  lastEventTime: number;
}

export class SessionManager {
  private sessionId: number;
  private lastEventTime: number;
  private listeners: Array<(id: number) => void> = [];

  constructor(
    private timeoutMs: number,
    initial?: Partial<SessionState>,
    now: number = Date.now(),
  ) {
    this.sessionId = initial?.sessionId ?? now;
    this.lastEventTime = initial?.lastEventTime ?? now;
  }

  onChange(fn: (id: number) => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.sessionId);
  }

  /**
   * Returns the session an event at `now` belongs to, rotating first when the
   * inactivity timeout has elapsed.
   */
  touch(now: number = Date.now()): number {
    if (isNewSession(this.timeoutMs, this.lastEventTime, now)) {
      this.sessionId = now;
      this.emit();
    }
    this.lastEventTime = now;
    return this.sessionId;
  }

  /** Pushes the timeout forward without recording an event. */
  extend(now: number = Date.now()): void {
    this.touch(now);
  }

  current(): number {
    return this.sessionId;
  }

  set(id: number, now: number = Date.now()): void {
    this.sessionId = id;
    this.lastEventTime = now;
    this.emit();
  }

  /** Starts a fresh session, used by `reset()`. */
  reset(now: number = Date.now()): void {
    this.set(now, now);
  }

  state(): SessionState {
    return { sessionId: this.sessionId, lastEventTime: this.lastEventTime };
  }
}
