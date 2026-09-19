// Sliding-window limiter, in memory. Good enough for ≤10 users on one or a few server
// instances (the security spec accepts this; no Redis). Keys are hashed by nothing: they
// never leave the process.

export interface Limiter {
  /** True if one more hit is allowed now (does not record). */
  allows(key: string, now?: number): boolean;
  /** Records a hit. */
  hit(key: string, now?: number): void;
}

export function createLimiter({ limit, windowMs }: { limit: number; windowMs: number }): Limiter {
  const hits = new Map<string, number[]>();
  const recent = (key: string, now: number) => {
    const kept = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  };
  return {
    allows: (key, now = Date.now()) => recent(key, now).length < limit,
    hit(key, now = Date.now()) {
      hits.set(key, [...recent(key, now), now]);
    },
  };
}

const MIN = 60_000;
const emailCodes = createLimiter({ limit: 5, windowMs: 15 * MIN });
const ipCodes = createLimiter({ limit: 20, windowMs: 60 * MIN });
const codeChecks = createLimiter({ limit: 10, windowMs: 15 * MIN });
const totpChecks = createLimiter({ limit: 10, windowMs: 15 * MIN });

/** Sign-in code requests: 5 per email per 15 min and 20 per IP per hour. Records on success. */
export function allowCodeRequest(email: string, ip: string, now = Date.now()): boolean {
  if (!emailCodes.allows(email, now) || !ipCodes.allows(ip, now)) return false;
  emailCodes.hit(email, now);
  ipCodes.hit(ip, now);
  return true;
}

/** Attempts to type a sign-in code: 10 per email per 15 min. */
export function allowCodeCheck(email: string, now = Date.now()): boolean {
  if (!codeChecks.allows(email, now)) return false;
  codeChecks.hit(email, now);
  return true;
}

/** Attempts at the authenticator-app code: 10 per person per 15 min. */
export function allowTotpCheck(userId: string, now = Date.now()): boolean {
  if (!totpChecks.allows(userId, now)) return false;
  totpChecks.hit(userId, now);
  return true;
}
