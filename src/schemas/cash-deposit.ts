import { z } from 'zod';
import { boundedDecimal, isoDateField, optionalText } from './common';

// "Deposit cash to bank" input, shared by the modal and the server actions. Money is text (never a
// float). Messages are `errors.field.*` keys. `post_cash_deposit` is the authority on the date, the
// period lock and closed days.

export const cashDepositSchema = z.object({
  date: isoDateField,
  /** NUMERIC(14,2), more than zero. */
  amount: boundedDecimal(14, 2, 'money_invalid').refine((v) => /[1-9]/.test(v), 'money_positive'),
  /** Bank slip / reference as written on the paying-in slip. */
  reference: optionalText(60),
  note: optionalText(500),
});

export const cancelCashDepositSchema = z.object({
  id: z.uuid('id_invalid'),
  // Kept in the audit trail beside the reversal.
  reason: z.string().trim().min(3, 'reason_required').max(200, 'text_long'),
});

export type CashDepositInput = z.input<typeof cashDepositSchema>;
