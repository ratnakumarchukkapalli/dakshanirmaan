import 'server-only';
import { one, rows } from '@/lib/db';
import { addDecimal, decimalText, negateDecimal, signOf, subtractDecimal } from '@/lib/decimal';
import { todayIn } from '@/lib/format';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);

export interface Employee {
  id: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  monthlySalary: string | null;
  dailyWage: string | null;
  /** Positive = the employee owes us that much of advance. */
  advance: string;
  /** Positive = we owe the employee that much. */
  payable: string;
}

export interface MoneyAccount { id: string; name: string; systemKey: string | null }

export interface StaffList {
  employees: Employee[];
  accounts: MoneyAccount[];
  today: string;
  /** First of the current month (ISO). */
  monthStart: string;
  tiles: { salaryBill: string; advances: string; paidThisMonth: string; salaried: number; wageWorkers: number };
}

const toEmployee = (r: Record<string, unknown>): Employee => ({
  id: r.party_id as string, name: r.name as string, phone: (r.phone as string | null) ?? null, isActive: !!r.is_active,
  monthlySalary: r.monthly_salary === null || r.monthly_salary === undefined ? null : d2(r.monthly_salary),
  dailyWage: r.daily_wage === null || r.daily_wage === undefined ? null : d2(r.daily_wage),
  advance: d2(r.advance_balance), payable: d2(r.payable_balance),
});

async function moneyAccounts(supabase: Supabase): Promise<MoneyAccount[]> {
  const res = await supabase.from('accounts').select('id, name, system_key').eq('is_money', true).eq('is_group', false).order('code');
  return rows(res, 'money accounts').map((a) => ({ id: a.id as string, name: a.name as string, systemKey: (a.system_key as string | null) ?? null }));
}

const PAGE = 1000;
const MAX_PAGES = 20;
const LEDGER_COLS = 'line_id, entry_id, entry_no, source_id, entry_date, doc_no, voucher_type, period_month, account_key, narration, debit, credit, advance_balance, payable_balance';

const toLedgerRow = (r: Record<string, unknown>): EmployeeLedgerRow => ({
  key: r.line_id as string, entryId: r.entry_id as string, entryNo: Number(r.entry_no), sourceId: (r.source_id as string | null) ?? null, date: r.entry_date as string, docNo: (r.doc_no as string | null) ?? null,
  voucherType: (r.voucher_type as EmployeeLedgerRow['voucherType']) ?? null, periodMonth: (r.period_month as string | null) ?? null,
  accountKey: r.account_key as EmployeeLedgerRow['accountKey'], narration: (r.narration as string | null) ?? null,
  debit: d2(r.debit), credit: d2(r.credit), advanceBalance: d2(r.advance_balance), payableBalance: d2(r.payable_balance),
});

