'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { requireMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { challanIdSchema, saveDraftChallanSchema } from '@/schemas/challans';

// Delivery challans: goods leave before the invoice exists. Drafts are written by any active
// member (RLS allows insert/update/delete only while status = 'draft'); posting and converting
// to an invoice are thin wrappers around the database, which derives the actor from the session
// and is the only place stock moves or a number is assigned. Nothing here calculates value.

type AddressRow = { label: string; state_code: string; is_default: boolean; address: Record<string, string | null> | null };

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

/** The address as it was on the day of the challan (later edits to the party never rewrite it). */
function snapshot(a: AddressRow | undefined | null) {
  if (!a) return null;
  const ad = a.address ?? {};
  return {
    label: a.label, line1: ad.line1 ?? '', line2: ad.line2 ?? null, city: ad.city ?? '',
    district: ad.district ?? null, pincode: ad.pincode ?? '', state_code: a.state_code,
  };
}

// Race recovery in convertChallanToInvoice: how many times, and how far apart, the loser looks for the winner's finished draft.
const RACE_RETRIES = 3;
const RACE_RETRY_MS = 120;

function revalidateChallan() {
  revalidatePath('/sales');
  revalidatePath('/sales/challans/new');
}

/** Creates or updates a draft delivery challan together with its lines. Returns the id and the new `updated_at`. */
export async function saveDraftChallan(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = saveDraftChallanSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();

  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  if (v.challanDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('date_future');

  // The existing draft, when editing: it must still be a draft, and tells us which items it already carries.
  let previousItemIds = new Set<string>();
  let previousPartyId: string | null = null;
  let previousLines: Record<string, unknown>[] = [];
  if (v.id) {
    const { data: head } = await supabase.from('delivery_challans').select('id, status, party_id').eq('id', v.id).maybeSingle();
    if (!head) return bad('no_such_challan');
    if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
    previousPartyId = head.party_id as string;
    const { data: old, error } = await supabase.from('delivery_challan_lines').select('*').eq('challan_id', v.id);
    if (error) return dbFailure(error);
    previousLines = old ?? [];
    previousItemIds = new Set(previousLines.map((l) => l.item_id as string));
  }

  // Party: a customer (or both), active. An existing draft may keep a party that was disabled since.
  const { data: party } = await supabase.from('parties').select('id, type, is_active').eq('id', v.partyId).maybeSingle();
  if (!party || !['customer', 'both'].includes(party.type as string)) return bad('invalid_party');
  if (!party.is_active && v.partyId !== previousPartyId) return bad('invalid_party');

  // The site (or the party's registered address when none is chosen): what the goods are consigned to.
  const { data: addrs, error: addrError } = await supabase
    .from('party_addresses').select('id, label, state_code, is_default, address').eq('party_id', v.partyId);
  if (addrError) return dbFailure(addrError);
  const rows = (addrs ?? []) as (AddressRow & { id: string })[];
  let site = rows.find((a) => a.is_default);
  if (v.siteId) {
    site = rows.find((a) => a.id === v.siteId);
    if (!site) return bad('site_invalid');
  }

  // Items: read now, so the snapshot on each line is what the item says at the moment of saving.
  // A challan is a goods-out note; a non-stock item (freight, loading charges) has nothing to
  // deliver and belongs on the invoice instead (the database refuses it again at posting time).
  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const { data: items, error: itemError } = await supabase
    .from('items').select('id, name, hsn_code, gst_rate, base_uom, alt_uom, is_active, is_stock').in('id', itemIds);
  if (itemError) return dbFailure(itemError);
  const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return bad('no_such_item');
    if (!item.is_active && !previousItemIds.has(id)) return bad('item_inactive');
    if (!item.is_stock) return bad('item_not_stock');
  }

  const { data: wh } = await supabase.from('warehouses').select('id').eq('is_default', true).eq('is_transit', false).maybeSingle();
  if (!wh) return bad('no_default_warehouse');

  const header = {
    challan_date: v.challanDate,
    party_id: v.partyId,
    warehouse_id: wh.id,
    site_address: snapshot(site),
    vehicle_no: v.vehicleNo ?? null,
  };
  const lineRows = (challanId: string) =>
    v.lines.map((l, i) => {
      const item = byId.get(l.itemId)!;
      return {
        challan_id: challanId, line_no: i + 1, item_id: l.itemId,
        item_name: item.name, hsn_code: item.hsn_code, uom: item.base_uom, gst_rate: item.gst_rate,
        qty: l.qty, alt_qty: item.alt_uom ? (l.altQty ?? null) : null, rate: l.rate, discount_pct: l.discountPct,
      };
    });

  let challanId: string;
  let updatedAt: string;

  if (v.id) {
    // Stale write guard: only the version the form loaded may be replaced.
    const { data: updated, error } = await supabase
      .from('delivery_challans').update(header)
      .eq('id', v.id).eq('status', 'draft').eq('updated_at', v.expectedUpdatedAt!)
      .select('id, updated_at');
    if (error) return dbFailure(error);
    if (!updated?.length) return fail('conflict', (await getTranslations('errors'))('conflict'));
    challanId = v.id;
    updatedAt = updated[0]!.updated_at as string;

    // Replace the lines. There is no single database call for this, so if the new lines are
    // refused, the previous ones are put back.
    const { error: delError } = await supabase.from('delivery_challan_lines').delete().eq('challan_id', challanId);
    if (delError) return dbFailure(delError);
    const { error: insError } = await supabase.from('delivery_challan_lines').insert(lineRows(challanId));
    if (insError) {
      const restore = previousLines.map((l) => {
        const rest = { ...l };
        delete rest.id;
        delete rest.created_at;
        return rest;
      });
      if (restore.length) {
        const { error: restoreError } = await supabase.from('delivery_challan_lines').insert(restore);
        if (restoreError) {
          console.error('[challans] could not restore draft lines after a failed save:', restoreError.message);
          return fail('partial', (await getTranslations('errors'))('partial'));
        }
      }
      return dbFailure(insError);
    }
  } else {
    const { data: created, error } = await supabase
      .from('delivery_challans')
      .insert({ ...header, status: 'draft', created_by: gate.member.userId })
      .select('id, updated_at')
      .single();
    if (error) return dbFailure(error);
    challanId = created.id as string;
    updatedAt = created.updated_at as string;

    const { error: insError } = await supabase.from('delivery_challan_lines').insert(lineRows(challanId));
    if (insError) {
      // Do not leave an empty draft behind.
      await supabase.from('delivery_challans').delete().eq('id', challanId);
      return dbFailure(insError);
    }
  }

  // No revalidatePath here, same reasoning as saveDraftInvoice: this runs mid-edit.
  return ok({ id: challanId, updatedAt });
}

