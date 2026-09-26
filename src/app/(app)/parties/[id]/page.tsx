import { createTranslator } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PartyModal } from '@/components/parties/PartyModal';
import { PartyStatusButton } from '@/components/parties/PartyStatusButton';
import { SitesPanel, type Site } from '@/components/parties/SitesPanel';
import { AgeingTiles } from '@/components/ui/AgeingTiles';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { KeyValue } from '@/components/ui/KeyValue';
import { LedgerTable, type LedgerTableRow } from '@/components/ui/LedgerTable';
import { Segmented } from '@/components/ui/Segmented';
import { SiteChips } from '@/components/ui/SiteChips';
import { bucketOpen, emptyBuckets, type BucketTotals } from '@/lib/ageing';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { one, rows as dbRows } from '@/lib/db';
import { decimalText, signOf } from '@/lib/decimal';
import { formatDate, inr2, todayIn } from '@/lib/format';
import { fyName, fyStartYear, parseFyParam } from '@/lib/fy';
import { stateName } from '@/lib/gst';
import { documentHref, loadPartyLedger } from '@/lib/party-ledger';
import { reminderUrl } from '@/lib/party-reminder';
import { createClient } from '@/lib/supabase/server';
import en from '@/messages/en.json';

const d2 = (v: unknown) => decimalText(v as number | string | null, 2);

