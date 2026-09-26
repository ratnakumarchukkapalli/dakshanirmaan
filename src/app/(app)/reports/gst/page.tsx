import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadGstr1, loadGstr3b, type Gstr3bRow } from '@/lib/books-data';
import { signOf } from '@/lib/decimal';
import { inr2, todayIn } from '@/lib/format';
import { blockingWarnings, periodOrDefault, type Gstr1Data } from '@/lib/gstr1-file';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

const SECTIONS = ['b2b', 'b2cl', 'b2cs', 'cdnr', 'nil'] as const;

/** The last 12 months (newest first), as `YYYY-MM` with a readable label. */
function monthOptions(today: string): { value: string; label: string }[] {
  const [y0, m0] = today.split('-').map(Number) as [number, number];
  const fmt = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => {
    const idx = y0 * 12 + (m0 - 1) - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    return { value: `${y}-${String(m).padStart(2, '0')}`, label: fmt.format(new Date(Date.UTC(y, m - 1, 1))) };
  });
}

// GST returns for one month: GSTR-1 (what the portal file holds, with downloads) and the GSTR-3B summary
// with its check against the ledger. Owner only.
export default async function GstPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.gst'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  const today = todayIn(ctx.timeZone);
  const period = periodOrDefault(sp.period, today);
  const options = monthOptions(today);
  if (!options.some((o) => o.value === period)) options.push({ value: period, label: period });

  let g1: Gstr1Data | null = null;
  let g3: Gstr3bRow[] = [];
  try {
    [g1, g3] = await Promise.all([loadGstr1(supabase, period), loadGstr3b(supabase, period)]);
  } catch (e) {
    console.error('[reports] gst failed:', e instanceof Error ? e.message : e);
  }
  const blocked = g1 ? blockingWarnings(g1) : [];
  const recon = g3.filter((r) => r.key.startsWith('recon_'));
  const agrees = recon.every((r) => signOf(r.igst) === 0 && signOf(r.cgst) === 0 && signOf(r.sgst) === 0);
  // Message keys cannot contain dots, so the return's row numbers (3.1a) are looked up as 3_1a.
  const label = (key: string) => {
    if (key.startsWith('3.2:')) return `${t('rows.3_2')} ${key.slice(4)}`;
    const id = key.replace('.', '_');
    return t.has(`rows.${id}`) ? t(`rows.${id}`) : key;
  };
  const noBills = g1 !== null && g1.totals.invoices === 0 && g1.totals.notes === 0;

  return (
    <div className="screen">
      <ReportHead title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')} />
      <ReportFilters dates={[]} select={{ name: 'period', label: t('month'), value: period, options }} datePlaceholder={tr('datePlaceholder')} submitLabel={tr('show')} />
      {!g1 ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <div className="stack">
          <Card>
            <div className="cardtitle">{t('gstr1Title')} · {period}</div>
            {noBills ? <p className="muted" style={{ margin: 0 }}>{t('empty')}</p> : (
              <LedgerTable
                columns={[{ header: t('colSection') }, { header: t('colDocs'), numeric: true }, { header: t('colTaxable'), numeric: true }, { header: t('colIgst'), numeric: true }, { header: t('colCgst'), numeric: true }, { header: t('colSgst'), numeric: true }]}
                rows={SECTIONS.map((k) => {
                  const x = g1.summary[k];
                  return { key: k, cells: [t(`sections.${k}`), String(x.count), inr2(x.txval), inr2(x.iamt), inr2(x.camt), inr2(x.samt)] };
                })}
                footer={[t('netTotal'), String(g1.totals.invoices + g1.totals.notes), inr2(g1.totals.taxable), inr2(g1.totals.igst), inr2(g1.totals.cgst), inr2(g1.totals.sgst)]}
              />
            )}
            <p className="hint">{t('hsnLines', { count: g1.summary.hsn.count })}</p>
            {g1.warnings.length > 0 && (
              <div role="status" className={blocked.length ? 'alert bad' : 'alert warn'}>
                {blocked.length > 0 && <p style={{ margin: '0 0 6px' }}>{t('blocked')}</p>}
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {g1.warnings.map((w) => <li key={w.key}>{t(`warn.${w.key}`, { count: w.count })}</li>)}
                </ul>
              </div>
            )}
            {!noBills && (
              <div className="toolbar" style={{ marginTop: 12 }}>
                {blocked.length === 0 ? (
                  <>
                    <a className="btn primary" href={`/api/reports/gstr1?period=${period}`} download>{t('downloadJson')}</a>
                    <a className="btn ghost" href={`/api/reports/gstr1?period=${period}&format=xlsx`} download>{t('downloadXlsx')}</a>
                  </>
                ) : null}
              </div>
            )}
            <p className="hint">{t('turnoverNote')}</p>
            <p className="hint">{t('uploadNote')}</p>
          </Card>

          <Card>
            <div className="cardtitle">{t('gstr3bTitle')} · {period}</div>
            <LedgerTable
              columns={[{ header: t('colRow') }, { header: t('colTaxable'), numeric: true }, { header: t('colIgst'), numeric: true }, { header: t('colCgst'), numeric: true }, { header: t('colSgst'), numeric: true }]}
              rows={g3.filter((r) => !r.key.startsWith('books_') && !r.key.startsWith('recon_')).map((r) => ({
                key: r.key, cells: [label(r.key), inr2(r.taxable), inr2(r.igst), inr2(r.cgst), inr2(r.sgst)],
              }))}
            />
            <p className="hint">{t('summaryOnly')}</p>
            <div className="cardtitle" style={{ marginTop: 14 }}>{t('checkTitle')}</div>
            <LedgerTable
              columns={[{ header: t('colRow') }, { header: t('colIgst'), numeric: true }, { header: t('colCgst'), numeric: true }, { header: t('colSgst'), numeric: true }]}
              rows={g3.filter((r) => r.key.startsWith('books_') || r.key.startsWith('recon_')).map((r) => ({
                key: r.key, cells: [label(r.key), inr2(r.igst), inr2(r.cgst), inr2(r.sgst)],
              }))}
            />
            {agrees ? <p><Chip tone="good">{t('reconOk')}</Chip></p> : <p role="status" className="alert warn">{t('reconDiff')}</p>}
            <div className="toolbar">
              <a className="btn ghost" href={`/api/reports/gstr3b/xlsx?period=${period}`} download>{t('downloadXlsx')}</a>
            </div>
          </Card>
          <p className="hint">{t('hint')}</p>
        </div>
      )}
    </div>
  );
}
