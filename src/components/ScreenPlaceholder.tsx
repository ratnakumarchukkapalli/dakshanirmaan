import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';

export type ScreenKey =
  | 'dashboard' | 'sales' | 'purchases' | 'payments' | 'parties' | 'stock' | 'staff' | 'reports' | 'settings';

/** Empty screen shown until the real one is built. Replaced page by page in later changes. */
export async function ScreenPlaceholder({ screen }: { screen: ScreenKey }) {
  const [tScreen, tPlaceholder] = await Promise.all([getTranslations('screens'), getTranslations('placeholder')]);
  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{tScreen(screen)}</h1>
        <Chip tone="muted">{tPlaceholder('title')}</Chip>
      </div>
      <Card>
        <p className="muted" style={{ margin: 0 }}>
          {tPlaceholder('body')}
        </p>
      </Card>
    </div>
  );
}
