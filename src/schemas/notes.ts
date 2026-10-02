import { z } from 'zod';
import { blankToUndefined, boundedDecimal, isoDateField, noControlChars } from './common';

// Credit and debit note input, shared by the note form and the server actions. Money and quantities
// are strings (never floats); messages are `errors.field.*` keys. The wire date is ISO. The same
// shape serves both notes: a credit note is against a sales invoice, a debit note against a purchase bill.

const positive = (v: string) => /[1-9]/.test(v);

export const NOTE_KINDS = ['credit', 'debit'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const MAX_NOTE_LINES = 100;

export const noteLineSchema = z.object({
  /** The invoice (or bill) line this note line reverses or adjusts. */
  againstLineId: z.uuid('line_required'),
  // Base unit (kg for TMT). NUMERIC(12,3).
  qty: boundedDecimal(12, 3, 'qty_invalid').refine(positive, 'qty_positive'),
  // Only a value-only note uses it (the amount per unit); a return takes its value from the invoice, so it is ignored there.
  rate: z.preprocess(blankToUndefined, boundedDecimal(14, 4, 'rate_invalid').optional()),
});

export const saveDraftNoteSchema = z
  .object({
    kind: z.enum(NOTE_KINDS),
    /** Present = update this draft; absent = create one. */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form loaded; a different one in the database means someone else saved first. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    /** The posted invoice (credit note) or bill (debit note) this note is against. */
    invoiceId: z.uuid('invoice_required'),
    noteDate: isoDateField,
    reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long').refine(noControlChars, 'text_invalid'),
    /** True = goods go back (stock moves); false = a value-only adjustment (rate difference, discount). */
    stockEffect: z.boolean(),
    lines: z.array(noteLineSchema).min(1, 'lines_required').max(MAX_NOTE_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
    v.lines.forEach((l, i) => {
      if (!v.stockEffect && (l.rate === undefined || !positive(l.rate))) {
        ctx.addIssue({ code: 'custom', path: ['lines', i, 'rate'], message: 'rate_positive' });
      }
    });
    // One note line per invoice line (the database refuses a second one too).
    const seen = new Set<string>();
    v.lines.forEach((l, i) => {
      if (seen.has(l.againstLineId)) ctx.addIssue({ code: 'custom', path: ['lines', i, 'againstLineId'], message: 'line_duplicate' });
      seen.add(l.againstLineId);
    });
  });

export const noteIdSchema = z.object({ kind: z.enum(NOTE_KINDS), id: z.uuid('id_invalid') });

export const cancelNoteSchema = z.object({
  kind: z.enum(NOTE_KINDS),
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long').refine(noControlChars, 'text_invalid'),
});

export type SaveDraftNoteInput = z.input<typeof saveDraftNoteSchema>;
export type NoteLineInput = z.input<typeof noteLineSchema>;
