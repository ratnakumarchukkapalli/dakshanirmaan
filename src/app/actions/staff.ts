'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { afterIdCollision, claimDraftId, isUniqueViolation } from '@/lib/draft-claim';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdminMember } from '@/lib/auth/require';
import { multiplyDays } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';
import { advanceSchema, createEmployeeSchema, salarySchema, updateEmployeeSchema, wagesSchema } from '@/schemas/staff';

// Employees and their pay vouchers: OWNER-ONLY (owner decision 2026-09-21). The database agrees:
// salary/wage vouchers and the pay rates are unreadable to a counter user, `post_expense_voucher`
// refuses a counter user everything except advances up to Rs 5,000 (which have no screen here on
// purpose), and creating an employee is refused by the parties guard. Each voucher action saves the
// draft and posts it in one call; a refused post removes the draft again. The journal — including how
// much advance a salary recovers — is `post_expense_voucher`'s, not this file's.

type Supabase = Awaited<ReturnType<typeof createClient>>;
type Voucher = {
  /** The client's draft id: makes a retry idempotent (see `draft-claim.ts`). */
  id: string;
  voucherDate: string;
  employeeId: string | null;
  payAccountId: string;
  type: 'advance' | 'salary' | 'wages';
  /** system_key of the debit ledger: employee_advance for an advance, else the expense ledger. */
  expense: { systemKey: string };
  amount: string;
  narration: string | null;
  periodMonth: string | null;
  /** null = let the database recover the maximum. */
  advanceRecovered: string | null;
};

const bad = async (detail: string) => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

function revalidateStaff(employeeId: string | null) {
  revalidatePath('/staff');
  if (employeeId) revalidatePath(`/staff/${employeeId}`);
  revalidatePath('/');
}

async function recordVoucher(supabase: Supabase, userId: string, v: Voucher): Promise<ActionResult<{ id: string }>> {
  // A repeat of a call that already posted (lost response, double click): answer with the voucher it made.
  const claim = await claimDraftId(supabase, 'expense_vouchers', v.id);
  if (claim.kind === 'error') return dbFailure(claim.error);
  if (claim.kind === 'recorded') return ok({ id: v.id });

  const { data: org, error: orgError } = await supabase.from('organization').select('timezone').maybeSingle();
  if (orgError) return dbFailure(orgError);
  if (v.voucherDate > todayIn(org?.timezone ?? 'Asia/Kolkata')) return bad('doc_date_future');

  if (v.employeeId) {
    const { data: emp, error } = await supabase.from('parties').select('id, type, is_active').eq('id', v.employeeId).maybeSingle();
    if (error) return dbFailure(error);
    if (!emp || emp.type !== 'employee' || !emp.is_active) return bad('invalid_party');
  }

  const { data: pay, error: payError } = await supabase.from('accounts').select('id, is_money').eq('id', v.payAccountId).maybeSingle();
  if (payError) return dbFailure(payError);
  if (!pay || !pay.is_money) return bad('invalid_account');

  const { data: expense, error: accError } = await supabase.from('accounts').select('id, is_group').eq('system_key', v.expense.systemKey).maybeSingle();
  if (accError) return dbFailure(accError);
  if (!expense || expense.is_group) return bad('missing_account');

  const { error } = await supabase
    .from('expense_vouchers')
    .insert({
      id: v.id, voucher_date: v.voucherDate, party_id: v.employeeId, status: 'draft', voucher_type: v.type, pay_account_id: v.payAccountId,
      advance_recovered: v.advanceRecovered, period_month: v.periodMonth, created_by: userId,
    });
  if (error) return isUniqueViolation(error) ? afterIdCollision(supabase, 'expense_vouchers', v.id) : dbFailure(error);
  const id = v.id;

  const { error: lineError } = await supabase
    .from('expense_voucher_lines')
    .insert({ voucher_id: id, line_no: 1, account_id: expense.id, amount: v.amount, narration: v.narration });
  if (lineError) {
    await dropDraft(supabase, id);
    return dbFailure(lineError);
  }

  const { error: postError } = await supabase.rpc('post_expense_voucher', { p_voucher_id: id });
  if (postError) {
    await dropDraft(supabase, id);
    return dbFailure(postError);
  }
  return ok({ id });
}

async function dropDraft(supabase: Supabase, id: string) {
  const { error } = await supabase.from('expense_vouchers').delete().eq('id', id).eq('status', 'draft');
  if (error) console.error('[staff] could not remove the voucher draft after a failed post:', error.message);
}

export async function recordAdvance(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = advanceSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const res = await recordVoucher(await createClient(), gate.member.userId, {
    id: v.id, voucherDate: v.voucherDate, employeeId: v.employeeId, payAccountId: v.payAccountId, type: 'advance',
    expense: { systemKey: 'employee_advance' }, amount: v.amount, narration: v.note ?? null, periodMonth: null, advanceRecovered: null,
  });
  if (res.ok) revalidateStaff(v.employeeId);
  return res;
}

export async function recordSalary(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = salarySchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const res = await recordVoucher(await createClient(), gate.member.userId, {
    id: v.id, voucherDate: v.voucherDate, employeeId: v.employeeId, payAccountId: v.payAccountId, type: 'salary',
    // Found by system key (`salaries`, on account 5500), so renumbering the chart cannot misdirect a salary.
    expense: { systemKey: 'salaries' }, amount: v.amount, narration: `Salary ${v.month}`, periodMonth: `${v.month}-01`,
    advanceRecovered: v.advanceRecovered ?? null,
  });
  if (res.ok) revalidateStaff(v.employeeId);
  return res;
}

export async function recordWages(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = wagesSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  // days x rate is the person's own arithmetic made exact; the voucher records the amount paid.
  const amount = multiplyDays(v.days, v.rate);
  if (!amount || !/[1-9]/.test(amount)) return bad('invalid_amount');

  const res = await recordVoucher(await createClient(), gate.member.userId, {
    id: v.id, voucherDate: v.voucherDate, employeeId: v.employeeId ?? null, payAccountId: v.payAccountId, type: 'wages',
    expense: { systemKey: 'loading_unloading' }, amount,
    narration: v.note ?? `${v.days} days x ${v.rate}`, periodMonth: null,
    // A named worker's advance is recovered only when asked for; an unnamed casual has none.
    advanceRecovered: v.employeeId ? (v.advanceRecovered ?? '0.00') : null,
  });
  if (res.ok) revalidateStaff(v.employeeId ?? null);
  return res;
}

export async function createEmployee(input: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = createEmployeeSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data: org, error: orgError } = await supabase.from('organization').select('state_code').maybeSingle();
  if (orgError) return dbFailure(orgError);
  if (!org) return bad('missing_field');

  const { data, error } = await supabase
    .from('parties')
    .insert({
      name: v.name, type: 'employee', state_code: org.state_code, phone: v.phone ?? null,
      monthly_salary: v.monthlySalary ?? null, daily_wage: v.dailyWage ?? null,
    })
    .select('id')
    .single();
  if (error) return dbFailure(error);

  revalidatePath('/staff');
  return ok({ id: data.id as string });
}

export async function updateEmployee(input: unknown): Promise<ActionResult> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = updateEmployeeSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { id, ...v } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('parties')
    .update({ name: v.name, phone: v.phone ?? null, monthly_salary: v.monthlySalary ?? null, daily_wage: v.dailyWage ?? null })
    .eq('id', id)
    .eq('type', 'employee')
    .select('id');
  if (error) return dbFailure(error);
  if (!data?.length) return bad('no_such_party');

  revalidateStaff(id);
  return ok();
}
