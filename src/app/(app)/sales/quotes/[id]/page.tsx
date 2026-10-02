import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { QuoteActions } from '@/components/quotes/QuoteActions';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { decimalText } from '@/lib/decimal';
import { formatDate, inr2, inrRate } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { isQuoteStatus, quoteActions, type QuoteStatus } from '@/lib/quotes-view';
import { createClient } from '@/lib/supabase/server';
import { trimZeros } from '@/lib/units';

type Addr = { line1?: string; line2?: string | null; city?: string; pincode?: string } | null;
const addressLines = (a: Addr): string[] =>
  a ? [a.line1, a.line2, [a.city, a.pincode].filter(Boolean).join(' ')].filter((v): v is string => !!v && v.trim() !== '') : [];

const CHIP_TONE: Record<QuoteStatus, ChipTone> = { open: 'accent', accepted: 'good', expired: 'bad', converted: 'muted' };

// One quotation: a print-friendly document (title "Quotation", validity line, note / terms). Every
// figure is what the database computed (v_quotations / v_quotation_lines); nothing is added up here.
export default async function QuoteViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; done?: string }> }) {
  const { id } = await params;
  const { saved, done } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, supabase] = await Promise.all([getTranslations('quotes'), createClient()]);

  const [{ data: q }, { data: lines }, { data: org }] = await Promise.all([
    supabase.from('v_quotations').select('*').eq('id', id).maybeSingle(),
    supabase.from('v_quotation_lines')
      .select('line_no, item_name, hsn_code, uom, qty, alt_qty, rate, discount_pct, taxable_value, gst_rate')
      .eq('quote_id', id).order('line_no'),
    supabase.from('organization').select('legal_name, trade_name, gstin, state_code, address').maybeSingle(),
  ]);
  if (!q) notFound();
  const { data: billing } = await supabase
    .from('party_addresses').select('address').eq('party_id', q.party_id as string).eq('is_default', true).maybeSingle();

  const stored: QuoteStatus = isQuoteStatus(q.status) ? q.status : 'open';
  const effective: QuoteStatus = isQuoteStatus(q.effective_status) ? q.effective_status : stored;
  const allowed = quoteActions(stored, effective);
  const statusLabel: Record<QuoteStatus, string> = {
    open: t('statusOpen'), accepted: t('statusAccepted'), expired: t('statusExpired'), converted: t('statusConverted'),
  };
  const number = q.quote_no as string;
  const intra = q.is_intra === true;
  const invoiceId = q.converted_invoice_id as string | null;
  const invoiceDraft = q.converted_invoice_status === 'draft';
  const orgAddress = org?.address as Addr;
  const note = (q.note as string | null)?.trim();
  const notice = done === 'accepted' ? t('noticeAccepted') : done === 'reopened' ? t('noticeReopened') : done === 'expired' ? t('noticeExpired') : null;

  return (
    <div className="screen stack">
      <div className="screenhead no-print" style={{ marginBottom: 0 }}>
        <Link href="/sales/quotes" className="btn ghost sm">{t('back')}</Link>
        <h1><span>{t('docTitle')}</span> <span className="mono">{number}</span></h1>
        <Chip tone={CHIP_TONE[effective]}>{statusLabel[effective]}</Chip>
        <span className="headbtns"><QuoteActions id={id} allowed={allowed} /></span>
      </div>

      <div className="no-print">
        {saved === '1' && <p role="status" className="alert good">{t('saved', { no: number })}</p>}
        {notice && <p role="status" className="alert good">{notice}</p>}
        {effective === 'expired' && stored !== 'expired' && (
          <p role="status" className="alert warn">{t('expiredBanner', { date: formatDate(q.valid_until as string) })}</p>
        )}
        {stored === 'converted' && invoiceId && (
          <p role="status" className="alert good">
            {t('convertedNote')}{' '}
            <Link href={invoiceDraft ? `/sales/${invoiceId}` : `/sales/${invoiceId}/view`} className="rownum">
              {invoiceDraft ? t('convertedDraft') : t('convertedPosted', { no: (q.converted_invoice_no as string | null) ?? '' })}
            </Link>{' '}
            <span aria-hidden="true">→</span>
          </p>
        )}
      </div>

      <Card className="qdoc">
        <div className="qdoc-head">
          <div>
            <div className="qdoc-org">{org?.legal_name ?? ''}</div>
            {org?.trade_name && org.trade_name !== org.legal_name ? <div className="sub">({org.trade_name})</div> : null}
            {addressLines(orgAddress).map((l, i) => <div key={i} className="sub">{l}</div>)}
            {org?.state_code ? (
              <div className="sub">
                {stateName(org.state_code)} ({org.state_code}){org.gstin ? <span className="mono"> · {t('gstinLine', { gstin: org.gstin })}</span> : null}
              </div>
            ) : null}
          </div>
          <dl className="kv qdoc-meta">
            <dt>{t('docTitle')}</dt>
            <dd className="mono"><b>{number}</b></dd>
            <dt>{t('quoteDate')}</dt>
            <dd className="num">{formatDate(q.quote_date as string)}</dd>
            <dt>{t('validUntil')}</dt>
            <dd className="num"><b>{formatDate(q.valid_until as string)}</b></dd>
          </dl>
        </div>

        <div className="qdoc-party">
          <div className="lbl">{t('preparedFor')}</div>
          <div><b>{q.party_name as string}</b></div>
          {addressLines((billing?.address as Addr) ?? null).map((l, i) => <div key={i} className="sub">{l}</div>)}
          <div className="sub">
            {t('placeOfSupplyLine', { state: stateName(q.place_of_supply as string), code: q.place_of_supply as string })}
            {q.party_gstin ? <span className="mono"> · {t('gstinLine', { gstin: q.party_gstin as string })}</span> : null}
          </div>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>{t('item')}</th><th className="r">{t('qty')}</th><th className="r">{t('rate')}</th>
                <th className="r">{t('discount')}</th><th className="r">{t('lineTaxable')}</th><th className="r">{t('gstRate')}</th>
              </tr>
            </thead>
            <tbody>
              {(lines ?? []).map((l) => (
                <tr key={l.line_no as number}>
                  <td className="num">{l.line_no as number}</td>
                  <td>{l.item_name as string}<div className="sub mono">{t('hsn')} {l.hsn_code as string}</div></td>
                  <td className="r num">
                    {trimZeros(decimalText(l.qty as string, 3))} {l.uom as string}
                    {l.alt_qty !== null && <div className="sub">≈ {trimZeros(decimalText(l.alt_qty as string, 3))}</div>}
                  </td>
                  <td className="r num">{inrRate(l.rate as string)}</td>
                  <td className="r num">{Number(l.discount_pct) ? `${trimZeros(decimalText(l.discount_pct as string, 2))}%` : '—'}</td>
                  <td className="r num">{inr2(l.taxable_value as string)}</td>
                  <td className="r num">{trimZeros(decimalText(l.gst_rate as string, 2))}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="qdoc-foot">
          <div className="qdoc-notes">
            {note ? (
              <>
                <div className="lbl">{t('noteTitle')}</div>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note}</p>
              </>
            ) : null}
            <p className="sub" style={{ marginBottom: 0 }}>{t('validity', { date: formatDate(q.valid_until as string) })}</p>
          </div>
          <div className="qdoc-totals">
            <TotalsRows
              intra={intra}
              totals={{
                taxable: decimalText(q.taxable_total as string, 2), cgst: decimalText(q.cgst_total as string, 2), sgst: decimalText(q.sgst_total as string, 2),
                igst: decimalText(q.igst_total as string, 2), roundOff: decimalText(q.round_off as string, 2), grandTotal: decimalText(q.grand_total as string, 2),
              }}
              labels={{ taxable: t('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: t('roundOff'), total: t('total') }}
            />
          </div>
        </div>
        <div className="qdoc-sign">{t('forOrg', { org: org?.legal_name ?? '' })}</div>
      </Card>
    </div>
  );
}
