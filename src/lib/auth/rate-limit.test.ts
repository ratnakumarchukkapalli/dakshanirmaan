import { describe, expect, it } from 'vitest';
import { allowCodeRequest, allowTotpCheck, createLimiter, recordSignInFailure, recordSignInSuccess, signInAllowed } from './rate-limit';

const MIN = 60_000;

describe('createLimiter', () => {
  it('allows up to the limit inside the window, then refuses', () => {
    const l = createLimiter({ limit: 3, windowMs: 10 * MIN });
    for (let i = 0; i < 3; i++) {
      expect(l.allows('k', i)).toBe(true);
      l.hit('k', i);
    }
    expect(l.allows('k', 5)).toBe(false);
  });
  it('lets hits age out of the window', () => {
    const l = createLimiter({ limit: 1, windowMs: 10 * MIN });
    l.hit('k', 0);
    expect(l.allows('k', 5 * MIN)).toBe(false);
    expect(l.allows('k', 10 * MIN + 1)).toBe(true);
  });
  it('keeps keys apart', () => {
    const l = createLimiter({ limit: 1, windowMs: MIN });
    l.hit('a', 0);
    expect(l.allows('b', 0)).toBe(true);
  });
});

describe('createLimiter: bounded memory', () => {
  it('sweeps expired keys periodically', () => {
    const l = createLimiter({ limit: 1, windowMs: MIN, sweepEvery: 10 });
    for (let i = 0; i < 9; i++) l.hit(`old-${i}`, 0);
    expect(l.size()).toBe(9);
    l.hit('new', 5 * MIN); // the 10th write triggers a sweep; every old key has expired
    expect(l.size()).toBe(1);
  });
  it('never holds more than maxKeys, evicting the stalest first', () => {
    const l = createLimiter({ limit: 1, windowMs: 60 * MIN, maxKeys: 100, sweepEvery: 1_000_000 });
    for (let i = 0; i < 1_000; i++) l.hit(`k-${i}`, i);
    expect(l.size()).toBeLessThanOrEqual(101);
    expect(l.allows('k-999', 1_000)).toBe(false); // newest key still remembered
    expect(l.allows('k-0', 1_000)).toBe(true); // stalest key was evicted
  });
  it('keeps live keys through a sweep', () => {
    const l = createLimiter({ limit: 1, windowMs: MIN, sweepEvery: 3 });
    l.hit('live', 0);
    l.hit('x', 1);
    l.hit('y', 2);
    expect(l.allows('live', 3)).toBe(false);
  });
});

describe('sign-in code limits', () => {
  it('5 requests per email per address per 15 minutes', () => {
    const t = 1_000_000_000;
    for (let i = 0; i < 5; i++) expect(allowCodeRequest('one@x.test', 'ip-1', t + i)).toBe(true);
    expect(allowCodeRequest('one@x.test', 'ip-1', t + 10)).toBe(false);
    expect(allowCodeRequest('one@x.test', 'ip-1', t + 16 * MIN)).toBe(true);
  });
  it('one address exhausting its budget does not lock the owner out from another address', () => {
    const t = 1_500_000_000;
    for (let i = 0; i < 30; i++) allowCodeRequest('owner@x.test', 'attacker', t + i);
    expect(allowCodeRequest('owner@x.test', 'attacker', t + 100)).toBe(false);
    expect(allowCodeRequest('owner@x.test', 'owner-home', t + 100)).toBe(true);
  });
  it('a looser per-email ceiling of 20 per 15 minutes still stops a spread-out attack', () => {
    const t = 1_600_000_000;
    // 4 requests from each of 5 addresses stays inside every per-address budget: 20 in all.
    for (let ip = 0; ip < 5; ip++) for (let i = 0; i < 4; i++) expect(allowCodeRequest('vic@x.test', `ip-${ip}`, t + ip * 10 + i)).toBe(true);
    expect(allowCodeRequest('vic@x.test', 'ip-fresh', t + 100)).toBe(false);
    expect(allowCodeRequest('vic@x.test', 'ip-fresh', t + 16 * MIN)).toBe(true);
  });
  it('20 requests per IP per hour, across different emails', () => {
    const t = 2_000_000_000;
    for (let i = 0; i < 20; i++) expect(allowCodeRequest(`e${i}@x.test`, 'same-ip', t + i)).toBe(true);
    expect(allowCodeRequest('fresh@x.test', 'same-ip', t + 100)).toBe(false);
  });
  it('a refused request does not use up the other counters', () => {
    const t = 3_000_000_000;
    for (let i = 0; i < 5; i++) allowCodeRequest('capped@x.test', 'ip-y', t + i);
    for (let i = 0; i < 30; i++) allowCodeRequest('capped@x.test', 'ip-y', t + 100 + i); // all refused
    expect(allowCodeRequest('other@x.test', 'ip-y', t + 200)).toBe(true);
    expect(allowCodeRequest('capped@x.test', 'ip-z', t + 200)).toBe(true); // email ceiling still at 5, not 35
  });
});

