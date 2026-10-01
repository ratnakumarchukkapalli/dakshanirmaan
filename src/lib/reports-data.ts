import 'server-only';
import { completeRows, one, rows } from '@/lib/db';
import { sumMoney } from '@/lib/dashboard-math';
import { decimalText } from '@/lib/decimal';
import { moneyGap, pageCount, sameMoney } from '@/lib/reports-math';
import { containsPattern } from '@/lib/search';
import type { createClient } from '@/lib/supabase/server';

// Read side of the reports (change 15). Every figure is a stored view / function value; the only
// arithmetic is exact-decimal totals of the rows on screen. The same loaders feed the Excel
// exports, so a workbook always equals its screen. Each loader throws (naming the query) rather
// than returning a partial list: a total built from a truncated list would be wrong without
// looking wrong. A counter session never selects an owner-only column.

type Supabase = Awaited<ReturnType<typeof createClient>>;
const d2 = (v: unknown) => decimalText(v as number | string | null, 2);
const d3 = (v: unknown) => decimalText(v as number | string | null, 3);
const d4 = (v: unknown) => decimalText(v as number | string | null, 4);

/** PostgREST's row cap is 1000; ranges of ledger rows beyond it are refused, never shown partial. */
export const LEDGER_CAP = 1000;

// ---------------------------------------------------------------- day close

export interface DayCloseFigures {
  openingCash: string;
  cashIn: string;
  cashOut: string;
  deposited: string;
  expected: string;
}

export interface DayCloseRow {
  id: string;
  closeDate: string;
  expected: string;
  counted: string;
  difference: string;
  status: 'posted' | 'cancelled';
  note: string | null;
  closedByName: string | null;
  closedAt: string;
}

export interface DayCloseScreen {
  date: string;
  /** What closing the day would store (null when the date is already closed: the stored row speaks). */
  preview: DayCloseFigures;
  /** The live (not reopened) close of this date, if any. */
  live: DayCloseRow | null;
  recent: DayCloseRow[];
}

export const RECENT_CLOSES = 14;

const closeRow = (r: Record<string, unknown>, names: Map<string, string>): DayCloseRow => ({
  id: r.id as string,
  closeDate: r.close_date as string,
  expected: d2(r.expected),
  counted: d2(r.counted),
  difference: d2(r.difference),
  status: r.status as DayCloseRow['status'],
  note: (r.note as string | null) ?? null,
  closedByName: r.closed_by ? (names.get(r.closed_by as string) ?? null) : null,
  closedAt: r.closed_at as string,
});

