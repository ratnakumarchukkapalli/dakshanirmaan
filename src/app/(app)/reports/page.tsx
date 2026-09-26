import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';

const CARDS = [
  { key: 'dayClose', href: '/reports/day-close', ownerOnly: false },
  { key: 'dayBook', href: '/reports/day-book', ownerOnly: false },
  { key: 'aging', href: '/reports/aging', ownerOnly: false },
  { key: 'stock', href: '/reports/stock', ownerOnly: false },
  { key: 'cashBank', href: '/reports/cash-bank', ownerOnly: true },
  { key: 'trialBalance', href: '/reports/trial-balance', ownerOnly: true },
  { key: 'pnl', href: '/reports/pnl', ownerOnly: true },
  { key: 'balanceSheet', href: '/reports/balance-sheet', ownerOnly: true },
  { key: 'gst', href: '/reports/gst', ownerOnly: true },
] as const;

/** Card grid of the reports. Each card is a real link (Tab + Enter); the owner-only ones are not offered to a counter. */
export default async function ReportsPage() {
  const [t, member] = await Promise.all([getTranslations('reports'), getCurrentMember()]);
  const isAdmin = isVerifiedAdmin(member);
  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
      </div>
      <nav className="reportcards" aria-label={t('title')}>
        {CARDS.filter((c) => isAdmin || !c.ownerOnly).map((c) => (
          <Link key={c.key} href={c.href} className="rcard">
            <b>{t(`cards.${c.key}.title`)}</b>
            <span>{t(`cards.${c.key}.desc`)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
