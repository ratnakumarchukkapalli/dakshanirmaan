import { getTranslations } from 'next-intl/server';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { Segmented } from '@/components/ui/Segmented';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { compareDecimal } from '@/lib/decimal';
import { inr2, inrRate } from '@/lib/format';
import { loadStockReport } from '@/lib/reports-data';
import { createClient } from '@/lib/supabase/server';
import { qtyDisplay } from '@/lib/units';

// Stock on hand by item and godown, from `v_stock_summary`. Quantities for everyone; cost (average
// rate, value, the total and its check against the Inventory account) is owner-only and a counter
// session never selects it.
export default async function StockReportPage({ searchParams }: { searchParams: Promise<{ wh?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, supabase] = await Promise.all([getTranslations('reports.stock'), getTranslations('reports'), getCurrentMember(), createClient()]);
  const isAdmin = isVerifiedAdmin(member);

  let report: Awaited<ReturnType<typeof loadStockReport>> | null = null;
  try {
    report = await loadStockReport(supabase, { isAdmin, warehouse: sp.wh });
  } catch (e) {
    console.error('[reports] stock failed:', e instanceof Error ? e.message : e);
  }

  const href = (wh: string) => `/reports/stock?wh=${wh}`;
  return (
    <div className="screen">
      <ReportHead
        title={t('title')} subtitle={isAdmin ? t('subtitleAdmin') : t('subtitle')} backLabel={tr('back')}
        export={{ href: `/api/reports/stock/xlsx${report && report.selected !== 'all' ? `?wh=${report.selected}` : ''}`, label: tr('exportXlsx') }}
      />
      {!report ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <div className="toolbar">
            <Segmented
              label={t('godownSegments')}
              active={report.selected}
              options={[{ key: 'all', label: t('allGodowns'), href: href('all') }, ...report.godowns.map((g) => ({ key: g.id, label: g.name, href: href(g.id) }))]}
            />
          </div>
          {report.reconciliation && (
            <p className="recon">
              {report.reconciliation.agrees
                ? <Chip tone="good">{t('reconAgrees', { amount: inr2(report.reconciliation.control) })}</Chip>
                : <Chip tone="warn">{t('reconGap', { control: inr2(report.reconciliation.control), gap: inr2(report.reconciliation.gap) })}</Chip>}
              {compareDecimal(report.reconciliation.inTransit, '0.00', 2) !== 0 && <span>{t('reconTransit', { amount: inr2(report.reconciliation.inTransit) })}</span>}
            </p>
          )}
          <Card>
            {report.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
            ) : (
              <LedgerTable
                columns={[
                  { header: t('colItem') },
                  { header: t('colGodown') },
                  { header: t('colQty'), numeric: true },
                  ...(isAdmin ? [{ header: t('colAvg'), numeric: true }, { header: t('colValue'), numeric: true }] : []),
                ]}
                rows={report.rows.map((r) => ({
                  key: `${r.itemId}-${r.godown}`,
                  cells: [
                    r.itemName,
                    r.godown,
                    `${qtyDisplay(r.qty)} ${r.baseUom}`,
                    ...(isAdmin ? [r.avgRate === null ? '—' : inrRate(r.avgRate), r.value === null ? '—' : inr2(r.value)] : []),
                  ],
                }))}
                footer={isAdmin && report.totalValue !== null ? [t('total'), '', '', '', inr2(report.totalValue)] : undefined}
              />
            )}
            <p className="hint">{t('hint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
