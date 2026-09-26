import { getTranslations } from 'next-intl/server';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import type { createClient } from '@/lib/supabase/server';

// Idempotency for the "save the draft and post it in one call" actions. The modal generates a UUID once
// per open and sends it as `id`; the action inserts the draft WITH that id. A retry after a lost
// response therefore finds the document already there instead of posting a second one.

type Supabase = Awaited<ReturnType<typeof createClient>>;
export type DraftTable = 'expense_vouchers' | 'stock_adjustments' | 'stock_transfers';

export type Claim = { kind: 'fresh' } | { kind: 'recorded' } | { kind: 'error'; error: { message: string; code?: string } };

/**
 * Where does this id stand? `recorded`: a document with it is already posted (or cancelled), so the
 * earlier call succeeded and the answer is that document's id. `fresh`: nothing there (a leftover draft
 * from a call that died before it could clean up is removed first). Anything else is an error.
 */
export async function claimDraftId(supabase: Supabase, table: DraftTable, id: string): Promise<Claim> {
  const { data, error } = await supabase.from(table).select('id, status').eq('id', id).maybeSingle();
  if (error) return { kind: 'error', error };
  if (!data) return { kind: 'fresh' };
  if (data.status !== 'draft') return { kind: 'recorded' };
  const { error: dropError } = await supabase.from(table).delete().eq('id', id).eq('status', 'draft');
  if (dropError) return { kind: 'error', error: dropError };
  return { kind: 'fresh' };
}

/**
 * The header insert lost a race on the primary key: another call with this id got in first. If that
 * call has already posted, this one is a harmless repeat; otherwise it is still in flight and this one
 * must not touch it.
 */
export async function afterIdCollision(supabase: Supabase, table: DraftTable, id: string): Promise<ActionResult<{ id: string }>> {
  const { data } = await supabase.from(table).select('id, status').eq('id', id).maybeSingle();
  if (data && data.status !== 'draft') return ok({ id });
  return fail('conflict', (await getTranslations('errors'))('conflict'));
}

export const isUniqueViolation = (error: { code?: string } | null | undefined) => error?.code === '23505';