/** Posts a draft challan: stock leaves the warehouse into Goods in Transit (both roles may do this). */
export async function postChallan(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = challanIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('post_delivery_challan', { p_challan_id: parsed.data.id });
  if (error) return dbFailure(error);

  revalidateChallan();
  revalidatePath('/stock');
  revalidatePath('/');
  return ok({ id: parsed.data.id });
}

/**
 * Starts (or resumes) the invoice for a posted, open challan. Idempotent: calling it again for
 * the same challan before that invoice is posted returns the same draft id and creates nothing
 * new; calling it once the invoice is posted returns that invoice's id.
 */
export async function convertChallanToInvoice(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = challanIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id } = parsed.data;

  const supabase = await createClient();
  const { data: challan } = await supabase
    .from('delivery_challans')
    .select('id, status, invoice_id, party_id, warehouse_id, site_address, vehicle_no')
    .eq('id', id).maybeSingle();
  if (!challan) return bad('no_such_challan');
  if (challan.status !== 'posted') return fail('not_posted', (await getTranslations('errors'))('not_posted'));

  // Already converted and posted: nothing new, same invoice every time.
  if (challan.invoice_id) return ok({ id: challan.invoice_id as string });

  // A draft invoice already started from this challan (the button pressed twice before that
  // draft was posted): return it rather than starting a sibling draft.
  const { data: existingDraft } = await supabase
    .from('sales_invoices').select('id').eq('challan_id', id).eq('status', 'draft')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existingDraft) return ok({ id: existingDraft.id as string });

  const { data: party } = await supabase.from('parties').select('state_code, type, is_active').eq('id', challan.party_id).maybeSingle();
  if (!party || !['customer', 'both'].includes(party.type as string) || !party.is_active) return bad('invalid_party');

  const { data: addrs } = await supabase
    .from('party_addresses').select('label, state_code, is_default, address').eq('party_id', challan.party_id);
  const billing = ((addrs ?? []) as AddressRow[]).find((a) => a.is_default);

  const { data: lines, error: linesError } = await supabase
    .from('delivery_challan_lines')
    .select('item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct')
    .eq('challan_id', id).order('line_no');
  if (linesError) return dbFailure(linesError);
  if (!lines?.length) return bad('no_lines');

  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  const site = challan.site_address as { state_code?: string } | null;

  const { data: created, error } = await supabase
    .from('sales_invoices')
    .insert({
      invoice_date: todayIn(org?.timezone ?? 'Asia/Kolkata'),
      party_id: challan.party_id,
      warehouse_id: challan.warehouse_id,
      place_of_supply: site?.state_code ?? party.state_code,
      billing_address: snapshot(billing),
      shipping_address: challan.site_address,
      vehicle_no: challan.vehicle_no,
      challan_id: challan.id,
      status: 'draft',
      created_by: gate.member.userId,
    })
    .select('id')
    .single();
  if (error) {
    // Lost a race with another call converting the same challan at the same instant (the
    // existing-draft check above and this insert are not atomic together): the database's own
    // unique index refused the second row. The winner's draft may not have its lines yet (it
    // inserts the header first), or may be deleted again if its own line insert fails, so the
    // id is only handed back once that draft still exists AND carries lines. A few short
    // retries cover the first case; if it never settles, say so and let the person press again.
    if (error.code === '23505' && /sales_invoices_one_draft_per_challan/.test(error.message ?? '')) {
      for (let attempt = 0; attempt < RACE_RETRIES; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, RACE_RETRY_MS));
        const { data: winner } = await supabase
          .from('sales_invoices').select('id').eq('challan_id', id).eq('status', 'draft').maybeSingle();
        if (!winner) continue;
        const { data: winnerLines } = await supabase
          .from('sales_invoice_lines').select('id').eq('invoice_id', winner.id as string).limit(1);
        if (winnerLines?.length) return ok({ id: winner.id as string });
      }
      return fail('conflict', (await getTranslations('errors'))('validation.convert_in_progress'));
    }
    return dbFailure(error);
  }
  const invoiceId = created.id as string;

  const { error: insError } = await supabase.from('sales_invoice_lines').insert(
    lines.map((l, i) => ({
      invoice_id: invoiceId, line_no: i + 1, item_id: l.item_id, item_name: l.item_name, hsn_code: l.hsn_code,
      uom: l.uom, gst_rate: l.gst_rate, qty: l.qty, alt_qty: l.alt_qty, rate: l.rate, discount_pct: l.discount_pct,
    })),
  );
  if (insError) {
    // Do not leave an empty draft behind.
    await supabase.from('sales_invoices').delete().eq('id', invoiceId);
    return dbFailure(insError);
  }

  revalidateChallan();
  return ok({ id: invoiceId });
}
