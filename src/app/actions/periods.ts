'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

// Period locks (change 18). Lock a month once its GST return is filed; the database refuses every posting
// into a locked (or missing) month. Both functions are owner-only in the database too, and audited there.

const lockSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, 'date_invalid'),
  locked: z.boolean(),
  reason: z.string().trim().max(200, 'text_long').optional(),
});
const yearSchema = z.object({ label: z.string().regex(/^\d{4}-\d{2}$/, 'request_invalid') });

export async function setPeriodLock(input: unknown): Promise<ActionResult<{ changed: boolean }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = lockSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;
  if (!v.locked && !v.reason) return dbFailure({ message: 'DN_VALIDATION:reason_required' });

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_period_lock', { p_month: v.month, p_locked: v.locked, p_reason: v.reason ?? null });
  if (error) return dbFailure(error);
  revalidatePath('/settings/period-locks');
  revalidatePath('/settings/audit-trail');
  return ok({ changed: data === true });
}

/** Creates the 12 months of a financial year (`2027-28`) so bills can be posted in them. Returns how many were added. */
export async function createFiscalYear(input: unknown): Promise<ActionResult<{ added: number }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = yearSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('ensure_fiscal_year', { p_label: parsed.data.label });
  if (error) return dbFailure(error);
  revalidatePath('/settings/period-locks');
  return ok({ added: Number(data ?? 0) });
}
