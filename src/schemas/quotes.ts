import { z } from 'zod';
import { blankToUndefined, isoDateField, optionalText } from './common';
import { invoiceLineSchema, MAX_INVOICE_LINES } from './sales';

// Quotation input, shared by the quote form and the server actions. Same discipline as the
// invoice schemas: quantities, rates and discounts travel as strings (lines reuse
// `invoiceLineSchema`), the wire date is ISO, messages are `errors.field.*` keys. A quote has no
// tax or total on the wire: the database takes names, HSN and GST from the item master and
// computes every figure.

export const QUOTE_NOTE_MAX = 500;
export const QUOTE_STATUSES = ['open', 'accepted', 'expired'] as const;

export const saveQuoteSchema = z
  .object({
    /** Present = edit this quote; absent = create one (the number is given at the first save). */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form last read or was given back; the database refuses a stale one. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    partyId: z.uuid('party_required'),
    quoteDate: isoDateField,
    /** Blank = the database's default (quote date + 7 days). */
    validUntil: z.preprocess(blankToUndefined, isoDateField.optional()),
    note: optionalText(QUOTE_NOTE_MAX, 'text_long', true),
    lines: z.array(invoiceLineSchema).min(1, 'lines_required').max(MAX_INVOICE_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
    if (v.validUntil && v.validUntil < v.quoteDate) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'valid_until_before_date' });
  });

export const quoteIdSchema = z.object({ id: z.uuid('id_invalid') });

export const markQuoteSchema = z.object({
  id: z.uuid('id_invalid'),
  status: z.enum(QUOTE_STATUSES, 'status_invalid'),
});

export type SaveQuoteInput = z.input<typeof saveQuoteSchema>;
export type SaveQuoteOutput = z.output<typeof saveQuoteSchema>;
