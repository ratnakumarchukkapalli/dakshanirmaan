import { notFound, redirect } from 'next/navigation';
import { NoteForm } from '@/components/notes/NoteForm';
import { StaleDraft } from '@/components/notes/StaleDraft';
import { rows, one } from '@/lib/db';
import { decimalText } from '@/lib/decimal';
import { loadNoteFormContext } from '@/lib/notes-data';
import { NOTE_CONFIG, type NoteFormInitial } from '@/lib/notes-types';
import { createClient } from '@/lib/supabase/server';
import { rateText, trimZeros } from '@/lib/units';
import { isUuid } from '@/lib/uuid';
import type { NoteKind } from '@/schemas/notes';

/** `<base>/new?invoice=<id>`: a blank note against a posted invoice (credit note) or bill (debit note). */
export async function NewNoteScreen({ kind, invoiceId }: { kind: NoteKind; invoiceId: string | undefined }) {
  if (!invoiceId || !isUuid(invoiceId)) notFound();
  const ctx = await loadNoteFormContext(await createClient(), kind, invoiceId);
  if (!ctx) notFound();
  return <NoteForm ctx={ctx} />;
}

/** `<base>/<id>`: a draft note, editable. Once posted or cancelled a note is only ever viewed. */
export async function DraftNoteScreen({ kind, id }: { kind: NoteKind; id: string }) {
  const cfg = NOTE_CONFIG[kind];
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const [headRes, linesRes] = await Promise.all([
    supabase.from(cfg.note).select('id, status, updated_at, note_date, reason, stock_effect, against_invoice_id').eq('id', id).maybeSingle(),
    supabase.from(cfg.lines).select('against_line_id, qty, rate, line_no').eq('note_id', id).order('line_no'),
  ]);
  const head = one<{ id: string; status: string; updated_at: string; note_date: string; reason: string | null; stock_effect: boolean; against_invoice_id: string | null }>(headRes, 'draft note');
  if (!head) notFound();
  if (head.status !== 'draft') redirect(`${cfg.base}/${id}/view`);
  // Every note is made against a posted invoice or bill; a draft without one cannot be edited here.
  if (!head.against_invoice_id) notFound();
  const lines = rows<{ against_line_id: string | null; qty: number; rate: number }>(linesRes, 'draft note lines').filter((l) => l.against_line_id);

  const ctx = await loadNoteFormContext(supabase, kind, head.against_invoice_id);
  // The invoice was cancelled after this draft was saved: it can never be posted, so offer to throw it away.
  if (!ctx) return <StaleDraft kind={kind} id={id} invoiceId={head.against_invoice_id} />;

  const initial: NoteFormInitial = {
    id: head.id,
    updatedAt: head.updated_at,
    values: {
      noteDate: head.note_date,
      reason: head.reason ?? '',
      stockEffect: head.stock_effect,
      lines: lines.map((l) => ({
        againstLineId: l.against_line_id!,
        qty: trimZeros(decimalText(l.qty, 3)),
        // A return's rate is the invoice's own and is not shown; only a value-only note keeps the person's.
        rate: head.stock_effect ? '' : rateText(decimalText(l.rate, 4)),
      })),
    },
  };
  return <NoteForm ctx={ctx} initial={initial} />;
}
