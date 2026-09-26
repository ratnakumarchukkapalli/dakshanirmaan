// Pure helpers for the reports (change 15): date ranges from the URL, paging, and the one exact-
// decimal comparison the reconciliation chips need. No money arithmetic beyond exact sums.
import { addDaysIso } from '@/lib/dashboard-math';
import { compareDecimal, subtractDecimal } from '@/lib/decimal';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date on the wire (YYYY-MM-DD), or null. */
export function validIso(raw: string | undefined | null): string | null {
  if (!raw || !ISO.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? raw : null;
}

/** First day of the month an ISO date falls in. */
export const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;

export interface DateRange { from: string; to: string }

/**
 * `?from=&to=` from the URL: anything missing or not a real date falls back to "this month so far",
 * and a range whose end is before its start is swapped rather than shown empty.
 */
export function parseRange(from: string | undefined, to: string | undefined, today: string): DateRange {
  const f = validIso(from) ?? monthStart(today);
  const t = validIso(to) ?? today;
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

/** The date to close: `?date=` when it is a real date not after today, otherwise today. */
export function parseCloseDate(raw: string | undefined, today: string): string {
  const d = validIso(raw);
  return d && d <= today ? d : today;
}

/** 1-based page number from the URL, clamped to [1, last]. */
export function parsePage(raw: string | undefined, pages: number): number {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, Math.max(pages, 1));
}

export const pageCount = (total: number, size: number): number => Math.max(1, Math.ceil(total / size));

/** True when two 2-decimal texts are the same amount. */
export const sameMoney = (a: string, b: string): boolean => compareDecimal(a, b, 2) === 0;

/** a - b for a reconciliation chip ("differs by ..."); '0.00' when either side is unreadable. */
export const moneyGap = (a: string, b: string): string => subtractDecimal(a, b, 2) ?? '0.00';

/** The day before an ISO date (for "opening balance as at the day before the range"). */
export const dayBefore = (iso: string): string => addDaysIso(iso, -1);

export type CloseBlock = 'later_close' | 'too_old' | null;

/**
 * Why a day may not be closed from this screen (the database allows more for an owner, per the
 * change 05 spec, but closing an earlier day after a later one books the drawer's current cash
 * against a past ledger — so the app asks for the later close to be reopened first). A counter may
 * also only close today or yesterday: an older day cannot be recounted.
 */
export function closeBlock(o: { date: string; today: string; latestClose: string | null; isAdmin: boolean }): CloseBlock {
  if (o.latestClose !== null && o.latestClose > o.date) return 'later_close';
  if (!o.isAdmin && o.date < addDaysIso(o.today, -1)) return 'too_old';
  return null;
}
