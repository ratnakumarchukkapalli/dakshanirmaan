import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { RowLink } from '@/components/sales/RowLink';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/SearchInput';
import { Segmented } from '@/components/ui/Segmented';
import { StatTile } from '@/components/ui/StatTile';
import { requireOwnerPage } from '@/lib/auth/require';
import { formatDate, inr, inr2 } from '@/lib/format';
import { loadPurchaseTiles } from '@/lib/purchases-data';
import { cleanSearchText, containsPattern, quoteFilterValue } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';

type Segment = 'all' | 'posted' | 'draft';
const LIMIT = 200;

// Owner-only screen (the proxy turns a counter session away; the database refuses one anyway).
export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  await requireOwnerPage();
  const sp = await searchParams;
  const segment: Segment = sp.status === 'posted' || sp.status === 'draft' ? sp.status : 'all';
  const q = cleanSearchText(sp.q);

  const [t, supabase] = await Promise.all([getTranslations('purchases'), createClient()]);
  const tiles = await loadPurchaseTiles(supabase);

  const href = (s: Segment) => {
    const params = new URLSearchParams();
    if (s !== 'all') params.set('status', s);
    if (q) params.set('q', q);
    const str = params.toString();
    return str ? `/purchases?${str}` : '/purchases';
  };
  const chip: Record<string, { tone: ChipTone; label: string }> = {
    posted: { tone: 'good', label: t('statusPosted') },
    draft: { tone: 'muted', label: t('statusDraft') },
    cancelled: { tone: 'bad', label: t('statusCancelled') },
  };

  let query = supabase
    .from('purchase_invoices')
    .select('id, invoice_no, invoice_date, status, grand_total, supplier_bill_no, party:parties(name)')
    .order('invoice_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (segment === 'draft') query = query.eq('status', 'draft');
  if (segment === 'posted') query = query.in('status', ['posted', 'cancelled']);
  if (q) {
    // Our number, the supplier's bill number, or the supplier's name (escaped for LIKE and PostgREST, see lib/search.ts).
    const pattern = quoteFilterValue(containsPattern(q));
    const { data: matches, error: matchError } = await supabase.from('parties').select('id').ilike('name', containsPattern(q)).limit(200);
    if (matchError) throw new Error(`supplier search: ${matchError.message}`);
    const ids = (matches ?? []).map((p) => p.id as string);
    query = query.or([`invoice_no.ilike.${pattern}`, `supplier_bill_no.ilike.${pattern}`, ...(ids.length ? [`party_id.in.(${ids.join(',')})`] : [])].join(','));
  }
  const { data: rows, error } = await query;
  if (error) throw new Error(`purchase list: ${error.message}`);

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <Link href="/purchases/new" className="btn primary">+ {t('newBill')}</Link>
        </span>
      </div>

      <div className="tiles">
        <StatTile label={t('tilePayable')} value={inr(tiles.payable)} sub={t('tilePayableSub')} />
        <StatTile label={t('tileItc')} value={inr(tiles.itc)} sub={t('tileItcSub')} />
        <StatTile label={t('tileRcm')} value={inr(tiles.rcmPayable)} sub={t('tileRcmSub')} />
      </div>

      <div className="toolbar">
        <Segmented
          label={t('segments')}
          active={segment}
          options={[
            { key: 'all', label: t('all'), href: href('all') },
            { key: 'posted', label: t('bills'), href: href('posted') },
            { key: 'draft', label: t('drafts'), href: href('draft') },
          ]}
        />
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} keep={{ status: segment === 'all' ? undefined : segment }} />
      </div>

      <Card>
        {(rows ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{q || segment !== 'all' ? t('emptyFiltered') : t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th><th className="hide-narrow">{t('supplierBillNo')}</th><th className="hide-narrow">{t('date')}</th>
                  <th>{t('supplier')}</th><th className="hide-narrow">{t('status')}</th><th className="r">{t('total')}</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const draft = r.status === 'draft';
                  const to = draft ? `/purchases/${r.id}` : `/purchases/${r.id}/view`;
                  const c = chip[r.status as string] ?? chip.draft!;
                  const supplierName = (r.party as unknown as { name: string } | null)?.name ?? '—';
                  return (
                    <RowLink key={r.id} href={to}>
                      <td className="nowrap">
                        <Link href={to} className="mono rownum">{draft ? t('draftNumber') : r.invoice_no}</Link>
                        <div className="sub num only-narrow">{formatDate(r.invoice_date as string)}</div>
                      </td>
                      <td className="nowrap mono hide-narrow">{r.supplier_bill_no ?? '—'}</td>
                      <td className="nowrap num hide-narrow">{formatDate(r.invoice_date as string)}</td>
                      <td>
                        {supplierName}
                        <div className="only-narrow"><Chip tone={c.tone}>{c.label}</Chip></div>
                      </td>
                      <td className="hide-narrow"><Chip tone={c.tone}>{c.label}</Chip></td>
                      <td className="r num">{draft ? '—' : inr2(r.grand_total as number)}</td>
                    </RowLink>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {(rows ?? []).length >= LIMIT && <p className="hint">{t('limitNote', { n: LIMIT })}</p>}
      </Card>
    </div>
  );
}
