import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { SearchInput } from '@/components/ui/SearchInput';
import { Segmented } from '@/components/ui/Segmented';
import { RowLink } from '@/components/sales/RowLink';
import { formatDate, inr2 } from '@/lib/format';
import { cleanSearchText, containsPattern, quoteFilterValue } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';

type Segment = 'all' | 'invoice' | 'challan' | 'draft';
const LIMIT = 200;

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const segment: Segment = sp.status === 'invoice' || sp.status === 'challan' || sp.status === 'draft' ? sp.status : 'all';
  const q = cleanSearchText(sp.q);

  const [t, supabase] = await Promise.all([getTranslations('sales'), createClient()]);

  const href = (s: Segment) => {
    const params = new URLSearchParams();
    if (s !== 'all') params.set('status', s);
    if (q) params.set('q', q);
    const str = params.toString();
    return str ? `/sales?${str}` : '/sales';
  };
  const chip: Record<string, { tone: ChipTone; label: string }> = {
    posted: { tone: 'good', label: t('statusPosted') },
    draft: { tone: 'muted', label: t('statusDraft') },
    cancelled: { tone: 'bad', label: t('statusCancelled') },
  };

  let table: ReactNode;
  if (segment === 'challan') {
    // `delivery_challans` has two FKs to `parties` (party_id, driver_party_id); the embed needs
    // the explicit constraint name or PostgREST refuses the ambiguous embed outright.
    let cq = supabase
      .from('delivery_challans')
      .select('id, challan_no, challan_date, status, party:parties!delivery_challans_party_id_fkey(name)')
      .order('challan_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(LIMIT);
    if (q) {
      const pattern = quoteFilterValue(containsPattern(q));
      const { data: matches } = await supabase.from('parties').select('id').ilike('name', containsPattern(q)).limit(200);
      const ids = (matches ?? []).map((p) => p.id as string);
      cq = cq.or([`challan_no.ilike.${pattern}`, ...(ids.length ? [`party_id.in.(${ids.join(',')})`] : [])].join(','));
    }
    const { data: rows } = await cq;
    table = (
      <>
        {(rows ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{q ? t('emptyFiltered') : t('emptyChallans')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('number')}</th><th className="hide-narrow">{t('date')}</th><th>{t('party')}</th><th>{t('status')}</th></tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const draft = r.status === 'draft';
                  const c = chip[r.status as string] ?? chip.draft!;
                  const partyName = (r.party as unknown as { name: string } | null)?.name ?? '—';
                  const cells = (
                    <>
                      <td className="nowrap">
                        {draft ? (
                          <Link href={`/sales/challans/new?id=${r.id}`} className="mono rownum">{t('draftNumber')}</Link>
                        ) : (
                          <span className="mono rownum">{r.challan_no}</span>
                        )}
                        <div className="sub num only-narrow">{formatDate(r.challan_date as string)}</div>
                      </td>
                      <td className="nowrap num hide-narrow">{formatDate(r.challan_date as string)}</td>
                      <td>
                        {partyName}
                        <div className="only-narrow"><Chip tone={c.tone}>{c.label}</Chip></div>
                      </td>
                      <td className="hide-narrow"><Chip tone={c.tone}>{c.label}</Chip></td>
                    </>
                  );
                  // Only a draft opens anything (its edit form); a posted or cancelled challan has
                  // no view screen of its own — it shows up in the open-challans panel instead.
                  return draft ? <RowLink key={r.id} href={`/sales/challans/new?id=${r.id}`}>{cells}</RowLink> : <tr key={r.id}>{cells}</tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        {(rows ?? []).length >= LIMIT && <p className="hint">{t('limitNote', { n: LIMIT })}</p>}
      </>
    );
  } else {
    let query = supabase
      .from('sales_invoices')
      .select('id, invoice_no, invoice_date, status, grand_total, party:parties(name)')
      .order('invoice_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(LIMIT);
    if (segment === 'draft') query = query.eq('status', 'draft');
    if (segment === 'invoice') query = query.in('status', ['posted', 'cancelled']);

    if (q) {
      // Number or party name. The party names are looked up first (the text is escaped for LIKE
      // and PostgREST, see lib/search.ts); their ids come from the database, so they are safe to reuse.
      const pattern = quoteFilterValue(containsPattern(q));
      const { data: matches } = await supabase.from('parties').select('id').ilike('name', containsPattern(q)).limit(200);
      const ids = (matches ?? []).map((p) => p.id as string);
      query = query.or([`invoice_no.ilike.${pattern}`, ...(ids.length ? [`party_id.in.(${ids.join(',')})`] : [])].join(','));
    }
    const { data: rows } = await query;
    table = (
      <>
        {(rows ?? []).length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{q || segment !== 'all' ? t('emptyFiltered') : t('empty')}</p>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>{t('number')}</th><th className="hide-narrow">{t('date')}</th><th>{t('party')}</th><th className="hide-narrow">{t('status')}</th><th className="r">{t('total')}</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const draft = r.status === 'draft';
                  const to = draft ? `/sales/${r.id}` : `/sales/${r.id}/view`;
                  const c = chip[r.status as string] ?? chip.draft!;
                  const partyName = (r.party as unknown as { name: string } | null)?.name ?? '—';
                  return (
                    <RowLink key={r.id} href={to}>
                      <td className="nowrap">
                        <Link href={to} className="mono rownum">{draft ? t('draftNumber') : r.invoice_no}</Link>
                        <div className="sub num only-narrow">{formatDate(r.invoice_date as string)}</div>
                      </td>
                      <td className="nowrap num hide-narrow">{formatDate(r.invoice_date as string)}</td>
                      <td>
                        {partyName}
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
      </>
    );
  }

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <Link href="/sales/challans/new" className="btn ghost">+ {t('newChallan')}</Link>
          <Link href="/sales/new" className="btn primary">+ {t('newInvoice')}</Link>
        </span>
      </div>
      <div className="toolbar">
        <Segmented
          label={t('segments')}
          active={segment}
          options={[
            { key: 'all', label: t('all'), href: href('all') },
            { key: 'invoice', label: t('invoices'), href: href('invoice') },
            { key: 'challan', label: t('challans'), href: href('challan') },
            { key: 'draft', label: t('drafts'), href: href('draft') },
          ]}
        />
        <SearchInput name="q" defaultValue={q} label={t('searchLabel')} placeholder={t('searchPlaceholder')} buttonLabel={t('searchButton')} keep={{ status: segment === 'all' ? undefined : segment }} />
      </div>
      <Card>{table}</Card>
    </div>
  );
}
