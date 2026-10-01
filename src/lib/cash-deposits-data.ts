import 'server-only';
import { decimalText } from '@/lib/decimal';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

export interface CashDepositRow {
  id: string;
  depositDate: string;
  /** Exact decimal text, 2 places. */
  amount: string;
  reference: string | null;
  note: string | null;
  status: 'posted' | 'cancelled';
}

/** Cash deposits, newest first: those on one day, or the latest few. A read failure is logged and shown as "none". */
export async function loadCashDeposits(supabase: Supabase, opts: { date?: string; limit: number }): Promise<CashDepositRow[]> {
  let q = supabase
    .from('cash_deposits')
    .select('id, deposit_date, amount, reference, note, status')
    .order('deposit_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(opts.limit);
  if (opts.date) q = q.eq('deposit_date', opts.date);
  const { data, error } = await q;
  if (error) {
    console.error('[cash-deposits] read failed:', error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    depositDate: r.deposit_date as string,
    amount: decimalText(r.amount as number | string, 2),
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    status: r.status as CashDepositRow['status'],
  }));
}

/** What the books say the drawer should hold at the end of `date` (day_close_preview's `expected`), or null if unreadable. */
export async function loadCashOnHand(supabase: Supabase, date: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('day_close_preview', { p_date: date });
  if (error) {
    console.error('[cash-deposits] cash on hand failed:', error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { expected?: number | string } | null;
  return row?.expected === undefined ? null : decimalText(row.expected, 2);
}
