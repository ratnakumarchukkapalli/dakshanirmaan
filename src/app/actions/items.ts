'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { createItemSchema, itemIdSchema, updateItemSchema } from '@/schemas/items';

// Items are owner-only (an admin who has passed the authenticator step). The database re-checks the role and locks units once an item has history.

type ItemFields = ReturnType<typeof createItemSchema.parse>;

const columns = (v: ItemFields) => ({
  name: v.name, brand: v.brand ?? null, category: v.category, hsn_code: v.hsnCode, gst_rate: v.gstRate,
  base_uom: v.baseUom, alt_uom: v.altUom ?? null, conversion_factor: v.conversionFactor ?? null,
  reorder_level: v.reorderLevel, sale_rate: v.saleRate, is_stock: v.isStock,
});

export async function createItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.from('items').insert(columns(parsed.data)).select('id').single();
  if (error) return dbFailure(error);

  revalidatePath('/settings/items');
  revalidatePath('/stock', 'layout');
  return ok({ id: data.id as string });
}

export async function updateItem(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, ...v } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.from('items').update(columns(v)).eq('id', id).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_item'));

  revalidatePath('/settings/items');
  revalidatePath('/stock', 'layout');
  return ok();
}

async function setActive(input: unknown, active: boolean): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = itemIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.from('items').update({ is_active: active }).eq('id', parsed.data.itemId).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_item'));

  revalidatePath('/settings/items');
  revalidatePath('/stock', 'layout');
  return ok();
}

/** Removes an item nothing has ever used; the database refuses (foreign keys) if it has history. */
export async function deleteItem(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = itemIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.from('items').delete().eq('id', parsed.data.itemId).select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('validation', t('validation.no_such_item'));

  revalidatePath('/settings/items');
  revalidatePath('/stock', 'layout');
  return ok();
}

export async function deactivateItem(input: unknown): Promise<ActionResult> {
  return setActive(input, false);
}

export async function reactivateItem(input: unknown): Promise<ActionResult> {
  return setActive(input, true);
}
