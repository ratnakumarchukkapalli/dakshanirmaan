import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CancelBill } from '@/components/purchases/CancelBill';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { KeyValue } from '@/components/ui/KeyValue';
import { requireOwnerPage } from '@/lib/auth/require';
import { rows } from '@/lib/db';
import { addDecimal, decimalText } from '@/lib/decimal';
import { formatDate, inr2, inrRate } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { trimZeros } from '@/lib/units';
import { isUuid } from '@/lib/uuid';
import { createClient } from '@/lib/supabase/server';

interface JournalLine { line_no: number; debit: number; credit: number; party_id: string | null; account: { code: string; name: string } | null }
interface JournalEntry { id: string; entry_no: number; entry_date: string; narration: string | null; reversed_by: string | null; lines: JournalLine[] }
interface Payment { voucher_no: string | null; mode: string; status: string; payment_date: string; account: { name: string } | null }

// The record of a posted (or cancelled) bill. Every figure is what the database stored; lines
// come from the snapshot columns on the bill, never from the item master.
export default async function BillViewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  const { done } = await searchParams;
  if (!isUuid(id)) notFound();
  const [t, supabase] = await Promise.all([getTranslations('purchases'), createClient()]);

  const [headRes, linesRes, entriesRes, stockRes, allocRes] = await Promise.all([
    supabase.from('purchase_invoices').select('*, party:parties(name, gstin, state_code)').eq('id', id).maybeSingle(),
    supabase.from('purchase_invoice_lines')
      .select('line_no, item_name, hsn_code, uom, qty, alt_qty, rate, discount_pct, taxable_value, gst_rate, cgst_amt, sgst_amt, igst_amt')
      .eq('invoice_id', id).order('line_no'),
    supabase.from('journal_entries')
      .select('id, entry_no, entry_date, narration, reversed_by, lines:journal_lines(line_no, debit, credit, party_id, account:accounts(code, name))')
      .eq('source_type', 'purchase_invoice').eq('source_id', id).order('entry_no'),
    supabase.from('v_stock_ledger').select('movement_id, warehouse_name, item_name, qty, rate, value, is_reversal, movement_date')
      .eq('source_type', 'purchase_invoice').eq('source_id', id).order('movement_date').order('movement_id'),
    supabase.from('payment_allocations')
      .select('amount, payment:payments(voucher_no, mode, status, payment_date, account:accounts(name))')
      .eq('invoice_type', 'purchase_invoice').eq('invoice_id', id),
  ]);
  if (headRes.error) throw new Error(`bill: ${headRes.error.message}`);
  const bill = headRes.data;
  if (!bill) notFound();
  if (bill.status === 'draft') redirect(`/purchases/${id}`);

  const lines = rows<{
    line_no: number; item_name: string; hsn_code: string; uom: string; qty: number; alt_qty: number | null; rate: number;
    discount_pct: number; taxable_value: number; gst_rate: number; cgst_amt: number; sgst_amt: number; igst_amt: number;
  }>(linesRes, 'bill lines');
  const stock = rows<{ movement_id: string; warehouse_name: string; item_name: string; qty: number; rate: number; value: number; is_reversal: boolean }>(stockRes, 'stock effect');
  const supplier = bill.party as { name: string; gstin: string | null; state_code: string } | null;
  const cancelled = bill.status === 'cancelled';
  const journal = rows<JournalEntry>(entriesRes, 'journal').map((e) => ({ ...e, lines: [...e.lines].sort((a, b) => a.line_no - b.line_no) }));
  const reversal = journal.find((e) => e.id === journal[0]?.reversed_by);
  const payments = rows<{ payment: Payment | null }>(allocRes, 'payments').map((a) => a.payment).filter((p): p is Payment => !!p && p.status === 'posted');
  // Which tax rows to show comes from what was stored at posting (IGST is zero on a same-state bill), never from
  // today's supplier or organisation state: a later edit of either must not re-label an old bill.
  const intra = decimalText(bill.igst_total, 2) === '0.00';
  const number = bill.invoice_no as string;

  // The page itself is owner-only (requireOwnerPage), so the role needs no second test here.
  const canCancel = bill.status === 'posted' && payments.length === 0;
  const chip: { tone: ChipTone; label: string } = cancelled ? { tone: 'bad', label: t('statusCancelled') } : { tone: 'good', label: t('statusPosted') };
  const modeLabel = (m: string) => (({ cash: t('modeCash'), upi: t('modeUpi'), bank: t('modeBank'), neft: t('modeNeft'), cheque: t('modeCheque') }) as Record<string, string>)[m] ?? m;

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href="/purchases" className="btn ghost sm">{t('back')}</Link>
        <h1 className="mono">{number}</h1>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="headbtns no-print">
          {canCancel && <CancelBill id={id} number={number} />}
        </span>
      </div>

      {done === 'posted' && bill.status === 'posted' && <p role="status" className="alert good">{t('donePosted', { number })}</p>}
      {done === 'cancelled' && cancelled && <p role="status" className="alert good">{t('doneCancelled', { number })}</p>}
      {cancelled && (
        <p role="status" className="alert bad">{t('cancelledBanner', { date: reversal ? formatDate(reversal.entry_date) : '—' })}</p>
      )}
      {!cancelled && payments.length > 0 && <p className="alert warn">{t('cancelBlockedPaid')}</p>}

      <div className="grid2">
        <Card>
          <KeyValue
            rows={[
              { label: t('supplier'), value: <>{supplier?.name}{supplier?.gstin ? <span className="mono sub"> · {supplier.gstin}</span> : null}</> },
              { label: t('supplierBillNo'), value: <span className="mono">{bill.supplier_bill_no ?? '—'}</span> },
              { label: t('supplierBillDate'), value: <span className="num">{bill.supplier_bill_date ? formatDate(bill.supplier_bill_date) : '—'}</span> },
              { label: t('receivedOn'), value: <span className="num">{formatDate(bill.invoice_date)}</span> },
              { label: t('taxApplied'), value: intra ? t('intraNote') : t('interNote') },
              ...(supplier ? [{ label: t('supplierState'), value: `${stateName(supplier.state_code)} (${supplier.state_code})` }] : []),
              { label: t('itcLabel'), value: bill.itc_eligible ? t('itcClaimed') : t('itcNotClaimed') },
            ]}
          />
        </Card>
        <Card>
          <div className="cardtitle"><span>{t('storedTotals')}</span></div>
          <TotalsRows
            intra={intra}
            totals={{
              taxable: decimalText(bill.taxable_total, 2), cgst: decimalText(bill.cgst_total, 2), sgst: decimalText(bill.sgst_total, 2),
              igst: decimalText(bill.igst_total, 2), roundOff: decimalText(bill.round_off, 2), grandTotal: decimalText(bill.grand_total, 2),
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
              {lines.map((l) => {
                const gst = [l.cgst_amt, l.sgst_amt, l.igst_amt].reduce<string>((s, v) => addDecimal(s, decimalText(v, 2), 2) ?? s, '0.00');
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
        const sum = (pick: (l: JournalLine) => number) => e.lines.reduce<string>((s, l) => addDecimal(s, decimalText(pick(l), 2), 2) ?? s, '0.00');
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
                      <td>{l.account ? `${l.account.code} · ${l.account.name}` : '—'}{l.party_id && supplier ? ` — ${supplier.name}` : ''}</td>
                      <td className="r num">{Number(l.debit) ? inr2(l.debit) : ''}</td>
                      <td className="r num">{Number(l.credit) ? inr2(l.credit) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Σ</td><td className="r num">{inr2(sum((l) => l.debit))}</td><td className="r num">{inr2(sum((l) => l.credit))}</td></tr></tfoot>
              </table>
            </div>
            {e.narration && <p className="hint">{e.narration}</p>}
          </Card>
        );
      })}

      {stock.length > 0 && (
        <Card>
          <div className="cardtitle"><span>{t('stockEffect')}</span></div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('item')}</th><th>{t('godown')}</th><th className="r">{t('qty')}</th><th className="r">{t('costRate')}</th><th className="r">{t('costValue')}</th></tr>
              </thead>
              <tbody>
                {stock.map((m) => (
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
