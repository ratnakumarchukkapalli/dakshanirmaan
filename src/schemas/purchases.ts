import { z } from 'zod';
import { blankToUndefined, boundedDecimal, decimal, isoDateField, noControlChars } from './common';

// Purchase bill input, shared by the bill form and the server actions. Money and quantities are
// strings (never floats); messages are `errors.field.*` keys. The wire date is ISO.

const positive = (v: string) => /[1-9]/.test(v);

export const MAX_BILL_LINES = 100;

/** Letters, digits, spaces and / - . only; starts with a letter or digit. The one rule for a supplier's bill number. */
export const SUPPLIER_BILL_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 /\-.]*$/;

export const billLineSchema = z.object({
  itemId: z.uuid('item_required'),
  // Base unit (kg for TMT). NUMERIC(12,3).
  qty: boundedDecimal(12, 3, 'qty_invalid').refine(positive, 'qty_positive'),
  // The second unit (pieces) as the supplier's bill shows it, when the item has one.
  altQty: z.preprocess(blankToUndefined, boundedDecimal(12, 3, 'qty_invalid').optional()),
  // The supplier's rate, NUMERIC(14,4).
  rate: boundedDecimal(14, 4, 'rate_invalid'),
  // NUMERIC(5,2), 0-100; blank means 0.
  discountPct: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? '0' : v),
    decimal(2, 'discount_invalid').refine((v) => Number(v) <= 100, 'discount_invalid'),
  ),
});

export const saveDraftBillSchema = z
  .object({
    /** Present = update this draft; absent = create one. */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form loaded; a different one in the database means someone else saved first. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    partyId: z.uuid('supplier_required'),
    /** The day the goods and the bill came in (the books' date). */
    invoiceDate: isoDateField,
    /** The supplier's own bill number and date: what the tax credit is claimed against. */
    supplierBillNo: z.string().trim().min(1, 'supplier_bill_no_required').max(40, 'text_long')
      .regex(SUPPLIER_BILL_NO_PATTERN, 'supplier_bill_no_invalid'),
    supplierBillDate: isoDateField,
    /** Input tax credit can be claimed on this bill. When false the tax becomes part of the stock cost. */
    itcEligible: z.boolean(),
    lines: z.array(billLineSchema).min(1, 'lines_required').max(MAX_BILL_LINES, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
    // A supplier's bill cannot be dated after the day it was booked.
    if (v.supplierBillDate > v.invoiceDate) ctx.addIssue({ code: 'custom', path: ['supplierBillDate'], message: 'supplier_bill_after_receipt' });
  });

export const billIdSchema = z.object({ id: z.uuid('id_invalid') });

export const cancelBillSchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long').refine(noControlChars, 'text_invalid'),
});

export type SaveDraftBillInput = z.input<typeof saveDraftBillSchema>;
export type BillLineInput = z.input<typeof billLineSchema>;

/**
 * Freight on a posted bill, paid to a transport company that charges GST on reverse charge (a goods transport agency).
 * It is its own voucher, not a line on the bill. The amount is the freight charged, before tax; the database works out
 * the 5% (2.5 + 2.5) and refuses a transporter outside our own state.
 */
export const addFreightSchema = z.object({
  /** Client-generated per modal open: the voucher is inserted with it, so a retry cannot post a second one. */
  id: z.uuid('request_invalid'),
  billId: z.uuid('id_invalid'),
  voucherDate: isoDateField,
  transporterId: z.uuid('supplier_required'),
  amount: boundedDecimal(14, 2, 'money_invalid').refine(positive, 'money_positive'),
  payAccountId: z.uuid('account_required'),
  note: z.preprocess(blankToUndefined, z.string().trim().max(120, 'text_long').refine(noControlChars, 'text_invalid').optional()),
});
export type AddFreightInput = z.input<typeof addFreightSchema>;
