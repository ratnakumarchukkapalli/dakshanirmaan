import { getTranslations } from 'next-intl/server';
import { NavLink } from '@/components/shell/NavLink';

const TABS = [
  { key: 'organisation', href: '/settings/organisation' },
  { key: 'users', href: '/settings/users' },
  { key: 'items', href: '/settings/items' },
  { key: 'coa', href: '/settings/chart-of-accounts' },
  { key: 'periods', href: '/settings/period-locks' },
  { key: 'audit', href: '/settings/audit-trail' },
  { key: 'cutover', href: '/settings/cutover' },
  { key: 'export', href: '/settings/export' },
] as const;

export async function SettingsTabs() {
  const t = await getTranslations('settings.tabs');
  return (
    <nav className="settings-nav" aria-label={t('label')}>
      {TABS.map((tab) => (
        <NavLink key={tab.key} href={tab.href}>
          {t(tab.key)}
        </NavLink>
      ))}
    </nav>
  );
}
