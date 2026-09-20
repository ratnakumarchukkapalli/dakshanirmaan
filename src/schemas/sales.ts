import { z } from 'zod';
import { blankToUndefined, boundedDecimal, decimal, optionalText, stateField } from './common';

// Sales invoice input, shared by the billing form and the server actions. Money and quantities
// are strings (never floats); messages are `errors.field.*` keys. The wire date is ISO.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_invalid')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'date_invalid');

const positive = (v: string) => /[1-9]/.test(v);

export const invoiceLineSchema = z.object({
  itemId: z.uuid('item_required'),
  // Base unit (kg for TMT). NUMERIC(12,3).
  qty: boundedDecimal(12, 3, 'qty_invalid').refine(positive, 'qty_positive'),
  // The second unit (pieces) as shown to the customer, when the item has one.
  altQty: z.preprocess(blankToUndefined, boundedDecimal(12, 3, 'qty_invalid').optional()),
  // NUMERIC(14,4)
  rate: boundedDecimal(14, 4, 'rate_invalid'),
  // NUMERIC(5,2), 0-100; blank means 0.
  discountPct: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? '0' : v),
    decimal(2, 'discount_invalid').refine((v) => Number(v) <= 100, 'discount_invalid'),
  ),
});

export const MAX_INVOICE_LINES = 100;

export const saveDraftSchema = z
  .object({
    /** Present = update this draft; absent = create one. */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form loaded; a different one in the database means someone else saved first. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    partyId: z.uuid('party_required'),
    invoiceDate: isoDate,
    placeOfSupply: stateField,
    /** A delivery site (one of the party's addresses); blank = ship to the billing address. */
    siteId: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    // Vehicle numbers are kept in capitals (AP 16 TC 4455) however they were typed.
    vehicleNo: z.preprocess(blankToUndefined, z.string().trim().max(20, 'text_long').transform((v) => v.toUpperCase()).optional()),
    transporterName: optionalText(80),
    lines: z.array(invoiceLineSchema).min(1, 'lines_required').max(MAX_INVOICE_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
  });

export const invoiceIdSchema = z.object({ id: z.uuid('id_invalid') });

export const postInvoiceSchema = z.object({ id: z.uuid('id_invalid'), overrideCredit: z.boolean().optional() });

export const postCashSaleSchema = z.object({ id: z.uuid('id_invalid'), accountId: z.uuid('account_required') });

export const cancelInvoiceSchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
});

export type SaveDraftInput = z.input<typeof saveDraftSchema>;
export type SaveDraftOutput = z.output<typeof saveDraftSchema>;
export type InvoiceLineInput = z.input<typeof invoiceLineSchema>;
