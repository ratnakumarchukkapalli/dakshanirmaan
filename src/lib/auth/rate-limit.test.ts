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

describe('sign-in code limits', () => {
  it('5 requests per email per 15 minutes', () => {
    const t = 1_000_000_000;
    for (let i = 0; i < 5; i++) expect(allowCodeRequest('one@x.test', `ip-${i}`, t + i)).toBe(true);
    expect(allowCodeRequest('one@x.test', 'ip-9', t + 10)).toBe(false);
    expect(allowCodeRequest('one@x.test', 'ip-9', t + 16 * MIN)).toBe(true);
  });
  it('20 requests per IP per hour, across different emails', () => {
    const t = 2_000_000_000;
    for (let i = 0; i < 20; i++) expect(allowCodeRequest(`e${i}@x.test`, 'same-ip', t + i)).toBe(true);
    expect(allowCodeRequest('fresh@x.test', 'same-ip', t + 100)).toBe(false);
  });
  it('a refused request does not use up the other counter', () => {
    const t = 3_000_000_000;
    for (let i = 0; i < 5; i++) allowCodeRequest('capped@x.test', 'ip-y', t + i);
    for (let i = 0; i < 30; i++) allowCodeRequest('capped@x.test', 'ip-y', t + 100 + i); // all refused
    expect(allowCodeRequest('other@x.test', 'ip-y', t + 200)).toBe(true);
  });
  it('10 code checks per email and 10 authenticator checks per person', () => {
    const t = 4_000_000_000;
    for (let i = 0; i < 10; i++) expect(allowCodeCheck('c@x.test', t + i)).toBe(true);
    expect(allowCodeCheck('c@x.test', t + 20)).toBe(false);
    for (let i = 0; i < 10; i++) expect(allowTotpCheck('user-1', t + i)).toBe(true);
    expect(allowTotpCheck('user-1', t + 20)).toBe(false);
  });
});
