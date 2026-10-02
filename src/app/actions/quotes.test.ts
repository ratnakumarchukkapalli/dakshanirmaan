import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

import { convertQuoteToInvoice, markQuote, saveQuote } from './quotes';

const QUOTE = '11111111-1111-4111-8111-111111111111';
const PARTY = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const INVOICE = '44444444-4444-4444-8444-444444444444';
const STAMP = '2026-10-02T10:00:00.123456+00:00';

const line = { itemId: ITEM, qty: '200', altQty: '', rate: '385.5', discountPct: '' };
const form = { partyId: PARTY, quoteDate: '2026-10-02', validUntil: '', note: '', lines: [line] };
const rpcCalls = () => state.calls.filter((c) => c.op === 'rpc');

describe('saveQuote', () => {
  it('creates a quote through save_quotation and returns what the database gave back', async () => {
    reset(asCounter());
    state.respond = () => ({ data: { id: QUOTE, quote_no: 'QT/26-27/0001', updated_at: STAMP }, error: null });
    expect(await saveQuote(form)).toEqual({ ok: true, data: { id: QUOTE, quoteNo: 'QT/26-27/0001', updatedAt: STAMP } });
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({
      rpc: 'save_quotation',
      payload: {
        p_id: null, p_expected_updated_at: null, p_party_id: PARTY, p_quote_date: '2026-10-02',
        p_valid_until: null, p_note: null,
        p_lines: [{ item_id: ITEM, qty: '200', rate: '385.5', discount_pct: '0' }],
      },
    });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales', '/sales/quotes', `/sales/quotes/${QUOTE}`]));
    // The form page itself is not revalidated mid-edit.
    expect(state.revalidated).not.toContain('/sales/quotes/new');
  });
  it('an edit sends the id and the version it loaded; pieces and a note travel as typed', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: { id: QUOTE, quote_no: 'QT/26-27/0001', updated_at: STAMP }, error: null });
    const res = await saveQuote({ ...form, id: QUOTE, expectedUpdatedAt: STAMP, validUntil: '2026-10-20', note: ' 30 days credit ', lines: [{ ...line, altQty: '17' }] });
    expect(res.ok).toBe(true);
    expect(rpcCalls()[0]!.payload).toMatchObject({
      p_id: QUOTE, p_expected_updated_at: STAMP, p_valid_until: '2026-10-20', p_note: '30 days credit',
      p_lines: [{ item_id: ITEM, alt_qty: '17' }],
    });
  });
  it('sends updated_at back exactly as the database gave it (a string, microseconds intact), never through a Date', async () => {
    reset(asCounter());
    const exact = '2026-10-02T10:00:00.123457+00:00';
    state.respond = () => ({ data: { id: QUOTE, quote_no: 'QT/26-27/0001', updated_at: exact }, error: null });
    const first = await saveQuote({ ...form, id: QUOTE, expectedUpdatedAt: exact });
    expect(rpcCalls()[0]!.payload).toMatchObject({ p_expected_updated_at: exact });
    expect(first).toMatchObject({ ok: true, data: { updatedAt: exact } });
    // The version the action returns is the version the next save sends, byte for byte.
    if (first.ok) await saveQuote({ ...form, id: QUOTE, expectedUpdatedAt: first.data.updatedAt });
    expect(rpcCalls()[1]!.payload).toMatchObject({ p_expected_updated_at: '2026-10-02T10:00:00.123457+00:00' });
    expect(new Date(exact).toISOString()).not.toBe(exact); // a Date round trip would have lost the digits
  });
  it('sends no totals, names or tax: the database takes those from the item master and computes the sums', async () => {
    reset(asCounter());
    state.respond = () => ({ data: { id: QUOTE, quote_no: 'QT/26-27/0001', updated_at: STAMP }, error: null });
    await saveQuote({ ...form, grandTotal: '1', taxable: '1', lines: [{ ...line, itemName: 'x', gstRate: '28', hsn: '1' }] });
    const sent = rpcCalls()[0]!.payload as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['p_expected_updated_at', 'p_id', 'p_lines', 'p_note', 'p_party_id', 'p_quote_date', 'p_valid_until']);
    expect(Object.keys((sent.p_lines as object[])[0]!).sort()).toEqual(['discount_pct', 'item_id', 'qty', 'rate']);
  });
  it('is refused for a signed-out visitor, an owner without the authenticator step, and never touches the database', async () => {
    reset(null);
    expect(await saveQuote(form)).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin('aal1'));
    expect(await saveQuote(form)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('catches bad input before the database', async () => {
    reset(asCounter());
    expect(await saveQuote({ ...form, lines: [] })).toEqual({ ok: false, code: 'validation', error: 'field.lines_required' });
    expect(await saveQuote({ ...form, lines: [{ ...line, qty: '1e3' }] })).toMatchObject({ ok: false, code: 'validation' });
    expect(await saveQuote({ ...form, id: QUOTE })).toEqual({ ok: false, code: 'validation', error: 'field.stale_version_missing' });
    expect(await saveQuote({ ...form, validUntil: '2026-10-01' })).toEqual({ ok: false, code: 'validation', error: 'field.valid_until_before_date' });
    expect(await saveQuote({ ...form, note: 'x'.repeat(501) })).toEqual({ ok: false, code: 'validation', error: 'field.text_long' });
    expect(state.calls).toHaveLength(0);
  });
  it('a stale write (DN_CONFLICT) becomes the conflict code with the reload sentence', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_CONFLICT');
    expect(await saveQuote({ ...form, id: QUOTE, expectedUpdatedAt: STAMP })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
  });
  it('maps every DN_VALIDATION detail of the contract to a quote sentence, never the generic one', async () => {
    const details = [
      'invalid_date', 'future_date', 'valid_until_before_date', 'valid_until_too_far', 'note_too_long', 'no_such_quote', 'quote_not_open',
      'quote_fy_change', 'invalid_party', 'no_default_warehouse', 'invalid_warehouse', 'no_lines', 'too_many_lines', 'invalid_line', 'no_such_item',
      'item_inactive', 'invalid_qty', 'invalid_rate', 'invalid_discount', 'invalid_alt_qty', 'zero_total', 'invalid_status', 'quote_converted',
      'invalid_transition', 'quote_expired', 'amount_too_large', 'quote_pos_changed', 'quote_immutable', 'quote_no_delete',
    ];
    for (const d of details) {
      reset(asCounter());
      state.respond = () => dbError(`DN_VALIDATION:${d}`);
      expect(await saveQuote(form)).toEqual({ ok: false, code: 'validation', error: `quote.${d}` });
      // The same sentences serve mark and convert.
      expect(await markQuote({ id: QUOTE, status: 'accepted' })).toEqual({ ok: false, code: 'validation', error: `quote.${d}` });
      expect(await convertQuoteToInvoice({ id: QUOTE })).toEqual({ ok: false, code: 'validation', error: `quote.${d}` });
    }
  });
  it('names the disabled item or party when the database says which', async () => {
    reset(asCounter());
    state.respond = () => ({ data: null, error: { message: 'DN_VALIDATION:item_inactive', details: 'Old Cement 53', code: 'P0001' } as never });
    expect(await saveQuote(form)).toEqual({ ok: false, code: 'validation', error: 'quote.item_inactive_named' });
    state.respond = () => ({ data: null, error: { message: 'DN_VALIDATION:invalid_party', details: 'Ravi Traders', code: 'P0001' } as never });
    expect(await convertQuoteToInvoice({ id: QUOTE })).toEqual({ ok: false, code: 'validation', error: 'quote.invalid_party_named' });
  });
  it('an unexpected database error is internal and never echoes Postgres text', async () => {
    reset(asCounter());
    state.respond = () => dbError('relation "quotations" does not exist', '42P01');
    const res = await saveQuote(form);
    expect(res).toEqual({ ok: false, code: 'internal', error: 'internal' });
  });
  it('an odd reply from the database is internal, not a crash', async () => {
    reset(asCounter());
    state.respond = () => ({ data: { id: QUOTE }, error: null });
    expect(await saveQuote(form)).toMatchObject({ ok: false, code: 'internal' });
  });
});

