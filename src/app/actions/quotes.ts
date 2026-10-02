'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { markQuoteSchema, quoteIdSchema, saveQuoteSchema } from '@/schemas/quotes';

// Quotations. Any active member (counter included) writes them, and every write is one database
// function (save_quotation / mark_quotation / convert_quotation_to_invoice) called as the signed-in
// user: the database takes names, HSN and GST from the item master, numbers the quote, checks the
// stale-write version, and computes every total. Nothing here calculates money, and nothing posts.

const SCOPE = { scope: 'quote' } as const;

function revalidateQuotes(id?: string) {
  revalidatePath('/sales');
  revalidatePath('/sales/quotes');
  if (id) revalidatePath(`/sales/quotes/${id}`);
}

/** Creates (no `id`) or edits (`id` + `expectedUpdatedAt`) an open quote with all its lines. */
export async function saveQuote(input: unknown): Promise<ActionResult<{ id: string; quoteNo: string; updatedAt: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = saveQuoteSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('save_quotation', {
    p_id: v.id ?? null,
    p_expected_updated_at: v.expectedUpdatedAt ?? null,
    p_party_id: v.partyId,
    p_quote_date: v.quoteDate,
    p_valid_until: v.validUntil ?? null,
    p_note: v.note ?? null,
    p_lines: v.lines.map((l) => ({
      item_id: l.itemId, qty: l.qty, rate: l.rate, discount_pct: l.discountPct,
      ...(l.altQty ? { alt_qty: l.altQty } : {}),
    })),
  });
  if (error) return dbFailure(error, SCOPE);

  const saved = data as { id?: string; quote_no?: string; updated_at?: string } | null;
  if (!saved?.id || !saved.quote_no || !saved.updated_at) {
    console.error('[quotes] save_quotation returned an unexpected shape');
    return fail('internal', (await getTranslations('errors'))('internal'));
  }

  // Same reasoning as saveDraftInvoice: the form page itself is not revalidated mid-edit (its
  // address bar changes to ?id= after the first save and a re-render would throw the form's state away).
  revalidateQuotes(saved.id);
  return ok({ id: saved.id, quoteNo: saved.quote_no, updatedAt: saved.updated_at });
}

/** Moves a quote between open / accepted / expired. Converted is never set by hand; the database refuses it. */
export async function markQuote(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = markQuoteSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, status } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('mark_quotation', { p_quote_id: id, p_status: status });
  if (error) return dbFailure(error, SCOPE);

  revalidateQuotes(id);
  return ok({ id, updatedAt: String(data) });
}

/**
 * Turns an open or accepted quote into a DRAFT sales invoice at the quoted rates. Nothing posts;
 * the invoice goes through the normal flow (credit limit and stock are checked then). Repeating
 * the call returns the same draft id.
 */
export async function convertQuoteToInvoice(input: unknown): Promise<ActionResult<{ invoiceId: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = quoteIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('convert_quotation_to_invoice', { p_quote_id: id });
  if (error) return dbFailure(error, SCOPE);
  if (typeof data !== 'string' || !data) {
    console.error('[quotes] convert_quotation_to_invoice returned no invoice id');
    return fail('internal', (await getTranslations('errors'))('internal'));
  }

  revalidateQuotes(id);
  revalidatePath('/sales');
  return ok({ invoiceId: data });
}
