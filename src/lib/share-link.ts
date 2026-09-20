import { createHmac, timingSafeEqual } from 'node:crypto';

// Signed, expiring links to an invoice PDF (WhatsApp share). The signature covers the invoice id
// and the expiry, so changing either one, or using another secret, invalidates the link.

export const LINK_TTL_SECONDS = 24 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

const sign = (invoiceId: string, expires: number, secret: string) =>
  createHmac('sha256', secret).update(`${invoiceId}.${expires}`).digest('base64url');

/** Expiry (unix seconds) and signature for a link valid for `LINK_TTL_SECONDS` from `nowMs`. */
export function signInvoiceLink(invoiceId: string, secret: string, nowMs: number = Date.now()): { exp: number; sig: string } {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error('link secret too short');
  const exp = Math.floor(nowMs / 1000) + LINK_TTL_SECONDS;
  return { exp, sig: sign(invoiceId, exp, secret) };
}

export type LinkCheck = 'ok' | 'expired' | 'invalid';

/** Checks a link in constant time. Says nothing about *why* beyond expired / invalid. */
export function verifyInvoiceLink(
  invoiceId: string,
  expRaw: string | null,
  sigRaw: string | null,
  secret: string | undefined,
  nowMs: number = Date.now(),
): LinkCheck {
  if (!secret || secret.length < MIN_SECRET_LENGTH || !expRaw || !sigRaw) return 'invalid';
  if (!/^\d{1,12}$/.test(expRaw)) return 'invalid';
  const exp = Number(expRaw);
  const want = Buffer.from(sign(invoiceId, exp, secret));
  const got = Buffer.from(sigRaw);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'invalid';
  return Math.floor(nowMs / 1000) > exp ? 'expired' : 'ok';
}
