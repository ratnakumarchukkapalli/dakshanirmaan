'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import type { ZodType } from 'zod';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { requireAdmin } from '@/lib/auth/require';
import { parseOpeningCsv } from '@/lib/opening-csv';
import { createClient } from '@/lib/supabase/server';
import {
  cancelOpeningSchema, importOpeningStockSchema, openingMoneyLineSchema, openingPartyLineSchema,
  openingStockLineSchema, postOpeningSchema, removeOpeningLineSchema,
} from '@/schemas/cutover';

// Cutover: owners stage the opening dues, cash/bank balances and stock as lines of one draft batch, then
// `post_opening_balances` turns the batch into a single balanced journal entry. Nothing here adds anything
// up — the database previews and posts the figures (`opening_preview`, `post_opening_balances`).

type Supabase = Awaited<ReturnType<typeof createClient>>;

function revalidateCutover() {
  revalidatePath('/settings/cutover');
  // Every report and the dashboard read the ledger and stock the opening writes.
  revalidatePath('/', 'layout');
}

/** The one draft batch, started on first use. A posted opening means the lines are frozen. */
async function draftBatch(supabase: Supabase): Promise<{ id: string } | Failure> {
  const read = () => supabase.from('opening_batches').select('id, status').neq('status', 'cancelled').maybeSingle();
  let { data, error } = await read();
  if (error) return dbFailure(error);
  if (!data) {
    const made = await supabase.from('opening_batches').insert({}).select('id').single();
    if (made.error) {
      // Two clicks at once: the other one won the unique index, so read theirs.
      ({ data, error } = await read());
      if (error || !data) return dbFailure(made.error);
    } else {
      return { id: made.data.id as string };
    }
  }
  if (data.status !== 'draft') return fail('validation', (await getTranslations('errors'))('validation.opening_batch_not_draft'));
  return { id: data.id as string };
}

/** Shared shape of the three "add a line" actions. */
async function addLine<T>(input: unknown, schema: ZodType<T>, row: (v: T) => Record<string, unknown>): Promise<ActionResult> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = schema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const supabase = await createClient();
  const batch = await draftBatch(supabase);
  if ('ok' in batch) return batch;
  const { error } = await supabase.from('opening_lines').insert({ batch_id: batch.id, ...row(parsed.data) });
  if (error) return dbFailure(error);
  revalidateCutover();
  return ok();
}

/** A customer's or supplier's opening due. */
export async function addOpeningPartyLine(input: unknown): Promise<ActionResult> {
  return addLine(input, openingPartyLineSchema, (v) => ({ kind: 'party', party_id: v.partyId, side: v.side, amount: v.amount }));
}

/** Cash or bank balance. */
export async function addOpeningMoneyLine(input: unknown): Promise<ActionResult> {
  return addLine(input, openingMoneyLineSchema, (v) => ({ kind: 'money', account_id: v.accountId, amount: v.amount }));
}

/** Opening stock of one item in one godown at its cost rate. */
export async function addOpeningStockLine(input: unknown): Promise<ActionResult> {
  return addLine(input, openingStockLineSchema, (v) => ({ kind: 'stock', item_id: v.itemId, warehouse_id: v.warehouseId, qty: v.qty, rate: v.rate }));
}

export async function removeOpeningLine(input: unknown): Promise<ActionResult> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = removeOpeningLineSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.from('opening_lines').delete().eq('id', parsed.data.id);
  if (error) return dbFailure(error);
  revalidateCutover();
  return ok();
}

/**
 * Opening stock from a CSV file. All or nothing: any unreadable row, unknown item or godown stages
 * nothing and reports the first few problems with their line numbers.
 */
export async function importOpeningStock(input: unknown): Promise<ActionResult<{ added: number }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = importOpeningStockSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const t = await getTranslations('cutover');

  const { rows, problems } = parseOpeningCsv(parsed.data.csv);
  const say = (line: number, key: string) => t(`csv.${key}`, { line });
  if (problems.length > 0) {
    return fail('validation', problems.slice(0, 5).map((p) => say(p.line, p.key)).join(' '));
  }

  const supabase = await createClient();
  const [items, godowns] = await Promise.all([
    supabase.from('items').select('id, name').eq('is_stock', true).eq('is_active', true),
    supabase.from('warehouses').select('id, name').eq('is_transit', false),
  ]);
  if (items.error) return dbFailure(items.error);
  if (godowns.error) return dbFailure(godowns.error);
  // Names are not unique in the masters. A name that matches more than one row is refused rather than
  // staged against whichever came last (the equity would still balance, so nothing else would notice).
  const byName = (list: { id: unknown; name: unknown }[] | null) => {
    const m = new Map<string, string[]>();
    for (const r of list ?? []) {
      const key = String(r.name).trim().toLowerCase();
      m.set(key, [...(m.get(key) ?? []), r.id as string]);
    }
    return m;
  };
  const itemId = byName(items.data);
  const godownId = byName(godowns.data);

  const unknown: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const batch = await draftBatch(supabase);
  if ('ok' in batch) return batch;
  for (const r of rows) {
    const itemHits = itemId.get(r.item.toLowerCase()) ?? [];
    const godownHits = godownId.get(r.godown.toLowerCase()) ?? [];
    if (itemHits.length === 0) unknown.push(say(r.line, 'unknown_item'));
    else if (itemHits.length > 1) unknown.push(say(r.line, 'ambiguous_item'));
    else if (godownHits.length === 0) unknown.push(say(r.line, 'unknown_godown'));
    else if (godownHits.length > 1) unknown.push(say(r.line, 'ambiguous_godown'));
    else lines.push({ batch_id: batch.id, kind: 'stock', item_id: itemHits[0], warehouse_id: godownHits[0], qty: r.qty, rate: r.rate });
  }
  if (unknown.length > 0) return fail('validation', unknown.slice(0, 5).join(' '));

  const { error } = await supabase.from('opening_lines').insert(lines);
  if (error) return dbFailure(error);
  revalidateCutover();
  return ok({ added: lines.length });
}

/** Posts the batch. `expectedEquity` is the figure the screen showed; the database refuses a stale one. */
export async function postOpening(input: unknown): Promise<ActionResult> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = postOpeningSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('post_opening_balances', { p_date: parsed.data.date, p_expected_equity: parsed.data.expectedEquity });
  if (error) return dbFailure(error);
  revalidateCutover();
  return ok();
}

/** Reverses the posted opening (only while nothing else has posted); the lines come back as a draft. */
export async function cancelOpening(input: unknown): Promise<ActionResult> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = cancelOpeningSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_opening_balances', { p_reason: parsed.data.reason });
  if (error) return dbFailure(error);
  revalidateCutover();
  return ok();
}
