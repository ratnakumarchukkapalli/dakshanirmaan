import { rows } from '@/lib/db';
import { fyName, fyRange, fyStartYear } from '@/lib/fy';
import { todayIn } from '@/lib/format';
import type { FiscalYear, Supabase } from './types';

// Financial-year selection and the small text helpers every export shares. The FY is April to March
// (a hard rule of the app); which years can be exported is whatever the books hold in `fiscal_periods`.

export function fiscalYear(startYear: number): FiscalYear {
  const { from, to } = fyRange(startYear);
  return { startYear, from, to, label: fyName(startYear) };
}

/** Start years of every financial year that has months set up, newest first. */
export async function listFiscalYears(supabase: Supabase): Promise<number[]> {
  const res = await supabase.from('fiscal_periods').select('year_label');
  const years = new Set<number>();
  for (const r of rows<{ year_label: string }>(res, 'fiscal periods')) {
    const m = /^(\d{4})-\d{2}$/.exec(r.year_label);
    if (m) years.add(Number(m[1]));
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * `?fy=` -> the year to export. Missing = the current FY when it is set up, else the newest year that
 * is. A value that is not one of the available years is `null` (the route answers 400).
 */
export function resolveFiscalYear(raw: string | null | undefined, available: number[], timeZone: string, now: Date = new Date()): FiscalYear | null {
  if (raw === null || raw === undefined || raw === '') {
    const current = fyStartYear(todayIn(timeZone, now));
    const pick = available.includes(current) ? current : available[0];
    return pick === undefined ? null : fiscalYear(pick);
  }
  if (!/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return available.includes(year) ? fiscalYear(year) : null;
}

/** "02-10-2026 14:05 IST": an instant in the organisation's zone, for a README. */
export function generatedAtText(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('day')}-${get('month')}-${get('year')} ${hour}:${get('minute')} ${get('timeZoneName')}`;
}

/** daksha-books-FY26-27.xlsx, daksha-tally-vouchers-FY26-27.xml — letters, digits and dashes only, whatever the kind, part or extension. */
export function exportFileName(kind: 'books' | 'tally' | 'archive', fy: FiscalYear, extension: string, part?: string): string {
  const short = (n: number) => String(n % 100).padStart(2, '0');
  const mid = part ? `-${part.replace(/[^a-z0-9]/gi, '')}` : '';
  return `daksha-${kind}${mid}-FY${short(fy.startYear)}-${short(fy.startYear + 1)}.${extension.replace(/[^a-z0-9]/gi, '')}`;
}

/** Months of a financial year as 'YYYY-MM', April first. */
export function fyMonths(fy: FiscalYear): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((3 + i) % 12) + 1;
    const y = fy.startYear + (m >= 4 ? 0 : 1);
    return `${y}-${String(m).padStart(2, '0')}`;
  });
}
