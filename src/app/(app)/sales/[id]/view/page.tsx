import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NotesCard } from '@/components/notes/NotesCard';
import { CancelInvoice } from '@/components/sales/CancelInvoice';
import { EwbPanel } from '@/components/sales/EwbPanel';
import { InvoiceActions } from '@/components/sales/InvoiceActions';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { KeyValue } from '@/components/ui/KeyValue';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { addDecimal, compareDecimal, decimalText } from '@/lib/decimal';
import { validUntilDate, type EwbValues } from '@/lib/ewb';
import { loadInvoiceNotes } from '@/lib/notes-data';
import { formatDate, inr, inr2, inrRate } from '@/lib/format';
import { EWAY_BILL_THRESHOLD, stateName } from '@/lib/gst';
import { shareConfigured } from '@/lib/share-link';
import { trimZeros } from '@/lib/units';
import { createClient } from '@/lib/supabase/server';

type Addr = { label?: string; line1?: string; line2?: string | null; city?: string; district?: string | null; pincode?: string; state_code?: string } | null;
const addressText = (a: Addr) => {
  if (!a) return '';
  const body = [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(', ');
  return a.label ? `${a.label}: ${body}` : body;
};

interface JournalLine { line_no: number; debit: number; credit: number; party_id: string | null; account: { code: string; name: string } | null }
interface JournalEntry { id: string; entry_no: number; entry_date: string; narration: string | null; reversed_by: string | null; lines: JournalLine[] }

// The record of a posted (or cancelled) invoice. Every figure is what the database stored; lines
// come from the snapshot columns on the invoice, never from the item master.
export default async function InvoiceViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const { id } = await params;
  const { done } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [t, tn, supabase, member] = await Promise.all([getTranslations('sales'), getTranslations('notes.credit'), createClient(), getCurrentMember()]);

  const [{ data: inv }, { data: lines }, { data: entries }, { data: stock }, { data: allocs }, { data: org }] = await Promise.all([
    supabase.from('sales_invoices').select('*, party:parties(name, gstin, is_walk_in)').eq('id', id).maybeSingle(),
    supabase.from('sales_invoice_lines')
      .select('line_no, item_name, hsn_code, uom, qty, alt_qty, rate, discount_pct, taxable_value, gst_rate, cgst_amt, sgst_amt, igst_amt')
      .eq('invoice_id', id).order('line_no'),
    supabase.from('journal_entries')
      .select('id, entry_no, entry_date, narration, reversed_by, lines:journal_lines(line_no, debit, credit, party_id, account:accounts(code, name))')
      .eq('source_type', 'sales_invoice').eq('source_id', id).order('entry_no'),
    supabase.from('v_stock_ledger').select('movement_id, warehouse_name, item_name, qty, rate, value, is_reversal, movement_date')
      .eq('source_type', 'sales_invoice').eq('source_id', id).order('movement_date').order('movement_id'),
    supabase.from('payment_allocations')
      .select('amount, payment:payments(voucher_no, mode, status, payment_date, account:accounts(name))')
      .eq('invoice_type', 'sales_invoice').eq('invoice_id', id),
    supabase.from('organization').select('state_code').maybeSingle(),
  ]);
  if (!inv) notFound();
  if (inv.status === 'draft') redirect(`/sales/${id}`);
  const notes = await loadInvoiceNotes(supabase, 'credit', id);
  const hasPostedNotes = notes.some((n) => n.status === 'posted');

  const party = inv.party as { name: string; gstin: string | null; is_walk_in: boolean } | null;
  const cancelled = inv.status === 'cancelled';
  const journal = ((entries ?? []) as unknown as JournalEntry[]).map((e) => ({ ...e, lines: [...e.lines].sort((a, b) => a.line_no - b.line_no) }));
  const reversal = journal.find((e) => e.id === journal[0]?.reversed_by);
  const payments = (allocs ?? []).map((a) => a.payment as unknown as { voucher_no: string | null; mode: string; status: string; payment_date: string; account: { name: string } | null }).filter((p) => p && p.status === 'posted');
  const intra = inv.place_of_supply === org?.state_code;
  const number = inv.invoice_no as string;

  const ewb: EwbValues = {
    vehicleNo: inv.vehicle_no ?? '', transporterName: inv.transporter_name ?? '', transportMode: inv.transport_mode ?? '',
    distanceKm: inv.distance_km === null ? '' : String(inv.distance_km), transporterGstin: inv.transporter_gstin ?? '',
    ewbNo: inv.ewb_no ?? '', ewbDate: inv.ewb_date ?? '', ewbValidUntil: validUntilDate(inv.ewb_valid_until),
  };
  const needsEwb = !inv.ewb_no && compareDecimal(decimalText(inv.grand_total, 2), EWAY_BILL_THRESHOLD, 2) === 1;

  const canCancel = isVerifiedAdmin(member) && inv.status === 'posted' && payments.length === 0 && !hasPostedNotes;
  const chip: { tone: ChipTone; label: string } = cancelled ? { tone: 'bad', label: t('statusCancelled') } : { tone: 'good', label: t('statusPosted') };
  const modeLabel = (m: string) => (({ cash: t('modeCash'), upi: t('modeUpi'), bank: t('modeBank'), neft: t('modeNeft'), cheque: t('modeCheque') }) as Record<string, string>)[m] ?? m;

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href="/sales" className="btn ghost sm">{t('back')}</Link>
        <h1 className="mono">{number}</h1>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="headbtns no-print">
          <InvoiceActions id={id} cancelled={cancelled} canShare={shareConfigured()} />
          {canCancel && <CancelInvoice id={id} number={number} />}
        </span>
      </div>

      {done === 'posted' && <p role="status" className="alert good">{t('donePosted', { number })}</p>}
      {done === 'cash' && <p role="status" className="alert good">{t('doneCash', { number, account: payments[0]?.account?.name ?? '' })}</p>}
      {cancelled && (
        <p role="status" className="alert bad">{t('cancelledBanner', { date: reversal ? formatDate(reversal.entry_date) : '—' })}</p>
      )}
      {!cancelled && payments.length > 0 && <p className="alert warn">{t('cancelBlockedPaid')}</p>}
      {!cancelled && hasPostedNotes && <p className="alert warn">{tn('cancelBlocked')}</p>}

      <div className="grid2">
        <Card>
          <KeyValue
            rows={[
              { label: t('party'), value: <>{party?.name}{party?.gstin ? <span className="mono sub"> · {party.gstin}</span> : null}</> },
              { label: t('date'), value: <span className="num">{formatDate(inv.invoice_date)}</span> },
              { label: t('placeOfSupply'), value: `${stateName(inv.place_of_supply)} (${inv.place_of_supply}) · ${intra ? t('intraNote') : t('interNote')}` },
              ...(addressText(inv.billing_address) ? [{ label: t('billTo'), value: addressText(inv.billing_address) }] : []),
              ...(addressText(inv.shipping_address) ? [{ label: t('shipTo'), value: addressText(inv.shipping_address) }] : []),
            ]}
          />
        </Card>
        <Card>
          <div className="cardtitle"><span>{t('storedTotals')}</span></div>
          <TotalsRows
            intra={intra}
            totals={{
              taxable: decimalText(inv.taxable_total, 2), cgst: decimalText(inv.cgst_total, 2), sgst: decimalText(inv.sgst_total, 2),
              igst: decimalText(inv.igst_total, 2), roundOff: decimalText(inv.round_off, 2), grandTotal: decimalText(inv.grand_total, 2),
            }}
            labels={{ taxable: t('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: t('roundOff'), total: t('total') }}
          />
          {payments.length > 0 && (
            <div className="paidbox">
              <div className="lbl">{t('paymentsTitle')}</div>
              {payments.map((p, i) => (
                <div key={i} className="sub">{p.voucher_no} · {p.account?.name ?? modeLabel(p.mode)} · {formatDate(p.payment_date)}</div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <NotesCard kind="credit" invoiceId={id} notes={notes} canWrite={isVerifiedAdmin(member)} canMake={inv.status === 'posted'} />

      <EwbPanel
        key={JSON.stringify(ewb)} id={id} values={ewb} editable={!cancelled} needsEwb={needsEwb} thresholdLabel={inr(EWAY_BILL_THRESHOLD)}
      />

      <Card>
        <div className="cardtitle"><span>{t('items')}</span></div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('item')}</th><th>HSN</th><th className="r">{t('qty')}</th><th className="r">{t('rate')}</th>
                <th className="r">{t('discount')}</th><th className="r">{t('lineTaxable')}</th><th className="r">GST</th>
              </tr>
            </thead>
            <tbody>
              {(lines ?? []).map((l) => {
                const gst = [l.cgst_amt, l.sgst_amt, l.igst_amt].reduce((s, v) => addDecimal(s, decimalText(v, 2), 2) ?? s, '0.00');
                return (
                  <tr key={l.line_no}>
                    <td>{l.item_name}</td>
                    <td className="mono">{l.hsn_code}</td>
                    <td className="r num">
                      {trimZeros(decimalText(l.qty, 3))} {l.uom}
                      {l.alt_qty !== null && <span className="sub"> ≈ {trimZeros(decimalText(l.alt_qty, 3))}</span>}
                    </td>
                    <td className="r num">{inrRate(l.rate)}</td>
                    <td className="r num">{Number(l.discount_pct) ? `${trimZeros(decimalText(l.discount_pct, 2))}%` : '—'}</td>
                    <td className="r num">{inr2(l.taxable_value)}</td>
                    <td className="r num">{inr2(gst)}<div className="sub">{trimZeros(decimalText(l.gst_rate, 2))}%</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {journal.map((e, idx) => {
        const isReversal = idx > 0;
        const sum = (pick: (l: JournalLine) => number) => e.lines.reduce((s, l) => addDecimal(s, decimalText(pick(l), 2), 2) ?? s, '0.00');
        const dr = sum((l) => l.debit);
        const cr = sum((l) => l.credit);
        return (
          <Card key={e.id}>
            <div className="cardtitle">
              <span>{isReversal ? t('reversalEntry') : t('journalEntry')} · #{e.entry_no}</span>
              <span className="sub">{formatDate(e.entry_date)}</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>{t('account')}</th><th className="r">{t('debit')}</th><th className="r">{t('credit')}</th></tr></thead>
                <tbody>
                  {e.lines.map((l) => (
                    <tr key={l.line_no}>
                      <td>{l.account ? `${l.account.code} · ${l.account.name}` : '—'}{l.party_id && party ? ` — ${party.name}` : ''}</td>
                      <td className="r num">{Number(l.debit) ? inr2(l.debit) : ''}</td>
                      <td className="r num">{Number(l.credit) ? inr2(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Σ</td><td className="r num">{inr2(dr)}</td><td className="r num">{inr2(cr)}</td></tr></tfoot>
              </table>
            </div>
            {e.narration && <p className="hint">{e.narration}</p>}
          </Card>
        );
      })}

      {(stock ?? []).length > 0 && (
        <Card>
          <div className="cardtitle"><span>{t('stockEffect')}</span></div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('item')}</th><th>{t('godown')}</th><th className="r">{t('qty')}</th><th className="r">{t('costRate')}</th><th className="r">{t('costValue')}</th></tr>
              </thead>
              <tbody>
                {(stock ?? []).map((m) => (
                  <tr key={m.movement_id}>
                    <td>{m.item_name}{m.is_reversal && <> <Chip tone="muted">{t('reversalTag')}</Chip></>}</td>
                    <td>{m.warehouse_name}</td>
                    <td className="r num">{Number(m.qty) > 0 ? '+' : ''}{trimZeros(decimalText(m.qty, 3))}</td>
                    <td className="r num">{inrRate(m.rate)}</td>
                    <td className="r num">{inr2(m.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
