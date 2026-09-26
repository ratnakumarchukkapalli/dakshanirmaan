import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config headers()', () => {
  it('sends HSTS (2 years, subdomains, preload) and the other static security headers on every route', async () => {
    const rules = await nextConfig.headers?.();
    const all = rules?.find((r) => r.source === '/:path*');
    expect(all).toBeDefined();
    const byKey = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(byKey['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains; preload');
    expect(byKey['X-Frame-Options']).toBe('DENY');
    expect(byKey['X-Content-Type-Options']).toBe('nosniff');
  });
});
