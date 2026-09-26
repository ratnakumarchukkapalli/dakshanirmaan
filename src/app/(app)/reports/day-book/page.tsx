import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { formatDate, inr2, todayIn } from '@/lib/format';
import { DAY_BOOK_TYPES, loadDayBook, parseDayBookType } from '@/lib/reports-data';
import { parsePage, parseRange } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Day book: every posted entry of a date range, oldest first, from `v_day_book`. A cancellation or a
// bounced cheque is its own row (flagged), so nothing ever disappears from the book.
export default async function DayBookPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; type?: string; page?: string }> }) {
  const sp = await searchParams;
  const [t, tr, ctx, supabase] = await Promise.all([getTranslations('reports.dayBook'), getTranslations('reports'), getShellContext(), createClient()]);
  const range = parseRange(sp.from, sp.to, todayIn(ctx.timeZone));
  const type = parseDayBookType(sp.type);

  let book: Awaited<ReturnType<typeof loadDayBook>> | null = null;
  try {
    book = await loadDayBook(supabase, { ...range, type, page: parsePage(sp.page, Number.MAX_SAFE_INTEGER) });
  } catch (e) {
    console.error('[reports] day book failed:', e instanceof Error ? e.message : e);
  }

  const params = (page: number) => {
    const q = new URLSearchParams({ from: range.from, to: range.to, page: String(page) });
    if (type) q.set('type', type);
    return `/reports/day-book?${q.toString()}`;
  };
  const exportQuery = new URLSearchParams({ from: range.from, to: range.to });
  if (type) exportQuery.set('type', type);

  return (
    <div className="screen">
      <ReportHead title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')} export={{ href: `/api/reports/day-book/xlsx?${exportQuery.toString()}`, label: tr('exportXlsx') }} />
      <ReportFilters
        dates={[{ name: 'from', label: tr('from'), value: range.from }, { name: 'to', label: tr('to'), value: range.to }]}
        select={{
          name: 'type', label: t('type'), value: type ?? '',
          options: [{ value: '', label: t('allTypes') }, ...DAY_BOOK_TYPES.map((k) => ({ value: k, label: t(`types.${k}`) }))],
        }}
        datePlaceholder={tr('datePlaceholder')}
        submitLabel={tr('show')}
      />

      {!book ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <Card>
          {book.rows.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
          ) : (
            <LedgerTable
              columns={[
                { header: t('colDate'), nowrap: true },
                { header: t('colEntry'), nowrap: true },
                { header: t('colDoc'), nowrap: true },
                { header: t('colType') },
                { header: t('colNarration') },
                { header: t('colAmount'), numeric: true },
              ]}
              rows={book.rows.map((r) => ({
                key: r.entryId,
                cells: [
                  formatDate(r.date),
                  <span key="n" className="mono">{r.entryNo}</span>,
                  <span key="d" className="mono">{r.docNo ?? '—'}</span>,
                  <span key="t">
                    {t.has(`types.${r.sourceType}`) ? t(`types.${r.sourceType}`) : r.sourceType}
                    {r.isReversal && <> <Chip tone="warn">{t('reversal')}</Chip></>}
                    {r.isReversed && <> <Chip tone="muted">{t('reversed')}</Chip></>}
                  </span>,
                  r.narration ?? '',
                  inr2(r.amount),
                ],
              }))}
            />
          )}
          <nav className="pager" aria-label={t('pagerLabel')}>
            <span>{t('pageOf', { page: book.page, pages: book.pages, total: book.total })}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              {book.page > 1 ? <Link href={params(book.page - 1)}>{t('prev')}</Link> : <span className="off">{t('prev')}</span>}
              {book.page < book.pages ? <Link href={params(book.page + 1)}>{t('next')}</Link> : <span className="off">{t('next')}</span>}
            </span>
          </nav>
          <p className="hint">{t('hint')}</p>
        </Card>
      )}
    </div>
  );
}
