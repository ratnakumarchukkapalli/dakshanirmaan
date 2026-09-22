import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChallanForm } from '@/components/sales/ChallanForm';
import { OpenChallansPanel } from '@/components/sales/OpenChallansPanel';
import { decimalText } from '@/lib/decimal';
import { loadInvoiceFormContext, loadOpenChallans } from '@/lib/sales-data';
import type { ChallanFormInitial } from '@/lib/sales-types';
import { rateText, trimZeros } from '@/lib/units';
import { createClient } from '@/lib/supabase/server';

/**
 * One screen for both the challan form and the open-challans list — there is no separate route
 * for a posted challan (it is either still a draft here, being edited, or already showing in the
 * panel on the right). `?id=` resumes an existing draft; a fresh visit starts a blank one.
 */
export default async function NewChallanPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createClient();

  let initial: ChallanFormInitial | undefined;
  let keep: { partyId?: string; itemIds?: string[] } = {};
  let siteSnapshot: { label?: string; line1?: string; pincode?: string } | null = null;

  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const [{ data: head }, { data: lines }] = await Promise.all([
      supabase.from('delivery_challans').select('id, status, updated_at, challan_date, party_id, site_address, vehicle_no').eq('id', id).maybeSingle(),
      supabase.from('delivery_challan_lines').select('item_id, qty, alt_qty, rate, discount_pct, line_no').eq('challan_id', id).order('line_no'),
    ]);
    if (!head) notFound();
    // A posted or cancelled challan is read only through the "Open challans" panel and the
    // invoice it was (or can be) converted to; there is no draft form to hand it back to.
    if (head.status !== 'draft') notFound();
    keep = { partyId: head.party_id, itemIds: (lines ?? []).map((l) => l.item_id as string) };

    siteSnapshot = head.site_address as { label?: string; line1?: string; pincode?: string } | null;
    initial = {
      id: head.id,
      updatedAt: head.updated_at,
      values: {
        partyId: head.party_id,
        challanDate: head.challan_date,
        siteId: '', // resolved below once the parties are loaded
        vehicleNo: head.vehicle_no ?? '',
        lines: (lines ?? []).map((l) => ({
          itemId: l.item_id,
          qty: trimZeros(decimalText(l.qty, 3)),
          altQty: l.alt_qty === null ? '' : trimZeros(decimalText(l.alt_qty, 3)),
          rate: rateText(decimalText(l.rate, 4)),
          discountPct: Number(l.discount_pct) === 0 ? '' : trimZeros(decimalText(l.discount_pct, 2)),
        })),
      },
    };
  }

  const [t, ctx, openChallans] = await Promise.all([
    getTranslations('challans'), loadInvoiceFormContext(supabase, keep), loadOpenChallans(supabase),
  ]);

  if (initial) {
    const party = ctx.parties.find((p) => p.id === initial!.values.partyId);
    const match = party?.sites.find((s) => !s.isBilling && s.label === siteSnapshot?.label && s.line1 === siteSnapshot?.line1 && s.pincode === siteSnapshot?.pincode);
    initial.values.siteId = match?.id ?? '';
  }

  return (
    <div className="screen">
      <div className="screenhead">
        <Link href="/sales" className="btn ghost sm">{t('back')}</Link>
        <h1>{t('title')}</h1>
      </div>
      <div className="grid2">
        <ChallanForm ctx={ctx} initial={initial} />
        <OpenChallansPanel challans={openChallans} />
      </div>
    </div>
  );
}
