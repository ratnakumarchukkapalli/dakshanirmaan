// Pure helpers for the dashboard. No business math: money is summed as exact decimal text
// (BigInt-scaled), everything else is picking, ordering and calendar arithmetic on ISO dates.

import { addDecimal, decimalText, parseScaled, signOf } from '@/lib/decimal';

/** Exact sum of money texts / numbers at 2 decimals; null values count as 0. */
export function sumMoney(values: (string | number | null | undefined)[]): string {
  let total = '0.00';
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const next = addDecimal(total, decimalText(v, 2), 2);
    if (next === null) throw new Error(`Not a money value: ${String(v)}`);
    total = next;
  }
  return total;
}

/** ISO date + n days (n may be negative). A calendar walk on UTC fields: no time zone can move it. */
export function addDaysIso(iso: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** The last `count` days ending at `today`, oldest first. */
export function lastDays(today: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDaysIso(today, i - (count - 1)));
}

export type Category = 'cement' | 'steel' | 'other';

export interface SalesDay {
  date: string;
  cement: string;
  steel: string;
  other: string;
  /** The day's billed total (invoice grand totals), which the category amounts add up to with round-off. */
  total: string;
  roundOff: string;
  invoices: number;
}

interface DailyRow { sale_date: string; invoice_count: number; billed_total: number | string; round_off: number | string }
interface CategoryRow { sale_date: string; category: string; amount: number | string }

/** One entry per day of the window (zero-filled), from the two sales views. */
export function buildSalesWeek(days: string[], daily: DailyRow[], byCategory: CategoryRow[]): SalesDay[] {
  return days.map((date) => {
    const d = daily.find((r) => r.sale_date === date);
    const amountOf = (cat: Category) => {
      const r = byCategory.find((c) => c.sale_date === date && c.category === cat);
      return r ? decimalText(r.amount, 2) : '0.00';
    };
    return {
      date,
      cement: amountOf('cement'),
      steel: amountOf('steel'),
      other: amountOf('other'),
      total: d ? decimalText(d.billed_total, 2) : '0.00',
      roundOff: d ? decimalText(d.round_off, 2) : '0.00',
      invoices: d ? d.invoice_count : 0,
    };
  });
}

/** True when any day of the window has a sale. */
export const hasSales = (week: SalesDay[]): boolean => week.some((d) => signOf(d.total) !== 0);

/** A bar height as a share (0..1) of the tallest day. Geometry only: nothing stored or shown is derived from it. */
export function barShare(value: string, max: string): number {
  const v = parseScaled(value, 2);
  const m = parseScaled(max, 2);
  if (v === null || m === null || m === 0n) return 0;
  return Number((v * 10000n) / m) / 10000;
}

/** The largest day total, as a money text. */
export function maxTotal(week: SalesDay[]): string {
  let best = '0.00';
  for (const d of week) {
    const a = parseScaled(d.total, 2);
    const b = parseScaled(best, 2);
    if (a !== null && b !== null && a > b) best = d.total;
  }
  return best;
}

export interface AttentionRow {
  kind: string;
  severity: string;
  subject_type: string;
  subject_id: string | null;
  title: string;
  detail: string;
  due_date: string | null;
  amount: number | string | null;
  interest: number | string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where an attention row should land; null for a kind this screen does not know (rendered without a link). */
export function attentionHref(kind: string, subjectId: string | null): string | null {
  const id = subjectId && UUID.test(subjectId) ? subjectId : null;
  switch (kind) {
    case 'overdue_party': return id ? `/parties/${id}` : '/parties';
    case 'low_stock': return id ? `/stock/${id}` : '/stock';
    case 'cheque_due': return '/payments';
    case 'stale_challan':
    case 'challan_possible_duplicate': return '/sales?status=challan';
    case 'transfer_in_transit': return '/stock';
    case 'day_close_difference': return '/reports/day-close';
    case 'gst_due': return '/reports';
    case 'create_fy_periods': return '/settings';
    default: return null;
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Most urgent first (critical, warning, info), then the date it became due (oldest first, undated last), then title. */
export function sortAttention(rows: AttentionRow[]): AttentionRow[] {
  return [...rows].sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (s !== 0) return s;
    if (a.due_date !== b.due_date) {
      if (a.due_date === null) return 1;
      if (b.due_date === null) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });
}
