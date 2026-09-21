import { describe, expect, it } from 'vitest';
import { allowCodeCheck, allowCodeRequest, allowTotpCheck, createLimiter } from './rate-limit';

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

describe('code-check and authenticator limits', () => {
  it('10 code checks per email per address, and 10 authenticator checks per person', () => {
    const t = 4_000_000_000;
    for (let i = 0; i < 10; i++) expect(allowCodeCheck('c@x.test', 'ip-1', t + i)).toBe(true);
    expect(allowCodeCheck('c@x.test', 'ip-1', t + 20)).toBe(false);
    for (let i = 0; i < 10; i++) expect(allowTotpCheck('user-1', t + i)).toBe(true);
    expect(allowTotpCheck('user-1', t + 20)).toBe(false);
  });
  it('one address cannot burn the owner\'s code checks from another address', () => {
    const t = 5_000_000_000;
    for (let i = 0; i < 50; i++) allowCodeCheck('owner@x.test', 'attacker', t + i);
    expect(allowCodeCheck('owner@x.test', 'attacker', t + 100)).toBe(false);
    expect(allowCodeCheck('owner@x.test', 'owner-home', t + 100)).toBe(true);
  });
  it('a looser per-email ceiling of 40 per 15 minutes still applies across addresses', () => {
    const t = 6_000_000_000;
    for (let ip = 0; ip < 4; ip++) for (let i = 0; i < 10; i++) expect(allowCodeCheck('v@x.test', `ip-${ip}`, t + ip * 20 + i)).toBe(true);
    expect(allowCodeCheck('v@x.test', 'ip-fresh', t + 200)).toBe(false);
    expect(allowCodeCheck('v@x.test', 'ip-fresh', t + 16 * MIN)).toBe(true);
  });
});
