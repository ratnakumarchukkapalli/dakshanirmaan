import { getTranslations } from 'next-intl/server';
import { DayCloseForm } from '@/components/reports/DayCloseForm';
import { ReopenDay } from '@/components/reports/ReopenDay';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { ReportError, ReportHead } from '@/components/reports/ReportHead';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable } from '@/components/ui/LedgerTable';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { signOf } from '@/lib/decimal';
import { formatDate, inr2, todayIn } from '@/lib/format';
import { loadDayClose, type DayCloseRow } from '@/lib/reports-data';
import { closeBlock, parseCloseDate } from '@/lib/reports-math';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

// Day close: the counter counts the drawer; the database says what should be in it. Both roles close
// a day; only an owner reopens one. The figures are `day_close_preview` (open day) or the stored row.
export default async function DayClosePage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const sp = await searchParams;
  const [t, tr, member, ctx, supabase] = await Promise.all([
    getTranslations('reports.dayClose'), getTranslations('reports'), getCurrentMember(), getShellContext(), createClient(),
  ]);
  const isAdmin = isVerifiedAdmin(member);
  const today = todayIn(ctx.timeZone);
  const date = parseCloseDate(sp.date, today);

  let screen: Awaited<ReturnType<typeof loadDayClose>> | null = null;
  try {
    screen = await loadDayClose(supabase, date);
  } catch (e) {
    console.error('[reports] day close failed:', e instanceof Error ? e.message : e);
  }

  // Why this day cannot be closed from here (a later day is already closed, or a counter asking for an older day).
  const latestClose = screen?.recent[0]?.closeDate ?? null;
  const block = screen && !screen.live ? closeBlock({ date, today, latestClose, isAdmin }) : null;
  // Reopening an earlier day while a later one stays closed is refused: reopen the later one first.
  const laterExists = !!screen?.live && latestClose !== null && latestClose > screen.live.closeDate;
  // The moment a close happened, as a date in the organisation's time zone (not UTC).
  const localDay = (iso: string) => formatDate(todayIn(ctx.timeZone, new Date(iso)));

  const differenceChip = (r: DayCloseRow) => {
    const s = signOf(r.difference);
    return s === 0 ? <Chip tone="good">{t('diffNone')}</Chip>
      : s === -1 ? <Chip tone="bad">{t('diffShort', { amount: inr2(r.difference.replace('-', '')) })}</Chip>
      : <Chip tone="warn">{t('diffOver', { amount: inr2(r.difference) })}</Chip>;
  };

  return (
    <div className="screen">
      <ReportHead title={t('title')} subtitle={t('subtitle')} backLabel={tr('back')} />
      <ReportFilters dates={[{ name: 'date', label: t('date'), value: date }]} datePlaceholder={tr('datePlaceholder')} submitLabel={tr('show')} />

      {!screen ? (
        <ReportError message={tr('loadError')} />
      ) : (
        <>
          {screen.live ? (
            <Card>
              <div className="cardtitle">{t('closedTitle', { date: formatDate(screen.live.closeDate) })}</div>
              <div className="tiles">
                <StatTile label={t('expected')} value={inr2(screen.live.expected)} small />
                <StatTile label={t('counted')} value={inr2(screen.live.counted)} small />
                <StatTile label={t('difference')} value={differenceChip(screen.live)} small />
              </div>
              <p className="hint">
                {screen.live.closedByName
                  ? t('closedBy', { name: screen.live.closedByName, at: localDay(screen.live.closedAt) })
                  : t('closedAt', { at: localDay(screen.live.closedAt) })}
                {screen.live.note ? ` · ${screen.live.note}` : ''}
              </p>
              {!isAdmin ? <p className="hint">{t('reopenOwnerOnly')}</p>
                : laterExists ? <p className="hint">{t('reopenLaterFirst', { date: formatDate(latestClose!) })}</p>
                : <ReopenDay id={screen.live.id} />}
            </Card>
          ) : (
            <>
              <div className="tiles">
                <StatTile label={t('opening')} value={inr2(screen.preview.openingCash)} small />
                <StatTile label={t('cashIn')} value={inr2(screen.preview.cashIn)} small />
                <StatTile label={t('cashOut')} value={inr2(screen.preview.cashOut)} small />
                <StatTile label={t('deposited')} value={inr2(screen.preview.deposited)} small />
                <StatTile label={t('expectedNow')} value={inr2(screen.preview.expected)} sub={t('expectedSub')} small />
              </div>
              <Card>
                <div className="cardtitle">{t('countTitle', { date: formatDate(date) })}</div>
                {block ? (
                  <p className="alert warn" role="status">{block === 'later_close' ? t('blockedLater', { date: formatDate(latestClose!) }) : t('blockedOld')}</p>
                ) : (
                  <DayCloseForm date={date} expected={screen.preview.expected} />
                )}
              </Card>
            </>
          )}

          <Card>
            <div className="cardtitle">{t('recentTitle')}</div>
            {screen.recent.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>{t('recentEmpty')}</p>
            ) : (
              <LedgerTable
                columns={[
                  { header: t('colDate'), nowrap: true },
                  { header: t('expected'), numeric: true },
                  { header: t('counted'), numeric: true },
                  { header: t('difference') },
                ]}
                rows={screen.recent.map((r) => ({
                  key: r.id,
                  href: `/reports/day-close?date=${r.closeDate}`,
                  cells: [formatDate(r.closeDate), inr2(r.expected), inr2(r.counted), differenceChip(r)],
                }))}
              />
            )}
            <p className="hint">{t('snapshotNote')}</p>
          </Card>
        </>
      )}
    </div>
  );
}
