import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { DeleteItemButton, ItemModal, ItemStatusButton, type ItemValues } from '@/components/items/ItemModal';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { requireOwnerPage } from '@/lib/auth/require';
import { inrRate } from '@/lib/format';
import { createClient } from '@/lib/supabase/server';

export default async function ItemsPage({ searchParams }: { searchParams: Promise<{ inactive?: string }> }) {
  await requireOwnerPage();
  const showDisabled = (await searchParams).inactive === '1';
  const t = await getTranslations('items');
  const supabase = await createClient();
  let query = supabase.from('items').select('*').order('category').order('name');
  if (!showDisabled) query = query.eq('is_active', true);
  const { data } = await query;
  const items = data ?? [];

  return (
    <div className="stack">
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Link href={showDisabled ? '/settings/items' : '/settings/items?inactive=1'} className="btn ghost sm">
          {showDisabled ? t('hideDisabled') : t('showDisabled')}
        </Link>
        <span className="headbtns">
          <ItemModal />
        </span>
      </div>
      <Card>
        {items.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('name')}</th><th>{t('category')}</th><th>{t('hsn')}</th><th className="r">{t('gstRate')}</th>
                  <th>{t('baseUom')}</th><th>{t('altUom')}</th><th className="r">{t('reorderLevel')}</th><th className="r">{t('saleRate')}</th><th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const values: ItemValues = {
                    id: i.id, name: i.name, brand: i.brand, category: i.category, hsnCode: i.hsn_code, gstRate: String(i.gst_rate),
                    baseUom: i.base_uom, altUom: i.alt_uom, conversionFactor: i.conversion_factor == null ? null : String(i.conversion_factor),
                    reorderLevel: String(i.reorder_level), saleRate: String(i.sale_rate), isStock: i.is_stock, isActive: i.is_active,
                  };
                  return (
                    <tr key={i.id}>
                      <td>
                        <div className="pname">{i.name}</div>
                        <div className="sub">
                          {[i.brand, i.is_stock ? null : t('stockNo')].filter(Boolean).join(' · ')}
                          {!i.is_active && <> <Chip tone="muted">{t('disabled')}</Chip></>}
                        </div>
                      </td>
                      <td>{t(i.category)}</td>
                      <td className="mono">{i.hsn_code}</td>
                      <td className="r num">{i.gst_rate}%</td>
                      <td>{i.base_uom}</td>
                      <td>{i.alt_uom ? t('altShown', { alt: i.alt_uom, factor: String(i.conversion_factor), base: i.base_uom }) : '—'}</td>
                      <td className="r num">{i.reorder_level}</td>
                      <td className="r num">{inrRate(i.sale_rate)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <ItemModal item={values} triggerClassName="btn ghost sm" />
                          <ItemStatusButton itemId={i.id} isActive={i.is_active} />
                          <DeleteItemButton itemId={i.id} name={i.name} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="hint">{t('hint')}</p>
    </div>
  );
}
