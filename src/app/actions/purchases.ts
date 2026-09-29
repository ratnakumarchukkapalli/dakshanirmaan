'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { requireAdminMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { billIdSchema, cancelBillSchema, saveDraftBillSchema, SUPPLIER_BILL_NO_PATTERN } from '@/schemas/purchases';

// Supplier bills. OWNER-ONLY, drafts included: the database lets only an owner post or cancel a
// purchase, and supplier rates and input tax are not counter data, so the counter has no screen
// or action here. Drafts are written through the user-scoped client (RLS allows insert/update/delete
// only while status = 'draft'). Posting and cancelling are thin wrappers around the database
// functions, which derive the actor from the session and are the only place any tax, total or stock
// cost is computed. Nothing here calculates money.

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

// The unique index on posted bills (migration 20261002100000): the same supplier bill number twice.
const DUPLICATE_INDEX = /purchase_invoices_supplier_bill_uniq/;

function revalidateBill(id: string) {
  revalidatePath('/purchases');
  revalidatePath(`/purchases/${id}`);
  revalidatePath(`/purchases/${id}/view`);
}

function revalidateAfterPosting(id: string) {
  revalidateBill(id);
  revalidatePath('/parties');
  revalidatePath('/stock');
  revalidatePath('/payments');
  revalidatePath('/');
}

/** `ilike` treats % _ and \ as wildcards: an exact, case-insensitive match needs them escaped. */
const exactPattern = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Is this supplier's bill number already on a POSTED bill? (`exceptId`: the draft being saved or
 * posted, which is not a duplicate of itself.) The unique index is the real guard and also covers
 * two people posting at the same moment; this only gives the friendly early answer.
 */
async function billNumberTaken(supabase: Awaited<ReturnType<typeof createClient>>, partyId: string, billNo: string, exceptId?: string) {
  let q = supabase.from('purchase_invoices').select('id').eq('party_id', partyId).eq('status', 'posted').ilike('supplier_bill_no', exactPattern(billNo)).limit(1);
  if (exceptId) q = q.neq('id', exceptId);
  const { data, error } = await q;
  return { error, taken: (data?.length ?? 0) > 0 };
}

/** Creates or updates a draft bill together with its lines. Returns the id and the new `updated_at`. */
export async function saveDraftBill(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = saveDraftBillSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();

  // Business date rules that need the organisation: no future dates (its time zone decides "today").
  const { data: org, error: orgError } = await supabase.from('organization').select('timezone, state_code').maybeSingle();
  if (orgError) return dbFailure(orgError);
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');
  if (v.invoiceDate > today) return bad('bill_date_future');

  // The existing draft, when editing: it must still be a draft, and tells us which supplier/items it already carries.
  let previousItemIds = new Set<string>();
  let previousPartyId: string | null = null;
  let previousLines: Record<string, unknown>[] = [];
  if (v.id) {
    const { data: head, error } = await supabase.from('purchase_invoices').select('id, status, party_id').eq('id', v.id).maybeSingle();
    if (error) return dbFailure(error);
    if (!head) return bad('no_such_bill');
    if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
    previousPartyId = head.party_id as string;
    const { data: old, error: linesError } = await supabase.from('purchase_invoice_lines').select('*').eq('invoice_id', v.id);
    if (linesError) return dbFailure(linesError);
    previousLines = old ?? [];
    previousItemIds = new Set(previousLines.map((l) => l.item_id as string));
  }

  // Supplier: a supplier (or both), active. An existing draft may keep one that was disabled since.
  const { data: party, error: partyError } = await supabase.from('parties').select('id, type, is_active').eq('id', v.partyId).maybeSingle();
  if (partyError) return dbFailure(partyError);
  if (!party || !['supplier', 'both'].includes(party.type as string)) return bad('invalid_supplier');
  if (!party.is_active && v.partyId !== previousPartyId) return bad('invalid_supplier');

  // The same supplier bill entered twice would claim its tax twice.
  const dup = await billNumberTaken(supabase, v.partyId, v.supplierBillNo, v.id);
  if (dup.error) return dbFailure(dup.error);
  if (dup.taken) return bad('duplicate_supplier_bill');

  // Items: read now, so the snapshot on each line is what the item says at the moment of saving.
  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const { data: items, error: itemError } = await supabase
    .from('items').select('id, name, hsn_code, gst_rate, base_uom, alt_uom, is_active, is_stock').in('id', itemIds);
  if (itemError) return dbFailure(itemError);
  const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return bad('no_such_item');
    // Services (freight, hamali) are not bill lines: freight goes through its own voucher.
    if (!item.is_stock) return bad('bill_item_not_stock');
    if (!item.is_active && !previousItemIds.has(id)) return bad('bill_item_inactive');
  }

  const { data: wh, error: whError } = await supabase.from('warehouses').select('id').eq('is_default', true).eq('is_transit', false).maybeSingle();
  if (whError) return dbFailure(whError);
  if (!wh) return bad('no_default_warehouse');

  const header = {
    invoice_date: v.invoiceDate,
    party_id: v.partyId,
    // An inward bill is booked in our own state; the tax split follows the supplier's state and is
    // decided by post_purchase_invoice, not here.
    place_of_supply: org?.state_code as string,
    supplier_bill_no: v.supplierBillNo,
    supplier_bill_date: v.supplierBillDate,
    itc_eligible: v.itcEligible,
    // Reverse-charge bills have no posting path (RCM freight is its own voucher): never set from here.
    rcm: false,
    warehouse_id: wh.id,
  };
  const lineRows = (invoiceId: string) =>
    v.lines.map((l, i) => {
      const item = byId.get(l.itemId)!;
      return {
        invoice_id: invoiceId, line_no: i + 1, item_id: l.itemId,
        // Snapshot columns: the posted bill is read from these, never from the item. The database
        // re-reads name, HSN, unit and GST rate at posting and computes taxable value and tax.
        item_name: item.name, hsn_code: item.hsn_code, uom: item.base_uom, gst_rate: item.gst_rate,
        qty: l.qty, alt_qty: item.alt_uom ? (l.altQty ?? null) : null, rate: l.rate, discount_pct: l.discountPct,
        taxable_value: 0,
      };
    });

  let billId: string;
  let updatedAt: string;

  if (v.id) {
    // Stale write guard: only the version the form loaded may be replaced.
    const { data: updated, error } = await supabase
      .from('purchase_invoices').update(header)
      .eq('id', v.id).eq('status', 'draft').eq('updated_at', v.expectedUpdatedAt!)
      .select('id, updated_at');
    if (error) return dbFailure(error);
    if (!updated?.length) return fail('conflict', (await getTranslations('errors'))('conflict'));
    billId = v.id;
    updatedAt = updated[0]!.updated_at as string;

    // Replace the lines. There is no single database call for this, so if the new lines are
    // refused, the previous ones are put back.
    const { error: delError } = await supabase.from('purchase_invoice_lines').delete().eq('invoice_id', billId);
    if (delError) return dbFailure(delError);
    const { error: insError } = await supabase.from('purchase_invoice_lines').insert(lineRows(billId));
    if (insError) {
      const restore = previousLines.map((l) => {
        const rest = { ...l };
        delete rest.id;
        delete rest.created_at;
        return rest;
      });
      if (restore.length) {
        const { error: restoreError } = await supabase.from('purchase_invoice_lines').insert(restore);
        if (restoreError) {
          console.error('[purchases] could not restore draft lines after a failed save:', restoreError.message);
          return fail('partial', (await getTranslations('errors'))('partial'));
        }
      }
      return dbFailure(insError);
    }
  } else {
    const { data: created, error } = await supabase
      .from('purchase_invoices')
      .insert({ ...header, status: 'draft', created_by: gate.member.userId })
      .select('id, updated_at')
      .single();
    if (error) return dbFailure(error);
    billId = created.id as string;
    updatedAt = created.updated_at as string;

    const { error: insError } = await supabase.from('purchase_invoice_lines').insert(lineRows(billId));
    if (insError) {
      // Do not leave an empty draft behind.
      await supabase.from('purchase_invoices').delete().eq('id', billId);
      return dbFailure(insError);
    }
  }

  // No revalidatePath here, for the same reason as the sales form: the address bar already says
  // /purchases/<id> after the first save, and re-rendering the current route would swap the form
  // for the edit page and throw away what the person is looking at.
  return ok({ id: billId, updatedAt });
}

