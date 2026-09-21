import { describe, expect, it } from 'vitest';
import { LINK_TTL_SECONDS, shareConfigured, signInvoiceLink, verifyInvoiceLink } from './share-link';

const secret = 'a-test-secret-that-is-at-least-32-characters-long';
const id = 'd0000000-0000-0000-0000-000000000001';
const other = 'd0000000-0000-0000-0000-000000000002';
const t0 = Date.parse('2026-09-20T10:00:00Z');

describe('signed invoice links', () => {
  const { exp, sig } = signInvoiceLink(id, secret, t0);

  it('expires exactly 24 hours after signing', () => {
    expect(exp).toBe(Math.floor(t0 / 1000) + LINK_TTL_SECONDS);
  });
  it('accepts a fresh link and one on the last second', () => {
    expect(verifyInvoiceLink(id, String(exp), sig, secret, t0)).toBe('ok');
    expect(verifyInvoiceLink(id, String(exp), sig, secret, exp * 1000)).toBe('ok');
  });
  it('reports an old link as expired', () => {
    expect(verifyInvoiceLink(id, String(exp), sig, secret, (exp + 1) * 1000)).toBe('expired');
  });
  it('rejects another invoice id', () => {
    expect(verifyInvoiceLink(other, String(exp), sig, secret, t0)).toBe('invalid');
  });
  it('rejects a longer expiry (the signature covers it)', () => {
    expect(verifyInvoiceLink(id, String(exp + 3600), sig, secret, t0)).toBe('invalid');
  });
  it('rejects a changed character in the signature', () => {
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifyInvoiceLink(id, String(exp), flipped, secret, t0)).toBe('invalid');
  });
  it('rejects a different secret, a missing or short secret, and missing parts', () => {
    expect(verifyInvoiceLink(id, String(exp), sig, secret + 'x', t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, String(exp), sig, undefined, t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, String(exp), sig, 'short', t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, null, sig, secret, t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, String(exp), null, secret, t0)).toBe('invalid');
  });
  it('rejects a non-numeric or oversized expiry and a wrong-length signature', () => {
    expect(verifyInvoiceLink(id, 'abc', sig, secret, t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, '1'.repeat(30), sig, secret, t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, String(exp), sig + 'A', secret, t0)).toBe('invalid');
    expect(verifyInvoiceLink(id, String(exp), '', secret, t0)).toBe('invalid');
  });
  it('refuses to sign with a short secret', () => {
    expect(() => signInvoiceLink(id, 'short', t0)).toThrow();
  });
});

describe('shareConfigured', () => {
  it('needs a long secret; production also needs APP_ORIGIN', () => {
    expect(shareConfigured({ INVOICE_LINK_SECRET: secret, NODE_ENV: 'development' })).toBe(true);
    expect(shareConfigured({ INVOICE_LINK_SECRET: secret, NODE_ENV: 'production' })).toBe(false);
    expect(shareConfigured({ INVOICE_LINK_SECRET: secret, NODE_ENV: 'production', APP_ORIGIN: 'https://example.test' })).toBe(true);
    expect(shareConfigured({ INVOICE_LINK_SECRET: secret, NODE_ENV: 'production', APP_ORIGIN: '  ' })).toBe(false);
    expect(shareConfigured({ INVOICE_LINK_SECRET: 'too-short', NODE_ENV: 'development' })).toBe(false);
    expect(shareConfigured({ NODE_ENV: 'development' })).toBe(false);
  });
});
