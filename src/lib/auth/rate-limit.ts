// Sliding-window limiter, in memory. Good enough for ≤10 users on one or a few server
// instances (the security spec accepts this; no Redis). Keys are hashed by nothing: they
// never leave the process.

export interface Limiter {
  /** True if one more hit is allowed now (does not record). */
  allows(key: string, now?: number): boolean;
  /** Records a hit. */
  hit(key: string, now?: number): void;
  /** Forgets a key (e.g. after a successful sign-in). */
  clear(key: string): void;
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
    clear: (key) => void hits.delete(key),
    hit(key, now = Date.now()) {
      const kept = recent(key, now);
      hits.delete(key);
      hits.set(key, [...kept, now]);
      housekeeping(now);
    },
  };
}

const MIN = 60_000;
// Two counters per action. The tight one is per (email + caller address): one address can use up
// only its own budget, so a stranger who knows the owner's email cannot lock the owner out from
// somewhere else. The loose per-email ceiling still stops a spread-out attack on one account.
const pairKey = (email: string, ip: string) => `${email}|${ip}`;
const pairCodes = createLimiter({ limit: 5, windowMs: 15 * MIN });
const emailCodes = createLimiter({ limit: 20, windowMs: 15 * MIN });
const ipCodes = createLimiter({ limit: 20, windowMs: 60 * MIN });
const totpChecks = createLimiter({ limit: 10, windowMs: 15 * MIN });

/**
 * Sign-in code requests: 5 per email per address per 15 min, 20 per email (any address) per
 * 15 min, and 20 per address per hour. Records on success only.
 */
export function allowCodeRequest(email: string, ip: string, now = Date.now()): boolean {
  const pair = pairKey(email, ip);
  if (!pairCodes.allows(pair, now) || !emailCodes.allows(email, now) || !ipCodes.allows(ip, now)) return false;
  pairCodes.hit(pair, now);
  emailCodes.hit(email, now);
  ipCodes.hit(ip, now);
  return true;
}

// Password sign-in counts FAILED attempts only, so typing the right password never uses budget and a
// stranger cannot lock the owner out by hammering the login form:
//  - per (email + address): 10 failures per 15 min. Only that address is slowed down.
//  - per address: 30 failures per hour across all emails (stops one address spraying many accounts).
//  - per email, any address: 100 failures per 15 min. A backstop against a spread-out attack; it never
//    blocks an address that has signed in successfully as that person before.
// A successful sign-in clears the (email, address) failures and remembers the pair as known for 30 days.
const pairFails = createLimiter({ limit: 10, windowMs: 15 * MIN });
const ipFails = createLimiter({ limit: 30, windowMs: 60 * MIN });
const emailFails = createLimiter({ limit: 100, windowMs: 15 * MIN });
const KNOWN_FOR_MS = 30 * 24 * 60 * MIN;
const KNOWN_MAX = 2_000;
const knownPairs = new Map<string, number>(); // pair -> time of last good sign-in

const isKnown = (pair: string, now: number) => {
  const at = knownPairs.get(pair);
  if (at === undefined) return false;
  if (now - at >= KNOWN_FOR_MS) {
    knownPairs.delete(pair);
    return false;
  }
  return true;
};

/** True if this person may try a password from this address now. Does not record anything. */
export function signInAllowed(email: string, ip: string, now = Date.now()): boolean {
  const pair = pairKey(email, ip);
  if (!pairFails.allows(pair, now)) return false;
  if (isKnown(pair, now)) return true;
  return ipFails.allows(ip, now) && emailFails.allows(email, now);
}

/** Call after a wrong password (not after a server fault or a rate-limit answer). */
export function recordSignInFailure(email: string, ip: string, now = Date.now()): void {
  pairFails.hit(pairKey(email, ip), now);
  ipFails.hit(ip, now);
  emailFails.hit(email, now);
}

/** Call after a correct password: clears this pair's failures and remembers the pair. */
export function recordSignInSuccess(email: string, ip: string, now = Date.now()): void {
  const pair = pairKey(email, ip);
  pairFails.clear(pair);
  knownPairs.delete(pair);
  knownPairs.set(pair, now);
  if (knownPairs.size > KNOWN_MAX) {
    const oldest = knownPairs.keys().next().value;
    if (oldest !== undefined) knownPairs.delete(oldest);
  }
}

/** Attempts at the authenticator-app code: 10 per person per 15 min. */
export function allowTotpCheck(userId: string, now = Date.now()): boolean {
  if (!totpChecks.allows(userId, now)) return false;
  totpChecks.hit(userId, now);
  return true;
}
