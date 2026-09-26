'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { afterIdCollision, claimDraftId, isUniqueViolation } from '@/lib/draft-claim';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdminMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { recordAdjustmentSchema, recordTransferSchema, transferIdSchema } from '@/schemas/stock';

// Stock adjustments and godown transfers. All three posting functions are admin-only in the
// database (`post_stock_adjustment`, `post_stock_transfer`, `receive_stock_transfer`), so these
// actions are too, and the modals that call them are not rendered for a counter session. Each
// "record" action saves the draft and posts it in one call; if the post is refused the draft is
// removed again so nothing is left lying around that no screen lists. Nothing here values stock or
// touches the ledger: the posting function does, at the weighted average.

type Supabase = Awaited<ReturnType<typeof createClient>>;

const bad = async (detail: string) => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

function revalidateStock() {
  revalidatePath('/stock', 'layout');
  revalidatePath('/');
}

/** Best effort: a draft the post refused must not linger. A failure here is logged, never shown. */
async function dropDraft(supabase: Supabase, table: 'stock_adjustments' | 'stock_transfers', id: string) {
  const { error } = await supabase.from(table).delete().eq('id', id).eq('status', 'draft');
  if (error) console.error(`[stock] could not remove the ${table} draft after a failed post:`, error.message);
}

export async function recordAdjustment(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = recordAdjustmentSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;
  const supabase = await createClient();

  // A repeat of a call that already posted (lost response, double click): answer with the adjustment it made.
  const claim = await claimDraftId(supabase, 'stock_adjustments', v.id);
  if (claim.kind === 'error') return dbFailure(claim.error);
  if (claim.kind === 'recorded') return ok({ id: v.id });

  const { data: org, error: orgError } = await supabase.from('organization').select('timezone').maybeSingle();
  if (orgError) return dbFailure(orgError);
  if (v.adjDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('doc_date_future');

  const { data: wh, error: whError } = await supabase.from('warehouses').select('id, is_transit').eq('id', v.warehouseId).maybeSingle();
  if (whError) return dbFailure(whError);
  if (!wh) return bad('invalid_warehouse');
  if (wh.is_transit) return bad('transit_warehouse');

  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const { data: items, error: itemError } = await supabase.from('items').select('id, name, is_stock, is_active').in('id', itemIds);
  if (itemError) return dbFailure(itemError);
  const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return bad('no_such_item');
    if (!item.is_stock) return bad('non_stock_line');
    if (!item.is_active) return bad('item_inactive');
  }

  const { error } = await supabase
    .from('stock_adjustments')
    .insert({ id: v.id, adj_date: v.adjDate, warehouse_id: v.warehouseId, reason: v.reason, status: 'draft', created_by: gate.member.userId });
  if (error) return isUniqueViolation(error) ? afterIdCollision(supabase, 'stock_adjustments', v.id) : dbFailure(error);
  const id = v.id;

  const { error: lineError } = await supabase.from('stock_adjustment_lines').insert(
    v.lines.map((l, i) => ({
      adjustment_id: id, line_no: i + 1, item_id: l.itemId, item_name: byId.get(l.itemId)!.name,
      // Signed: a loss is negative. The database values a loss at the current average and refuses a rate on it.
      qty: l.direction === 'loss' ? `-${l.qty}` : l.qty,
      rate: l.direction === 'found' ? (l.rate ?? null) : null,
    })),
  );
  if (lineError) {
    await dropDraft(supabase, 'stock_adjustments', id);
    return dbFailure(lineError);
  }

  const { error: postError } = await supabase.rpc('post_stock_adjustment', { p_adjustment_id: id });
  if (postError) {
    await dropDraft(supabase, 'stock_adjustments', id);
    return dbFailure(postError);
  }

  revalidateStock();
  return ok({ id });
}

export async function recordTransfer(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = recordTransferSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;
  const supabase = await createClient();

  const claim = await claimDraftId(supabase, 'stock_transfers', v.id);
  if (claim.kind === 'error') return dbFailure(claim.error);
  if (claim.kind === 'recorded') return ok({ id: v.id });

  const { data: org, error: orgError } = await supabase.from('organization').select('timezone').maybeSingle();
  if (orgError) return dbFailure(orgError);
  if (v.transferDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('doc_date_future');

  const { data: whs, error: whError } = await supabase.from('warehouses').select('id, is_transit').in('id', [v.fromWarehouseId, v.toWarehouseId]);
  if (whError) return dbFailure(whError);
  if ((whs ?? []).length !== 2) return bad('invalid_warehouse');
  if ((whs ?? []).some((w) => w.is_transit)) return bad('transit_warehouse');

  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const { data: items, error: itemError } = await supabase.from('items').select('id, name, base_uom, is_stock, is_active').in('id', itemIds);
  if (itemError) return dbFailure(itemError);
  const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return bad('no_such_item');
    if (!item.is_stock) return bad('non_stock_line');
    if (!item.is_active) return bad('item_inactive');
  }

  const { error } = await supabase
    .from('stock_transfers')
    .insert({
      id: v.id, transfer_date: v.transferDate, from_warehouse_id: v.fromWarehouseId, to_warehouse_id: v.toWarehouseId,
      vehicle_no: v.vehicleNo ?? null, status: 'draft', created_by: gate.member.userId,
    });
  if (error) return isUniqueViolation(error) ? afterIdCollision(supabase, 'stock_transfers', v.id) : dbFailure(error);
  const id = v.id;

  const { error: lineError } = await supabase.from('stock_transfer_lines').insert(
    v.lines.map((l, i) => {
      const item = byId.get(l.itemId)!;
      return { transfer_id: id, line_no: i + 1, item_id: l.itemId, item_name: item.name, uom: item.base_uom, qty: l.qty };
    }),
  );
  if (lineError) {
    await dropDraft(supabase, 'stock_transfers', id);
    return dbFailure(lineError);
  }

  const { error: postError } = await supabase.rpc('post_stock_transfer', { p_transfer_id: id });
  if (postError) {
    await dropDraft(supabase, 'stock_transfers', id);
    return dbFailure(postError);
  }

  revalidateStock();
  return ok({ id });
}

/** The destination godown confirms the goods arrived: stock leaves In Transit into the destination. */
export async function receiveTransfer(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = transferIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('receive_stock_transfer', { p_transfer_id: parsed.data.id });
  if (error) return dbFailure(error);

  revalidateStock();
  return ok({ id: parsed.data.id });
}
