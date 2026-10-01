'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { requireAdmin, requireMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { derivePlaceOfSupply } from '@/lib/place-of-supply';
import { createClient } from '@/lib/supabase/server';
import {
  cancelInvoiceSchema, invoiceIdSchema, postCashSaleSchema, postInvoiceSchema, recordEwbSchema, saveDraftSchema,
} from '@/schemas/sales';

// Sales invoices. Drafts are written by any active member through the user-scoped client (RLS
// allows insert/update/delete only while status = 'draft'). Posting, cash sales and cancelling are
// thin wrappers around the database functions, which derive the actor from the session and are the
// only place any number, tax or total is computed. Nothing here calculates money.

type AddressRow = { label: string; state_code: string; is_default: boolean; address: Record<string, string | null> | null };

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

/** The address as it was on the day of the invoice (later edits to the party never rewrite a bill). */
function snapshot(a: AddressRow | undefined | null) {
  if (!a) return null;
  const ad = a.address ?? {};
  return {
    label: a.label, line1: ad.line1 ?? '', line2: ad.line2 ?? null, city: ad.city ?? '',
    district: ad.district ?? null, pincode: ad.pincode ?? '', state_code: a.state_code,
  };
}

function revalidateInvoice(id: string) {
  revalidatePath('/sales');
  revalidatePath(`/sales/${id}`);
  revalidatePath(`/sales/${id}/view`);
}

/** Creates or updates a draft invoice together with its lines. Returns the id and the new `updated_at`. */
export async function saveDraftInvoice(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = saveDraftSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();

  // Business date rules that need the organisation: no future dates (its time zone decides "today").
  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  if (v.invoiceDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('date_future');

  // The existing draft, when editing: it must still be a draft, and tells us which parties/items it already carries.
  let previousItemIds = new Set<string>();
  let previousPartyId: string | null = null;
  let previousLines: Record<string, unknown>[] = [];
  if (v.id) {
    const { data: head } = await supabase.from('sales_invoices').select('id, status, party_id').eq('id', v.id).maybeSingle();
    if (!head) return bad('no_such_invoice');
    if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
    previousPartyId = head.party_id as string;
    const { data: old, error } = await supabase.from('sales_invoice_lines').select('*').eq('invoice_id', v.id);
    if (error) return dbFailure(error);
    previousLines = old ?? [];
    previousItemIds = new Set(previousLines.map((l) => l.item_id as string));
  }

  // Party: a customer (or both), active. An existing draft may keep a party that was disabled since.
  const { data: party } = await supabase.from('parties').select('id, type, is_active, state_code').eq('id', v.partyId).maybeSingle();
  if (!party || !['customer', 'both'].includes(party.type as string)) return bad('invalid_party');
  if (!party.is_active && v.partyId !== previousPartyId) return bad('invalid_party');

  // Addresses: billing = the default one; shipping = the chosen delivery site, else billing.
  const { data: addrs, error: addrError } = await supabase
    .from('party_addresses').select('id, label, state_code, is_default, address').eq('party_id', v.partyId);
  if (addrError) return dbFailure(addrError);
  const rows = (addrs ?? []) as (AddressRow & { id: string })[];
  const billing = rows.find((a) => a.is_default);
  let shipping = billing;
  if (v.siteId) {
    shipping = rows.find((a) => a.id === v.siteId);
    if (!shipping) return bad('site_invalid');
  }

  // Items: read now, so the snapshot on each line is what the item says at the moment of saving.
  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const { data: items, error: itemError } = await supabase
    .from('items').select('id, name, hsn_code, gst_rate, base_uom, alt_uom, is_active').in('id', itemIds);
  if (itemError) return dbFailure(itemError);
  const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return bad('no_such_item');
    if (!item.is_active && !previousItemIds.has(id)) return bad('item_inactive');
  }

  const { data: wh } = await supabase.from('warehouses').select('id').eq('is_default', true).eq('is_transit', false).maybeSingle();
  if (!wh) return bad('no_default_warehouse');

  const header = {
    invoice_date: v.invoiceDate,
    party_id: v.partyId,
    // Derived, never taken from the form: the delivery state, else the customer's own. post_sales_invoice
    // derives it again from the database's own addresses, so this is only what the draft shows.
    place_of_supply: derivePlaceOfSupply(rows.map((a) => ({ id: a.id, stateCode: a.state_code, isBilling: a.is_default })), v.siteId, party.state_code as string) as string,
    billing_address: snapshot(billing),
    shipping_address: snapshot(shipping),
    vehicle_no: v.vehicleNo ?? null,
    transporter_name: v.transporterName ?? null,
    transport_mode: v.transportMode ?? null,
    distance_km: v.distanceKm === undefined ? null : Number(v.distanceKm),
    transporter_gstin: v.transporterGstin ?? null,
  };
  const lineRows = (invoiceId: string) =>
    v.lines.map((l, i) => {
      const item = byId.get(l.itemId)!;
      return {
        invoice_id: invoiceId, line_no: i + 1, item_id: l.itemId,
        // Snapshot columns: the posted invoice is read from these, never from the item.
        item_name: item.name, hsn_code: item.hsn_code, uom: item.base_uom, gst_rate: item.gst_rate,
        qty: l.qty, alt_qty: item.alt_uom ? (l.altQty ?? null) : null, rate: l.rate, discount_pct: l.discountPct,
      };
    });

  let invoiceId: string;
  let updatedAt: string;

  if (v.id) {
    // Stale write guard: only the version the form loaded may be replaced.
    const { data: updated, error } = await supabase
      .from('sales_invoices').update(header)
      .eq('id', v.id).eq('status', 'draft').eq('updated_at', v.expectedUpdatedAt!)
      .select('id, updated_at');
    if (error) return dbFailure(error);
    if (!updated?.length) return fail('conflict', (await getTranslations('errors'))('conflict'));
    invoiceId = v.id;
    updatedAt = updated[0]!.updated_at as string;

    // Replace the lines. There is no single database call for this, so if the new lines are
    // refused, the previous ones are put back.
    const { error: delError } = await supabase.from('sales_invoice_lines').delete().eq('invoice_id', invoiceId);
    if (delError) return dbFailure(delError);
    const { error: insError } = await supabase.from('sales_invoice_lines').insert(lineRows(invoiceId));
    if (insError) {
      const restore = previousLines.map((l) => {
        const rest = { ...l };
        delete rest.id;
        delete rest.created_at;
        return rest;
      });
      if (restore.length) {
        const { error: restoreError } = await supabase.from('sales_invoice_lines').insert(restore);
        if (restoreError) {
          console.error('[sales] could not restore draft lines after a failed save:', restoreError.message);
          return fail('partial', (await getTranslations('errors'))('partial'));
        }
      }
      return dbFailure(insError);
    }
  } else {
    const { data: created, error } = await supabase
      .from('sales_invoices')
      .insert({ ...header, warehouse_id: wh.id, status: 'draft', created_by: gate.member.userId })
      .select('id, updated_at')
      .single();
    if (error) return dbFailure(error);
    invoiceId = created.id as string;
    updatedAt = created.updated_at as string;

    const { error: insError } = await supabase.from('sales_invoice_lines').insert(lineRows(invoiceId));
    if (insError) {
      // Do not leave an empty draft behind.
      await supabase.from('sales_invoices').delete().eq('id', invoiceId);
      return dbFailure(insError);
    }
  }

  // Deliberately no revalidatePath here. Pages are dynamic (cookies), so the router never serves a
  // stale copy, and revalidating from an action re-renders the *current* route: after the first save
  // of a new invoice the address bar already says /sales/<id>, so that would swap the form for the
  // edit page and throw away what the person is looking at (an error, an open dialog, half-typed
  // fields). Post, cancel and delete revalidate because they navigate away.
  return ok({ id: invoiceId, updatedAt });
}

