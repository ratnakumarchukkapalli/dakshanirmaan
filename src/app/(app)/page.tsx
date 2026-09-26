import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AttentionList } from '@/components/dashboard/AttentionList';
import { SalesChart } from '@/components/dashboard/SalesChart';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import {
  loadAttention, loadBalances, loadBooksDifference, loadCashBank, loadDayClose, loadSalesWeek, loadStockValue, settle,
} from '@/lib/dashboard-data';
import { signOf } from '@/lib/decimal';
import { formatDate, inr, inr2, todayIn } from '@/lib/format';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

const QUICK = [
  { key: 'invoice', href: '/sales/new', glyph: '+' },
  { key: 'receipt', href: '/payments/new', glyph: '₹' },
  { key: 'challan', href: '/sales/challans/new', glyph: '⇥' },
  { key: 'dayclose', href: '/reports/day-close', glyph: '☾' },
] as const;

/** A tile whose query failed: a visible error, never an empty tile. */
function ErrorTile({ label, message }: { label: string; message: string }) {
  return (
    <div className="tile tile-error" role="status">
      <div className="lbl">{label}</div>
      <div className="val">{message}</div>
    </div>
  );
}

/**
 * Dashboard: a server component. Every figure comes from a database view (see
 * src/lib/dashboard-data.ts); a counter session never queries the owner-only ones (stock cost,
 * cash and bank, payables, trial balance), so their figures are not in the page at all.
 */
export default async function DashboardPage() {
  const [t, locale, ctx, member, supabase] = await Promise.all([
    getTranslations('dashboard'), getLocale(), getShellContext(), getCurrentMember(), createClient(),
  ]);
  const isAdmin = isVerifiedAdmin(member);
  const today = todayIn(ctx.timeZone);

  const [sales, balances, attention, dayClose, cashBank, stockValue, books] = await Promise.all([
    settle('sales', () => loadSalesWeek(supabase, today)),
    settle('balances', () => loadBalances(supabase, isAdmin)),
    settle('attention', () => loadAttention(supabase)),
    settle('day close', () => loadDayClose(supabase)),
    isAdmin ? settle('cash and bank', () => loadCashBank(supabase)) : null,
    isAdmin ? settle('stock value', () => loadStockValue(supabase)) : null,
    isAdmin ? settle('books balanced', () => loadBooksDifference(supabase)) : null,
  ]);

  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${today}T00:00:00Z`));
  const errorMessage = t('tile.error');

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title', { weekday, date: formatDate(today) })}</h1>
        <span className="headbtns">
          {dayClose.ok && <DayCloseChip status={dayClose.data} today={today} t={t} />}
          {books?.ok && (
            signOf(books.data) === 0
              ? <Chip tone="good">{t('booksBalanced')}</Chip>
              : <Chip tone="bad">{t('booksDiff', { amount: inr2(books.data) })}</Chip>
          )}
        </span>
      </div>

      <nav className="quick" aria-label={t('quick.label')}>
        {QUICK.map((q) => (
          <Link key={q.key} href={q.href}>
            <span className="k" aria-hidden="true">{q.glyph}</span>
            {t(`quick.${q.key}`)}
          </Link>
        ))}
      </nav>

      <div className="tiles">
        {sales.ok ? (
          <StatTile
            hero
            label={t('tile.today')}
            value={inr(sales.data.days[sales.data.days.length - 1]!.total)}
            sub={t('tile.todaySub', { count: sales.data.days[sales.data.days.length - 1]!.invoices, drafts: sales.data.drafts })}
          />
        ) : (
          <ErrorTile label={t('tile.today')} message={errorMessage} />
        )}

        {balances.ok ? (
          <StatTile
            label={t('tile.collect')}
            value={inr(balances.data.toCollect)}
            sub={
              !attention.ok ? errorMessage
                : attention.data.overdue.parties > 0
                  ? t('tile.collectOverdue', { amount: inr(attention.data.overdue.amount), count: attention.data.overdue.parties })
                  : t('tile.collectNone')
            }
            subTone={attention.ok && attention.data.overdue.parties > 0 ? 'bad' : undefined}
          />
        ) : (
          <ErrorTile label={t('tile.collect')} message={errorMessage} />
        )}

        {isAdmin && (balances.ok ? (
          <StatTile
            label={t('tile.pay')}
            value={inr(balances.data.toPay)}
            sub={t('tile.paySub', { count: balances.data.suppliersOwed ?? 0 })}
          />
        ) : (
          <ErrorTile label={t('tile.pay')} message={errorMessage} />
        ))}

        {cashBank && (cashBank.ok ? (
          <StatTile
            label={t('tile.cash')}
            value={inr(cashBank.data.total)}
            sub={cashBank.data.cash !== null ? t('tile.cashDrawer', { amount: inr(cashBank.data.cash) }) : undefined}
            subTone={cashBank.data.cash === null ? undefined : signOf(cashBank.data.cash) === -1 ? 'bad' : 'good'}
          />
        ) : (
          <ErrorTile label={t('tile.cash')} message={errorMessage} />
        ))}

        {stockValue && (stockValue.ok ? (
          <StatTile label={t('tile.stock')} value={inr(stockValue.data.onHand)} sub={t('tile.stockSub', { amount: inr(stockValue.data.inTransit) })} />
        ) : (
          <ErrorTile label={t('tile.stock')} message={errorMessage} />
        ))}

        {attention.ok ? (
          <StatTile
            label={t('tile.low')}
            value={t('tile.lowValue', { count: attention.data.lowStock.count })}
            sub={
              attention.data.lowStock.count === 0
                ? t('tile.lowNone')
                : attention.data.lowStock.count > 2
                  ? t('tile.lowMore', { names: attention.data.lowStock.names.slice(0, 2).join(', '), more: attention.data.lowStock.count - 2 })
                  : attention.data.lowStock.names.join(', ')
            }
            subTone={attention.data.lowStock.count === 0 ? 'good' : 'warn'}
          />
        ) : (
          <ErrorTile label={t('tile.low')} message={errorMessage} />
        )}
      </div>

      <div className="dash-grid">
        <Card>
          <div className="cardtitle">{t('chartTitle')}</div>
          {sales.ok ? (
            <>
              <SalesChart days={sales.data.days} />
              <p className="hint">{t('chartNote')}</p>
            </>
          ) : (
            <p className="alert bad" role="status">{t('sectionError')}</p>
          )}
        </Card>
        <Card>
          <div className="cardtitle">{t('attention.title')}</div>
          {attention.ok ? <AttentionList rows={attention.data.rows} /> : <p className="alert bad" role="status">{t('sectionError')}</p>}
        </Card>
      </div>
    </div>
  );
}

function DayCloseChip({ status, today, t }: {
  status: { last: { date: string; difference: string } | null };
  today: string;
  t: Awaited<ReturnType<typeof getTranslations<'dashboard'>>>;
}) {
  const last = status.last;
  if (last && last.date === today) {
    return signOf(last.difference) === 0
      ? <Chip tone="good">{t('dayClosed')}</Chip>
      : <Chip tone="warn">{t('dayClosedDiff', { amount: inr2(last.difference) })}</Chip>;
  }
  return <Chip tone="muted">{last ? t('dayOpenLast', { date: formatDate(last.date) }) : t('dayNever')}</Chip>;
}