/** Ledger lines of every salary/wage entry (originals and their reversals) dated within [from, to]. */
async function loadPayrollLedgerRows(supabase: Supabase, from: string, to: string): Promise<EmployeeLedgerRow[]> {
  const out: EmployeeLedgerRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('v_employee_ledger')
      .select(LEDGER_COLS)
      .in('voucher_type', ['salary', 'wages'])
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: true })
      .order('entry_no', { ascending: true })
      .order('line_no', { ascending: true })
      .order('line_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`payroll ledger: ${error.message}`);
    out.push(...(data ?? []).map(toLedgerRow));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

/** The staff list, tiles and pickers. Owner-only: v_employees returns nothing to anyone else. */
export async function loadStaffList(supabase: Supabase): Promise<StaffList> {
  const org = one(await supabase.from('organization').select('timezone').maybeSingle(), 'organization');
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');
  const monthStart = `${today.slice(0, 7)}-01`;

  const [empRes, accounts, paidRows] = await Promise.all([
    supabase.from('v_employees').select('party_id, name, phone, is_active, monthly_salary, daily_wage, advance_balance, payable_balance').order('name'),
    moneyAccounts(supabase),
    loadPayrollLedgerRows(supabase, monthStart, today),
  ]);
  const employees = rows(empRes, 'employees').map(toEmployee);

  const active = employees.filter((e) => e.isActive);
  const sum = (parts: (string | null)[]) => parts.reduce<string>((s, p) => (p ? (addDecimal(s, p, 2) ?? s) : s), '0.00');
  const paidThisMonth = netPaid(paidRows);
  return {
    employees, accounts, today, monthStart,
    tiles: {
      salaryBill: sum(active.map((e) => e.monthlySalary)),
      advances: sum(employees.map((e) => (signOf(e.advance) === 1 ? e.advance : null))),
      paidThisMonth,
      salaried: active.filter((e) => e.monthlySalary && signOf(e.monthlySalary) === 1).length,
      wageWorkers: active.filter((e) => e.dailyWage && signOf(e.dailyWage) === 1).length,
    },
  };
}

export interface EmployeeLedgerRow {
  key: string;
  entryId: string;
  /** `journal_entries.entry_no`: orders the entries of one document (the original, then its reversal). */
  entryNo: number;
  /** `journal_entries.source_id`: the voucher. A cancel posts a second entry with the SAME source (the view has no is_reversal column). */
  sourceId: string | null;
  date: string;
  docNo: string | null;
  voucherType: 'expense' | 'advance' | 'salary' | 'wages' | null;
  periodMonth: string | null;
  accountKey: 'employee_advance' | 'salary_payable';
  narration: string | null;
  debit: string;
  credit: string;
  advanceBalance: string;
  payableBalance: string;
}

export interface EmployeeLedger {
  employee: Employee;
  rows: EmployeeLedgerRow[];
  accounts: MoneyAccount[];
  today: string;
  truncated: boolean;
}

/** One employee's ledger (`v_employee_ledger`) plus their summary row. Null when there is no such employee (or the caller is not an owner). */
export async function loadEmployeeLedger(supabase: Supabase, id: string): Promise<EmployeeLedger | null> {
  const empRes = await supabase
    .from('v_employees')
    .select('party_id, name, phone, is_active, monthly_salary, daily_wage, advance_balance, payable_balance')
    .eq('party_id', id)
    .maybeSingle();
  const e = one(empRes, 'employee');
  if (!e) return null;

  const out: EmployeeLedgerRow[] = [];
  let truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from('v_employee_ledger')
      .select(LEDGER_COLS)
      .eq('party_id', id)
      .order('entry_date', { ascending: true })
      .order('entry_no', { ascending: true })
      .order('line_no', { ascending: true })
      .order('line_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`employee ledger: ${error.message}`);
    for (const r of data ?? []) {
      out.push(toLedgerRow(r));
    }
    if ((data?.length ?? 0) < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const org = one(await supabase.from('organization').select('timezone').maybeSingle(), 'organization');
  return { employee: toEmployee(e), rows: out, accounts: await moneyAccounts(supabase), today: todayIn(org?.timezone ?? 'Asia/Kolkata'), truncated };
}

/** One line per voucher, as the owner reads it: what was given, what was paid, what was recovered. */
export interface VoucherLine {
  key: string;
  /** True for the mirror entry a cancellation posts: every figure on it is negated so it nets the original out. */
  reversal: boolean;
  date: string;
  docNo: string | null;
  voucherType: EmployeeLedgerRow['voucherType'];
  periodMonth: string | null;
  /** Salary or wages: the gross that was earned (a plain advance has none). */
  gross: string | null;
  /** Salary or wages: what actually left the till (gross less the advance recovered). */
  paid: string | null;
  /** Advance handed over (advance debited). */
  advanceGiven: string;
  /** Advance recovered out of a salary or wage (advance credited). */
  advanceRecovered: string;
  advanceBalance: string;
  payableBalance: string;
}

const zero = '0.00';
const plus = (a: string, b: string) => addDecimal(a, b, 2) ?? a;

/**
 * Entries that are cancellations. `v_employee_ledger` does not say which entry is a reversal, but a
 * cancel posts its mirror entry against the SAME source document, so within one source the first entry
 * (lowest entry_no) is the original and any later one is a reversal. The narration ("Reversal of ...")
 * is a second, weaker signal for a row whose original is not in the loaded window.
 * TODO (when a cancel UI exists): expose `journal_entries.reversed_by`/an is_reversal column in the view.
 */
function reversalEntries(rows: EmployeeLedgerRow[]): Set<string> {
  const first = new Map<string, number>();
  for (const r of rows) {
    if (r.sourceId === null) continue;
    const seen = first.get(r.sourceId);
    if (seen === undefined || r.entryNo < seen) first.set(r.sourceId, r.entryNo);
  }
  const out = new Set<string>();
  for (const r of rows) {
    const later = r.sourceId !== null && r.entryNo > (first.get(r.sourceId) ?? r.entryNo);
    if (later || /^reversal of /i.test(r.narration ?? '')) out.add(r.entryId);
  }
  return out;
}

/**
 * Folds the per-account ledger lines of each journal entry into one line per voucher. A salary posts
 * three lines (payable raised, payable settled, advance recovered): the owner wants "salary 18,000,
 * 3,500 recovered, 14,500 paid", not the plumbing. The figures are the view's own, only added up
 * within one entry; balances are the last line's running balance. A reversal entry (a cancelled voucher)
 * mirrors the original with debits and credits swapped, so it is folded with every figure negated and
 * flagged `reversal`; original + reversal then sum to zero instead of showing a second salary.
 */
export function summariseVouchers(rows: EmployeeLedgerRow[]): VoucherLine[] {
  const out: VoucherLine[] = [];
  const index = new Map<string, VoucherLine>();
  const reversals = reversalEntries(rows);
  for (const r of rows) {
    const sign = reversals.has(r.entryId) ? negateDecimal : (x: string) => x;
    let v = index.get(r.entryId);
    if (!v) {
      v = {
        key: r.entryId, reversal: reversals.has(r.entryId), date: r.date, docNo: r.docNo, voucherType: r.voucherType, periodMonth: r.periodMonth,
        gross: null, paid: null, advanceGiven: zero, advanceRecovered: zero, advanceBalance: r.advanceBalance, payableBalance: r.payableBalance,
      };
      index.set(r.entryId, v);
      out.push(v);
    }
    if (r.accountKey === 'employee_advance') {
      // Original: given = debit, recovered = credit. Reversal (swapped lines): given = -credit, recovered = -debit.
      if (v.reversal) {
        v.advanceGiven = plus(v.advanceGiven, sign(r.credit));
        v.advanceRecovered = plus(v.advanceRecovered, sign(r.debit));
      } else {
        v.advanceGiven = plus(v.advanceGiven, r.debit);
        v.advanceRecovered = plus(v.advanceRecovered, r.credit);
      }
    } else {
      // The payable is raised (credit) and settled (debit) inside the same entry: the credit is the gross earned
      // (negated on a reversal, whose credit is the original's settlement).
      v.gross = plus(v.gross ?? zero, sign(r.credit));
    }
    v.advanceBalance = r.advanceBalance;
    v.payableBalance = r.payableBalance;
  }
  for (const v of out) if (v.gross !== null) v.paid = subtractDecimal(v.gross, v.advanceRecovered, 2);
  return out.filter((v) => !(v.gross === null && signOf(v.advanceGiven) === 0 && signOf(v.advanceRecovered) === 0));
}

/**
 * Net cash actually paid out on salary and wage vouchers: gross less the advance recovered (the
 * ledger row's "paid"), with a cancelled voucher's reversal netting its original out.
 */
export function netPaid(rows: EmployeeLedgerRow[]): string {
  return summariseVouchers(rows).reduce((s, v) => (v.paid !== null && (v.voucherType === 'salary' || v.voucherType === 'wages') ? plus(s, v.paid) : s), zero);
}
