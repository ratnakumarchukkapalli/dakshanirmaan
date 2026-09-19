import { getTranslations } from 'next-intl/server';
import { SideRail } from '@/components/shell/SideRail';
import { TabBar } from '@/components/shell/TabBar';
import { Topbar } from '@/components/shell/Topbar';
import { getShellContext } from '@/lib/shell-context';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [ctx, t] = await Promise.all([getShellContext(), getTranslations('a11y')]);
  return (
    <>
      <a href="#main" className="skip-link">
        {t('skip')}
      </a>
      <Topbar ctx={ctx} />
      <div className="shell">
        <SideRail role={ctx.role} />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <TabBar />
    </>
  );
}
