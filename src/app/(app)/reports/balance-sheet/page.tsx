import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadBalanceSheet, type BalanceSheet } from '@/lib/books-data';
import { inr2, todayIn } from '@/lib/format';
import { validIso } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Balance sheet as at a date. Owner only.
export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.statements'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  const asAt = validIso(sp.date) ?? todayIn(ctx.timeZone);

  let bs: BalanceSheet | null = null;
  try {
    bs = await loadBalanceSheet(supabase, asAt);
  } catch (e) {
    console.error('[reports] balance sheet failed:', e instanceof Error ? e.message : e);
  }
  const block = (rows: BalanceSheet['assets'], total: string, label: string) => (
    <LedgerTable
      columns={[{ header: t('colCode'), nowrap: true }, { header: label }, { header: t('colAmount'), numeric: true }]}
      rows={rows.map((r) => ({ key: r.code ?? 'profit', cells: [<span key="c" className="mono">{r.code ?? ''}</span>, r.isProfit ? t('profitRow') : r.name, inr2(r.amount)] }))}
      footer={['', label, inr2(total)]}
    />
  );

  return (
    <div className="screen">
      <ReportHead title={t('bsTitle')} subtitle={t('bsSubtitle')} backLabel={tr('back')}
        export={bs ? { href: `/api/reports/balance-sheet/xlsx?date=${asAt}`, label: tr('exportXlsx') } : undefined} />
      {!bs ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <ReportFilters dates={[{ name: 'date', label: t('dateLabel'), value: asAt }]} datePlaceholder={tr('datePlaceholder')} submitLabel={tr('show')} />
          <div className="tiles">
            <StatTile small label={t('assets')} value={inr2(bs.totalAssets)} />
            <StatTile small label={t('liabilitiesEquity')} value={inr2(bs.totalLiabilitiesEquity)} />
            <StatTile small label=" " value={<Chip tone={bs.balanced ? 'good' : 'bad'}>{bs.balanced ? t('bsBalanced') : t('bsNotBalanced')}</Chip>} />
          </div>
          <Card>
            {bs.assets.length === 0 && bs.liabilities.length === 0 && bs.equity.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
            ) : (
              <div className="stack">
                {block(bs.assets, bs.totalAssets, t('assets'))}
                {block(bs.liabilities, bs.totalLiabilities, t('liabilities'))}
                {block(bs.equity, bs.totalEquity, t('equity'))}
              </div>
            )}
            <p className="hint">{t('bsHint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
