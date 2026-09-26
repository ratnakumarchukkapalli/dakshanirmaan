import { getTranslations } from 'next-intl/server';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { NAV_HREF, RAIL_ADMIN, RAIL_MAIN, visibleFor, type NavKey } from '@/lib/nav';
import { NavIcon } from './icons';
import { NavLink } from './NavLink';

export async function SideRail({ role }: { role: 'admin' | 'user' }) {
  const t = await getTranslations('nav');
  const item = (key: NavKey) => (
    <NavLink key={key} href={NAV_HREF[key]}>
      <NavIcon name={key} />
      <span>{t(key)}</span>
    </NavLink>
  );
  return (
    <GlassPanel as="nav" className="rail" aria-label={t('main')}>
      {visibleFor(role, RAIL_MAIN).map(item)}
      <div className="sep" role="separator" />
      {visibleFor(role, RAIL_ADMIN).map(item)}
    </GlassPanel>
  );
}
