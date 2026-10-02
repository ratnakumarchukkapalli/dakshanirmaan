import { z } from 'zod';
import { blankToUndefined, isoDateField, optionalText } from './common';

// Bank statement import and matching input, shared by the screens and the server actions. Money
// travels as two-decimal strings (never a float); messages are `errors.field.*` keys. The database
// (`import_bank_statement`, `match_bank_line`, …) is the authority on every rule behind these shapes.

/** A statement amount: whole rupees then exactly two decimals, as the parser writes it. */
const amount = z.string('money_invalid').regex(/^\d{1,12}\.\d{2}$/, 'money_invalid');
/** The running balance after a line: same, but an overdraft may make it negative. */
const balance = z.string('bank_balance_invalid').regex(/^-?\d{1,12}\.\d{2}$/, 'bank_balance_invalid');

export const MAX_STATEMENT_LINES = 5000;

/** One parsed row, as `parseHdfcStatement` returns it (the browser parses; the server only receives lines). */
export const parsedLineSchema = z.object({
  lineNo: z.number().int().min(1),
  txnDate: isoDateField,
  valueDate: isoDateField.nullable(),
  narration: z.string().max(1000, 'text_long'),
  reference: z.string().max(64, 'text_long').nullable(),
  /** A reference token the parser found in the narration; used only when the Chq/Ref column was empty. */
  refHint: z.string().max(64, 'text_long').nullable().optional(),
  debit: amount,
  credit: amount,
  balance,
  kind: z.enum(['charge', 'other']).optional(),
});

export const importBankStatementSchema = z.object({
  fileName: z.string().trim().min(1, 'bank_file_required').max(200, 'text_long'),
  lines: z.array(parsedLineSchema).min(1, 'bank_lines_required').max(MAX_STATEMENT_LINES, 'bank_lines_many'),
});

export const statementIdSchema = z.object({ statementId: z.uuid('id_invalid') });
export const bankLineIdSchema = z.object({ lineId: z.uuid('id_invalid') });
export const matchBankLineSchema = z.object({ lineId: z.uuid('id_invalid'), entryId: z.uuid('id_invalid') });
export const matchLineToPaymentSchema = z.object({ lineId: z.uuid('id_invalid'), paymentId: z.uuid('id_invalid') });
export const ignoreBankLineSchema = z.object({
  lineId: z.uuid('id_invalid'),
  reason: z.string().trim().min(1, 'reason_required').max(200, 'text_long'),
});

/** Books a bank debit nobody recorded (a charge, a fee) as an expense paid from the bank. Date and amount come from the stored line. */
export const bookBankExpenseSchema = z.object({
  lineId: z.uuid('id_invalid'),
  /** Absent = the Bank Charges ledger. */
  accountId: z.preprocess(blankToUndefined, z.uuid('account_required').optional()),
  note: optionalText(120),
});

export type ImportBankStatementInput = z.input<typeof importBankStatementSchema>;
export type BookBankExpenseInput = z.input<typeof bookBankExpenseSchema>;
