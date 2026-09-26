// Pure checks behind `scripts/check-bundle.ts` (the CI "no secret in the browser bundle" gate).
// Spec: security-deployment "Client bundle hygiene" — the browser gets the Supabase URL and the
// publishable key and nothing else; the secret key, the invoice-link secret and any service-role
// token must never appear in `.next/static` or `public/`. Also refused anywhere in the browser-served
// files: a database URL with a password in it, a PEM private key, an age private key (the backup key).

/** The only `NEXT_PUBLIC_` variables the app is allowed to have. */
export const ALLOWED_PUBLIC_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] as const;

export interface Finding {
  file: string;
  kind: 'secret-key-prefix' | 'service-role-token' | 'secret-value' | 'db-url-password' | 'private-key' | 'age-secret-key';
  /** What matched, shortened so the log never reprints a whole secret. */
  detail: string;
}

/** Values shorter than this are not treated as secrets (an empty or placeholder env var must not match everything). */
const MIN_SECRET_LENGTH = 16;

/** Enough to recognise what matched, never enough to reuse it: the first few characters and the length. */
const short = (s: string) => `${s.slice(0, 6)}… (${s.length} chars)`;

const b64urlDecode = (s: string): string => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** True when a JWT-looking token's payload says `role: service_role`. */
export function isServiceRoleJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]!)) as { role?: unknown };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const SECRET_PREFIX = /sb_secret_[A-Za-z0-9_-]{8,}/g;
/** postgres:// or postgresql:// with user:password@ (a URL without a password is not a credential). */
const DB_URL_PASSWORD = /postgres(?:ql)?:\/\/[^\s:@/'"`<>]+:[^\s@/'"`<>]+@/g;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const AGE_SECRET_KEY = /AGE-SECRET-KEY-1[0-9A-Z]{20,}/g;

/**
 * Looks for secrets in one built file. `secretValues` are the actual values of server-only env vars
 * (the secret key, the invoice-link secret), when the CI environment has them.
 */
export function scanContent(file: string, text: string, secretValues: string[] = []): Finding[] {
  const found: Finding[] = [];
  for (const m of text.matchAll(SECRET_PREFIX)) found.push({ file, kind: 'secret-key-prefix', detail: short(m[0]) });
  for (const m of text.matchAll(JWT)) if (isServiceRoleJwt(m[0])) found.push({ file, kind: 'service-role-token', detail: short(m[0]) });
  for (const m of text.matchAll(DB_URL_PASSWORD)) found.push({ file, kind: 'db-url-password', detail: short(m[0]) });
  for (const m of text.matchAll(PEM_PRIVATE_KEY)) found.push({ file, kind: 'private-key', detail: short(m[0]) });
  for (const m of text.matchAll(AGE_SECRET_KEY)) found.push({ file, kind: 'age-secret-key', detail: short(m[0]) });
  for (const v of secretValues) {
    if (v.length >= MIN_SECRET_LENGTH && text.includes(v)) found.push({ file, kind: 'secret-value', detail: short(v) });
  }
  return found;
}

/** `NEXT_PUBLIC_*` names in a list (env keys, or lines of an env example) that the app may not have. */
export function disallowedPublicVars(names: string[]): string[] {
  return [...new Set(names.filter((n) => n.startsWith('NEXT_PUBLIC_') && !(ALLOWED_PUBLIC_VARS as readonly string[]).includes(n)))].sort();
}

/** Variable names assigned in a dotenv-style file's text (comments and blank lines ignored). */
export function envNames(text: string): string[] {
  return text
    .split('\n')
    .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
    .filter((n): n is string => !!n);
}
