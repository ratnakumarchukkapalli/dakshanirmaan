import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SettingsTabs } from '@/components/settings/SettingsTabs';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';

// Owners only. The proxy already turns counter users away; this is the second lock.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  if (!isVerifiedAdmin(await getCurrentMember())) redirect('/');
  const t = await getTranslations('settings');
  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
      </div>
      <SettingsTabs />
      {children}
    </div>
  );
}
