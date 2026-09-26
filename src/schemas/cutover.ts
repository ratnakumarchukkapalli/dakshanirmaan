import { z } from 'zod';
import { boundedDecimal, isoDateField, positiveQty } from './common';

// Cutover input, shared by the screen and the server actions. Money and quantities are text (never a
// float). Messages are `errors.field.*` keys. `post_opening_balances` is the authority on every rule
// (party type, money accounts, transit godown, existing stock, period lock, the balancing figure).

const positiveMoney = boundedDecimal(14, 2, 'money_invalid').refine((v) => /[1-9]/.test(v), 'money_positive');
const positiveRate = boundedDecimal(14, 4, 'rate_invalid').refine((v) => /[1-9]/.test(v), 'rate_invalid');

export const openingPartyLineSchema = z.object({
  partyId: z.uuid('id_invalid'),
  side: z.enum(['receivable', 'payable'], 'type_invalid'),
  amount: positiveMoney,
});

export const openingMoneyLineSchema = z.object({
  accountId: z.uuid('id_invalid'),
  amount: positiveMoney,
});

export const openingStockLineSchema = z.object({
  itemId: z.uuid('id_invalid'),
  warehouseId: z.uuid('id_invalid'),
  qty: positiveQty,
  rate: positiveRate,
});

export const removeOpeningLineSchema = z.object({ id: z.uuid('id_invalid') });

export const importOpeningStockSchema = z.object({
  csv: z.string().min(1, 'request_invalid').max(200_000, 'text_long'),
});

export const postOpeningSchema = z.object({
  date: isoDateField,
  /** The balancing figure the screen showed (positive = credited to Opening Balance Equity; may be negative). */
  expectedEquity: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'money_invalid'),
});

export const cancelOpeningSchema = z.object({
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
});
