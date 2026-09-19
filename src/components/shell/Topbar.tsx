import { getLocale, getTranslations } from 'next-intl/server';
import { toggleLocale } from '@/app/actions/locale';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { fyLabel, todayIn } from '@/lib/format';
import { MENU_EXTRAS, NAV_HREF, visibleFor } from '@/lib/nav';
import type { ShellContext } from '@/lib/shell-context';
import { AvatarMenu } from './AvatarMenu';
import { BrandMark } from './icons';
import { ThemeToggle } from './ThemeToggle';

export async function Topbar({ ctx }: { ctx: ShellContext }) {
  const [t, tNav, tRole, tTop, locale] = await Promise.all([
    getTranslations('brand'),
    getTranslations('nav'),
    getTranslations('role'),
    getTranslations('topbar'),
    getLocale(),
  ]);
  const isTelugu = locale === 'te';
  const roleLabel = tRole(ctx.role);
  const initial = (ctx.name.trim()[0] ?? '?').toUpperCase();

  return (
    <GlassPanel as="header" strong className="topbar">
      <div className="tb-left">
        <span className="pill num">{tTop('fy', { label: fyLabel(todayIn(ctx.timeZone)) })}</span>
        {ctx.gstin && (
          <span className="pill num" title={tTop('gstin')}>
            {ctx.gstin}
          </span>
        )}
      </div>
      <div className="tb-center">
        <BrandMark />
        <div>
          <div className="brandname">{t('name')}</div>
          <div className="brandsub">{t('tagline')}</div>
        </div>
      </div>
      <div className="tb-right">
        <span className="pill role">{roleLabel}</span>
        <form action={toggleLocale}>
          <button type="submit" className="iconbtn" lang={isTelugu ? 'en' : 'te'} aria-label={isTelugu ? tTop('languageTe') : tTop('language')} title={isTelugu ? tTop('languageTe') : tTop('language')}>
            {isTelugu ? 'A' : 'అ'}
          </button>
        </form>
        <ThemeToggle label={tTop('theme')} />
        <AvatarMenu
          initial={initial}
          name={ctx.name}
          roleLabel={roleLabel}
          label={tTop('account')}
          signOutLabel={tTop('signOut')}
          items={visibleFor(ctx.role, MENU_EXTRAS).map((key) => ({ href: NAV_HREF[key], label: tNav(key) }))}
        />
      </div>
    </GlassPanel>
  );
}
