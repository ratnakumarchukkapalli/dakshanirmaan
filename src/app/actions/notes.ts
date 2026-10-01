'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult, type Failure } from '@/lib/action-result';
import { requireAdminMember } from '@/lib/auth/require';
import { todayIn } from '@/lib/format';
import { NOTE_CONFIG } from '@/lib/notes-types';
import { createClient } from '@/lib/supabase/server';
import { cancelNoteSchema, noteIdSchema, saveDraftNoteSchema, type NoteKind } from '@/schemas/notes';

// Credit notes (against a sales invoice) and debit notes (against a purchase bill). OWNER-ONLY,
// drafts included: the database lets only an owner write, post or cancel a note. Drafts go through
// the user-scoped client (RLS allows them only while status = 'draft'). Posting and cancelling are
// thin wrappers around the database functions, which derive the actor from the session and are the
// only place any tax, total, round-off or stock cost is computed. Nothing here calculates money.

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

const POST_FUNCTION = { credit: 'post_credit_note', debit: 'post_debit_note' } as const satisfies Record<NoteKind, string>;

function revalidateNote(kind: NoteKind, id: string, invoiceId?: string | null) {
  const cfg = NOTE_CONFIG[kind];
  revalidatePath(cfg.invoiceBase);
  revalidatePath(`${cfg.base}/${id}`);
  revalidatePath(`${cfg.base}/${id}/view`);
  if (invoiceId) revalidatePath(`${cfg.invoiceBase}/${invoiceId}/view`);
}

/** After a post or a cancel the books move: balances, stock, the dashboard and the reports. */
function revalidateAfterPosting(kind: NoteKind, id: string, invoiceId?: string | null) {
  revalidateNote(kind, id, invoiceId);
  for (const p of ['/parties', '/stock', '/payments', '/reports', '/']) revalidatePath(p);
}

/** Creates or updates a draft note together with its lines. Returns the id and the new `updated_at`. */
export async function saveDraftNote(input: unknown): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = saveDraftNoteSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;
  const cfg = NOTE_CONFIG[v.kind];

  const supabase = await createClient();

  const { data: org, error: orgError } = await supabase.from('organization').select('timezone, state_code').maybeSingle();
  if (orgError) return dbFailure(orgError);
  if (v.noteDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('note_date_future');

  // The invoice (bill) must be posted: a note corrects a posted document, never a draft or a cancelled one.
  const { data: inv, error: invError } = await supabase
    .from(cfg.invoice).select('id, status, party_id, place_of_supply, invoice_date').eq('id', v.invoiceId).maybeSingle();
  if (invError) return dbFailure(invError);
  if (!inv) return bad(v.kind === 'credit' ? 'no_such_invoice' : 'no_such_bill');
  if (inv.status !== 'posted') return bad('invoice_not_posted');
  if (v.noteDate < (inv.invoice_date as string)) return bad('note_before_invoice');

  // Every note line must point at a line of THIS invoice; its item and snapshot come from there.
  const { data: invLines, error: invLinesError } = await supabase
    .from(cfg.invoiceLines).select('id, item_id, item_name, hsn_code, uom, rate, gst_rate').eq('invoice_id', v.invoiceId);
  if (invLinesError) return dbFailure(invLinesError);
  const byId = new Map((invLines ?? []).map((l) => [l.id as string, l]));
  for (const l of v.lines) if (!byId.has(l.againstLineId)) return bad('line_not_on_invoice');

  // The existing draft, when editing: it must still be a draft, and it stays against the same invoice.
  let previousLines: Record<string, unknown>[] = [];
  if (v.id) {
    const { data: head, error } = await supabase.from(cfg.note).select('id, status, against_invoice_id').eq('id', v.id).maybeSingle();
    if (error) return dbFailure(error);
    if (!head) return bad('no_such_note');
    if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));
    if (head.against_invoice_id !== v.invoiceId) return bad('note_invoice_locked');
    const { data: old, error: linesError } = await supabase.from(cfg.lines).select('*').eq('note_id', v.id);
    if (linesError) return dbFailure(linesError);
    previousLines = old ?? [];
  }

  const header = {
    note_date: v.noteDate,
    party_id: inv.party_id,
    // Set to something valid and overwritten at posting: a credit note takes the invoice's place of supply,
    // a debit note (an inward document) our own state. The database decides again; the client is never trusted.
    place_of_supply: v.kind === 'credit' ? inv.place_of_supply : org?.state_code,
    against_invoice_id: v.invoiceId,
    reason: v.reason,
    stock_effect: v.stockEffect,
  };
  const lineRows = (noteId: string) =>
    v.lines.map((l, i) => {
      const src = byId.get(l.againstLineId)!;
      return {
        note_id: noteId, line_no: i + 1, item_id: src.item_id, against_line_id: l.againstLineId,
        // Snapshot columns: the posted note is read from these. The database re-reads them from the invoice
        // line at posting and computes taxable value and tax; a return's rate is the invoice's, a value-only rate is the person's.
        item_name: src.item_name, hsn_code: src.hsn_code, uom: src.uom, gst_rate: src.gst_rate,
        qty: l.qty, rate: v.stockEffect ? src.rate : l.rate, taxable_value: 0,
      };
    });

  let noteId: string;
  let updatedAt: string;

  if (v.id) {
    // Stale write guard: only the version the form loaded may be replaced.
    const { data: updated, error } = await supabase
      .from(cfg.note).update(header).eq('id', v.id).eq('status', 'draft').eq('updated_at', v.expectedUpdatedAt!).select('id, updated_at');
    if (error) return dbFailure(error);
    if (!updated?.length) return fail('conflict', (await getTranslations('errors'))('conflict'));
    noteId = v.id;
    updatedAt = updated[0]!.updated_at as string;

    // Replace the lines. There is no single database call for this, so if the new lines are
    // refused, the previous ones are put back.
    const { error: delError } = await supabase.from(cfg.lines).delete().eq('note_id', noteId);
    if (delError) return dbFailure(delError);
    const { error: insError } = await supabase.from(cfg.lines).insert(lineRows(noteId));
    if (insError) {
      const restore = previousLines.map((l) => {
        const rest = { ...l };
        delete rest.id;
        delete rest.created_at;
        return rest;
      });
      if (restore.length) {
        const { error: restoreError } = await supabase.from(cfg.lines).insert(restore);
        if (restoreError) {
          console.error('[notes] could not restore draft lines after a failed save:', restoreError.message);
          return fail('partial', (await getTranslations('errors'))('partial'));
        }
      }
      return dbFailure(insError);
    }
  } else {
    const { data: created, error } = await supabase
      .from(cfg.note).insert({ ...header, status: 'draft', created_by: gate.member.userId }).select('id, updated_at').single();
    if (error) return dbFailure(error);
    noteId = created.id as string;
    updatedAt = created.updated_at as string;

    const { error: insError } = await supabase.from(cfg.lines).insert(lineRows(noteId));
    if (insError) {
      // Do not leave an empty draft behind.
      await supabase.from(cfg.note).delete().eq('id', noteId);
      return dbFailure(insError);
    }
  }

  // No revalidatePath here, for the same reason as the invoice form: the address bar already says
  // <base>/<id> after the first save, and re-rendering the current route would swap the form for the
  // edit page and throw away what the person is looking at.
  return ok({ id: noteId, updatedAt });
}

