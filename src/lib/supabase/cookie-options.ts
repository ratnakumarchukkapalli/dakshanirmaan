// Sign-in cookie settings, shared by the three Supabase clients (server, proxy, browser). The library
// default is a 400-day cookie that is not marked Secure; a copied cookie would then outlive the 8-hour
// session limit by a year. Match the session limit, and mark Secure everywhere except plain-http dev.
export const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 3600;

export function sessionCookieOptions(env: string | undefined = process.env.NODE_ENV) {
  return {
    secure: env === 'production',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    sameSite: 'lax' as const,
    path: '/',
  };
}
