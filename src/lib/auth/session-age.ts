// Session time-box. Supabase's own session-limit setting is a paid feature, so the app enforces
// it. The sign-in time comes from the signed token's `amr` (authentication methods) claim, which
// the person cannot edit.

export const SESSION_MAX_HOURS = 8;

interface AmrEntry {
  method?: unknown;
  timestamp?: unknown;
}

/** Epoch seconds of the earliest authentication in the token, or null if there is none. */
export function signInTime(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  const times = (amr as AmrEntry[])
    .map((e) => (typeof e?.timestamp === 'number' ? e.timestamp : NaN))
    .filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? Math.min(...times) : null;
}

/** True when the session is older than the limit — or its age cannot be established (fail closed). */
export function isSessionExpired(amr: unknown, nowMs: number, maxHours = SESSION_MAX_HOURS): boolean {
  const started = signInTime(amr);
  if (started === null) return true;
  return nowMs - started * 1000 > maxHours * 3_600_000;
}
