import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { LedgerTable, type LedgerTableRow } from '@/components/ui/LedgerTable';
import { Segmented } from '@/components/ui/Segmented';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { one } from '@/lib/db';
import { signOf } from '@/lib/decimal';
import { formatDate, inr2, inrRate, todayIn } from '@/lib/format';
import { fyName, fyRange, fyStartYear, parseFyParam } from '@/lib/fy';
import { documentHref } from '@/lib/party-ledger';
import { loadItemLedger } from '@/lib/stock-data';
import { averageRate } from '@/lib/stock-math';
import { createClient } from '@/lib/supabase/server';
import { baseToAlt, qtyDisplay } from '@/lib/units';

// One item's movement ledger in one godown: every movement links back to its document. A counter
// session sees quantities only; rate, value and the running average are owner-only.
export default async function ItemLedgerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ wh?: string; fy?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, member, supabase] = await Promise.all([getTranslations('stock'), getCurrentMember(), createClient()]);
  const isAdmin = isVerifiedAdmin(member);

  const org = one(await supabase.from('organization').select('timezone').maybeSingle(), 'organization');
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');
  const currentFy = fyStartYear(today);
  const fy = parseFyParam(sp.fy, currentFy);

  const ledger = await loadItemLedger(supabase, id, { warehouse: sp.wh, fy: fy === 'all' ? null : fyRange(fy), isAdmin });
  if (!ledger) notFound();
  const { item } = ledger;
  const godownName = ledger.godowns.find((g) => g.id === ledger.warehouseId)?.name ?? '';
  const fyParam = fy === 'all' ? 'all' : String(fy);
  const href = (wh: string, f: string) => `/stock/${id}?wh=${wh}&fy=${f}`;

  const pcs = item.altUom && item.factor ? baseToAlt(item.factor, ledger.closing.qty) : null;
  const qtyOrBlank = (v: string) => (signOf(v) === 0 ? '' : qtyDisplay(v.replace(/^-/, '')));

  const columns = [
    { header: t('lcDate'), nowrap: true }, { header: t('lcDocument'), nowrap: true }, { header: t('lcIn'), numeric: true }, { header: t('lcOut'), numeric: true },
    ...(isAdmin ? [{ header: t('lcRate'), numeric: true }] : []),
    { header: t('lcBalance'), numeric: true },
    ...(isAdmin ? [{ header: t('lcAvg'), numeric: true }] : []),
  ];
  const avg = (value: string | null, qty: string) => (value === null ? '' : signOf(qty) === 0 ? '' : inrRate(averageRate(value, qty) ?? '0'));

  const rows: LedgerTableRow[] = [];
  if (ledger.broughtForward && ledger.period) {
    rows.push({
      key: 'bf', variant: 'bf',
      cells: [
        <span key="d" className="num">{formatDate(ledger.period.from)}</span>, t('broughtForward'), '', '',
        ...(isAdmin ? [''] : []), <b key="b">{qtyDisplay(ledger.broughtForward.qty)}</b>,
        ...(isAdmin ? [avg(ledger.broughtForward.value, ledger.broughtForward.qty)] : []),
      ],
    });
  }
  for (const l of ledger.lines) {
    const inbound = signOf(l.qty) === 1;
    const link = documentHref(l.sourceType, l.sourceId);
    const label = l.docNo ?? t(`source.${l.sourceType}` as never);
    rows.push({
      key: l.key, href: link,
      cells: [
        <span key="d" className="num">{formatDate(l.date)}</span>,
        <span key="doc">
          {link ? <Link href={link} className="mono rownum">{label}</Link> : <span className="mono">{label}</span>}
          {l.isReversal && <> <Chip tone="warn">{t('reversal')}</Chip></>}
        </span>,
        inbound ? <span key="i" className="amt good">{qtyOrBlank(l.qty)}</span> : '',
        !inbound && signOf(l.qty) === -1 ? <span key="o" className="amt bad">{qtyOrBlank(l.qty)}</span> : '',
        ...(isAdmin ? [l.rate === null ? '' : inrRate(l.rate)] : []),
        <b key="b">{qtyDisplay(l.runningQty)}</b>,
        ...(isAdmin ? [avg(l.runningValue, l.runningQty)] : []),
      ],
    });
  }

  return (
    <div className="screen stack">
      <div className="ledgerhead" style={{ marginBottom: 0 }}>
        <Link href={`/stock?wh=${ledger.warehouseId}`} className="backbtn">← {t('backAll')}</Link>
        <div>
          <h1>{item.name}</h1>
          <span className="sub">
            {[t('hsn', { hsn: item.hsn }), godownName, isAdmin ? t('weightedAverage') : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        <span className="balpill num">
          {qtyDisplay(ledger.closing.qty)} {item.baseUom}
          {pcs && ` (${t('aboutPcs', { qty: qtyDisplay(pcs), uom: item.altUom ?? '' })})`}
          {isAdmin && ledger.closing.value !== null && ` · ${inr2(ledger.closing.value)}`}
        </span>
      </div>

      <div className="toolbar">
        <Segmented
          label={t('godownSegments')}
          active={ledger.warehouseId}
          options={ledger.godowns.map((g) => ({ key: g.id, label: g.name, href: href(g.id, fyParam) }))}
        />
        <Segmented
          label={t('fySegments')}
          active={fyParam}
          options={[
            { key: String(currentFy), label: fyName(currentFy), href: href(ledger.warehouseId, String(currentFy)) },
            { key: String(currentFy - 1), label: fyName(currentFy - 1), href: href(ledger.warehouseId, String(currentFy - 1)) },
            { key: 'all', label: t('fyAll'), href: href(ledger.warehouseId, 'all') },
          ]}
        />
      </div>

      <Card>
        {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t('ledgerEmpty')}</p> : <LedgerTable columns={columns} rows={rows} />}
        {ledger.truncated && <p className="alert warn" style={{ marginTop: 12 }}>{t('ledgerTruncated')}</p>}
      </Card>
      <p className="hint">{t('ledgerHint')}</p>
    </div>
  );
}