// Party ledger: balance, delivery-site chips, ageing tiles, the ledger itself (a financial year at
// a time), statement exports and a WhatsApp reminder; below, the master details and the sites panel.
export default async function PartyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fy?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [t, ts, member, supabase] = await Promise.all([getTranslations('parties'), getTranslations('statement'), getCurrentMember(), createClient()]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const orgRes = await supabase.from('organization').select('state_code, timezone, legal_name, trade_name').maybeSingle();
  const org = one(orgRes, 'organization');
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');
  const currentFy = fyStartYear(today);
  const fy = parseFyParam(sp.fy, currentFy);

  const ledger = await loadPartyLedger(supabase, id, fy);
  if (!ledger) notFound();

  const [pRes, addrRes, balRes, agingRes, openPurchaseRes] = await Promise.all([
    supabase
      .from('parties')
      .select('id, name, type, gstin, state_code, phone, whatsapp_phone, credit_limit, credit_days, interest_rate_pm, is_active, is_walk_in, default_site_id')
      .eq('id', id)
      .maybeSingle(),
    supabase.from('party_addresses').select('id, label, state_code, is_default, address').eq('party_id', id).order('created_at'),
    supabase.from('v_party_balances').select('ar_balance, ap_balance').eq('party_id', id).maybeSingle(),
    supabase.from('v_party_aging').select('bucket_0_30, bucket_31_60, bucket_61_90, bucket_90_plus, unallocated, interest, other_ar').eq('party_id', id).maybeSingle(),
    supabase.from('v_open_purchase_invoices').select('age_days, open_amount').eq('party_id', id),
  ]);
  const p = one(pRes, 'party');
  if (!p || p.type === 'employee') notFound();
  const addresses = dbRows(addrRes, 'party addresses');
  const bal = one(balRes, 'party balance');
  const aging = one(agingRes, 'party ageing');
  const openPurchases = dbRows(openPurchaseRes, 'open purchase invoices');

  const isAdmin = isVerifiedAdmin(member);
  const sites: Site[] = addresses.map((a) => {
    const ad = (a.address ?? {}) as Record<string, string | null>;
    return {
      id: a.id, label: a.label, line1: ad.line1 ?? '', line2: ad.line2 ?? null, city: ad.city ?? '', district: ad.district ?? null,
      pincode: ad.pincode ?? '', stateCode: a.state_code, isBilling: a.is_default,
    };
  });
  const typeLabel = { customer: t('typeCustomer'), supplier: t('typeSupplier'), both: t('typeBoth') } as const;
  const dash = '—';

  const ar = d2(bal?.ar_balance ?? 0);
  const ap = d2(bal?.ap_balance ?? 0);
  const both = p.type === 'both';
  const showAr = p.type !== 'supplier';
  const showAp = p.type !== 'customer';

  // Balance pill: what they owe us, what we owe them, or settled. Colour follows the words, never replaces them.
  const pill: { text: string; tone: 'good' | 'warn' | 'bad' }[] = [];
  if (showAr && signOf(ar) === 1) pill.push({ text: t('pillCollect', { amount: inr2(ar) }), tone: 'good' });
  if (showAr && signOf(ar) === -1) pill.push({ text: t('pillAdvance', { amount: inr2(ar.slice(1)) }), tone: 'warn' });
  if (showAp && signOf(ap) === 1) pill.push({ text: t('pillPay', { amount: inr2(ap) }), tone: 'bad' });
  if (showAp && signOf(ap) === -1) pill.push({ text: t('pillPaidAhead', { amount: inr2(ap.slice(1)) }), tone: 'warn' });

  // Receivable ageing from v_party_aging; payable ageing bucketed here from the open bills.
  const arBuckets: BucketTotals = aging
    ? { b0_30: d2(aging.bucket_0_30), b31_60: d2(aging.bucket_31_60), b61_90: d2(aging.bucket_61_90), b90_plus: d2(aging.bucket_90_plus) }
    : emptyBuckets();
  const apBuckets = bucketOpen(openPurchases.map((r) => ({ ageDays: Number(r.age_days), openAmount: d2(r.open_amount) })));
  const ageLabels = { b0_30: t('age0_30'), b31_60: t('age31_60'), b61_90: t('age61_90'), b90_plus: t('age90plus') };
  const arExtra: { label: string; value: string; sub?: string }[] = [];
  // Receivable held on the control account that no invoice or receipt explains (opening balance, manual
  // journal, unlinked credit note); without this tile the four buckets would not add up to "To collect".
  // Signed: a credit opening shows as a negative amount.
  if (aging && signOf(d2(aging.other_ar)) !== 0) arExtra.push({ label: t('tileOpening'), value: inr2(d2(aging.other_ar)), sub: t('tileOpeningSub') });
  if (aging && signOf(d2(aging.unallocated)) === 1) arExtra.push({ label: t('tileOnAccount'), value: inr2(d2(aging.unallocated)), sub: t('tileOnAccountSub') });
  if (aging && signOf(d2(aging.interest)) === 1) arExtra.push({ label: t('tileInterest'), value: inr2(d2(aging.interest)), sub: t('tileInterestSub') });

  // WhatsApp reminder: a receivable to chase and a WhatsApp mobile to send it to. The text is
  // customer-facing, so it is always English (same as the invoice share).
  const seller = org?.trade_name || org?.legal_name || '';
  const reminderText = createTranslator({ locale: 'en', messages: en, namespace: 'statement' })('reminder', {
    name: p.name, amount: inr2(ar), seller, date: formatDate(today),
  });
  const reminder = showAr && signOf(ar) === 1 ? reminderUrl(p.whatsapp_phone, reminderText) : null;

  const fyParam = fy === 'all' ? 'all' : String(fy);
  const fyHref = (v: string) => `/parties/${id}?fy=${v}`;
  const exportHref = (ext: 'xlsx' | 'pdf') => `/api/parties/${id}/statement.${ext}?fy=${fyParam}`;

  const acctLabel = (k: 'ar' | 'ap') => (k === 'ar' ? ts('receivable') : ts('payable'));
  const showDoc = (r: { docNo: string | null; sourceType: string; sourceId: string | null }) => {
    const href = documentHref(r.sourceType, r.sourceId);
    const text = r.docNo ?? t(`source.${r.sourceType}` as never);
    return href ? <Link href={href} className="mono rownum">{text}</Link> : <span className="mono">{text}</span>;
  };
  const money = (v: string) => (signOf(v) === 0 ? '' : inr2(v));

  const columns = [
    { header: ts('date'), nowrap: true }, { header: ts('document'), nowrap: true }, ...(both ? [{ header: ts('account') }] : []),
    { header: ts('details') }, { header: ts('debit'), numeric: true }, { header: ts('credit'), numeric: true }, { header: ts('balance'), numeric: true },
  ];
  const tableRows: LedgerTableRow[] = [];
  if (ledger.period) {
    for (const k of ['ar', 'ap'] as const) {
      const bf = ledger.broughtForward[k];
      if (bf === undefined) continue;
      tableRows.push({
        key: `bf-${k}`, variant: 'bf',
        cells: [
          <span key="d" className="num">{formatDate(ledger.period.from)}</span>, ts('broughtForward'),
          ...(both ? [acctLabel(k)] : []), '', '', '', <b key="b">{inr2(bf)}</b>,
        ],
      });
    }
  }
  for (const r of ledger.rows) {
    tableRows.push({
      key: r.key,
      href: documentHref(r.sourceType, r.sourceId),
      cells: [
        <span key="d" className="num">{formatDate(r.date)}</span>, showDoc(r),
        ...(both ? [<Chip key="a" tone="muted">{acctLabel(r.accountKey)}</Chip>] : []),
        <span key="n" className="muted">{r.narration}{r.isReversal ? <> <Chip tone="warn">{ts('reversal')}</Chip></> : null}</span>,
        money(r.debit), money(r.credit), <b key="b">{inr2(r.balance)}</b>,
      ],
    });
  }
  const closingEntries = (['ar', 'ap'] as const).filter((k) => ledger.closing[k] !== undefined);
  const footer = closingEntries.length === 1
    ? ['', ts('closing'), ...(both ? [acctLabel(closingEntries[0]!)] : []), '', '', '', inr2(ledger.closing[closingEntries[0]!]!)]
    : null;

  return (
    <div className="screen stack">
      <div className="ledgerhead" style={{ marginBottom: 0 }}>
        <Link href="/parties" className="backbtn">← {t('back')}</Link>
        <div>
          <h1>{p.name}</h1>
          <span className="sub mono">{[p.gstin ?? t('noGstin'), typeLabel[p.type as keyof typeof typeLabel]].join(' · ')}</span>
        </div>
        <Chip tone={p.is_active ? 'good' : 'muted'}>{p.is_active ? t('active') : t('inactive')}</Chip>
        <span className="balpill num">
          {pill.length === 0 ? <span className="good">{t('pillSettled')}</span> : pill.map((x, i) => (
            <span key={i} className={x.tone}>{i > 0 ? ' · ' : ''}{x.text}</span>
          ))}
        </span>
      </div>
      <div className="headbtns" style={{ marginLeft: 0 }}>
        <a className="btn ghost sm" href={exportHref('pdf')} target="_blank" rel="noopener">{t('statementPdf')}</a>
        <a className="btn ghost sm" href={exportHref('xlsx')}>{t('statementExcel')}</a>
        {reminder && <a className="btn ghost sm" href={reminder} target="_blank" rel="noopener noreferrer">{t('whatsappReminder')}</a>}
        {!p.is_walk_in && (
          <PartyModal
            isAdmin={isAdmin}
            defaultStateCode={org?.state_code ?? '37'}
            triggerClassName="btn primary sm"
            party={{
              id: p.id, name: p.name, type: p.type, gstin: p.gstin, stateCode: p.state_code, phone: p.phone, whatsappPhone: p.whatsapp_phone,
              creditLimit: p.credit_limit == null ? null : String(p.credit_limit), creditDays: String(p.credit_days),
              interestRatePm: String(p.interest_rate_pm),
            }}
          />
        )}
      </div>
      {!p.is_active && <p className="alert warn">{t('disabledNotice')}</p>}

      {sites.length > 0 && (
        <SiteChips
          label={t('sitesLabel')} billingText={t('siteBilling')} defaultText={t('siteDefault')} manageText={t('siteManage')}
          sites={sites.map((s) => ({ id: s.id, label: s.label, isBilling: s.isBilling, isDefault: s.id === p.default_site_id }))}
        />
      )}

      {showAr && (
        <section aria-label={t('ageingReceivable')}>
          {both && <div className="section-title">{t('ageingReceivable')}</div>}
          <AgeingTiles buckets={arBuckets} labels={ageLabels} empty={dash} extra={arExtra} />
        </section>
      )}
      {showAp && (
        <section aria-label={t('ageingPayable')}>
          {both && <div className="section-title">{t('ageingPayable')}</div>}
          <AgeingTiles buckets={apBuckets} labels={ageLabels} empty={dash} />
        </section>
      )}

      <div className="toolbar">
        <Segmented
          label={t('fySegments')}
          active={fy === 'all' ? 'all' : String(fy)}
          options={[
            { key: String(currentFy), label: fyName(currentFy), href: fyHref(String(currentFy)) },
            { key: String(currentFy - 1), label: fyName(currentFy - 1), href: fyHref(String(currentFy - 1)) },
            { key: 'all', label: t('fyAll'), href: fyHref('all') },
          ]}
        />
      </div>
      <Card>
        {tableRows.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t('ledgerEmpty')}</p>
        ) : (
          <LedgerTable columns={columns} rows={tableRows} footer={footer ?? undefined} />
        )}
        {ledger.truncated && <p className="alert warn" style={{ marginTop: 12 }}>{t('ledgerTruncated')}</p>}
        {closingEntries.length > 1 && (
          <p className="hint">{closingEntries.map((k) => `${acctLabel(k)}: ${inr2(ledger.closing[k]!)}`).join(' · ')}</p>
        )}
      </Card>

      <Card>
        <div className="cardtitle">{t('details')}</div>
        <KeyValue
          rows={[
            { label: t('type'), value: typeLabel[p.type as keyof typeof typeLabel] },
            { label: t('gstin'), value: p.gstin ? <span className="mono">{p.gstin}</span> : dash },
            { label: t('state'), value: `${stateName(p.state_code)} (${p.state_code})` },
            { label: t('phone'), value: p.phone ?? dash },
            { label: t('whatsapp'), value: p.whatsapp_phone ?? dash },
            { label: t('toCollect'), value: signOf(ar) !== 0 ? inr2(ar) : dash },
            { label: t('toPay'), value: signOf(ap) !== 0 ? inr2(ap) : dash },
            { label: t('creditLimitField'), value: p.credit_limit == null ? t('noLimit') : signOf(d2(p.credit_limit)) === 0 ? t('noCredit') : inr2(p.credit_limit) },
            { label: t('creditDays'), value: String(p.credit_days) },
            { label: t('interestRate'), value: `${p.interest_rate_pm}%` },
          ]}
        />
      </Card>

      <div id="sites">
        <SitesPanel partyId={p.id} sites={sites} defaultSiteId={p.default_site_id} defaultStateCode={p.state_code} />
      </div>

      {isAdmin && !p.is_walk_in && <PartyStatusButton partyId={p.id} isActive={p.is_active} />}
    </div>
  );
}
