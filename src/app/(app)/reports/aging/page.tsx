import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { AgeingTiles } from '@/components/ui/AgeingTiles';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { SearchInput } from '@/components/ui/SearchInput';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { compareDecimal } from '@/lib/decimal';
import { inr, inr2 } from '@/lib/format';
import { loadAgeing } from '@/lib/reports-data';
import { cleanSearchText } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';

// Receivables ageing from `v_party_aging`: open invoices by days since the invoice date, receipts not
// yet allocated shown as on account, and the interest the party's rate would add on overdue invoices
// (a computed figure — never posted automatically). The owner also sees whether the parties add up
// to the AR control account.
export default async function AgeingPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const q = cleanSearchText(sp.q);
  const [t, tr, member, supabase] = await Promise.all([getTranslations('reports.aging'), getTranslations('reports'), getCurrentMember(), createClient()]);
  const isAdmin = isVerifiedAdmin(member);

  let report: Awaited<ReturnType<typeof loadAgeing>> | null = null;
  try {
    report = await loadAgeing(supabase, { isAdmin, q });
  } catch (e) {
    console.error('[reports] ageing failed:', e instanceof Error ? e.message : e);
  }
  const positive = (v: string) => compareDecimal(v, '0.00', 2) === 1;

  return (
    <div className="screen">
      <ReportHead
        title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')}
        export={{ href: `/api/reports/aging/xlsx${q ? `?q=${encodeURIComponent(q)}` : ''}`, label: tr('exportXlsx') }}
      />
      <div className="toolbar">
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} />
      </div>

      {!report ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <AgeingTiles
            buckets={{ b0_30: report.totals.b0_30, b31_60: report.totals.b31_60, b61_90: report.totals.b61_90, b90_plus: report.totals.b90_plus }}
            labels={{ b0_30: t('b0_30'), b31_60: t('b31_60'), b61_90: t('b61_90'), b90_plus: t('b90_plus') }}
            empty={t('none')}
            extra={[
              { label: t('onAccount'), value: positive(report.totals.onAccount) ? inr(report.totals.onAccount) : t('none') },
              { label: t('interest'), value: positive(report.totals.interest) ? inr2(report.totals.interest) : t('none'), sub: t('interestSub') },
            ]}
          />
          {report.reconciliation && (
            <p className="recon">
              {report.reconciliation.agrees
                ? <Chip tone="good">{t('reconAgrees', { amount: inr2(report.reconciliation.control) })}</Chip>
                : <Chip tone="warn">{t('reconGap', { control: inr2(report.reconciliation.control), gap: inr2(report.reconciliation.gap) })}</Chip>}
            </p>
          )}
          <Card>
            {report.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{q ? t('emptySearch') : t('empty')}</p>
            ) : (
              <LedgerTable
                columns={[
                  { header: t('colParty') },
                  { header: t('b0_30'), numeric: true },
                  { header: t('b31_60'), numeric: true },
                  { header: t('b61_90'), numeric: true },
                  { header: t('b90_plus'), numeric: true },
                  { header: t('onAccount'), numeric: true },
                  { header: t('interest'), numeric: true },
                  { header: t('colReceivable'), numeric: true },
                ]}
                rows={report.rows.map((r) => ({
                  key: r.partyId,
                  href: `/parties/${r.partyId}`,
                  cells: [
                    <Link key="p" href={`/parties/${r.partyId}`}>{r.name}</Link>,
                    inr2(r.b0_30), inr2(r.b31_60), inr2(r.b61_90), inr2(r.b90_plus), inr2(r.onAccount), inr2(r.interest), inr2(r.receivable),
                  ],
                }))}
                footer={[
                  t('total'),
                  inr2(report.totals.b0_30), inr2(report.totals.b31_60), inr2(report.totals.b61_90), inr2(report.totals.b90_plus),
                  inr2(report.totals.onAccount), inr2(report.totals.interest), inr2(report.totals.receivable),
                ]}
              />
            )}
            <p className="hint">{t('hint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
