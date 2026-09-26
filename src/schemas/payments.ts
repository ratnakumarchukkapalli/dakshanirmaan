import { z } from 'zod';
import { compareDecimal } from '@/lib/decimal';
import { blankToUndefined, boundedDecimal, decimal } from './common';

// Receipt / outgoing payment input, shared by the payment form and the server actions. Money
// travels as strings (never floats); messages are `errors.field.*` keys. The wire date is ISO.
// Allocation caps are display-only here — `post_payment` re-validates every one under the
// payment's row lock and is the only authority on what an invoice can actually absorb.

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_invalid')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'date_invalid');

export const PAYMENT_MODES = ['cash', 'upi', 'neft', 'cheque', 'bank'] as const;
export const PAYMENT_DIRECTIONS = ['receipt', 'payment'] as const;

export const paymentAllocationSchema = z.object({
  invoiceType: z.enum(['sales_invoice', 'purchase_invoice']),
  invoiceId: z.uuid('id_invalid'),
  // NUMERIC(14,2), > 0 — a zero-amount allocation row is pointless and the DB's own check
  // would only ever see it as noise.
  amount: boundedDecimal(14, 2, 'money_invalid').refine((v) => compareDecimal(v, '0.00', 2) === 1, 'money_invalid'),
});

export const MAX_ALLOCATIONS = 100;

export const saveDraftPaymentSchema = z
  .object({
    /** Present = update this draft; absent = create one. */
    id: z.preprocess(blankToUndefined, z.uuid('id_invalid').optional()),
    /** The `updated_at` the form loaded; a different one in the database means someone else saved first. */
    expectedUpdatedAt: z.preprocess(blankToUndefined, z.string().max(40).optional()),
    direction: z.enum(PAYMENT_DIRECTIONS),
    partyId: z.uuid('payment_party_required'),
    paymentDate: isoDate,
    mode: z.enum(PAYMENT_MODES, 'mode_invalid'),
    // Cheque no. (mode = cheque) or UPI/NEFT reference — same free-text column either way.
    instrumentNo: z.preprocess(blankToUndefined, z.string().trim().max(40, 'text_long').optional()),
    instrumentDate: z.preprocess(blankToUndefined, isoDate.optional()),
    chequeBank: z.preprocess(blankToUndefined, z.string().trim().max(60, 'text_long').optional()),
    amount: boundedDecimal(14, 2, 'money_invalid').refine((v) => compareDecimal(v, '0.00', 2) === 1, 'money_invalid'),
    // Admin-only at post time (the database's own rule); accepted from anyone at draft time,
    // same as the invoice form accepts a credit override at draft time and the DB decides later.
    discount: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? '0' : v),
      decimal(2, 'money_invalid'),
    ),
    accountId: z.uuid('account_required'),
    note: z.preprocess(blankToUndefined, z.string().trim().max(200, 'text_long').optional()),
    allocations: z.array(paymentAllocationSchema).max(MAX_ALLOCATIONS, 'lines_many'),
  })
  .superRefine((v, ctx) => {
    if (v.id && !v.expectedUpdatedAt) ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: 'stale_version_missing' });
    if (v.mode === 'cheque' && !v.instrumentNo) ctx.addIssue({ code: 'custom', path: ['instrumentNo'], message: 'instrument_required' });
  });

export const paymentIdSchema = z.object({ id: z.uuid('id_invalid') });

export const bounceChequeSchema = z.object({
  id: z.uuid('id_invalid'),
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
});

export const cancelPaymentSchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
});

export type SaveDraftPaymentInput = z.input<typeof saveDraftPaymentSchema>;
export type SaveDraftPaymentOutput = z.output<typeof saveDraftPaymentSchema>;
export type PaymentAllocationInput = z.input<typeof paymentAllocationSchema>;
