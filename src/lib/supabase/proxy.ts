import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Member } from '@/lib/access';
import { isSessionExpired } from '@/lib/auth/session-age';
import { sessionCookieOptions } from './cookie-options';

export interface SessionFacts {
  /** The response to return (session cookies may have been refreshed or cleared on it). */
  response: () => NextResponse;
  member: Member;
}

/**
 * Refreshes the Supabase session cookies and works out who is asking: a signed-in, active app
 * member whose session is under the time limit, and whether an admin has passed the
 * authenticator-app step. getUser() asks the auth server, so a revoked session does not slip
 * through on a still-valid cookie.
 */
export async function readSession(request: NextRequest, requestHeaders: Headers): Promise<SessionFacts> {
  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const nobody = { response: () => response, member: null };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return nobody;

  const supabase = createServerClient(url, key, {
    cookieOptions: sessionCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        // Downstream server components must see the refreshed cookie, not the stale one.
        requestHeaders.set('cookie', request.headers.get('cookie') ?? '');
        response = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return nobody;

  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims || isSessionExpired(claims.amr, Date.now())) {
    // Too old (or unreadable): end this device's session only, so other devices are unaffected.
    await supabase.auth.signOut({ scope: 'local' });
    return nobody;
  }

  const { data: row } = await supabase.from('app_users').select('role, is_active').eq('user_id', user.id).maybeSingle();
  if (!row?.is_active) return nobody;

  return {
    response: () => response,
    member: { role: row.role === 'admin' ? 'admin' : 'user', aal: claims.aal === 'aal2' ? 'aal2' : 'aal1' },
  };
}
