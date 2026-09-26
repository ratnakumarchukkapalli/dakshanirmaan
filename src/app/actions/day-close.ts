'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { isVerifiedAdmin, requireAdmin, requireMember } from '@/lib/auth/require';
import { decimalText } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import { closeBlock } from '@/lib/reports-math';
import { createClient } from '@/lib/supabase/server';
import { closeDaySchema, reopenDaySchema } from '@/schemas/day-close';

// Day close: the counter counts the drawer, the database works out what should be there, stores the
// difference and posts it to cash over/short. Nothing here calculates cash — `post_day_close` reads
// the ledger itself. Reopening a close is owner-only (`cancel_document` refuses anyone else).

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Date of the most recent live (not reopened) close, or null when nothing has been closed. */
async function latestLiveClose(supabase: Supabase): Promise<string | null> {
  const { data } = await supabase
    .from('day_closes').select('close_date').neq('status', 'cancelled').order('close_date', { ascending: false }).limit(1).maybeSingle();
  return (data?.close_date as string | undefined) ?? null;
}

function revalidateClose() {
  revalidatePath('/reports/day-close');
  // The dashboard's day-close chip and the books.
  revalidatePath('/');
  revalidatePath('/reports/day-book');
  revalidatePath('/reports/cash-bank');
}

/** Closes a day with the counted cash. Both roles. Returns the difference as the database stored it. */
export async function closeDay(input: unknown): Promise<ActionResult<{ id: string; difference: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = closeDaySchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  if (v.date > todayIn(org?.timezone ?? 'Asia/Kolkata')) {
    return fail('validation', (await getTranslations('errors'))('validation.future_date'));
  }

  const block = closeBlock({ date: v.date, today: todayIn(org?.timezone ?? 'Asia/Kolkata'), latestClose: await latestLiveClose(supabase), isAdmin: isVerifiedAdmin(gate.member) });
  if (block) return fail('validation', (await getTranslations('errors'))(block === 'later_close' ? 'validation.later_close_exists' : 'validation.close_date_old'));

  const { error } = await supabase.rpc('post_day_close', { p_date: v.date, p_counted: v.counted, p_note: v.note ?? null, p_expected_seen: v.expectedSeen });
  if (error) return dbFailure(error);

  const { data: row, error: readError } = await supabase
    .from('day_closes').select('id, difference').eq('close_date', v.date).neq('status', 'cancelled').maybeSingle();
  if (readError || !row) {
    // The close is posted; only the read-back failed. Say so rather than pretend nothing happened.
    console.error('[day-close] posted but could not read back:', readError?.message);
    revalidateClose();
    return ok({ id: '', difference: '' });
  }
  revalidateClose();
  return ok({ id: row.id as string, difference: decimalText(row.difference as number | string, 2) });
}

/** Reopens a closed day (owner only): the over/short entry is reversed on the day itself and the date can be closed again. */
export async function reopenDay(input: unknown): Promise<ActionResult<{ id: string }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = reopenDaySchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  // Reopening an earlier day while a later one stays closed would leave the later close counted against a ledger that no longer matches it.
  const [{ data: target }, latest] = await Promise.all([
    supabase.from('day_closes').select('close_date').eq('id', parsed.data.id).maybeSingle(),
    latestLiveClose(supabase),
  ]);
  const targetDate = (target?.close_date as string | undefined) ?? null;
  if (targetDate !== null && latest !== null && latest > targetDate) {
    return fail('validation', (await getTranslations('errors'))('validation.reopen_later_first'));
  }
  const { error } = await supabase.rpc('cancel_document', { p_source_type: 'day_close', p_source_id: parsed.data.id, p_reason: parsed.data.reason });
  if (error) return dbFailure(error);

  revalidateClose();
  return ok({ id: parsed.data.id });
}
