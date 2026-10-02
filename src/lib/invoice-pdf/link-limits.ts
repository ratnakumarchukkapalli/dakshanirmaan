import { createLimiter } from '@/lib/auth/rate-limit';

// Rate limits for the public signed-link invoice PDF (WhatsApp share). Rendering a PDF costs real CPU and
// anyone holding a link can hit it, so every signed request is counted, valid or not.
const WINDOW_MS = 10 * 60 * 1000;
export const SIGNED_LINK_LIMIT = 30;
/** Seconds to wait, sent as Retry-After on a 429. */
export const RETRY_AFTER_SECONDS = Math.ceil(WINDOW_MS / 1000);

// Bad signatures from one address: a brute-force spray is cut off long before it could matter.
const badLinks = createLimiter({ limit: 20, windowMs: WINDOW_MS });
// Every signed request from one address, and every correctly signed request for one invoice. The per-invoice count
// only runs after the signature checks out, so a stranger who merely knows an invoice id cannot use up its budget.
const signedByIp = createLimiter({ limit: SIGNED_LINK_LIMIT, windowMs: WINDOW_MS });
const signedByInvoice = createLimiter({ limit: SIGNED_LINK_LIMIT, windowMs: WINDOW_MS });

/** Counts a signed-link request from this address; false = over the limit (do not serve). */
export function allowSignedRequest(ip: string, now = Date.now()): boolean {
  if (!badLinks.allows(ip, now) || !signedByIp.allows(ip, now)) return false;
  signedByIp.hit(ip, now);
  return true;
}

/** Remember a bad signature from this address. */
export function recordBadLink(ip: string, now = Date.now()): void {
  badLinks.hit(ip, now);
}

/** Counts a correctly signed request for this invoice; false = over the limit. */
export function allowInvoiceLinkUse(invoiceId: string, now = Date.now()): boolean {
  if (!signedByInvoice.allows(invoiceId, now)) return false;
  signedByInvoice.hit(invoiceId, now);
  return true;
}
