import { describe, it, expect, vi } from 'vitest';
import { isNewSession, SessionManager } from './session';

const TIMEOUT = 1_800_000;

describe('isNewSession', () => {
  it('is false inside the timeout', () => {
    expect(isNewSession(TIMEOUT, 1000, 1000 + TIMEOUT - 1)).toBe(false);
  });

  it('is false exactly at the timeout', () => {
    expect(isNewSession(TIMEOUT, 1000, 1000 + TIMEOUT)).toBe(false);
  });

  it('is true one millisecond past the timeout', () => {
    expect(isNewSession(TIMEOUT, 1000, 1000 + TIMEOUT + 1)).toBe(true);
  });
});

describe('SessionManager', () => {
  it('uses the session start time as the identifier, not a uuid', () => {
    // This is what removes the need for a session table anywhere.
    const m = new SessionManager(TIMEOUT, {}, 5000);
    expect(m.current()).toBe(5000);
  });

  it('keeps the same session for events inside the timeout', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    expect(m.touch(1000 + TIMEOUT)).toBe(1000);
  });

  it('rotates once the timeout elapses', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    const next = 1000 + TIMEOUT + 1;
    expect(m.touch(next)).toBe(next);
  });

  it('slides the window on each event', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    // Two touches, each inside the timeout of the previous one.
    m.touch(1000 + TIMEOUT);
    expect(m.touch(1000 + 2 * TIMEOUT)).toBe(1000);
  });

  it('resumes a persisted session rather than inventing a new one', () => {
    const m = new SessionManager(TIMEOUT, { sessionId: 777, lastEventTime: 800 }, 900);
    expect(m.current()).toBe(777);
    expect(m.touch(900)).toBe(777);
  });

  it('extendSession pushes the timeout forward without an event', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    m.extend(1000 + TIMEOUT);
    expect(m.touch(1000 + 2 * TIMEOUT)).toBe(1000);
  });

  it('setSessionId overrides explicitly', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    m.set(42, 1000);
    expect(m.current()).toBe(42);
  });

  it('reset starts a fresh session', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    m.reset(9999);
    expect(m.current()).toBe(9999);
  });

  it('notifies listeners on rotation and explicit set, but not on a quiet touch', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    const seen = vi.fn();
    m.onChange(seen);

    m.touch(1000 + 60_000);
    expect(seen).not.toHaveBeenCalled();

    m.touch(1000 + TIMEOUT * 3);
    expect(seen).toHaveBeenCalledOnce();

    m.set(5);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('exposes state for persistence', () => {
    const m = new SessionManager(TIMEOUT, {}, 1000);
    m.touch(2000);
    expect(m.state()).toEqual({ sessionId: 1000, lastEventTime: 2000 });
  });
});
