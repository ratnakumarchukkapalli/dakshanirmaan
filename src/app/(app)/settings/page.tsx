import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ScreenPlaceholder } from '@/components/ScreenPlaceholder';
import { Card } from '@/components/ui/Card';

// Only the Users tab exists so far; the other settings tabs arrive with change 09.
export default async function Page() {
  const t = await getTranslations('users');
  return (
    <div className="stack">
      <ScreenPlaceholder screen="settings" />
      <Card>
        <Link href="/settings/users">{t('title')}</Link>
      </Card>
    </div>
  );
}
