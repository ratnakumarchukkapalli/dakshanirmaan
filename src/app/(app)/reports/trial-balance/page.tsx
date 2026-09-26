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
import { loadTrialBalance, type TrialBalance } from '@/lib/books-data';
import { signOf } from '@/lib/decimal';
import { inr2, todayIn } from '@/lib/format';
import { validIso } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Trial balance as at a date. Owner only (the proxy, this page, the database function and the Excel route each check).
export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.statements'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  const asAt = validIso(sp.date) ?? todayIn(ctx.timeZone);

  let tb: TrialBalance | null = null;
  try {
    tb = await loadTrialBalance(supabase, asAt);
  } catch (e) {
    console.error('[reports] trial balance failed:', e instanceof Error ? e.message : e);
  }

  return (
    <div className="screen">
      <ReportHead title={t('tbTitle')} subtitle={t('tbSubtitle')} backLabel={tr('back')}
        export={tb ? { href: `/api/reports/trial-balance/xlsx?date=${asAt}`, label: tr('exportXlsx') } : undefined} />
      {!tb ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <ReportFilters dates={[{ name: 'date', label: t('dateLabel'), value: asAt }]} datePlaceholder={tr('datePlaceholder')} submitLabel={tr('show')} />
          <div className="tiles">
            <StatTile small label={t('colDebit')} value={inr2(tb.totalDebit)} />
            <StatTile small label={t('colCredit')} value={inr2(tb.totalCredit)} />
            <StatTile small label=" " value={<Chip tone={tb.balanced ? 'good' : 'bad'}>{tb.balanced ? t('balanced') : t('notBalanced')}</Chip>} />
          </div>
          <Card>
            {tb.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
            ) : (
              <LedgerTable
                columns={[{ header: t('colCode'), nowrap: true }, { header: t('colAccount') }, { header: t('colDebit'), numeric: true }, { header: t('colCredit'), numeric: true }]}
                rows={tb.rows.map((r) => ({
                  key: r.code,
                  cells: [<span key="c" className="mono">{r.code}</span>, r.name, signOf(r.debit) === 0 ? '' : inr2(r.debit), signOf(r.credit) === 0 ? '' : inr2(r.credit)],
                }))}
                footer={['', t('total'), inr2(tb.totalDebit), inr2(tb.totalCredit)]}
              />
            )}
            <p className="hint">{t('tbHint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
