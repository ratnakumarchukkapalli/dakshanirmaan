import { notFound, redirect } from 'next/navigation';
import { BillForm } from '@/components/purchases/BillForm';
import { requireOwnerPage } from '@/lib/auth/require';
import { decimalText } from '@/lib/decimal';
import { loadAttachments } from '@/lib/attachments-data';
import { loadBillFormContext } from '@/lib/purchases-data';
import type { BillFormInitial } from '@/lib/purchases-types';
import { rateText, trimZeros } from '@/lib/units';
import { isUuid } from '@/lib/uuid';
import { createClient } from '@/lib/supabase/server';

// A draft bill, editable. Once posted or cancelled a bill is only ever viewed.
export default async function DraftBillPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();

  const [headRes, linesRes] = await Promise.all([
    supabase.from('purchase_invoices').select('id, status, updated_at, invoice_date, party_id, supplier_bill_no, supplier_bill_date, itc_eligible').eq('id', id).maybeSingle(),
    supabase.from('purchase_invoice_lines').select('item_id, qty, alt_qty, rate, discount_pct, line_no').eq('invoice_id', id).order('line_no'),
  ]);
  if (headRes.error) throw new Error(`bill: ${headRes.error.message}`);
  if (linesRes.error) throw new Error(`bill lines: ${linesRes.error.message}`);
  const head = headRes.data;
  const lines = linesRes.data ?? [];
  if (!head) notFound();
  if (head.status !== 'draft') redirect(`/purchases/${id}/view`);

  const [ctx, photos] = await Promise.all([
    loadBillFormContext(supabase, { partyId: head.party_id, itemIds: lines.map((l) => l.item_id as string) }),
    loadAttachments(supabase, id),
  ]);

  const initial: BillFormInitial = {
    id: head.id,
    updatedAt: head.updated_at,
    values: {
      partyId: head.party_id,
      invoiceDate: head.invoice_date,
      supplierBillNo: head.supplier_bill_no ?? '',
      supplierBillDate: head.supplier_bill_date ?? head.invoice_date,
      itcEligible: head.itc_eligible,
      lines: lines.map((l) => ({
        itemId: l.item_id,
        qty: trimZeros(decimalText(l.qty, 3)),
        altQty: l.alt_qty === null ? '' : trimZeros(decimalText(l.alt_qty, 3)),
        rate: rateText(decimalText(l.rate, 4)),
        discountPct: Number(l.discount_pct) === 0 ? '' : trimZeros(decimalText(l.discount_pct, 2)),
      })),
    },
  };
  return <BillForm ctx={ctx} initial={initial} photos={photos} />;
}
