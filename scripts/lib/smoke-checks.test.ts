import { describe, expect, it } from 'vitest';
import {
  checkFreshNonce, checkLoginPage, checkManifest, checkRedirectsToLogin, checkRefused, checkServiceWorker, checkSignupDisabled, nonceOf, type Res,
} from './smoke-checks.ts';

const goodHeaders = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc123==' 'strict-dynamic'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=()',
};
const login = (over: Partial<Res> = {}, h: Record<string, string | undefined> = {}): Res => {
  const headers: Record<string, string> = { ...goodHeaders };
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return { status: 200, headers, ...over };
};

describe('login page checks', () => {
  it('accepts the shipped configuration', () => expect(checkLoginPage(login())).toEqual([]));
  it('fails each missing header, one message each', () => {
    for (const h of ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'content-security-policy']) {
      expect(checkLoginPage(login({}, { [h]: undefined })).length, h).toBeGreaterThan(0);
    }
  });
  it('fails a CSP without a nonce, or with unsafe-eval / unsafe-inline scripts', () => {
    expect(checkLoginPage(login({}, { 'content-security-policy': "script-src 'self'" }))).toContain('CSP has no nonce');
    expect(checkLoginPage(login({}, { 'content-security-policy': "script-src 'nonce-a' 'unsafe-eval'" }))).toContain("CSP script-src allows 'unsafe-eval'");
    expect(checkLoginPage(login({}, { 'content-security-policy': "script-src 'nonce-a' 'unsafe-inline'; frame-ancestors 'none'" }))).toContain("CSP script-src allows 'unsafe-inline'");
  });
  it('fails a non-200 page and an exposed X-Powered-By', () => {
    expect(checkLoginPage(login({ status: 500 }))[0]).toMatch(/500/);
    expect(checkLoginPage(login({}, { 'x-powered-by': 'Next.js' }))).toContain('X-Powered-By is exposed');
  });
  it('reads the nonce and compares two requests', () => {
    expect(nonceOf(login())).toBe('abc123==');
    expect(checkFreshNonce(login(), login())).toHaveLength(1);
    expect(checkFreshNonce(login(), login({}, { 'content-security-policy': "script-src 'nonce-other'" }))).toEqual([]);
  });
});

describe('access checks', () => {
  const redirect = (to: string): Res => ({ status: 307, headers: { location: to } });
  it('a redirect to /login (relative or absolute) passes', () => {
    expect(checkRedirectsToLogin('/', redirect('/login'))).toEqual([]);
    expect(checkRedirectsToLogin('/', redirect('http://localhost:3000/login'))).toEqual([]);
  });
  it('a 200, or a redirect elsewhere, fails', () => {
    expect(checkRedirectsToLogin('/reports', { status: 200, headers: {} })).toHaveLength(1);
    expect(checkRedirectsToLogin('/reports', redirect('/login/mfa'))).toHaveLength(1);
  });
  it('a refusal is a redirect to sign-in, 401 or 403, never 200', () => {
    expect(checkRefused('/x', { status: 401, headers: {} })).toEqual([]);
    expect(checkRefused('/x', { status: 403, headers: {} })).toEqual([]);
    expect(checkRefused('/x', redirect('/login'))).toEqual([]);
    expect(checkRefused('/x', { status: 200, headers: {} })).toHaveLength(1);
  });
});

describe('static assets and Supabase', () => {
  it('manifest must be standalone with a name and icons', () => {
    const ok = JSON.stringify({ name: 'Daksha', display: 'standalone', icons: [{}] });
    expect(checkManifest({ status: 200, headers: {}, body: ok })).toEqual([]);
    expect(checkManifest({ status: 200, headers: {}, body: JSON.stringify({ name: 'x' }) }).length).toBeGreaterThan(0);
    expect(checkManifest({ status: 200, headers: {}, body: '<html>' })).toEqual(['manifest is not JSON']);
    expect(checkManifest({ status: 404, headers: {} })).toHaveLength(1);
  });
  it('service worker is served as JavaScript', () => {
    expect(checkServiceWorker({ status: 200, headers: { 'content-type': 'application/javascript; charset=UTF-8' } })).toEqual([]);
    expect(checkServiceWorker({ status: 200, headers: { 'content-type': 'text/html' } })).toHaveLength(1);
  });
  it('open signup fails; signup_disabled passes; other errors are called out', () => {
    expect(checkSignupDisabled('signup', { status: 200, headers: {}, body: '{"id":"x"}' })).toEqual(['signup succeeded: signup is open']);
    expect(checkSignupDisabled('signup', { status: 422, headers: {}, body: '{"error_code":"signup_disabled"}' })).toEqual([]);
    expect(checkSignupDisabled('signup', { status: 500, headers: {}, body: 'boom' })).toHaveLength(1);
  });
});