describe('markQuote', () => {
  it('calls mark_quotation and returns the new version', async () => {
    reset(asCounter());
    state.respond = () => ({ data: STAMP, error: null });
    expect(await markQuote({ id: QUOTE, status: 'accepted' })).toEqual({ ok: true, data: { id: QUOTE, updatedAt: STAMP } });
    expect(rpcCalls()[0]).toMatchObject({ rpc: 'mark_quotation', payload: { p_quote_id: QUOTE, p_status: 'accepted' } });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales/quotes', `/sales/quotes/${QUOTE}`]));
  });
  it('is refused for a non-member with zero database calls, and never accepts "converted"', async () => {
    reset(null);
    expect(await markQuote({ id: QUOTE, status: 'open' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
    reset(asCounter());
    expect(await markQuote({ id: QUOTE, status: 'converted' })).toEqual({ ok: false, code: 'validation', error: 'field.status_invalid' });
    expect(await markQuote({ id: 'nope', status: 'open' })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toHaveLength(0);
  });
  it('a refused move from the database is a quote sentence', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_VALIDATION:invalid_transition');
    expect(await markQuote({ id: QUOTE, status: 'open' })).toEqual({ ok: false, code: 'validation', error: 'quote.invalid_transition' });
  });
});

describe('convertQuoteToInvoice', () => {
  it('returns the draft invoice id the database made, and posts nothing itself', async () => {
    reset(asCounter());
    state.respond = () => ({ data: INVOICE, error: null });
    expect(await convertQuoteToInvoice({ id: QUOTE })).toEqual({ ok: true, data: { invoiceId: INVOICE } });
    expect(state.calls).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({ rpc: 'convert_quotation_to_invoice', payload: { p_quote_id: QUOTE } });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales', '/sales/quotes', `/sales/quotes/${QUOTE}`]));
  });
  it('a repeat call just asks again and gets the same id', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: INVOICE, error: null });
    const a = await convertQuoteToInvoice({ id: QUOTE });
    const b = await convertQuoteToInvoice({ id: QUOTE });
    expect(a).toEqual(b);
  });
  it('is refused for a non-member with zero database calls', async () => {
    reset(null);
    expect(await convertQuoteToInvoice({ id: QUOTE })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('a database that returns forbidden stays forbidden; no id means internal', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_FORBIDDEN');
    expect(await convertQuoteToInvoice({ id: QUOTE })).toEqual({ ok: false, code: 'forbidden', error: 'forbidden' });
    state.respond = () => ({ data: null, error: null });
    expect(await convertQuoteToInvoice({ id: QUOTE })).toMatchObject({ ok: false, code: 'internal' });
  });
});
