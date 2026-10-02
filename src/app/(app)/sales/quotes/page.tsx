import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { Segmented } from '@/components/ui/Segmented';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatTile } from '@/components/ui/StatTile';
import { RowLink } from '@/components/sales/RowLink';
import { addDecimal, decimalText } from '@/lib/decimal';
import { formatDate, inr, inr2, todayIn } from '@/lib/format';
import { expiresWithin, isQuoteStatus, type QuoteStatus } from '@/lib/quotes-view';
import { cleanSearchText, orContainsFilter } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';

type Segment = 'all' | QuoteStatus;
const SEGMENTS: Segment[] = ['all', 'open', 'accepted', 'expired', 'converted'];
const LIMIT = 200;
const CHIP_TONE: Record<QuoteStatus, ChipTone> = { open: 'accent', accepted: 'good', expired: 'bad', converted: 'muted' };

// Quotations list. Status filters use v_quotations.effective_status, so an open quote past its
// date is listed as Expired without any background job.
export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const segment: Segment = SEGMENTS.includes(sp.status as Segment) ? (sp.status as Segment) : 'all';
  const q = cleanSearchText(sp.q);

  const [t, supabase] = await Promise.all([getTranslations('quotes'), createClient()]);
  const { data: org } = await supabase.from('organization').select('timezone').maybeSingle();
  const today = todayIn(org?.timezone ?? 'Asia/Kolkata');

  let query = supabase
    .from('v_quotations')
    .select('id, quote_no, quote_date, valid_until, effective_status, party_name, grand_total')
    .order('quote_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (segment !== 'all') query = query.eq('effective_status', segment);
  const search = orContainsFilter(['quote_no', 'party_name'], q);
  if (search) query = query.or(search);

  const [{ data: rows }, { data: live }] = await Promise.all([
    query,
    // The tiles always describe the live book (open and accepted), whatever the list is filtered to.
    supabase.from('v_quotations').select('effective_status, valid_until, grand_total').in('effective_status', ['open', 'accepted']).limit(2000),
  ]);

  // Counting and adding up figures the database already stored (exact decimals, nothing recalculated).
  const liveRows = live ?? [];
  const openCount = liveRows.filter((r) => r.effective_status === 'open').length;
  const accepted = liveRows.filter((r) => r.effective_status === 'accepted');
  const acceptedValue = accepted.reduce((s, r) => addDecimal(s, decimalText(r.grand_total as string, 2), 2) ?? s, '0.00');
  const expiring = liveRows.filter((r) => isQuoteStatus(r.effective_status) && expiresWithin(r.effective_status, r.valid_until as string, today)).length;

  const label: Record<QuoteStatus, string> = {
    open: t('statusOpen'), accepted: t('statusAccepted'), expired: t('statusExpired'), converted: t('statusConverted'),
  };
  const href = (s: Segment) => {
    const params = new URLSearchParams();
    if (s !== 'all') params.set('status', s);
    if (q) params.set('q', q);
    const str = params.toString();
    return str ? `/sales/quotes?${str}` : '/sales/quotes';
  };
  const segLabel: Record<Segment, string> = {
    all: t('all'), open: t('open'), accepted: t('accepted'), expired: t('expired'), converted: t('converted'),
  };

  return (
    <div className="screen">
      <div className="screenhead">
        <Link href="/sales" className="btn ghost sm">{t('backToSales')}</Link>
        <h1>{t('title')}</h1>
        <span className="sub">{t('subtitle')}</span>
        <span className="headbtns">
          <Link href="/sales/quotes/new" className="btn primary">+ {t('newQuote')}</Link>
        </span>
      </div>

      <div className="tiles">
        <StatTile label={t('tileOpen')} value={openCount} sub={t('tileOpenSub', { n: openCount })} />
        <StatTile label={t('tileAccepted')} value={inr(acceptedValue)} sub={t('tileAcceptedSub', { n: accepted.length })} />
        <StatTile label={t('tileExpiring')} value={expiring} tone={expiring > 0 ? 'warn' : undefined} sub={t('tileExpiringSub')} />
      </div>

      <div className="toolbar">
        <Segmented label={t('segments')} active={segment} options={SEGMENTS.map((s) => ({ key: s, label: segLabel[s], href: href(s) }))} />
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
                  <th>{t('number')}</th><th className="hide-narrow">{t('date')}</th><th>{t('party')}</th>
                  <th className="hide-narrow">{t('validUntil')}</th><th className="hide-narrow">{t('status')}</th><th className="r">{t('total')}</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const status: QuoteStatus = isQuoteStatus(r.effective_status) ? r.effective_status : 'open';
                  const to = `/sales/quotes/${r.id}`;
                  const soon = expiresWithin(status, r.valid_until as string, today);
                  const chips = (
                    <>
                      <Chip tone={CHIP_TONE[status]}>{label[status]}</Chip>
                      {soon && <> <Chip tone="warn">{t('expiringTag')}</Chip></>}
                    </>
                  );
                  return (
                    <RowLink key={r.id as string} href={to}>
                      <td className="nowrap">
                        <Link href={to} className="mono rownum">{r.quote_no as string}</Link>
                        <div className="sub num only-narrow">{formatDate(r.quote_date as string)}</div>
                      </td>
                      <td className="nowrap num hide-narrow">{formatDate(r.quote_date as string)}</td>
                      <td>
                        {r.party_name as string}
                        <div className="only-narrow">
                          {chips}
                          <div className="sub num">{t('validUntil')}: {formatDate(r.valid_until as string)}</div>
                        </div>
                      </td>
                      <td className="nowrap num hide-narrow">{formatDate(r.valid_until as string)}</td>
                      <td className="hide-narrow">{chips}</td>
                      <td className="r num">{inr2(r.grand_total as string)}</td>
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
