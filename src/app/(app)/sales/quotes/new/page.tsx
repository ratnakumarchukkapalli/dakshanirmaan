import { notFound, redirect } from 'next/navigation';
import { QuoteForm } from '@/components/quotes/QuoteForm';
import { decimalText } from '@/lib/decimal';
import type { QuoteFormInitial } from '@/lib/quotes-types';
import { loadInvoiceFormContext } from '@/lib/sales-data';
import { rateText, trimZeros } from '@/lib/units';
import { createClient } from '@/lib/supabase/server';

// New quotation, or `?id=` to edit an open one. Anything else (accepted, expired, converted) is only viewed.
export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createClient();

  let initial: QuoteFormInitial | undefined;
  let keep: { partyId?: string; itemIds?: string[] } = {};
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const [{ data: head }, { data: lines }] = await Promise.all([
      supabase.from('v_quotations').select('id, quote_no, status, updated_at, quote_date, valid_until, party_id, note').eq('id', id).maybeSingle(),
      supabase.from('v_quotation_lines').select('item_id, qty, alt_qty, rate, discount_pct, line_no').eq('quote_id', id).order('line_no'),
    ]);
    if (!head) notFound();
    if (head.status !== 'open') redirect(`/sales/quotes/${id}`);
    keep = { partyId: head.party_id as string, itemIds: (lines ?? []).map((l) => l.item_id as string) };
    initial = {
      id: head.id as string,
      quoteNo: head.quote_no as string,
      // The database's own text, handed back unchanged on save.
      updatedAt: head.updated_at as string,
      values: {
        partyId: head.party_id as string,
        quoteDate: head.quote_date as string,
        validUntil: head.valid_until as string,
        note: (head.note as string | null) ?? '',
        lines: (lines ?? []).map((l) => ({
          itemId: l.item_id as string,
          qty: trimZeros(decimalText(l.qty, 3)),
          altQty: l.alt_qty === null ? '' : trimZeros(decimalText(l.alt_qty, 3)),
          rate: rateText(decimalText(l.rate, 4)),
          discountPct: Number(l.discount_pct) === 0 ? '' : trimZeros(decimalText(l.discount_pct, 2)),
        })),
      },
    };
  }

  const ctx = await loadInvoiceFormContext(supabase, keep);
  return <QuoteForm ctx={ctx} initial={initial} />;
}
