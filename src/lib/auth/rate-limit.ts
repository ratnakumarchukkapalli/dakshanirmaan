// Sliding-window limiter, in memory. Good enough for ≤10 users on one or a few server
// instances (the security spec accepts this; no Redis). Keys are hashed by nothing: they
// never leave the process.

export interface Limiter {
  /** True if one more hit is allowed now (does not record). */
  allows(key: string, now?: number): boolean;
  /** Records a hit. */
  hit(key: string, now?: number): void;
  /** How many keys are held right now (for tests and monitoring). */
  size(): number;
}

/** Housekeeping: sweep expired keys every this many writes, and never hold more than this many keys. */
const SWEEP_EVERY = 500;
const MAX_KEYS = 10_000;

export function createLimiter({ limit, windowMs, maxKeys = MAX_KEYS, sweepEvery = SWEEP_EVERY }: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  sweepEvery?: number;
}): Limiter {
  // Map order is write order (a write deletes then re-sets), so the first key is the stalest.
  const hits = new Map<string, number[]>();
  let writes = 0;
  const recent = (key: string, now: number) => {
    const kept = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
  };
  // Without this, a spray of distinct keys (e.g. random emails) would grow the map without bound.
  const housekeeping = (now: number) => {
    if (++writes < sweepEvery && hits.size <= maxKeys) return;
    writes = 0;
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= windowMs)) hits.delete(key);
    }
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) break;
      hits.delete(key);
    }
  };
  return {
    allows: (key, now = Date.now()) => recent(key, now).length < limit,
    size: () => hits.size,
    hit(key, now = Date.now()) {
      const kept = recent(key, now);
      hits.delete(key);
      hits.set(key, [...kept, now]);
      housekeeping(now);
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
