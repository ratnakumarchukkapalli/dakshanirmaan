// Runs before every page: security headers, session refresh, and the sign-in gate.
// (Called "middleware" in the specs; Next.js 16 renamed the file convention to proxy.)
import { NextResponse, type NextRequest } from 'next/server';
import { decideAccess } from '@/lib/access';
import { buildCsp, generateNonce } from '@/lib/csp';
import { readSession } from '@/lib/supabase/proxy';

export async function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    isDev: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const session = await readSession(request, requestHeaders);
  const decision = decideAccess({ pathname: request.nextUrl.pathname, search: request.nextUrl.search, member: session.member });

  let response: NextResponse;
  if (decision.action === 'redirect') {
    response = NextResponse.redirect(new URL(decision.to, request.url));
    // Keep any cookies the session step set (a refreshed token, or the cleared cookie of an expired session).
    session.response().cookies.getAll().forEach((c) => response.cookies.set(c));
  } else {
    response = session.response();
  }
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Skip static assets; everything else (pages, /api, actions) is covered.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icons/|sw\\.js|offline\\.html).*)'],
};
