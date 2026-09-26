import 'server-only';
import { completeRows, one, rows } from '@/lib/db';
import {
  buildSalesWeek, lastDays, sortAttention, sumMoney,
  type AttentionRow, type SalesDay,
} from '@/lib/dashboard-math';
import { decimalText, signOf, subtractDecimal } from '@/lib/decimal';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);

/** A dashboard section either loaded or failed; one failing query never blanks the whole page. */
export type Section<T> = { ok: true; data: T } | { ok: false };

/** Runs a loader; a failure is logged on the server and becomes a visible error state, never an empty one. */
export async function settle<T>(name: string, load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (e) {
    console.error(`[dashboard] ${name} failed:`, e instanceof Error ? e.message : e);
    return { ok: false };
  }
}

export const WEEK_DAYS = 7;

export interface SalesWeekData {
  today: string;
  days: SalesDay[];
  /** Draft invoices waiting to be posted (any date). */
  drafts: number;
}

/** Today and the six days before it, from the two sales views; drafts counted separately. */
export async function loadSalesWeek(supabase: Supabase, today: string): Promise<SalesWeekData> {
  const days = lastDays(today, WEEK_DAYS);
  const from = days[0]!;
  const [dailyRes, catRes, draftRes] = await Promise.all([
    supabase.from('v_sales_daily').select('sale_date, invoice_count, billed_total, round_off').gte('sale_date', from).lte('sale_date', today),
    supabase.from('v_sales_daily_category').select('sale_date, category, amount').gte('sale_date', from).lte('sale_date', today),
    supabase.from('sales_invoices').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
  ]);
  const daily = rows<{ sale_date: string; invoice_count: number; billed_total: number; round_off: number }>(dailyRes, 'sales by day');
  const byCategory = rows<{ sale_date: string; category: string; amount: number }>(catRes, 'sales by category');
  if (draftRes.error) throw new Error(`draft invoices: ${draftRes.error.message}`);
  return { today, days: buildSalesWeek(days, daily, byCategory), drafts: draftRes.count ?? 0 };
}

export interface Balances {
  /** What customers owe us in total (the receivables control balance). */
  toCollect: string;
  /** Owner-only; null for a counter session, which never selects it. */
  toPay: string | null;
  suppliersOwed: number | null;
}

export async function loadBalances(supabase: Supabase, isAdmin: boolean): Promise<Balances> {
  const res = await supabase.from('v_party_balances').select(isAdmin ? 'ar_balance, ap_balance' : 'ar_balance', { count: 'exact' });
  const list = completeRows<{ ar_balance: number; ap_balance?: number }>(res, 'party balances');
  return {
    toCollect: sumMoney(list.map((r) => r.ar_balance)),
    toPay: isAdmin ? sumMoney(list.map((r) => r.ap_balance)) : null,
    suppliersOwed: isAdmin ? list.filter((r) => signOf(d2(r.ap_balance)) === 1).length : null,
  };
}

export interface Attention {
  /** Every row, most urgent first. */
  rows: AttentionRow[];
  overdue: { parties: number; amount: string };
  lowStock: { count: number; names: string[] };
}

export async function loadAttention(supabase: Supabase): Promise<Attention> {
  const res = await supabase
    .from('v_attention')
    .select('kind, severity, subject_type, subject_id, title, detail, due_date, amount, interest', { count: 'exact' });
  const list = sortAttention(completeRows<AttentionRow>(res, 'attention'));
  const overdue = list.filter((r) => r.kind === 'overdue_party');
  const low = list.filter((r) => r.kind === 'low_stock');
  let names: string[] = [];
  const ids = low.map((r) => r.subject_id).filter((x): x is string => !!x);
  if (ids.length) {
    const nameRes = await supabase.from('items').select('id, name').in('id', ids);
    const byId = new Map(rows<{ id: string; name: string }>(nameRes, 'low-stock item names').map((i) => [i.id, i.name]));
    names = ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
  }
  return {
    rows: list,
    overdue: { parties: overdue.length, amount: sumMoney(overdue.map((r) => r.amount)) },
    lowStock: { count: low.length, names },
  };
}

export interface CashBank {
  total: string;
  /** The cash drawer's own balance, when a cash account exists. */
  cash: string | null;
}

/** Owner only: `v_money_balances` returns nothing to a counter session and is never queried for one. */
export async function loadCashBank(supabase: Supabase): Promise<CashBank> {
  const res = await supabase.from('v_money_balances').select('system_key, balance', { count: 'exact' });
  const list = completeRows<{ system_key: string | null; balance: number }>(res, 'cash and bank balances');
  const cash = list.find((r) => r.system_key === 'cash');
  return { total: sumMoney(list.map((r) => r.balance)), cash: cash ? d2(cash.balance) : null };
}

export interface StockValue {
  onHand: string;
  inTransit: string;
}

/** Owner only (cost). Real godowns and the in-transit godown, each summed exactly. */
export async function loadStockValue(supabase: Supabase): Promise<StockValue> {
  const [onHandRes, transitRes] = await Promise.all([
    supabase.from('v_stock_summary').select('value', { count: 'exact' }),
    supabase.from('v_stock_summary_all').select('value', { count: 'exact' }).eq('is_transit', true),
  ]);
  return {
    onHand: sumMoney(completeRows<{ value: number }>(onHandRes, 'stock value').map((r) => r.value)),
    inTransit: sumMoney(completeRows<{ value: number }>(transitRes, 'stock in transit').map((r) => r.value)),
  };
}

/** Owner only. Debits minus credits over every ledger account; zero when the books balance. */
export async function loadBooksDifference(supabase: Supabase): Promise<string> {
  const res = await supabase.from('v_trial_balance').select('total_debit, total_credit', { count: 'exact' });
  const list = completeRows<{ total_debit: number; total_credit: number }>(res, 'trial balance');
  const diff = subtractDecimal(sumMoney(list.map((r) => r.total_debit)), sumMoney(list.map((r) => r.total_credit)), 2);
  if (diff === null) throw new Error('trial balance: totals are not decimal');
  return diff;
}

export interface DayCloseStatus {
  /** The most recent posted day close, if there is one. */
  last: { date: string; difference: string } | null;
}

export async function loadDayClose(supabase: Supabase): Promise<DayCloseStatus> {
  const res = await supabase
    .from('day_closes')
    .select('close_date, difference')
    .eq('status', 'posted')
    .order('close_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = one<{ close_date: string; difference: number }>(res, 'day close');
  return { last: row ? { date: row.close_date, difference: d2(row.difference) } : null };
}
