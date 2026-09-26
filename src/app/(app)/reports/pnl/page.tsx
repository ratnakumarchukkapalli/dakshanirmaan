import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadPnl, type Pnl } from '@/lib/books-data';
import { signOf } from '@/lib/decimal';
import { fyRange, fyStartYear } from '@/lib/fy';
import { inr2, todayIn } from '@/lib/format';
import { parseRange } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Profit and loss for a range (default: this financial year so far). Owner only.
export default async function PnlPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.statements'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  const today = todayIn(ctx.timeZone);
  const range = parseRange(sp.from ?? fyRange(fyStartYear(today)).from, sp.to, today);

  let pnl: Pnl | null = null;
  try {
    pnl = await loadPnl(supabase, range.from, range.to);
  } catch (e) {
    console.error('[reports] pnl failed:', e instanceof Error ? e.message : e);
  }
  const table = (rows: Pnl['income'], total: string, label: string) => (
    <LedgerTable
      columns={[{ header: t('colCode'), nowrap: true }, { header: label }, { header: t('colAmount'), numeric: true }]}
      rows={rows.map((r) => ({ key: r.code ?? r.name, cells: [<span key="c" className="mono">{r.code}</span>, r.name, inr2(r.amount)] }))}
      footer={['', label, inr2(total)]}
    />
  );

  return (
    <div className="screen">
      <ReportHead title={t('pnlTitle')} subtitle={t('pnlSubtitle')} backLabel={tr('back')}
        export={pnl ? { href: `/api/reports/pnl/xlsx?from=${range.from}&to=${range.to}`, label: tr('exportXlsx') } : undefined} />
      {!pnl ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <ReportFilters
            dates={[{ name: 'from', label: tr('from'), value: range.from }, { name: 'to', label: tr('to'), value: range.to }]}
            datePlaceholder={tr('datePlaceholder')} submitLabel={tr('show')}
          />
          <div className="tiles">
            <StatTile small label={t('income')} value={inr2(pnl.totalIncome)} />
            <StatTile small label={t('expenses')} value={inr2(pnl.totalExpenses)} />
            <StatTile small hero label={t('net')} value={inr2(pnl.net)} tone={signOf(pnl.net) === -1 ? 'bad' : undefined} />
          </div>
          <Card>
            {pnl.income.length === 0 && pnl.expenses.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
            ) : (
              <div className="stack">
                {table(pnl.income, pnl.totalIncome, t('income'))}
                {table(pnl.expenses, pnl.totalExpenses, t('expenses'))}
              </div>
            )}
            <p className="hint">{t('pnlHint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
