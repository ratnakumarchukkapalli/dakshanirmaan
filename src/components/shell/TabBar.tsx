import { getTranslations } from 'next-intl/server';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { NAV_HREF, TABS } from '@/lib/nav';
import { NavIcon } from './icons';
import { NavLink } from './NavLink';

export async function TabBar() {
  const t = await getTranslations('tabs');
  return (
    <GlassPanel as="nav" className="tabbar" aria-label={t('label')}>
      {TABS.map(({ key, label }) => (
        <NavLink key={key} href={NAV_HREF[key]}>
          <NavIcon name={key} size={20} />
          <span>{t(label)}</span>
        </NavLink>
      ))}
    </GlassPanel>
  );
}
