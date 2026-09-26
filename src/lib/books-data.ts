import 'server-only';
import { rows } from '@/lib/db';
import { addDecimal, decimalText, negateDecimal, signOf, subtractDecimal } from '@/lib/decimal';
import type { Gstr1Data } from '@/lib/gstr1-file';
import type { createClient } from '@/lib/supabase/server';

// Loaders for the self-audit screens (change 18): the three statements and the two GST returns.
// Every figure is the database's (`trial_balance_asat`, `pnl_range`, `balance_sheet_asat`, `gstr1_data`,
// `gstr3b_summary`); this file only splits a closing into debit/credit columns and adds the columns up
// with exact decimals for the footer and the "agrees" chip.

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);
const sum = (values: string[]) => values.reduce((acc, v) => addDecimal(acc, v, 2) ?? acc, '0.00');

export interface TrialBalanceRow { code: string; name: string; type: string; debit: string; credit: string }
export interface TrialBalance { rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string; balanced: boolean }

export async function loadTrialBalance(supabase: Supabase, asAt: string): Promise<TrialBalance> {
  const res = await supabase.rpc('trial_balance_asat', { p_date: asAt });
  const list = rows<Record<string, unknown>>(res, 'trial balance').map((r) => {
    const closing = d2(r.closing);
    const side = signOf(closing);
    return {
      code: String(r.code), name: String(r.name), type: String(r.account_type),
      debit: side === 1 ? closing : '0.00',
      credit: side === -1 ? (negateDecimal(closing) ?? '0.00') : '0.00',
    };
  }).filter((r) => signOf(r.debit) !== 0 || signOf(r.credit) !== 0);
  const totalDebit = sum(list.map((r) => r.debit));
  const totalCredit = sum(list.map((r) => r.credit));
  return { rows: list, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

export interface StatementRow { code: string | null; name: string; amount: string; isProfit?: boolean }
export interface Pnl { income: StatementRow[]; expenses: StatementRow[]; totalIncome: string; totalExpenses: string; net: string }

export async function loadPnl(supabase: Supabase, from: string, to: string): Promise<Pnl> {
  const res = await supabase.rpc('pnl_range', { p_from: from, p_to: to });
  const all = rows<Record<string, unknown>>(res, 'profit and loss').map((r) => ({ type: String(r.account_type), code: String(r.code), name: String(r.name), amount: d2(r.amount) }));
  const income = all.filter((r) => r.type === 'income');
  const expenses = all.filter((r) => r.type === 'expense');
  const totalIncome = sum(income.map((r) => r.amount));
  const totalExpenses = sum(expenses.map((r) => r.amount));
  return { income, expenses, totalIncome, totalExpenses, net: subtractDecimal(totalIncome, totalExpenses, 2) ?? '0.00' };
}

export interface BalanceSheet {
  assets: StatementRow[]; liabilities: StatementRow[]; equity: StatementRow[];
  totalAssets: string; totalLiabilities: string; totalEquity: string; totalLiabilitiesEquity: string; balanced: boolean;
}

export async function loadBalanceSheet(supabase: Supabase, asAt: string): Promise<BalanceSheet> {
  const res = await supabase.rpc('balance_sheet_asat', { p_date: asAt });
  const all = rows<Record<string, unknown>>(res, 'balance sheet').map((r) => ({
    section: String(r.section), code: (r.code as string | null) ?? null, name: String(r.name), amount: d2(r.amount), isProfit: r.is_current_profit === true,
  }));
  const pick = (s: string): StatementRow[] => all.filter((r) => r.section === s).map(({ code, name, amount, isProfit }) => ({ code, name, amount, isProfit }));
  const assets = pick('asset'); const liabilities = pick('liability'); const equity = pick('equity');
  const totalAssets = sum(assets.map((r) => r.amount));
  const totalLiabilities = sum(liabilities.map((r) => r.amount));
  const totalEquity = sum(equity.map((r) => r.amount));
  const totalLiabilitiesEquity = sum([totalLiabilities, totalEquity]);
  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, totalLiabilitiesEquity, balanced: totalAssets === totalLiabilitiesEquity };
}

export async function loadGstr1(supabase: Supabase, period: string): Promise<Gstr1Data> {
  const res = await supabase.rpc('gstr1_data', { p_month: `${period}-01` });
  if (res.error) throw new Error(`gstr1: ${res.error.message}`);
  return res.data as Gstr1Data;
}

export interface Gstr3bRow { key: string; taxable: string; igst: string; cgst: string; sgst: string }

export async function loadGstr3b(supabase: Supabase, period: string): Promise<Gstr3bRow[]> {
  const res = await supabase.rpc('gstr3b_summary', { p_month: `${period}-01` });
  return rows<Record<string, unknown>>(res, 'gstr3b').map((r) => ({
    key: String(r.row_key), taxable: d2(r.taxable), igst: d2(r.igst), cgst: d2(r.cgst), sgst: d2(r.sgst),
  }));
}