/** Throws away a draft (a posted bill is never deleted; it is cancelled). */
export async function deleteDraftBill(input: unknown): Promise<ActionResult> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = billIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('purchase_invoices').delete().eq('id', parsed.data.id).eq('status', 'draft').select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('not_draft', (await getTranslations('errors'))('not_draft'));

  revalidatePath('/purchases');
  return ok();
}

/** Posts a draft bill: stock in, input tax (when eligible), and what we owe the supplier. */
export async function postBill(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = billIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id } = parsed.data;

  const supabase = await createClient();

  // Re-check the supplier's number at posting time too: it may have been entered on another bill since the draft was saved.
  const { data: head, error: headError } = await supabase.from('purchase_invoices').select('party_id, supplier_bill_no, status').eq('id', id).maybeSingle();
  if (headError) return dbFailure(headError);
  if (!head) return bad('no_such_bill');
  if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
  const stored = head.supplier_bill_no as string | null;
  const billNo = stored?.trim();
  if (!stored || !billNo) return bad('supplier_bill_no_missing');
  // A draft written around the form (straight to the API) may carry a number the form would never accept: a tab,
  // a non-breaking space, look-alike letters. The unique index only strips plain spaces, so such a number would slip
  // past it. The stored value is tested as it is (not trimmed first), so a stray trailing tab is caught too.
  if (!SUPPLIER_BILL_NO_PATTERN.test(stored)) return bad('supplier_bill_no_invalid');
  const dup = await billNumberTaken(supabase, head.party_id as string, billNo, id);
  if (dup.error) return dbFailure(dup.error);
  if (dup.taken) return bad('duplicate_supplier_bill');

  const { error } = await supabase.rpc('post_purchase_invoice', { p_invoice_id: id });
  if (error) {
    // Two owners posting the same supplier bill at the same moment: the index refuses the second.
    if (error.code === '23505' && DUPLICATE_INDEX.test(error.message ?? '')) return bad('duplicate_supplier_bill');
    return dbFailure(error);
  }

  revalidateAfterPosting(id);
  return ok({ id });
}

/** Cancels a posted bill by reversal (the database refuses it when payments are allocated or the stock was already sold). */
export async function cancelBill(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = cancelBillSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, reason } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_document', { p_source_type: 'purchase_invoice', p_source_id: id, p_reason: reason });
  if (error) {
    const failure = await dbFailure(error);
    // The generic sentence says "reduce the quantity"; for a bill whose goods were already sold the remedy is a debit note.
    if (failure.code === 'negative_stock') return fail('negative_stock', (await getTranslations('errors'))('validation.bill_cancel_stock_sold'));
    return failure;
  }

  revalidateAfterPosting(id);
  return ok({ id });
}
