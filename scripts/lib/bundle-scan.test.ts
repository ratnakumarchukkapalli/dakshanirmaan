import { describe, expect, it } from 'vitest';
import { disallowedPublicVars, envNames, isServiceRoleJwt, scanContent } from './bundle-scan.ts';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase-demo' })}.c2lnbmF0dXJlMTIz`;

describe('service-role token detection', () => {
  it('reads the role claim, not the look of the token', () => {
    expect(isServiceRoleJwt(jwt('service_role'))).toBe(true);
    expect(isServiceRoleJwt(jwt('anon'))).toBe(false);
    expect(isServiceRoleJwt('not.a.jwt')).toBe(false);
    expect(isServiceRoleJwt('a.b')).toBe(false);
  });
});

describe('scanContent', () => {
  it('passes a bundle that only has the anon/publishable material', () => {
    const text = `const a="${jwt('anon')}";const k="sb_publishable_abcdefghijklmnop";`;
    expect(scanContent('a.js', text)).toEqual([]);
  });
  it('flags a secret-key prefix', () => {
    const f = scanContent('chunk.js', 'x="sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'secret-key-prefix', file: 'chunk.js' });
    expect(f[0]!.detail).not.toContain('N7UND0UgjKTVK');
    expect(f[0]!.detail).toMatch(/chars\)$/);
  });
  it('flags a service-role JWT hidden anywhere in the text', () => {
    const f = scanContent('c.js', `foo(${JSON.stringify(jwt('service_role'))})`);
    expect(f.map((x) => x.kind)).toEqual(['service-role-token']);
  });
  it('flags the exact value of a server-only variable, but ignores short or empty ones', () => {
    const secret = 'z9y8x7w6v5u4t3s2r1q0';
    expect(scanContent('c.js', `var s="${secret}"`, [secret]).map((x) => x.kind)).toEqual(['secret-value']);
    expect(scanContent('c.js', 'var s="abc"', ['abc', ''])).toEqual([]);
    expect(scanContent('c.js', 'var s="anything"', [secret])).toEqual([]);
  });
});

describe('NEXT_PUBLIC_ hygiene', () => {
  it('allows exactly the two Supabase variables', () => {
    expect(disallowedPublicVars(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'PATH', 'NODE_ENV'])).toEqual([]);
  });
  it('reports anything else once, sorted', () => {
    expect(disallowedPublicVars(['NEXT_PUBLIC_SENTRY_DSN', 'NEXT_PUBLIC_A', 'NEXT_PUBLIC_A', 'NEXT_PUBLIC_SUPABASE_URL'])).toEqual(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_SENTRY_DSN']);
  });
  it('reads variable names out of an env example, skipping comments', () => {
    const text = '# NEXT_PUBLIC_IN_A_COMMENT=1\nNEXT_PUBLIC_SUPABASE_URL=http://x\nexport SUPABASE_SECRET_KEY=\n\nAPP_ORIGIN=';
    expect(envNames(text)).toEqual(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'APP_ORIGIN']);
  });
});
