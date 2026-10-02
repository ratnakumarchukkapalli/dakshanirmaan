import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ImportCard } from '@/components/bank/ImportCard';
import { ReconTiles } from '@/components/bank/ReconTiles';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadRecon, loadStatements } from '@/lib/bank-data';
import { formatDate, inr2 } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

// Bank reconciliation: import the HDFC statement, see what the books already explain, book what is missing.
// Owner only — bank balances are not counter-staff data (the proxy, this page and every database function each refuse a counter).
export default async function ReconcilePage() {
  const [t, tr, member, supabase] = await Promise.all([getTranslations('bank'), getTranslations('reports'), getCurrentMember(), createClient()]);
  if (!isVerifiedAdmin(member)) redirect('/reports');

  let data: { recon: Awaited<ReturnType<typeof loadRecon>>; statements: Awaited<ReturnType<typeof loadStatements>> } | null = null;
  try {
    const [recon, statements] = await Promise.all([loadRecon(supabase), loadStatements(supabase)]);
    data = { recon, statements };
  } catch (e) {
    console.error('[bank] reconcile page failed:', e instanceof Error ? e.message : e);
  }

  return (
    <div className="screen">
      <ReportHead title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')} />
      {!data ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <div className="stack">
          <ReconTiles recon={data.recon} />
          <ImportCard />
          <Card>
            <div className="cardtitle">{t('statementsTitle')}</div>
            {data.statements.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('statementsEmpty')}</p>
            ) : (
              <LedgerTable
                columns={[
                  { header: t('colPeriod'), nowrap: true },
                  { header: t('colFile') },
                  { header: t('colLines'), numeric: true },
                  { header: t('colUnmatched'), numeric: true },
                  { header: t('colClosing'), numeric: true },
                ]}
                rows={data.statements.map((s) => ({
                  key: s.id,
                  href: `/reports/reconcile/${s.id}`,
                  cells: [
                    `${formatDate(s.periodFrom)} → ${formatDate(s.periodTo)}`,
                    <span key="f" style={{ overflowWrap: 'anywhere' }}>{s.sourceFile ?? '—'}</span>,
                    String(s.lineCount),
                    String(s.unmatchedCount),
                    s.closingBalance === null ? '—' : inr2(s.closingBalance),
                  ],
                }))}
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
