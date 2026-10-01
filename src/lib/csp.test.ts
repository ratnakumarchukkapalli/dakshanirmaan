import { describe, expect, it } from 'vitest';
import { buildCsp, generateNonce } from './csp';

describe('buildCsp', () => {
  const prod = buildCsp({ nonce: 'abc', supabaseUrl: 'https://x.supabase.co', isDev: false });

  it('is nonce-based with no eval and no inline scripts in production', () => {
    expect(prod).toContain(`script-src 'self' 'nonce-abc' 'strict-dynamic'`);
    expect(prod).not.toContain('unsafe-eval');
    expect(prod).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(prod).toContain('upgrade-insecure-requests');
  });
  it('blocks framing and plugins', () => {
    expect(prod).toContain(`frame-ancestors 'none'`);
    expect(prod).toContain(`object-src 'none'`);
  });
  it('allows only self and the Supabase project (http + websocket) for connections', () => {
    expect(prod).toContain(`connect-src 'self' https://x.supabase.co wss://x.supabase.co`);
  });
  it('lets images load from self, data: and the Supabase project (signed bill photos) and nowhere else', () => {
    expect(prod).toContain(`img-src 'self' data: https://x.supabase.co;`);
    expect(buildCsp({ nonce: 'a', isDev: false })).toContain(`img-src 'self' data:;`);
  });
  it('only allows eval and plain-http Supabase in development', () => {
    const dev = buildCsp({ nonce: 'abc', supabaseUrl: 'http://127.0.0.1:54321', isDev: true });
    expect(dev).toContain(`'unsafe-eval'`);
    expect(dev).toContain('ws://127.0.0.1:54321');
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
  it('survives a missing or malformed Supabase URL', () => {
    expect(buildCsp({ nonce: 'a', isDev: false })).toContain(`connect-src 'self';`);
    expect(buildCsp({ nonce: 'a', supabaseUrl: 'nope', isDev: false })).toContain(`connect-src 'self';`);
  });
});

describe('generateNonce', () => {
  it('differs on every call', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
