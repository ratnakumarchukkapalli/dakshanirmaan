import { z } from 'zod';
import { isPhone, normalisePhone } from '@/lib/phone';
import { blankToUndefined, boundedDecimal, decimal, isoDateField, noControlChars } from './common';

// Employees and their pay vouchers (owner-only, like everything on the staff screen). Money is
// text with at most 2 decimals; the voucher amount is what the person says was paid, and
// `post_expense_voucher` is the authority on advance recovery and the journal.

const positiveMoney = boundedDecimal(14, 2, 'money_invalid').refine((v) => /[1-9]/.test(v), 'money_positive');
const optionalMoney = z.preprocess(blankToUndefined, boundedDecimal(14, 2, 'money_invalid').optional());

const phoneField = z.preprocess(
  (v) => blankToUndefined(typeof v === 'string' ? normalisePhone(v) : v),
  z.string().refine(isPhone, 'phone_invalid').optional(),
);

const employeeShape = {
  name: z.string().trim().min(1, 'name_required').max(80, 'name_long').refine(noControlChars, 'text_invalid'),
  phone: phoneField,
  /** Monthly salary, for a salaried person. Blank = none. */
  monthlySalary: optionalMoney,
  /** Daily wage, for a wage worker. Blank = none. */
  dailyWage: optionalMoney,
};

export const createEmployeeSchema = z.object(employeeShape);
export const updateEmployeeSchema = z.object({ id: z.uuid('id_invalid'), ...employeeShape });

const voucherBase = {
  /** Client-generated per modal open: the draft is inserted with it, so a retry cannot post a second voucher. */
  id: z.uuid('request_invalid'),
  voucherDate: isoDateField,
  payAccountId: z.uuid('account_required'),
};

export const advanceSchema = z.object({
  ...voucherBase,
  employeeId: z.uuid('employee_required'),
  amount: positiveMoney,
  note: z.preprocess(blankToUndefined, z.string().trim().max(120, 'text_long').refine(noControlChars, 'text_invalid').optional()),
});

/**
 * `YYYY-MM` from the month picker. Deliberately not transformed here: the schema runs twice (in the form,
 * then again in the action), so the value must be the same shape both times. The action adds the day.
 */
const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month_invalid');

export const salarySchema = z.object({
  ...voucherBase,
  employeeId: z.uuid('employee_required'),
  month: monthField,
  /** Gross salary for the month. */
  amount: positiveMoney,
  /** Blank = recover as much of the advance as the database allows (the smaller of the advance and the salary). */
  advanceRecovered: optionalMoney,
});

export const wagesSchema = z.object({
  ...voucherBase,
  /** Blank = unnamed casual labour (a plain expense voucher, no employee ledger). */
  employeeId: z.preprocess(blankToUndefined, z.uuid('employee_required').optional()),
  days: decimal(1, 'days_invalid').refine((v) => /[1-9]/.test(v), 'days_invalid'),
  rate: boundedDecimal(14, 2, 'money_invalid').refine((v) => /[1-9]/.test(v), 'money_positive'),
  /** A named worker's advance is recovered only when the person says so (blank = none). */
  advanceRecovered: optionalMoney,
  note: z.preprocess(blankToUndefined, z.string().trim().max(120, 'text_long').refine(noControlChars, 'text_invalid').optional()),
});

export type EmployeeInput = z.input<typeof createEmployeeSchema>;
export type AdvanceInput = z.input<typeof advanceSchema>;
export type SalaryInput = z.input<typeof salarySchema>;
export type WagesInput = z.input<typeof wagesSchema>;