export async function loadDayClose(supabase: Supabase, date: string): Promise<DayCloseScreen> {
  const [prevRes, closesRes, recentRes] = await Promise.all([
    supabase.rpc('day_close_preview', { p_date: date }),
    supabase
      .from('day_closes')
      .select('id, close_date, expected, counted, difference, status, note, closed_by, closed_at')
      .eq('close_date', date)
      .neq('status', 'cancelled')
      .maybeSingle(),
    supabase
      .from('day_closes')
      .select('id, close_date, expected, counted, difference, status, note, closed_by, closed_at')
      .neq('status', 'cancelled')
      .order('close_date', { ascending: false })
      .limit(RECENT_CLOSES),
  ]);
  const p = one<Record<string, unknown>>({ data: Array.isArray(prevRes.data) ? prevRes.data[0] : prevRes.data, error: prevRes.error }, 'day close preview');
  if (!p) throw new Error('day close preview: no figures returned');
  const live = one<Record<string, unknown>>(closesRes, 'day close');
  const recent = rows<Record<string, unknown>>(recentRes, 'recent day closes');

  // Who closed: app_users names are readable to members.
  const ids = [...new Set([...(live ? [live] : []), ...recent].map((r) => r.closed_by as string | null).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (ids.length) {
    const users = rows<{ user_id: string; name: string }>(await supabase.from('app_users').select('user_id, name').in('user_id', ids), 'closer names');
    for (const u of users) names.set(u.user_id, u.name);
  }
  return {
    date,
    preview: { openingCash: d2(p.opening_cash), cashIn: d2(p.cash_in), cashOut: d2(p.cash_out), deposited: d2(p.deposited), expected: d2(p.expected) },
    live: live ? closeRow(live, names) : null,
    recent: recent.map((r) => closeRow(r, names)),
  };
}

// ---------------------------------------------------------------- day book

export const DAY_BOOK_PAGE = 100;
/** Most rows one Excel export will write; a bigger range asks the user to narrow the dates. */
export const DAY_BOOK_EXPORT_CAP = 20000;

export const DAY_BOOK_TYPES = [
  'sales_invoice', 'purchase_invoice', 'payment', 'expense_voucher', 'delivery_challan',
  'stock_adjustment', 'day_close', 'credit_note', 'debit_note', 'cash_deposit', 'opening', 'manual',
] as const;
export type DayBookType = (typeof DAY_BOOK_TYPES)[number];
export const parseDayBookType = (raw: string | undefined): DayBookType | null =>
  (DAY_BOOK_TYPES as readonly string[]).includes(raw ?? '') ? (raw as DayBookType) : null;

export interface DayBookRow {
  entryId: string;
  date: string;
  entryNo: number | string;
  sourceType: string;
  docNo: string | null;
  narration: string | null;
  amount: string;
  isReversal: boolean;
  isReversed: boolean;
}

const dayBookRow = (r: Record<string, unknown>): DayBookRow => ({
  entryId: r.entry_id as string,
  date: r.entry_date as string,
  entryNo: r.entry_no as number | string,
  sourceType: r.source_type as string,
  docNo: (r.doc_no as string | null) ?? null,
  narration: (r.narration as string | null) ?? null,
  amount: d2(r.total_debit),
  isReversal: !!r.is_reversal,
  isReversed: !!r.is_reversed,
});

const DAY_BOOK_COLS = 'entry_id, entry_date, entry_no, source_type, doc_no, narration, total_debit, is_reversal, is_reversed';

export async function loadDayBook(
  supabase: Supabase,
  opts: { from: string; to: string; type: DayBookType | null; page: number },
): Promise<{ rows: DayBookRow[]; total: number; pages: number; page: number }> {
  const build = () => {
    let q = supabase.from('v_day_book').select(DAY_BOOK_COLS, { count: 'exact' }).gte('entry_date', opts.from).lte('entry_date', opts.to);
    if (opts.type) q = q.eq('source_type', opts.type);
    return q.order('entry_date', { ascending: true }).order('entry_no', { ascending: true });
  };
  // Count first so the requested page can be clamped to what exists.
  const head = await supabase
    .from('v_day_book').select('entry_id', { count: 'exact', head: true }).gte('entry_date', opts.from).lte('entry_date', opts.to)
    .match(opts.type ? { source_type: opts.type } : {});
  if (head.error) throw new Error(`day book count: ${head.error.message}`);
  const total = head.count ?? 0;
  const pages = pageCount(total, DAY_BOOK_PAGE);
  const page = Math.min(Math.max(opts.page, 1), pages);
  const res = await build().range((page - 1) * DAY_BOOK_PAGE, page * DAY_BOOK_PAGE - 1);
  return { rows: rows<Record<string, unknown>>(res, 'day book').map(dayBookRow), total, pages, page };
}

/** Every day-book row of a range for the Excel export; throws (`too_many`) past the cap. */
export async function loadDayBookAll(
  supabase: Supabase,
  opts: { from: string; to: string; type: DayBookType | null },
): Promise<DayBookRow[]> {
  const out: DayBookRow[] = [];
  for (let offset = 0; ; offset += LEDGER_CAP) {
    let q = supabase.from('v_day_book').select(DAY_BOOK_COLS).gte('entry_date', opts.from).lte('entry_date', opts.to);
    if (opts.type) q = q.eq('source_type', opts.type);
    const res = await q.order('entry_date', { ascending: true }).order('entry_no', { ascending: true }).range(offset, offset + LEDGER_CAP - 1);
    const batch = rows<Record<string, unknown>>(res, 'day book export');
    out.push(...batch.map(dayBookRow));
    if (out.length > DAY_BOOK_EXPORT_CAP) throw new Error('too_many');
    if (batch.length < LEDGER_CAP) return out;
  }
}

// ---------------------------------------------------------------- ageing

export interface AgeingRow {
  partyId: string;
  name: string;
  b0_30: string;
  b31_60: string;
  b61_90: string;
  b90_plus: string;
  /** Receipts not yet allocated to an invoice (shown as on account). */
  onAccount: string;
  interest: string;
  /** What the party owes: the AR control account's lines for this party. */
  receivable: string;
}

export interface AgeingReport {
  rows: AgeingRow[];
  totals: Omit<AgeingRow, 'partyId' | 'name'>;
  /**
   * Owner only, and only for the unfiltered list: the AR control account in the trial balance vs the
   * sum of the parties' receivables. `gap` is control minus parties (non-zero = AR lines with no party).
   */
  reconciliation: { control: string; agrees: boolean; gap: string } | null;
}

export async function loadAgeing(supabase: Supabase, opts: { isAdmin: boolean; q: string }): Promise<AgeingReport> {
  let q = supabase
    .from('v_party_aging')
    .select('party_id, party_name, bucket_0_30, bucket_31_60, bucket_61_90, bucket_90_plus, unallocated, unapplied_discount, interest, ar_balance', { count: 'exact' });
  if (opts.q) q = q.ilike('party_name', containsPattern(opts.q));
  const res = await q.order('ar_balance', { ascending: false }).order('party_name', { ascending: true });
  const list = completeRows<Record<string, unknown>>(res, 'ageing').map((r): AgeingRow => ({
    partyId: r.party_id as string,
    name: r.party_name as string,
    b0_30: d2(r.bucket_0_30),
    b31_60: d2(r.bucket_31_60),
    b61_90: d2(r.bucket_61_90),
    b90_plus: d2(r.bucket_90_plus),
    // Cash received but not yet allocated, plus any discount given but not yet applied, both reduce
    // what is open; the screen shows them together as "on account".
    onAccount: sumMoney([r.unallocated as number, r.unapplied_discount as number]),
    interest: d2(r.interest),
    receivable: d2(r.ar_balance),
  }));
  const col = (k: keyof Omit<AgeingRow, 'partyId' | 'name'>) => sumMoney(list.map((r) => r[k]));
  const totals = {
    b0_30: col('b0_30'), b31_60: col('b31_60'), b61_90: col('b61_90'), b90_plus: col('b90_plus'),
    onAccount: col('onAccount'), interest: col('interest'), receivable: col('receivable'),
  };

  let reconciliation: AgeingReport['reconciliation'] = null;
  if (opts.isAdmin && !opts.q) {
    const tb = await supabase.from('v_trial_balance').select('closing').eq('system_key', 'ar').maybeSingle();
    const row = one<{ closing: number }>(tb, 'receivables control balance');
    if (row) {
      const control = d2(row.closing);
      reconciliation = { control, agrees: sameMoney(control, totals.receivable), gap: moneyGap(control, totals.receivable) };
    }
  }
  return { rows: list, totals, reconciliation };
}

// ---------------------------------------------------------------- stock

export interface StockReportRow {
  itemId: string;
  itemName: string;
  category: string;
  godown: string;
  baseUom: string;
  qty: string;
  /** Owner only; null for a counter (never selected). */
  avgRate: string | null;
  value: string | null;
}

export interface StockReport {
  godowns: { id: string; name: string }[];
  selected: string;
  rows: StockReportRow[];
  /** Owner only. */
  totalValue: string | null;
  /**
   * Owner only, all godowns: the Inventory account vs the stock ledger's value including goods in
   * transit (which no godown row holds, so `inTransit` is what the table total leaves out).
   */
  reconciliation: { control: string; agrees: boolean; gap: string; inTransit: string } | null;
}

export async function loadStockReport(supabase: Supabase, opts: { isAdmin: boolean; warehouse: string | undefined }): Promise<StockReport> {
  const whRes = await supabase.from('warehouses').select('id, name').eq('is_transit', false).order('name');
  const godowns = rows<{ id: string; name: string }>(whRes, 'godowns');
  const selected = godowns.some((g) => g.id === opts.warehouse) ? (opts.warehouse as string) : 'all';

  const cols = 'item_id, item_name, category, base_uom, warehouse_name, qty' + (opts.isAdmin ? ', avg_rate, value' : '');
  // Weighted-average issues round to paise, so an item can reach zero quantity with a few paise of value
  // left; an owner still sees that row (the table then adds up to the ledger). A counter has no value column.
  let q = supabase.from('v_stock_summary').select(cols, { count: 'exact' });
  q = opts.isAdmin ? q.or('qty.neq.0,value.neq.0') : q.neq('qty', 0);
  if (selected !== 'all') q = q.eq('warehouse_id', selected);
  const res = await q.order('item_name', { ascending: true }).order('warehouse_name', { ascending: true });
  const list = completeRows<Record<string, unknown>>(res, 'stock report').map((r): StockReportRow => ({
    itemId: r.item_id as string,
    itemName: r.item_name as string,
    category: r.category as string,
    godown: r.warehouse_name as string,
    baseUom: r.base_uom as string,
    qty: d3(r.qty),
    avgRate: opts.isAdmin ? d4(r.avg_rate) : null,
    value: opts.isAdmin ? d2(r.value) : null,
  }));
  const totalValue = opts.isAdmin ? sumMoney(list.map((r) => r.value)) : null;

  let reconciliation: StockReport['reconciliation'] = null;
  if (opts.isAdmin && selected === 'all') {
    const [allRes, tbRes] = await Promise.all([
      supabase.from('v_stock_summary_all').select('value, is_transit', { count: 'exact' }),
      supabase.from('v_trial_balance').select('closing').eq('system_key', 'inventory').maybeSingle(),
    ]);
    const all = completeRows<{ value: number; is_transit: boolean }>(allRes, 'stock value (all godowns)');
    const ledgerValue = sumMoney(all.map((r) => r.value));
    const inTransit = sumMoney(all.filter((r) => r.is_transit).map((r) => r.value));
    const tb = one<{ closing: number }>(tbRes, 'inventory control balance');
    if (tb) {
      const control = d2(tb.closing);
      reconciliation = { control, agrees: sameMoney(control, ledgerValue), gap: moneyGap(control, ledgerValue), inTransit };
    }
  }
  return { godowns, selected, rows: list, totalValue, reconciliation };
}

// ---------------------------------------------------------------- cash & bank book

export interface CashBookRow {
  key: string;
  date: string;
  entryNo: number | string;
  docNo: string | null;
  narration: string | null;
  isReversal: boolean;
  debit: string;
  credit: string;
  balance: string;
}

export interface CashBook {
  accounts: { id: string; name: string; key: string | null }[];
  account: { id: string; name: string };
  opening: string;
  rows: CashBookRow[];
  totalIn: string;
  totalOut: string;
  closing: string;
}

/**
 * One money account's lines for a date range with the running balance. Owner-only (the view returns
 * nothing to a counter). The opening balance is the running balance of the last line before the
 * range and the closing balance is that of the last line in it — read, not recomputed.
 */
export async function loadCashBook(
  supabase: Supabase,
  opts: { account: string | undefined; from: string; to: string },
): Promise<CashBook> {
  const accRes = await supabase.from('v_money_balances').select('account_id, name, system_key, code').order('code');
  const accounts = rows<{ account_id: string; name: string; system_key: string | null }>(accRes, 'money accounts').map((a) => ({ id: a.account_id, name: a.name, key: a.system_key }));
  if (accounts.length === 0) throw new Error('money accounts: none visible');
  const account = accounts.find((a) => a.id === opts.account) ?? accounts.find((a) => a.key === 'cash') ?? accounts[0]!;

  const [beforeRes, rangeRes] = await Promise.all([
    supabase.from('v_money_ledger').select('running_balance').eq('account_id', account.id).lt('entry_date', opts.from)
      .order('entry_date', { ascending: false }).order('entry_no', { ascending: false }).order('line_no', { ascending: false }).order('line_id', { ascending: false }).limit(1),
    supabase
      .from('v_money_ledger')
      .select('line_id, entry_date, entry_no, doc_no, narration, is_reversal, debit, credit, running_balance', { count: 'exact' })
      .eq('account_id', account.id).gte('entry_date', opts.from).lte('entry_date', opts.to)
      .order('entry_date', { ascending: true }).order('entry_no', { ascending: true }).order('line_no', { ascending: true }).order('line_id', { ascending: true })
      .range(0, LEDGER_CAP - 1),
  ]);
  const before = rows<{ running_balance: number }>(beforeRes, 'opening balance')[0];
  if (rangeRes.count !== null && rangeRes.count !== undefined && rangeRes.count > LEDGER_CAP) throw new Error('too_many');
  const list = rows<Record<string, unknown>>(rangeRes, 'cash book').map((r): CashBookRow => ({
    key: r.line_id as string,
    date: r.entry_date as string,
    entryNo: r.entry_no as number | string,
    docNo: (r.doc_no as string | null) ?? null,
    narration: (r.narration as string | null) ?? null,
    isReversal: !!r.is_reversal,
    debit: d2(r.debit),
    credit: d2(r.credit),
    balance: d2(r.running_balance),
  }));
  const opening = before ? d2(before.running_balance) : '0.00';
  return {
    accounts,
    account: { id: account.id, name: account.name },
    opening,
    rows: list,
    totalIn: sumMoney(list.map((r) => r.debit)),
    totalOut: sumMoney(list.map((r) => r.credit)),
    closing: list.length ? list[list.length - 1]!.balance : opening,
  };
}
