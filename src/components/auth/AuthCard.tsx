import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { BrandMark } from '@/components/shell/icons';
import { GlassPanel } from '@/components/ui/GlassPanel';

/** Glass card that frames every signed-out screen. */
export async function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const tBrand = await getTranslations('brand');
  return (
    <div className="login-wrap">
      <GlassPanel strong className="login-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <BrandMark />
          <div className="brandname" style={{ fontSize: 13 }}>
            {tBrand('name')}
          </div>
        </div>
        <h1 style={{ fontSize: 21, fontWeight: 750, marginBottom: 12 }}>{title}</h1>
        {children}
      </GlassPanel>
    </div>
  );
}