/** Throws away a draft note (a posted note is never deleted; it is cancelled). */
export async function deleteDraftNote(input: unknown): Promise<ActionResult> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = noteIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { kind, id } = parsed.data;
  const cfg = NOTE_CONFIG[kind];

  const supabase = await createClient();
  const { data, error } = await supabase.from(cfg.note).delete().eq('id', id).eq('status', 'draft').select('id, against_invoice_id');
  if (error) return dbFailure(error);
  if (!data?.length) return fail('not_draft', (await getTranslations('errors'))('not_draft'));

  revalidatePath(cfg.invoiceBase);
  if (data[0]!.against_invoice_id) revalidatePath(`${cfg.invoiceBase}/${data[0]!.against_invoice_id}/view`);
  return ok();
}

/** Posts a draft note: the database numbers it, works out every figure, and moves the books and the stock. */
export async function postNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = noteIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { kind, id } = parsed.data;

  const supabase = await createClient();
  const { data: head, error: headError } = await supabase.from(NOTE_CONFIG[kind].note).select('status, against_invoice_id').eq('id', id).maybeSingle();
  if (headError) return dbFailure(headError);
  if (!head) return bad('no_such_note');
  if (head.status !== 'draft') return fail('not_draft', (await getTranslations('errors'))('not_draft'));

  const { error } = await supabase.rpc(POST_FUNCTION[kind], { p_note_id: id });
  if (error) return dbFailure(error);

  revalidateAfterPosting(kind, id, head.against_invoice_id as string | null);
  return ok({ id });
}

/** Cancels a posted note by reversal (the database refuses it when a later note stands, the month is locked, or later stock moved). */
export async function cancelNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = cancelNoteSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { kind, id, reason } = parsed.data;
  const cfg = NOTE_CONFIG[kind];

  const supabase = await createClient();
  const { data: head } = await supabase.from(cfg.note).select('against_invoice_id').eq('id', id).maybeSingle();
  const { error } = await supabase.rpc('cancel_document', { p_source_type: cfg.source, p_source_id: id, p_reason: reason });
  if (error) {
    const failure = await dbFailure(error);
    // On a note this code means other stock moved after it, not "not enough stock": the remedy is to cancel the later documents first.
    if (failure.code === 'negative_stock') return fail('negative_stock', (await getTranslations('errors'))('validation.note_cancel_stock_moved'));
    return failure;
  }

  revalidateAfterPosting(kind, id, (head?.against_invoice_id as string | null | undefined) ?? null);
  return ok({ id });
}
