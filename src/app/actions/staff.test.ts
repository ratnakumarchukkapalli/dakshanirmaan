import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { createEmployee, recordAdvance, recordSalary, recordWages, updateEmployee } from './staff';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const EMP = '11111111-1111-4111-8111-111111111111';
const PAY = '22222222-2222-4222-8222-222222222222';
const EXP = '33333333-3333-4333-8333-333333333333';
const VOUCHER = '44444444-4444-4444-8444-444444444444';

function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table ?? call.rpc}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata', state_code: '37' }] };
      case 'parties:select': return { data: [{ id: EMP, type: 'employee', is_active: true }] };
      case 'accounts:select': return { data: call.filters.some(([c]) => c === 'id') ? [{ id: PAY, is_money: true }] : [{ id: EXP, is_group: false }] };
      case 'expense_vouchers:insert': return { data: [{ id: VOUCHER }] };
      case 'parties:insert': return { data: [{ id: EMP }] };
      case 'parties:update': return { data: [{ id: EMP }] };
      default: return { data: [], error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);
const accountFilter = () => state.calls.filter((c) => c.table === 'accounts').flatMap((c) => c.filters);

const base = { id: VOUCHER, voucherDate: '2026-09-20', payAccountId: PAY };

describe('recordAdvance', () => {
  it('saves an advance voucher on the employee-advance ledger, then posts it', async () => {
    reset(asAdmin());
    healthy();
    const res = await recordAdvance({ ...base, employeeId: EMP, amount: '2000', note: 'festival' });
    expect(res).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ voucher_type: 'advance', party_id: EMP, pay_account_id: PAY, status: 'draft', advance_recovered: null, period_month: null });
    expect(accountFilter()).toContainEqual(['system_key', 'employee_advance']);
    expect(find('expense_voucher_lines', 'insert')!.payload).toMatchObject({ voucher_id: VOUCHER, account_id: EXP, amount: '2000', narration: 'festival' });
    expect(rpc('post_expense_voucher')!.payload).toEqual({ p_voucher_id: VOUCHER });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/staff', `/staff/${EMP}`]));
  });

  it('is owner-only, even for an amount a counter user could post in the database', async () => {
    for (const member of [asCounter(), asAdmin('aal1')]) {
      reset(member);
      healthy();
      expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(state.calls).toHaveLength(0);
    }
  });

  it('refuses a party that is not an active employee', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'parties' ? { data: [{ id: EMP, type: 'customer', is_active: true }] } : undefined));
    expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, error: 'validation.invalid_party' });
    expect(find('expense_vouchers', 'insert')).toBeUndefined();
  });

  it('refuses a non-money pay account and a future date', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'accounts' && c.filters.some(([f]) => f === 'id') ? { data: [{ id: PAY, is_money: false }] } : undefined));
    expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, error: 'validation.invalid_account' });
    healthy();
    expect(await recordAdvance({ ...base, voucherDate: '2999-01-01', employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, error: 'validation.doc_date_future' });
  });

  it('a refused post removes the draft and maps the database message', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_expense_voucher' ? dbError('DN_PERIOD_LOCKED') : undefined));
    expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, code: 'period_locked' });
    expect(find('expense_vouchers', 'delete')!.filters).toContainEqual(['id', VOUCHER]);
  });
});

