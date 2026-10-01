'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin, requireMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { cancelCashDepositSchema, cashDepositSchema } from '@/schemas/cash-deposit';

// Cash banked from the drawer: one modal, one action. No draft state. `post_cash_deposit` writes the
// Dr bank / Cr cash entry and every refusal (locked month, a closed day, amount, role) comes from the
// database. Only an owner cancels one, through `cancel_document`.

function revalidateDeposits() {
  revalidatePath('/payments');
  revalidatePath('/reports/day-close');
  // The dashboard's money tiles and the books.
  revalidatePath('/');
  revalidatePath('/reports/day-book');
  revalidatePath('/reports/cash-bank');
}

/** Records cash taken from the drawer to the bank. Any active member. Returns the deposit's id. */
export async function postCashDeposit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = cashDepositSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  if (v.date > todayIn(org?.timezone ?? 'Asia/Kolkata')) {
    return fail('validation', (await getTranslations('errors'))('validation.doc_date_future'));
  }

  const { data, error } = await supabase.rpc('post_cash_deposit', {
    p_date: v.date, p_amount: v.amount, p_reference: v.reference ?? null, p_note: v.note ?? null,
  });
  if (error) return dbFailure(error);

  revalidateDeposits();
  return ok({ id: (data as string | null) ?? '' });
}

/** Cancels a deposit (owner only): reversed on the deposit's own day, refused while that day is closed. */
export async function cancelCashDeposit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = cancelCashDepositSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('cancel_document', { p_source_type: 'cash_deposit', p_source_id: parsed.data.id, p_reason: parsed.data.reason });
  if (error) return dbFailure(error);

  revalidateDeposits();
  return ok({ id: parsed.data.id });
}