describe('password sign-in limits (failures only)', () => {
  const fail = (email: string, ip: string, n: number, t: number) => { for (let i = 0; i < n; i++) recordSignInFailure(email, ip, t + i); };

  it('10 failures per email per address per 15 minutes, then it opens again', () => {
    const t = 4_000_000_000;
    fail('c@x.test', 'ip-1', 9, t);
    expect(signInAllowed('c@x.test', 'ip-1', t + 20)).toBe(true);
    fail('c@x.test', 'ip-1', 1, t + 30);
    expect(signInAllowed('c@x.test', 'ip-1', t + 40)).toBe(false);
    expect(signInAllowed('c@x.test', 'ip-1', t + 16 * MIN)).toBe(true);
  });
  it('checking is free: only recorded failures count', () => {
    const t = 4_100_000_000;
    for (let i = 0; i < 50; i++) expect(signInAllowed('free@x.test', 'ip-1', t + i)).toBe(true);
  });
  it('an attacker\'s failures from one address never block the owner from another address', () => {
    const t = 5_000_000_000;
    for (let i = 0; i < 40; i++) if (signInAllowed('owner@x.test', 'attacker', t + i)) recordSignInFailure('owner@x.test', 'attacker', t + i);
    expect(signInAllowed('owner@x.test', 'attacker', t + 100)).toBe(false);
    expect(signInAllowed('owner@x.test', 'owner-home', t + 100)).toBe(true);
  });
  it('a correct sign-in clears the failures of that address', () => {
    const t = 5_100_000_000;
    fail('p@x.test', 'ip-1', 10, t);
    expect(signInAllowed('p@x.test', 'ip-1', t + 20)).toBe(false);
    recordSignInSuccess('p@x.test', 'ip-1', t + 30);
    expect(signInAllowed('p@x.test', 'ip-1', t + 40)).toBe(true);
  });
  it('the per-email ceiling (100 / 15 min) stops a spread-out attack on strangers\' addresses but not a known address', () => {
    const t = 6_000_000_000;
    recordSignInSuccess('v@x.test', 'known-ip', t - 1000);
    for (let ip = 0; ip < 11; ip++) fail('v@x.test', `ip-${ip}`.padEnd(8, 'x'), 10, t + ip * 20);
    expect(signInAllowed('v@x.test', 'ip-fresh', t + 500)).toBe(false);
    expect(signInAllowed('v@x.test', 'known-ip', t + 500)).toBe(true);
    expect(signInAllowed('v@x.test', 'ip-fresh', t + 16 * MIN)).toBe(true);
  });
  it('one address spraying many emails is stopped at 30 failures an hour, for that address only', () => {
    const t = 7_000_000_000;
    for (let i = 0; i < 30; i++) recordSignInFailure(`e${i}@x.test`, 'sprayer', t + i);
    expect(signInAllowed('new@x.test', 'sprayer', t + 100)).toBe(false);
    expect(signInAllowed('new@x.test', 'elsewhere', t + 100)).toBe(true);
  });
});

describe('authenticator limits', () => {
  it('10 authenticator checks per person per 15 minutes', () => {
    const t = 4_000_000_000;
    for (let i = 0; i < 10; i++) expect(allowTotpCheck('user-1', t + i)).toBe(true);
    expect(allowTotpCheck('user-1', t + 20)).toBe(false);
  });
});
