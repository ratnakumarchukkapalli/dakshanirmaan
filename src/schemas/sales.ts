import { z } from 'zod';
import { GSTIN_PATTERN } from '@/lib/gst';
import { blankToUndefined, boundedDecimal, decimal, noControlChars, optionalText, stateField } from './common';

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

export const TRANSPORT_MODES = ['road', 'rail', 'air', 'ship'] as const;

// Transport details, on the draft and (after posting) through record_invoice_ewb. The database
// checks the same shapes again. Vehicle numbers are kept in capitals (AP 16 TC 4455).
const transportFields = {
  vehicleNo: z.preprocess(
    blankToUndefined,
    z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9 -]{4,20}$/, 'vehicle_invalid')).optional(),
  ),
  transporterName: optionalText(120),
  transportMode: z.preprocess(blankToUndefined, z.enum(TRANSPORT_MODES, 'transport_mode_invalid').optional()),
  distanceKm: z.preprocess(
    blankToUndefined,
    z.string().trim().regex(/^\d{1,4}$/, 'distance_invalid').refine((v) => Number(v) <= 5000, 'distance_invalid').optional(),
  ),
  transporterGstin: z.preprocess(
    blankToUndefined,
    z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(GSTIN_PATTERN, 'gstin_invalid')).optional(),
  ),
};

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
    ...transportFields,
    lines: z.array(invoiceLineSchema).min(1, 'lines_required').max(MAX_INVOICE_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
  });

// E-way bill facts recorded on a posted invoice. The number and its two dates go together.
export const recordEwbSchema = z
  .object({
    id: z.uuid('id_invalid'),
    ...transportFields,
    ewbNo: z.preprocess(blankToUndefined, z.string().trim().regex(/^\d{12}$/, 'ewb_no_invalid').optional()),
    ewbDate: z.preprocess(blankToUndefined, isoDate.optional()),
    ewbValidUntil: z.preprocess(blankToUndefined, isoDate.optional()),
  })
  .superRefine((v, ctx) => {
    const given = [v.ewbNo, v.ewbDate, v.ewbValidUntil].filter((x) => x !== undefined).length;
    if (given !== 0 && given !== 3) ctx.addIssue({ code: 'custom', path: ['ewbNo'], message: 'ewb_incomplete' });
    else if (v.ewbDate && v.ewbValidUntil && v.ewbValidUntil < v.ewbDate) ctx.addIssue({ code: 'custom', path: ['ewbValidUntil'], message: 'ewb_dates' });
  });

export const invoiceIdSchema = z.object({ id: z.uuid('id_invalid') });

export const postInvoiceSchema = z.object({ id: z.uuid('id_invalid'), overrideCredit: z.boolean().optional() });

export const postCashSaleSchema = z.object({ id: z.uuid('id_invalid'), accountId: z.uuid('account_required') });

export const cancelInvoiceSchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long').refine(noControlChars, 'text_invalid'),
});

export type RecordEwbInput = z.input<typeof recordEwbSchema>;
export type SaveDraftInput = z.input<typeof saveDraftSchema>;
export type SaveDraftOutput = z.output<typeof saveDraftSchema>;
export type InvoiceLineInput = z.input<typeof invoiceLineSchema>;
