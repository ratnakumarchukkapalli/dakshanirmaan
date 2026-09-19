import { describe, expect, it } from 'vitest';
import { isSessionExpired, signInTime, SESSION_MAX_HOURS } from './session-age';

const HOUR = 3_600_000;
const t0 = 1_760_000_000; // epoch seconds of sign-in
const at = (hoursLater: number) => t0 * 1000 + hoursLater * HOUR;

describe('isSessionExpired', () => {
  const amr = [{ method: 'otp', timestamp: t0 }];
  it('keeps a session alive inside the limit', () => {
    expect(isSessionExpired(amr, at(1))).toBe(false);
    expect(isSessionExpired(amr, at(SESSION_MAX_HOURS - 0.01))).toBe(false);
  });
  it('ends it once the limit has passed', () => {
    expect(isSessionExpired(amr, at(SESSION_MAX_HOURS + 0.01))).toBe(true);
    expect(isSessionExpired(amr, at(30))).toBe(true);
  });
  it('counts from the FIRST sign-in step, not the later authenticator step', () => {
    const both = [{ method: 'totp', timestamp: t0 + 7 * 3600 }, { method: 'otp', timestamp: t0 }];
    expect(signInTime(both)).toBe(t0);
    expect(isSessionExpired(both, at(9))).toBe(true);
  });
  it('fails closed when the age cannot be established', () => {
    expect(isSessionExpired(undefined, at(0))).toBe(true);
    expect(isSessionExpired([], at(0))).toBe(true);
    expect(isSessionExpired([{ method: 'otp' }], at(0))).toBe(true);
    expect(isSessionExpired([{ method: 'otp', timestamp: 'yesterday' }], at(0))).toBe(true);
    expect(isSessionExpired('nope', at(0))).toBe(true);
  });
  it('honours a different limit', () => {
    expect(isSessionExpired(amr, at(3), 2)).toBe(true);
    expect(isSessionExpired(amr, at(3), 12)).toBe(false);
  });
});
