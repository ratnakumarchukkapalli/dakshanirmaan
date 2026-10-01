import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CancelNote } from '@/components/notes/CancelNote';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { KeyValue } from '@/components/ui/KeyValue';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { rows } from '@/lib/db';
import { addDecimal, decimalText } from '@/lib/decimal';
import { formatDate, inr2, inrRate } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { NOTE_CONFIG } from '@/lib/notes-types';
import { createClient } from '@/lib/supabase/server';
import { trimZeros } from '@/lib/units';
import { isUuid } from '@/lib/uuid';
import type { NoteKind } from '@/schemas/notes';

interface JournalLine { line_no: number; debit: number; credit: number; party_id: string | null; account: { code: string; name: string } | null }
interface JournalEntry { id: string; entry_no: number; entry_date: string; narration: string | null; reversed_by: string | null; lines: JournalLine[] }

/**
 * The record of a posted (or cancelled) credit or debit note. Every figure is what the database
 * stored; lines come from the snapshot columns on the note, never from the item master.
 */
export async function NoteView({ kind, id, done }: { kind: NoteKind; id: string; done?: string }) {
  const cfg = NOTE_CONFIG[kind];
  if (!isUuid(id)) notFound();
  const [t, tk, supabase, member] = await Promise.all([getTranslations('notes'), getTranslations(`notes.${kind}`), createClient(), getCurrentMember()]);

  const [headRes, linesRes, entriesRes, stockRes] = await Promise.all([
    supabase.from(cfg.note).select('*, party:parties(name, gstin)').eq('id', id).maybeSingle(),
    supabase.from(cfg.lines)
      .select('line_no, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, cgst_amt, sgst_amt, igst_amt')
      .eq('note_id', id).order('line_no'),
    supabase.from('journal_entries')
      .select('id, entry_no, entry_date, narration, reversed_by, lines:journal_lines(line_no, debit, credit, party_id, account:accounts(code, name))')
      .eq('source_type', cfg.source).eq('source_id', id).order('entry_no'),
    supabase.from('v_stock_ledger').select('movement_id, warehouse_name, item_name, qty, rate, value, is_reversal, movement_date')
      .eq('source_type', cfg.source).eq('source_id', id).order('movement_date').order('movement_id'),
  ]);
  if (headRes.error) throw new Error(`note: ${headRes.error.message}`);
  const note = headRes.data;
  if (!note) notFound();
  if (note.status === 'draft') redirect(`${cfg.base}/${id}`);

  // The invoice (bill) it is against: its number for the link back.
  let against: { id: string; invoice_no: string | null } | null = null;
  if (note.against_invoice_id) {
    const { data, error } = await supabase.from(cfg.invoice).select('id, invoice_no').eq('id', note.against_invoice_id).maybeSingle();
    if (error) throw new Error(`note invoice: ${error.message}`);
    against = data;
  }

  const lines = rows<{
    line_no: number; item_name: string; hsn_code: string; uom: string; qty: number; rate: number;
    taxable_value: number; gst_rate: number; cgst_amt: number; sgst_amt: number; igst_amt: number;
  }>(linesRes, 'note lines');
  const stock = rows<{ movement_id: string; warehouse_name: string; item_name: string; qty: number; rate: number | null; value: number | null; is_reversal: boolean }>(stockRes, 'stock effect');
  // Cost comes back NULL for a counter session (change 28); the database decides, the page only lays out.
  const showCost = stock.some((m) => m.rate !== null);
  const party = note.party as { name: string; gstin: string | null } | null;
  const cancelled = note.status === 'cancelled';
  const journal = rows<JournalEntry>(entriesRes, 'journal').map((e) => ({ ...e, lines: [...e.lines].sort((a, b) => a.line_no - b.line_no) }));
  const reversal = journal.find((e) => e.id === journal[0]?.reversed_by);
  // Which tax rows to show comes from what was stored at posting, never from today's party or organisation state.
  const intra = decimalText(note.igst_total, 2) === '0.00';
  const number = note.note_no as string;
  const canCancel = isVerifiedAdmin(member) && note.status === 'posted';
  const chip: { tone: ChipTone; label: string } = cancelled ? { tone: 'bad', label: t('statusCancelled') } : { tone: 'good', label: t('statusPosted') };
  const sum = (list: JournalLine[], pick: (l: JournalLine) => number) => list.reduce<string>((s, l) => addDecimal(s, decimalText(pick(l), 2), 2) ?? s, '0.00');

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        {against ? (
          <Link href={`${cfg.invoiceBase}/${against.id}/view`} className="btn ghost sm">← {against.invoice_no}</Link>
        ) : (
          <Link href={cfg.list} className="btn ghost sm">{tk('back')}</Link>
        )}
        <h1 className="mono">{number}</h1>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <span className="headbtns no-print">{canCancel && <CancelNote kind={kind} id={id} number={number} />}</span>
      </div>

      {done === 'posted' && note.status === 'posted' && <p role="status" className="alert good">{t('donePosted', { number })}</p>}
      {done === 'cancelled' && cancelled && <p role="status" className="alert good">{t('doneCancelled', { number })}</p>}
      {cancelled && <p role="status" className="alert bad">{t('cancelledBanner', { date: reversal ? formatDate(reversal.entry_date) : '—' })}</p>}
      {!cancelled && <p className="hint" style={{ margin: 0 }}>{t('cancelOrderHint')}</p>}

      <div className="grid2">
        <Card>
          <KeyValue
            rows={[
              { label: tk('party'), value: <>{party?.name}{party?.gstin ? <span className="mono sub"> · {party.gstin}</span> : null}</> },
              ...(against ? [{ label: tk('against'), value: <Link href={`${cfg.invoiceBase}/${against.id}/view`} className="mono">{against.invoice_no}</Link> }] : []),
              { label: t('noteDate'), value: <span className="num">{formatDate(note.note_date)}</span> },
              { label: t('reason'), value: note.reason ?? '—' },
              { label: t('kindLabel'), value: note.stock_effect ? tk('kindGoods') : tk('kindValue') },
              { label: t('placeOfSupply'), value: `${stateName(note.place_of_supply)} (${note.place_of_supply}) · ${intra ? t('intraNote') : t('interNote')}` },
            ]}
          />
        </Card>
        <Card>
          <div className="cardtitle"><span>{t('storedTotals')}</span></div>
          <TotalsRows
            intra={intra}
            totals={{
              taxable: decimalText(note.taxable_total, 2), cgst: decimalText(note.cgst_total, 2), sgst: decimalText(note.sgst_total, 2),
              igst: decimalText(note.igst_total, 2), roundOff: decimalText(note.round_off, 2), grandTotal: decimalText(note.grand_total, 2),
            }}
            labels={{ taxable: t('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: t('roundOff'), total: t('total') }}
          />
        </Card>
      </div>

      <Card>
        <div className="cardtitle"><span>{t('items')}</span></div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('item')}</th><th>HSN</th><th className="r">{t('qty')}</th><th className="r">{t('rate')}</th>
                <th className="r">{t('lineTaxable')}</th><th className="r">GST</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const gst = [l.cgst_amt, l.sgst_amt, l.igst_amt].reduce<string>((s, v) => addDecimal(s, decimalText(v, 2), 2) ?? s, '0.00');
                return (
                  <tr key={l.line_no}>
                    <td>{l.item_name}</td>
                    <td className="mono">{l.hsn_code}</td>
                    <td className="r num">{trimZeros(decimalText(l.qty, 3))} {l.uom}</td>
                    <td className="r num">{inrRate(l.rate)}</td>
                    <td className="r num">{inr2(l.taxable_value)}</td>
                    <td className="r num">{inr2(gst)}<div className="sub">{trimZeros(decimalText(l.gst_rate, 2))}%</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {journal.map((e, idx) => (
        <Card key={e.id}>
          <div className="cardtitle">
            <span>{idx > 0 ? t('reversalEntry') : t('journalEntry')} · #{e.entry_no}</span>
            <span className="sub">{formatDate(e.entry_date)}</span>
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>{t('account')}</th><th className="r">{t('colDebit')}</th><th className="r">{t('colCredit')}</th></tr></thead>
              <tbody>
                {e.lines.map((l) => (
                  <tr key={l.line_no}>
                    <td>{l.account ? `${l.account.code} · ${l.account.name}` : '—'}{l.party_id && party ? ` — ${party.name}` : ''}</td>
                    <td className="r num">{Number(l.debit) ? inr2(l.debit) : ''}</td>
                    <td className="r num">{Number(l.credit) ? inr2(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td>Σ</td><td className="r num">{inr2(sum(e.lines, (l) => l.debit))}</td><td className="r num">{inr2(sum(e.lines, (l) => l.credit))}</td></tr></tfoot>
            </table>
          </div>
          {e.narration && <p className="hint">{e.narration}</p>}
        </Card>
      ))}

      {stock.length > 0 && (
        <Card>
          <div className="cardtitle"><span>{t('stockEffect')}</span></div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>{t('item')}</th><th>{t('godown')}</th><th className="r">{t('qty')}</th>{showCost && <><th className="r">{t('costRate')}</th><th className="r">{t('costValue')}</th></>}</tr>
              </thead>
              <tbody>
                {stock.map((m) => (
                  <tr key={m.movement_id}>
                    <td>{m.item_name}{m.is_reversal && <> <Chip tone="muted">{t('reversalTag')}</Chip></>}</td>
                    <td>{m.warehouse_name}</td>
                    <td className="r num">{Number(m.qty) > 0 ? '+' : ''}{trimZeros(decimalText(m.qty, 3))}</td>
                    {showCost && <><td className="r num">{inrRate(m.rate)}</td><td className="r num">{inr2(m.value)}</td></>}
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