/** Throws away a draft (a posted invoice is never deleted; it is cancelled). */
export async function deleteDraftInvoice(input: unknown): Promise<ActionResult> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = invoiceIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('sales_invoices').delete().eq('id', parsed.data.id).eq('status', 'draft').select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('not_draft', (await getTranslations('errors'))('not_draft'));

  revalidatePath('/sales');
  return ok();
}

/**
 * Posts a draft as a credit sale. Only an owner may ask for the credit-limit override, and the
 * database checks that again; a counter user asking for it is refused rather than quietly ignored.
 */
export async function postInvoice(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = postInvoiceSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, overrideCredit } = parsed.data;
  if (overrideCredit && gate.member.role !== 'admin') return fail('forbidden', (await getTranslations('errors'))('forbidden'));

  const supabase = await createClient();
  const { error } = await supabase.rpc('post_sales_invoice', { p_invoice_id: id, p_override_credit: overrideCredit === true });
  if (error) return dbFailure(error);

  revalidateAfterPosting(id);
  return ok({ id });
}

/** Posts a draft as a cash sale: the invoice and a full receipt into the chosen cash / bank account, in one transaction. */
export async function postCashSale(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = postCashSaleSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, accountId } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc('post_cash_sale', { p_invoice_id: id, p_account_id: accountId });
  if (error) return dbFailure(error);

  revalidateAfterPosting(id);
  revalidatePath('/payments');
  return ok({ id });
}

/** Cancels a posted invoice by reversal (owners only; the database refuses anyone else). */
export async function cancelInvoice(input: unknown): Promise<ActionResult<{ id: string }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = cancelInvoiceSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, reason } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_document', { p_source_type: 'sales_invoice', p_source_id: id, p_reason: reason });
  if (error) return dbFailure(error);

  revalidateAfterPosting(id);
  return ok({ id });
}

// India has no daylight saving, so "valid until <date>" is the end of that day at +05:30.
const endOfDay = (isoDate: string) => `${isoDate}T23:59:59+05:30`;

/**
 * Records transport and e-way-bill details on a POSTED invoice (the number comes from the
 * government portal; nothing here talks to it). Any active member; the database function changes
 * only those columns and writes an audit row.
 */
export async function recordInvoiceEwb(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = recordEwbSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc('record_invoice_ewb', {
    p_invoice_id: v.id,
    p_transport_mode: v.transportMode ?? null,
    p_distance_km: v.distanceKm === undefined ? null : Number(v.distanceKm),
    p_transporter_name: v.transporterName ?? null,
    p_transporter_gstin: v.transporterGstin ?? null,
    p_vehicle_no: v.vehicleNo ?? null,
    p_ewb_no: v.ewbNo ?? null,
    p_ewb_date: v.ewbDate ?? null,
    p_ewb_valid_until: v.ewbValidUntil ? endOfDay(v.ewbValidUntil) : null,
  });
  if (error) return dbFailure(error);

  revalidateInvoice(v.id);
  return ok({ id: v.id });
}

function revalidateAfterPosting(id: string) {
  revalidateInvoice(id);
  revalidatePath('/parties');
  revalidatePath('/stock');
  revalidatePath('/');
}
