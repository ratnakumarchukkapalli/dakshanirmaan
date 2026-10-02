import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { Segmented } from '@/components/ui/Segmented';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { signOf } from '@/lib/decimal';
import { formatDate, inr2, todayIn } from '@/lib/format';
import { loadCashBook } from '@/lib/reports-data';
import { parseRange } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Cash & bank book: one money account at a time, every line with its running balance. Owner only —
// bank balances and payroll cash are not counter-staff data (the proxy, this page, the view and the
// Excel route each refuse a counter on their own).
export default async function CashBankPage({ searchParams }: { searchParams: Promise<{ account?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.cashBook'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  if (!isVerifiedAdmin(member)) redirect('/reports');
  const range = parseRange(sp.from, sp.to, todayIn(ctx.timeZone));

  let book: Awaited<ReturnType<typeof loadCashBook>> | null = null;
  let tooMany = false;
  try {
    book = await loadCashBook(supabase, { account: sp.account, ...range });
  } catch (e) {
    tooMany = e instanceof Error && e.message === 'too_many';
    if (!tooMany) console.error('[reports] cash book failed:', e instanceof Error ? e.message : e);
  }

  const q = (account: string) => new URLSearchParams({ account, from: range.from, to: range.to }).toString();
  return (
    <div className="screen">
      <ReportHead
        title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')}
        export={book ? { href: `/api/reports/cash-bank/xlsx?${q(book.account.id)}`, label: tr('exportXlsx') } : undefined}
      >
        <Link className="btn ghost" href="/reports/reconcile">{t('reconcileLink')}</Link>
      </ReportHead>
      {tooMany ? (
        <ReportError message={t('tooMany')} />
      ) : !book ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          <div className="toolbar">
            <Segmented
              label={t('accountSegments')}
              active={book.account.id}
              options={book.accounts.map((a) => ({ key: a.id, label: a.name, href: `/reports/cash-bank?${q(a.id)}` }))}
            />
          </div>
          <ReportFilters
            dates={[{ name: 'from', label: tr('from'), value: range.from }, { name: 'to', label: tr('to'), value: range.to }]}
            keep={{ account: book.account.id }}
            datePlaceholder={tr('datePlaceholder')}
            submitLabel={tr('show')}
          />
          <div className="tiles">
            <StatTile label={t('opening')} value={inr2(book.opening)} sub={t('openingSub', { date: formatDate(range.from) })} small />
            <StatTile label={t('in')} value={inr2(book.totalIn)} small />
            <StatTile label={t('out')} value={inr2(book.totalOut)} small />
            <StatTile label={t('closing')} value={inr2(book.closing)} tone={signOf(book.closing) === -1 ? 'bad' : undefined} sub={t('closingSub', { date: formatDate(range.to) })} small />
          </div>
          <Card>
            {book.rows.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
            ) : (
              <LedgerTable
                columns={[
                  { header: t('colDate'), nowrap: true },
                  { header: t('colDoc'), nowrap: true },
                  { header: t('colDetails') },
                  { header: t('in'), numeric: true },
                  { header: t('out'), numeric: true },
                  { header: t('colBalance'), numeric: true },
                ]}
                rows={book.rows.map((r) => ({
                  key: r.key,
                  cells: [
                    formatDate(r.date),
                    <span key="d" className="mono">{r.docNo ?? '—'}</span>,
                    <span key="n">{r.narration ?? ''}{r.isReversal && <> <Chip tone="warn">{t('reversal')}</Chip></>}</span>,
                    signOf(r.debit) === 0 ? '' : inr2(r.debit),
                    signOf(r.credit) === 0 ? '' : inr2(r.credit),
                    inr2(r.balance),
                  ],
                }))}
                footer={[t('closing'), '', '', inr2(book.totalIn), inr2(book.totalOut), inr2(book.closing)]}
              />
            )}
            <p className="hint">{t('hint')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
