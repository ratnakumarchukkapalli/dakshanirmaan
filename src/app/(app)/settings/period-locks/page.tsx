import { PeriodLocks, type PeriodRow } from '@/components/settings/PeriodLocks';
import { requireOwnerPage } from '@/lib/auth/require';
import { rows } from '@/lib/db';
import { createClient } from '@/lib/supabase/server';

// Draft documents by month: a month with drafts in it can still be locked, but the owner should see them.
const DRAFT_SOURCES = [
  ['sales_invoices', 'invoice_date'], ['purchase_invoices', 'invoice_date'], ['payments', 'payment_date'],
  ['expense_vouchers', 'voucher_date'], ['delivery_challans', 'challan_date'], ['stock_adjustments', 'adj_date'],
] as const;

/** `2026-27` -> `2027-28`. */
const nextLabel = (label: string) => {
  const y = Number(label.slice(0, 4)) + 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

export default async function PeriodLocksPage() {
  await requireOwnerPage();
  const supabase = await createClient();
  const [periodsRes, ...draftRes] = await Promise.all([
    supabase.from('fiscal_periods').select('month, year_label, is_locked').order('month', { ascending: false }),
    ...DRAFT_SOURCES.map(([table, col]) => supabase.from(table).select(col).eq('status', 'draft')),
  ]);
  const drafts = new Map<string, number>();
  draftRes.forEach((res, i) => {
    for (const r of rows<Record<string, string>>(res, `drafts ${DRAFT_SOURCES[i]![0]}`)) {
      const month = `${String(r[DRAFT_SOURCES[i]![1]]).slice(0, 7)}-01`;
      drafts.set(month, (drafts.get(month) ?? 0) + 1);
    }
  });
  const list = rows<{ month: string; year_label: string; is_locked: boolean }>(periodsRes, 'fiscal periods');
  const periods: PeriodRow[] = list.map((p) => ({ month: p.month, yearLabel: p.year_label, isLocked: p.is_locked, drafts: drafts.get(p.month) ?? 0 }));
  // Offered from February: the next financial year's months, unless they exist already.
  const latest = list[0]?.year_label ?? null;
  const nextYear = latest ? nextLabel(latest) : null;
  return <PeriodLocks periods={periods} nextYear={nextYear} />;
}
