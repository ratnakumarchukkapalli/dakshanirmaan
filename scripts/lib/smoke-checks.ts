// Pure judgements behind `scripts/smoke.ts` (the CI HTTP smoke). Each returns the list of things
// that are wrong, empty when the response is what the spec promises.

export interface Res {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body?: string;
}

const csp = (r: Res) => r.headers['content-security-policy'] ?? '';

export const nonceOf = (r: Res): string | null => /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp(r))?.[1] ?? null;

/** The sign-in page: renders, carries every security header, and a nonce CSP without unsafe script sources. */
export function checkLoginPage(r: Res): string[] {
  const bad: string[] = [];
  if (r.status !== 200) bad.push(`/login returned ${r.status}, expected 200`);
  const c = csp(r);
  if (!c) bad.push('no Content-Security-Policy header');
  else {
    if (!nonceOf(r)) bad.push('CSP has no nonce');
    const script = /(?:^|;)\s*script-src([^;]*)/.exec(c)?.[1] ?? '';
    if (!script) bad.push('CSP has no script-src');
    if (/'unsafe-eval'/.test(script)) bad.push("CSP script-src allows 'unsafe-eval'");
    if (/'unsafe-inline'/.test(script) && !/'strict-dynamic'/.test(script)) bad.push("CSP script-src allows 'unsafe-inline'");
    if (!/frame-ancestors\s+'none'/.test(c) && r.headers['x-frame-options'] !== 'DENY') bad.push('page can be framed');
  }
  if (r.headers['x-frame-options'] !== 'DENY') bad.push('X-Frame-Options is not DENY');
  if (r.headers['x-content-type-options'] !== 'nosniff') bad.push('X-Content-Type-Options is not nosniff');
  if (!r.headers['referrer-policy']) bad.push('no Referrer-Policy');
  if (!r.headers['permissions-policy']) bad.push('no Permissions-Policy');
  if (r.headers['x-powered-by']) bad.push('X-Powered-By is exposed');
  return bad;
}

/** Two requests to the same page must not share a nonce. */
export function checkFreshNonce(a: Res, b: Res): string[] {
  const x = nonceOf(a);
  const y = nonceOf(b);
  return x && y && x === y ? ['the CSP nonce is the same on two requests'] : [];
}

/** A signed-out visitor is sent to the sign-in page (a redirect whose target is /login). */
export function checkRedirectsToLogin(path: string, r: Res): string[] {
  const loc = r.headers['location'] ?? '';
  if (r.status < 300 || r.status > 399) return [`${path} returned ${r.status} to a signed-out visitor, expected a redirect to /login`];
  return new URL(loc, 'http://x').pathname === '/login' ? [] : [`${path} redirected to ${loc}, expected /login`];
}

/** Anything but a successful response: a redirect to sign-in, 401 or 403. */
export function checkRefused(path: string, r: Res): string[] {
  if (r.status === 401 || r.status === 403) return [];
  return checkRedirectsToLogin(path, r);
}

export function checkManifest(r: Res): string[] {
  if (r.status !== 200) return [`manifest returned ${r.status}`];
  try {
    const m = JSON.parse(r.body ?? '') as { name?: string; display?: string; icons?: unknown[] };
    const bad: string[] = [];
    if (!m.name) bad.push('manifest has no name');
    if (m.display !== 'standalone') bad.push('manifest display is not standalone');
    if (!Array.isArray(m.icons) || m.icons.length === 0) bad.push('manifest has no icons');
    return bad;
  } catch {
    return ['manifest is not JSON'];
  }
}

export function checkServiceWorker(r: Res): string[] {
  if (r.status !== 200) return [`sw.js returned ${r.status}`];
  return /javascript/.test(r.headers['content-type'] ?? '') ? [] : [`sw.js content-type is ${r.headers['content-type'] ?? 'missing'}`];
}

/** Supabase's public signup and unknown-email code request must both be refused with `signup_disabled`. */
export function checkSignupDisabled(what: string, r: Res): string[] {
  if (r.status >= 200 && r.status < 300) return [`${what} succeeded: signup is open`];
  return /signup_disabled|not allowed/i.test(r.body ?? '') ? [] : [`${what} was refused (${r.status}) but not as signup_disabled: ${(r.body ?? '').slice(0, 120)}`];
}
