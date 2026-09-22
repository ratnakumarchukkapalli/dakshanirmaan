'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { isVerifiedAdmin, requireAdmin, requireMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { bounceChequeSchema, paymentIdSchema, saveDraftPaymentSchema } from '@/schemas/payments';

// Receipts and outgoing payments: drafts are written by any active member (RLS allows
// insert/update/delete only while status = 'draft'); posting and the cheque-lifecycle actions are
// thin wrappers around the database, which derives the actor from the session, re-checks every
// role gate independently, and is the only place money moves or a voucher number is assigned.
// Nothing here calculates an allocation cap — the form's caps are a preview, `post_payment`'s are
// the truth.

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

function revalidatePayments() {
  revalidatePath('/payments');
  revalidatePath('/payments/new');
}

/** Creates or updates a draft receipt/payment together with its allocations. */
export async function saveDraftPayment(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = saveDraftPaymentSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();

  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  if (v.paymentDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('payment_date_future');

  if (v.id) {
    const { data: head } = await supabase.from('payments').select('id, status').eq('id', v.id).maybeSingle();
    if (!head) return bad('no_such_payment');
    if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
  }

  const { data: party } = await supabase.from('parties').select('id, type, is_active').eq('id', v.partyId).maybeSingle();
  if (!party) return bad('invalid_party');
  const wantType = v.direction === 'receipt' ? ['customer', 'both'] : ['supplier', 'both'];
  if (!wantType.includes(party.type as string)) return bad('invalid_party');

  const { data: account } = await supabase.from('accounts').select('id, is_money').eq('id', v.accountId).maybeSingle();
  if (!account?.is_money) return bad('invalid_account');

  const header = {
    direction: v.direction,
    payment_date: v.paymentDate,
    party_id: v.partyId,
    mode: v.mode,
    instrument_no: v.instrumentNo ?? null,
    instrument_date: v.instrumentDate ?? null,
    cheque_bank: v.chequeBank ?? null,
    amount: v.amount,
    discount: v.discount,
    account_id: v.accountId,
  };
  const allocRows = (paymentId: string) =>
    v.allocations.map((a) => ({ payment_id: paymentId, invoice_type: a.invoiceType, invoice_id: a.invoiceId, amount: a.amount }));

  let paymentId: string;
  let updatedAt: string;

  if (v.id) {
    const { data: updated, error } = await supabase
      .from('payments').update(header)
      .eq('id', v.id).eq('status', 'draft').eq('updated_at', v.expectedUpdatedAt!)
      .select('id, updated_at');
    if (error) return dbFailure(error);
    if (!updated?.length) return fail('conflict', (await getTranslations('errors'))('conflict'));
    paymentId = v.id;
    updatedAt = updated[0]!.updated_at as string;

    const { data: previous } = await supabase.from('payment_allocations').select('*').eq('payment_id', paymentId);
    const { error: delError } = await supabase.from('payment_allocations').delete().eq('payment_id', paymentId);
    if (delError) return dbFailure(delError);
    if (v.allocations.length) {
      const { error: insError } = await supabase.from('payment_allocations').insert(allocRows(paymentId));
      if (insError) {
        const restore = (previous ?? []).map((a) => {
          const rest = { ...a };
          delete rest.id;
          delete rest.created_at;
          return rest;
        });
        if (restore.length) {
          const { error: restoreError } = await supabase.from('payment_allocations').insert(restore);
          if (restoreError) {
            console.error('[payments] could not restore draft allocations after a failed save:', restoreError.message);
            return fail('partial', (await getTranslations('errors'))('partial'));
          }
        }
        return dbFailure(insError);
      }
    }
  } else {
    const { data: created, error } = await supabase
      .from('payments')
      .insert({ ...header, status: 'draft', created_by: gate.member.userId })
      .select('id, updated_at')
      .single();
    if (error) return dbFailure(error);
    paymentId = created.id as string;
    updatedAt = created.updated_at as string;

    if (v.allocations.length) {
      const { error: insError } = await supabase.from('payment_allocations').insert(allocRows(paymentId));
      if (insError) {
        // Do not leave an empty draft behind.
        await supabase.from('payments').delete().eq('id', paymentId);
        return dbFailure(insError);
      }
    }
  }

  // No revalidatePath here, same reasoning as saveDraftInvoice/saveDraftChallan: this runs mid-edit.
  return ok({ id: paymentId, updatedAt });
}

/**
 * Posts a draft receipt or payment. Outgoing payments (`direction = 'payment'`) and any payment
 * carrying a discount are admin-only — read directly off `post_payment`'s own role gate, checked
 * here first so a counter-staff session gets a clear refusal instead of a raw database error, and
 * re-checked by the database regardless of what this action decides.
 */
export async function postPayment(input: unknown): Promise<ActionResult<{ id: string; voucherNo: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = paymentIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data: draft } = await supabase.from('payments').select('direction, discount').eq('id', parsed.data.id).maybeSingle();
  if (!draft) return bad('no_such_payment');
  if ((draft.direction === 'payment' || Number(draft.discount) > 0) && !isVerifiedAdmin(gate.member)) {
    return fail('forbidden', (await getTranslations('errors'))('forbidden'));
  }

  const { error } = await supabase.rpc('post_payment', { p_payment_id: parsed.data.id });
  if (error) return dbFailure(error);

  const { data: posted } = await supabase.from('payments').select('voucher_no').eq('id', parsed.data.id).maybeSingle();

  revalidatePayments();
  return ok({ id: parsed.data.id, voucherNo: (posted?.voucher_no as string | null) ?? '' });
}

/** Deposits a received cheque: Dr bank / Cr cheques-in-hand. Any active member. */
export async function depositCheque(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = paymentIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('deposit_cheque', { p_payment_id: parsed.data.id });
  if (error) return dbFailure(error);

  revalidatePayments();
  return ok({ id: parsed.data.id });
}

/** Marks a cheque cleared: a status change only, no money moves. Any active member. */
export async function markCleared(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = paymentIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('mark_cheque_cleared', { p_payment_id: parsed.data.id });
  if (error) return dbFailure(error);

  revalidatePayments();
  return ok({ id: parsed.data.id });
}

/** Bounces a received cheque: reverses the receipt (and its deposit, if any), re-opens the invoices it settled. Admin only. */
export async function bounceCheque(input: unknown): Promise<ActionResult<{ id: string }>> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = bounceChequeSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('bounce_cheque', { p_payment_id: parsed.data.id, p_reason: parsed.data.reason });
  if (error) return dbFailure(error);

  revalidatePayments();
  return ok({ id: parsed.data.id });
}
