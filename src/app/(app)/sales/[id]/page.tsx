import { notFound, redirect } from 'next/navigation';
import { InvoiceForm } from '@/components/sales/InvoiceForm';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { decimalText } from '@/lib/decimal';
import { loadInvoiceFormContext } from '@/lib/sales-data';
import type { InvoiceFormInitial } from '@/lib/sales-types';
import { rateText, trimZeros } from '@/lib/units';
import { createClient } from '@/lib/supabase/server';

// A draft, editable. Once posted or cancelled an invoice is only ever viewed.
export default async function DraftInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();

  const [{ data: head }, { data: lines }, member] = await Promise.all([
    supabase.from('sales_invoices').select('id, status, updated_at, invoice_date, party_id, place_of_supply, shipping_address, vehicle_no, transporter_name').eq('id', id).maybeSingle(),
    supabase.from('sales_invoice_lines').select('item_id, qty, alt_qty, rate, discount_pct, line_no').eq('invoice_id', id).order('line_no'),
    getCurrentMember(),
  ]);
  if (!head) notFound();
  if (head.status !== 'draft') redirect(`/sales/${id}/view`);

  const ctx = await loadInvoiceFormContext(supabase, { partyId: head.party_id, itemIds: (lines ?? []).map((l) => l.item_id as string) });

  // Which delivery site was chosen: the party address whose label matches the saved shipping snapshot (none = billing address).
  const party = ctx.parties.find((p) => p.id === head.party_id);
  const ship = head.shipping_address as { label?: string; line1?: string; pincode?: string } | null;
  const site = party?.sites.find((s) => !s.isBilling && s.label === ship?.label && s.line1 === ship?.line1 && s.pincode === ship?.pincode);

  const initial: InvoiceFormInitial = {
    id: head.id,
    updatedAt: head.updated_at,
    values: {
      partyId: head.party_id,
      invoiceDate: head.invoice_date,
      placeOfSupply: head.place_of_supply,
      siteId: site?.id ?? '',
      vehicleNo: head.vehicle_no ?? '',
      transporterName: head.transporter_name ?? '',
      lines: (lines ?? []).map((l) => ({
        itemId: l.item_id,
        qty: trimZeros(decimalText(l.qty, 3)),
        altQty: l.alt_qty === null ? '' : trimZeros(decimalText(l.alt_qty, 3)),
        rate: rateText(decimalText(l.rate, 4)),
        discountPct: Number(l.discount_pct) === 0 ? '' : trimZeros(decimalText(l.discount_pct, 2)),
      })),
    },
  };
  return <InvoiceForm ctx={ctx} initial={initial} isAdmin={isVerifiedAdmin(member)} />;
}
