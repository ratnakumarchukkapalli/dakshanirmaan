import 'server-only';
import { one, rows } from '@/lib/db';
import { addDecimal, decimalText, signOf, subtractDecimal } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import { NOTE_CONFIG, type NoteFormContext, type NoteSourceInvoice, type NoteSourceLine } from '@/lib/notes-types';
import type { createClient } from '@/lib/supabase/server';
import type { NoteKind } from '@/schemas/notes';

type Supabase = Awaited<ReturnType<typeof createClient>>;

const dec = (v: unknown, dp: number) => decimalText(v as number | string | null, dp);

/** a - b, never below zero (a posted total can only be a hint here; the database is the check). */
function remaining(total: string, used: string, dp: number): string {
  const diff = subtractDecimal(total, used, dp);
  if (diff === null || signOf(diff) <= 0) return dec(0, dp);
  return diff;
}

/**
 * The posted invoice (or bill) a note is against, with each line's returnable quantity and
 * adjustable value. Returns null when it is missing or not posted. Only POSTED notes count: a draft or
 * cancelled note has taken nothing from the invoice. These numbers are hints for the form; the
 * posting function checks the same caps again under the invoice's lock.
 */
export async function loadNoteSource(supabase: Supabase, kind: NoteKind, invoiceId: string): Promise<NoteSourceInvoice | null> {
  const cfg = NOTE_CONFIG[kind];
  const headRes = await supabase
    .from(cfg.invoice)
    .select(kind === 'debit'
      ? 'id, invoice_no, invoice_date, status, grand_total, supplier_bill_no, party:parties(name, gstin)'
      : 'id, invoice_no, invoice_date, status, grand_total, party:parties(name, gstin)')
    .eq('id', invoiceId).maybeSingle();
  const head = one<{
    id: string; invoice_no: string | null; invoice_date: string; status: string; grand_total: number; supplier_bill_no?: string | null;
    party: { name: string; gstin: string | null } | null;
  }>(headRes, 'note source invoice');
  if (!head || head.status !== 'posted') return null;

  const [linesRes, notesRes, openRes] = await Promise.all([
    supabase.from(cfg.invoiceLines).select('id, line_no, item_id, item_name, hsn_code, uom, qty, taxable_value, gst_rate').eq('invoice_id', invoiceId).order('line_no'),
    supabase.from(cfg.note).select('id, stock_effect').eq('against_invoice_id', invoiceId).eq('status', 'posted'),
    supabase.from(cfg.open).select('open_amount').eq('invoice_id', invoiceId).maybeSingle(),
  ]);
  const invLines = rows<{ id: string; line_no: number; item_id: string; item_name: string; hsn_code: string; uom: string; qty: number; taxable_value: number; gst_rate: number }>(linesRes, 'note source lines');
  const posted = rows<{ id: string; stock_effect: boolean }>(notesRes, 'posted notes');
  const open = one<{ open_amount: number }>(openRes, 'open amount');

  // What posted notes already took from each line: returned quantity (goods notes only) and adjusted value (all notes).
  const returnedQty = new Map<string, string>();
  const adjusted = new Map<string, string>();
  if (posted.length) {
    const stockNotes = new Set(posted.filter((n) => n.stock_effect).map((n) => n.id));
    const noteLines = rows<{ note_id: string; against_line_id: string | null; qty: number; taxable_value: number }>(
      await supabase.from(cfg.lines).select('note_id, against_line_id, qty, taxable_value').in('note_id', posted.map((n) => n.id)),
      'posted note lines',
    );
    for (const nl of noteLines) {
      if (!nl.against_line_id) continue;
      adjusted.set(nl.against_line_id, addDecimal(adjusted.get(nl.against_line_id) ?? '0.00', dec(nl.taxable_value, 2), 2) ?? '0.00');
      if (stockNotes.has(nl.note_id)) returnedQty.set(nl.against_line_id, addDecimal(returnedQty.get(nl.against_line_id) ?? '0.000', dec(nl.qty, 3), 3) ?? '0.000');
    }
  }

  // TMT pieces: the item's second unit and bar weight (display only).
  const itemRes = await supabase.from('items').select('id, alt_uom, conversion_factor').in('id', [...new Set(invLines.map((l) => l.item_id))]);
  const alt = new Map(rows<{ id: string; alt_uom: string | null; conversion_factor: number | null }>(itemRes, 'note items').map((i) => [i.id, i]));

  const lines: NoteSourceLine[] = invLines.map((l) => {
    const item = alt.get(l.item_id);
    return {
      id: l.id, lineNo: l.line_no, itemId: l.item_id, itemName: l.item_name, hsn: l.hsn_code, uom: l.uom, gstRate: dec(l.gst_rate, 2),
      qty: dec(l.qty, 3), remainingQty: remaining(dec(l.qty, 3), returnedQty.get(l.id) ?? '0.000', 3),
      taxable: dec(l.taxable_value, 2), remainingTaxable: remaining(dec(l.taxable_value, 2), adjusted.get(l.id) ?? '0.00', 2),
      altUom: item?.alt_uom ?? null, factor: item?.conversion_factor == null ? null : dec(item.conversion_factor, 4),
    };
  });

  return {
    id: head.id, number: head.invoice_no ?? '—', date: head.invoice_date, partyName: head.party?.name ?? '—', partyGstin: head.party?.gstin ?? null,
    grandTotal: dec(head.grand_total, 2), openAmount: open ? dec(open.open_amount, 2) : null, supplierBillNo: head.supplier_bill_no ?? null, lines,
  };
}

/** The form context for a new note against `invoiceId`, or null when the invoice is missing or not posted. */
export async function loadNoteFormContext(supabase: Supabase, kind: NoteKind, invoiceId: string): Promise<NoteFormContext | null> {
  const [invoice, orgRes] = await Promise.all([loadNoteSource(supabase, kind, invoiceId), supabase.from('organization').select('timezone').maybeSingle()]);
  if (!invoice) return null;
  const org = one<{ timezone: string }>(orgRes, 'organisation');
  return { kind, invoice, today: todayIn(org?.timezone ?? 'Asia/Kolkata') };
}

export interface InvoiceNote {
  id: string;
  noteNo: string | null;
  date: string;
  status: string;
  grandTotal: string;
  stockEffect: boolean;
}

/** Every note against one invoice or bill, newest first: the "Credit notes" / "Debit notes" card on its view. */
export async function loadInvoiceNotes(supabase: Supabase, kind: NoteKind, invoiceId: string): Promise<InvoiceNote[]> {
  const cfg = NOTE_CONFIG[kind];
  const res = await supabase.from(cfg.note).select('id, note_no, note_date, status, grand_total, stock_effect')
    .eq('against_invoice_id', invoiceId).order('note_date', { ascending: false }).order('created_at', { ascending: false });
  return rows<{ id: string; note_no: string | null; note_date: string; status: string; grand_total: number; stock_effect: boolean }>(res, 'invoice notes')
    .map((n) => ({ id: n.id, noteNo: n.note_no, date: n.note_date, status: n.status, grandTotal: dec(n.grand_total, 2), stockEffect: n.stock_effect }));
}
