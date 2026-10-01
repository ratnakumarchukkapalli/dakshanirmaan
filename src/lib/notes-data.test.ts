import { describe, expect, it, vi } from 'vitest';
import { reset, state, asAdmin, type Answer, type Call } from '@/test/harness';
import { loadInvoiceNotes, loadNoteSource } from './notes-data';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const INVOICE = '22222222-2222-4222-8222-222222222222';
const LINE = '55555555-5555-4555-8555-555555555555';
const ITEM = '33333333-3333-4333-8333-333333333333';

const head = { id: INVOICE, invoice_no: 'INV/26-27/0001', invoice_date: '2026-09-10', status: 'posted', grand_total: 11800, party: { name: 'Sri Rama Constructions', gstin: null } };
const invoiceLine = { id: LINE, line_no: 1, item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', qty: 100, taxable_value: 1000, gst_rate: 18 };

function answer(over: (c: Call) => Answer | undefined = () => undefined) {
  state.respond = (c) => {
    const o = over(c);
    if (o) return o;
    switch (c.table) {
      case 'sales_invoices': return { data: [head] };
      case 'sales_invoice_lines': return { data: [invoiceLine] };
      case 'credit_notes': return { data: [] };
      case 'v_open_sales_invoices': return { data: [{ open_amount: 11800 }] };
      case 'items': return { data: [{ id: ITEM, alt_uom: 'pcs', conversion_factor: 4.2 }] };
      default: return { data: [] };
    }
  };
}
const supabase = async () => (await import('@/lib/supabase/server')).createClient();

describe('loadNoteSource', () => {
  it('a fresh invoice is fully returnable and fully adjustable', async () => {
    reset(asAdmin());
    answer();
    const src = await loadNoteSource(await supabase(), 'credit', INVOICE);
    expect(src).toMatchObject({ number: 'INV/26-27/0001', grandTotal: '11800.00', openAmount: '11800.00', partyName: 'Sri Rama Constructions' });
    expect(src!.lines[0]).toMatchObject({ id: LINE, qty: '100.000', remainingQty: '100.000', taxable: '1000.00', remainingTaxable: '1000.00', altUom: 'pcs', factor: '4.2000' });
  });

  it('counts posted notes only: goods notes take quantity, every note takes value', async () => {
    reset(asAdmin());
    answer((c) => {
      if (c.table === 'credit_notes') return { data: [{ id: 'n1', stock_effect: true }, { id: 'n2', stock_effect: false }] };
      if (c.table === 'credit_note_lines') return { data: [
        { note_id: 'n1', against_line_id: LINE, qty: 30, taxable_value: 300 },
        { note_id: 'n2', against_line_id: LINE, qty: 100, taxable_value: 200 },
      ] };
      return undefined;
    });
    const src = await loadNoteSource(await supabase(), 'credit', INVOICE);
    expect(src!.lines[0]).toMatchObject({ remainingQty: '70.000', remainingTaxable: '500.00' });
    // Only posted notes are asked for: a draft or cancelled note has taken nothing.
    expect(state.calls.find((c) => c.table === 'credit_notes')!.filters).toEqual(expect.arrayContaining([['against_invoice_id', INVOICE], ['status', 'posted']]));
  });

  it('never goes below zero, and a fully paid invoice has no open amount', async () => {
    reset(asAdmin());
    answer((c) => {
      if (c.table === 'credit_notes') return { data: [{ id: 'n1', stock_effect: true }] };
      if (c.table === 'credit_note_lines') return { data: [{ note_id: 'n1', against_line_id: LINE, qty: 100, taxable_value: 1200 }] };
      if (c.table === 'v_open_sales_invoices') return { data: [] };
      return undefined;
    });
    const src = await loadNoteSource(await supabase(), 'credit', INVOICE);
    expect(src!.lines[0]).toMatchObject({ remainingQty: '0.000', remainingTaxable: '0.00' });
    expect(src!.openAmount).toBeNull();
  });

  it('a draft or cancelled invoice (or none) gives no source', async () => {
    for (const rows of [[], [{ ...head, status: 'draft' }], [{ ...head, status: 'cancelled' }]]) {
      reset(asAdmin());
      answer((c) => (c.table === 'sales_invoices' ? { data: rows } : undefined));
      expect(await loadNoteSource(await supabase(), 'credit', INVOICE)).toBeNull();
    }
  });

  it('a debit note reads the bill tables and carries the supplier bill number', async () => {
    reset(asAdmin());
    state.respond = (c) => {
      switch (c.table) {
        case 'purchase_invoices': return { data: [{ ...head, supplier_bill_no: 'SUP/77' }] };
        case 'purchase_invoice_lines': return { data: [invoiceLine] };
        case 'items': return { data: [{ id: ITEM, alt_uom: null, conversion_factor: null }] };
        default: return { data: [] };
      }
    };
    const src = await loadNoteSource(await supabase(), 'debit', INVOICE);
    expect(src).toMatchObject({ supplierBillNo: 'SUP/77', openAmount: null });
    expect(src!.lines[0]).toMatchObject({ altUom: null, factor: null });
    expect(state.calls.some((c) => c.table === 'sales_invoices')).toBe(false);
  });

  it('a database error fails loudly instead of looking like an empty list', async () => {
    reset(asAdmin());
    answer((c) => (c.table === 'sales_invoice_lines' ? { data: null, error: { message: 'boom' } } : undefined));
    await expect(loadNoteSource(await supabase(), 'credit', INVOICE)).rejects.toThrow(/note source lines: boom/);
  });
});

describe('loadInvoiceNotes', () => {
  it('lists the notes against one invoice with their totals as text', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [{ id: 'n1', note_no: 'CN/26-27/0001', note_date: '2026-09-12', status: 'posted', grand_total: 590, stock_effect: true }] });
    expect(await loadInvoiceNotes(await supabase(), 'credit', INVOICE)).toEqual([
      { id: 'n1', noteNo: 'CN/26-27/0001', date: '2026-09-12', status: 'posted', grandTotal: '590.00', stockEffect: true },
    ]);
  });
});