describe('idempotent retry (client draft id)', () => {
  it('the draft is inserted with the client id', async () => {
    reset(asAdmin());
    healthy();
    await recordAdvance({ ...base, employeeId: EMP, amount: '500' });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ id: VOUCHER });
  });

  it('the same id twice: the second call answers with the posted voucher and posts nothing again', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000' })).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(state.calls.filter((c) => c.rpc === 'post_expense_voucher')).toHaveLength(1);
    state.calls.length = 0;
    // The database now holds the posted voucher under that id.
    healthy((c) => (c.table === 'expense_vouchers' && c.op === 'select' ? { data: [{ id: VOUCHER, status: 'posted' }] } : undefined));
    expect(await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000' })).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(state.calls.filter((c) => c.rpc === 'post_expense_voucher')).toHaveLength(0);
    expect(state.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('a leftover draft under the id (the earlier call died) is cleared and the call starts fresh', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'expense_vouchers' && c.op === 'select' ? { data: [{ id: VOUCHER, status: 'draft' }] } : undefined));
    expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(find('expense_vouchers', 'delete')!.filters).toContainEqual(['id', VOUCHER]);
    expect(state.calls.filter((c) => c.rpc === 'post_expense_voucher')).toHaveLength(1);
  });

  it('losing the primary-key race to a call that is still in flight is a conflict, not a second posting', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'expense_vouchers' && c.op === 'insert' ? dbError('duplicate key value', '23505') : undefined));
    expect(await recordAdvance({ ...base, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(state.calls.filter((c) => c.rpc === 'post_expense_voucher')).toHaveLength(0);
  });

  it('a request without an id is refused', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordAdvance({ voucherDate: '2026-09-20', payAccountId: PAY, employeeId: EMP, amount: '500' })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('recordSalary', () => {
  it('sets the salary month to the first of the month and leaves recovery to the database when blank', async () => {
    reset(asAdmin());
    healthy();
    await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000', advanceRecovered: '' });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ voucher_type: 'salary', period_month: '2026-09-01', advance_recovered: null });
    expect(accountFilter()).toContainEqual(['system_key', 'salaries']);
  });

  it('passes an explicit recovery through', async () => {
    reset(asAdmin());
    healthy();
    await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000', advanceRecovered: '1000' });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ advance_recovered: '1000' });
  });

  it('maps a recovery larger than the advance', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_expense_voucher' ? dbError('DN_VALIDATION:recovery_exceeds_advance') : undefined));
    expect(await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000', advanceRecovered: '99999' }))
      .toMatchObject({ ok: false, code: 'validation', error: 'validation.recovery_exceeds_advance' });
  });

  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await recordSalary({ ...base, employeeId: EMP, month: '2026-09', amount: '18000' })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('recordWages', () => {
  it('an unnamed casual is a plain wages voucher on Loading & Unloading, days x rate to the paisa', async () => {
    reset(asAdmin());
    healthy();
    await recordWages({ ...base, employeeId: '', days: '6', rate: '600' });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ voucher_type: 'wages', party_id: null, advance_recovered: null });
    expect(accountFilter()).toContainEqual(['system_key', 'loading_unloading']);
    expect(find('expense_voucher_lines', 'insert')!.payload).toMatchObject({ amount: '3600.00', narration: '6 days x 600' });
  });

  it('a named worker recovers no advance unless asked to', async () => {
    reset(asAdmin());
    healthy();
    await recordWages({ ...base, employeeId: EMP, days: '5.5', rate: '600' });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({ party_id: EMP, advance_recovered: '0.00' });
    expect(find('expense_voucher_lines', 'insert')!.payload).toMatchObject({ amount: '3300.00' });
  });

  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await recordWages({ ...base, days: '1', rate: '600' })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('createEmployee / updateEmployee', () => {
  it('creates an employee party in the organisation state with its pay rates', async () => {
    reset(asAdmin());
    healthy();
    const res = await createEmployee({ name: 'Suribabu', phone: '98765 43210', monthlySalary: '18000', dailyWage: '' });
    expect(res).toEqual({ ok: true, data: { id: EMP } });
    expect(find('parties', 'insert')!.payload).toEqual({ name: 'Suribabu', type: 'employee', state_code: '37', phone: '9876543210', monthly_salary: '18000', daily_wage: null });
  });

  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await createEmployee({ name: 'X' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await updateEmployee({ id: EMP, name: 'X' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });

  it('updates only employee parties', async () => {
    reset(asAdmin());
    healthy();
    expect(await updateEmployee({ id: EMP, name: 'Suribabu K', monthlySalary: '19000' })).toEqual({ ok: true, data: null });
    const u = find('parties', 'update')!;
    expect(u.payload).toEqual({ name: 'Suribabu K', phone: null, monthly_salary: '19000', daily_wage: null });
    expect(u.filters).toContainEqual(['type', 'employee']);
    healthy((c) => (c.op === 'update' ? { data: [] } : undefined));
    expect(await updateEmployee({ id: EMP, name: 'X' })).toMatchObject({ ok: false, error: 'validation.no_such_party' });
  });
});

describe('the salary schema runs twice (form, then action)', () => {
  it('a value the form produced is accepted again by the action', async () => {
    const { salarySchema } = await import('@/schemas/staff');
    const once = salarySchema.parse({ ...base, employeeId: EMP, month: '2026-09', amount: '18000' });
    expect(salarySchema.safeParse(once).success).toBe(true);
  });
});
