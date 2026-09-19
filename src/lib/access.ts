// Who may see what, decided before any page renders. Pure so it can be unit-tested;
// src/proxy.ts feeds it the session facts.

export type AccessDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: '/login' | '/login/mfa' | '/' };

/** null = not signed in, not an active member, or session too old. */
export type Member = { role: 'admin' | 'user'; aal: 'aal1' | 'aal2' } | null;

const PUBLIC_PREFIXES = ['/api/manifest.webmanifest', '/sw.js', '/offline.html', '/icons/'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

const isLoginPath = (p: string) => p === '/login' || p.startsWith('/login/');
const isSettingsPath = (p: string) => p === '/settings' || p.startsWith('/settings/');

export function decideAccess({ pathname, member }: { pathname: string; member: Member }): AccessDecision {
  if (isPublicPath(pathname)) return { action: 'allow' };

  if (!member) return pathname === '/login' ? { action: 'allow' } : { action: 'redirect', to: '/login' };

  // Admins must finish the authenticator-app step before anything else.
  if (member.role === 'admin' && member.aal !== 'aal2') {
    return pathname === '/login/mfa' ? { action: 'allow' } : { action: 'redirect', to: '/login/mfa' };
  }

  if (isLoginPath(pathname)) return { action: 'redirect', to: '/' };
  if (member.role === 'user' && isSettingsPath(pathname)) return { action: 'redirect', to: '/' };
  return { action: 'allow' };
}
