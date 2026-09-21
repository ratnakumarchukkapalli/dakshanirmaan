'use server';

import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/require';
import { decimalText } from '@/lib/decimal';
import { formatDate, inr2 } from '@/lib/format';
import { whatsappNumber } from '@/lib/phone';
import { MIN_SECRET_LENGTH, signInvoiceLink } from '@/lib/share-link';
import { createClient } from '@/lib/supabase/server';
import { invoiceIdSchema } from '@/schemas/sales';

export interface ShareLink {
  /** The signed, 24-hour PDF link (also what "Copy link" copies). */
  link: string;
  /** wa.me link with the message; null when the customer has no usable mobile number. */
  whatsappUrl: string | null;
  /** Unix seconds. */
  expires: number;
}

/**
 * The public origin the link points at. `APP_ORIGIN` in production; in development the request's
 * own host is an acceptable stand-in. A production server without it refuses rather than guess.
 */
async function origin(): Promise<string | null> {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return null;
  const h = await headers();
  const host = h.get('host');
  return host ? `${host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'}://${host}` : null;
}

/**
 * Builds the WhatsApp share for a posted invoice: a signed PDF link that works for 24 hours without
 * signing in, and (when the customer has a mobile number) the wa.me link that opens WhatsApp with
 * the message ready. Any active member. Never falls back to an unsigned link.
 */
export async function whatsappInvoiceLink(input: unknown): Promise<ActionResult<ShareLink>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = invoiceIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const t = await getTranslations('errors');

  const secret = process.env.INVOICE_LINK_SECRET;
  const base = await origin();
  if (!secret || secret.length < MIN_SECRET_LENGTH || !base) {
    console.error('[share] INVOICE_LINK_SECRET (>= 32 characters) and APP_ORIGIN must be set to share invoices');
    return fail('validation', t('validation.share_not_configured'));
  }

  const supabase = await createClient();
  const [{ data: inv, error }, { data: org }] = await Promise.all([
    supabase
      .from('sales_invoices')
      .select('id, status, invoice_no, invoice_date, grand_total, party:parties(whatsapp_phone)')
      .eq('id', parsed.data.id)
      .maybeSingle(),
    supabase.from('organization').select('legal_name, trade_name').maybeSingle(),
  ]);
  if (error) return dbFailure(error);
  // Only a posted invoice is shared; a draft has no number and a cancelled one is not for customers.
  if (!inv || inv.status !== 'posted') return fail('not_posted', t('not_posted'));

  const { exp, sig } = signInvoiceLink(inv.id as string, secret);
  const link = `${base}/api/invoices/${inv.id}/pdf?exp=${exp}&sig=${sig}`;

  // Only the WhatsApp number, never the ordinary phone: that one may be a landline, and the database
  // stores it without its trunk zero, so "0863 2345678" looks exactly like a mobile. A wrong guess
  // would send a customer's invoice to a stranger.
  const party = inv.party as unknown as { whatsapp_phone: string | null } | null;
  const mobile = whatsappNumber(party?.whatsapp_phone);
  const seller = org?.trade_name || org?.legal_name || '';
  const text = [
    `${seller}`,
    `Invoice ${inv.invoice_no} dated ${formatDate(inv.invoice_date as string)}`,
    `Amount: ${inr2(decimalText(inv.grand_total as number | string, 2))}`,
    `View / download: ${link}`,
  ].join('\n');

  return ok({
    link,
    whatsappUrl: mobile ? `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}` : null,
    expires: exp,
  });
}
