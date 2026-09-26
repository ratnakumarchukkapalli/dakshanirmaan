import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { ItemModal } from '@/components/items/ItemModal';
import { RowLink } from '@/components/sales/RowLink';
import { ReceiveButton, StockActions } from '@/components/stock/StockActions';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/SearchInput';
import { Segmented } from '@/components/ui/Segmented';
import { StatTile } from '@/components/ui/StatTile';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { inr, inr2, inrRate, formatDate } from '@/lib/format';
import { cleanSearchText } from '@/lib/search';
import { loadStockSummary, type StockLevel } from '@/lib/stock-data';
import { createClient } from '@/lib/supabase/server';
import { baseToAlt, qtyDisplay, trimZeros } from '@/lib/units';

const LEVEL_TONE: Record<StockLevel, ChipTone> = { ok: 'good', low: 'warn', out: 'bad', none: 'muted' };

export default async function StockPage({ searchParams }: { searchParams: Promise<{ wh?: string; q?: string }> }) {
  const sp = await searchParams;
  const q = cleanSearchText(sp.q);
  const [t, member, supabase] = await Promise.all([getTranslations('stock'), getCurrentMember(), createClient()]);
  const isAdmin = isVerifiedAdmin(member);

  const s = await loadStockSummary(supabase, { warehouse: sp.wh, isAdmin, q });
  const defaultGodown = s.godowns.find((g) => g.isDefault)?.id ?? s.godowns[0]?.id ?? '';
  const godownName = s.selected === 'all' ? t('allGodowns') : (s.godowns.find((g) => g.id === s.selected)?.name ?? '');

  const href = (wh: string) => {
    const params = new URLSearchParams();
    params.set('wh', wh);
    if (q) params.set('q', q);
    return `/stock?${params.toString()}`;
  };
  const levelLabel: Record<StockLevel, string> = { ok: t('levelOk'), low: t('levelLow'), out: t('levelOut'), none: t('levelNone') };
  // The ledger opens in the godown being looked at; "All" has no single running balance, so it opens the default godown.
  const ledgerWh = s.selected === 'all' ? defaultGodown : s.selected;

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{isAdmin ? t('subtitleAdmin') : t('subtitle')}</span>
        {isAdmin && (
          <span className="headbtns">
            <StockActions items={s.form.items} godowns={s.godowns} today={s.today} defaultGodown={s.selected === 'all' ? defaultGodown : s.selected} />
            <ItemModal />
          </span>
        )}
      </div>

      <div className="toolbar">
        <Segmented
          label={t('godownSegments')}
          active={s.selected}
          options={[...s.godowns.map((g) => ({ key: g.id, label: g.name, href: href(g.id) })), { key: 'all', label: t('allGodowns'), href: href('all') }]}
        />
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} keep={{ wh: s.selected }} />
      </div>

      <div className="tiles">
        {isAdmin && s.tiles.value !== null ? (
          <StatTile label={t('tileOnHand', { godown: godownName })} value={inr(s.tiles.value)} sub={t('tileItems', { count: s.tiles.itemCount })} small />
        ) : (
          <StatTile label={t('tileItemsLabel', { godown: godownName })} value={String(s.tiles.itemCount)} small />
        )}
        {s.tiles.cement && <StatTile label={t('tileCement')} value={`${qtyDisplay(s.tiles.cement.qty)} ${s.tiles.cement.uom}`} small />}
        {s.tiles.steel && (
          <StatTile
            label={t('tileSteel')}
            value={s.tiles.steel.tonnes ? t('tonnes', { qty: s.tiles.steel.tonnes }) : `${qtyDisplay(s.tiles.steel.qty)} ${s.tiles.steel.uom}`}
            small
          />
        )}
        <StatTile
          label={t('tileTransit')}
          value={String(s.tiles.inTransit.transfers)}
          sub={isAdmin && s.tiles.inTransit.value !== null ? t('tileTransitValue', { value: inr(s.tiles.inTransit.value) }) : t('tileTransitSub')}
          small
        />
      </div>

      {s.transfers.length > 0 && (
        <Card>
          <div className="cardtitle">{t('transitTitle')}</div>
          <div className="stack">
            {s.transfers.map((tr) => (
              <div key={tr.id} className="lrow">
                <div className="lhead">
                  <div className="litem">
                    <b className="mono">{tr.transferNo ?? '—'}</b>
                    <div className="sub">
                      {t('transitRoute', { from: tr.fromName, to: tr.toName })} · {formatDate(tr.transferDate)}
                      {tr.vehicleNo ? ` · ${tr.vehicleNo}` : ''}
                    </div>
                    <div className="sub">{tr.lines.map((l) => `${l.itemName} ${qtyDisplay(l.qty)} ${l.uom}`).join(', ')}</div>
                  </div>
                  {isAdmin && <ReceiveButton id={tr.id} />}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        {s.rows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('colItem')}</th><th>{t('colHsn')}</th><th className="r">{t('colStock')}</th>
                  {isAdmin && <><th className="r">{t('colAvg')}</th><th className="r">{t('colValue')}</th></>}
                  <th>{t('colLevel')}</th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => {
                  const pcs = r.item.altUom && r.item.factor ? baseToAlt(r.item.factor, r.qty) : null;
                  const target = `/stock/${r.item.id}${ledgerWh ? `?wh=${ledgerWh}` : ''}`;
                  return (
                    <RowLink key={r.item.id} href={target}>
                      <td>
                        <div className="pname"><Link href={target}>{r.item.name}</Link></div>
                        {r.item.brand && <div className="sub">{r.item.brand}</div>}
                      </td>
                      <td className="mono">{r.item.hsn}</td>
                      <td className="r num">
                        {qtyDisplay(r.qty)} {r.item.baseUom}
                        {pcs && <div className="sub">{t('aboutPcs', { qty: qtyDisplay(pcs), uom: r.item.altUom ?? '' })}</div>}
                      </td>
                      {isAdmin && (
                        <>
                          <td className="r num">{r.avgRate === null ? '—' : inrRate(r.avgRate)}</td>
                          <td className="r num">{r.value === null ? '—' : inr2(r.value)}</td>
                        </>
                      )}
                      <td>
                        <Chip tone={LEVEL_TONE[r.level]}>
                          {r.level === 'low' ? t('levelLowAt', { qty: trimZeros(r.item.reorderLevel) }) : levelLabel[r.level]}
                        </Chip>
                      </td>
                    </RowLink>
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
