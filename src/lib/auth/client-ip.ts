// Caller address for rate limiting, from request headers. Pure so it can be tested.

/**
 * `x-real-ip` is set by the platform (Vercel) and cannot be supplied by the caller, so it wins.
 * Otherwise use the RIGHT-most `x-forwarded-for` entry: each proxy appends the address it saw,
 * so the right-most one was added by our own edge, while everything to its left is whatever the
 * caller chose to claim. Never the left-most.
 */
export function pickClientIp(get: (name: string) => string | null | undefined): string {
  const real = get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = get('x-forwarded-for')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return forwarded?.at(-1) ?? 'unknown';
}
