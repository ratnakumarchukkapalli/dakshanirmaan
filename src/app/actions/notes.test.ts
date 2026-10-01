import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { cancelNote, deleteDraftNote, postNote, saveDraftNote } from './notes';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const NOTE = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';
const PARTY = '44444444-4444-4444-8444-444444444444';
const ITEM = '33333333-3333-4333-8333-333333333333';
const LINE = '55555555-5555-4555-8555-555555555555';
const STAMP = '2026-09-20T10:00:00.123456+00:00';

const credit = {
  kind: 'credit', invoiceId: INVOICE, noteDate: '2026-09-19', reason: 'Damaged bags', stockEffect: true,
  lines: [{ againstLineId: LINE, qty: '10.000', rate: '' }],
};
const debit = { ...credit, kind: 'debit' };
const invLine = { id: LINE, item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', rate: 52.5, gst_rate: 18 };

/** Answers each table like a healthy database for either kind; a test overrides what it wants to break. */
function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata', state_code: '37' }] };
      case 'sales_invoices:select': case 'purchase_invoices:select':
        return { data: [{ id: INVOICE, status: 'posted', party_id: PARTY, place_of_supply: '36', invoice_date: '2026-09-10' }] };
      case 'sales_invoice_lines:select': case 'purchase_invoice_lines:select': return { data: [invLine] };
      case 'credit_notes:insert': case 'debit_notes:insert': case 'credit_notes:update': case 'debit_notes:update':
        return { data: [{ id: NOTE, updated_at: STAMP }] };
      case 'credit_notes:select': case 'debit_notes:select': return { data: [{ id: NOTE, status: 'draft', against_invoice_id: INVOICE }] };
      case 'credit_note_lines:select': case 'debit_note_lines:select': return { data: [] };
      case 'credit_notes:delete': case 'debit_notes:delete': return { data: [{ id: NOTE, against_invoice_id: INVOICE }] };
      default: return { data: null, error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);
const forbidden = { ok: false, code: 'forbidden', error: 'forbidden' };

describe('every note action is owner-only', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['saveDraftNote', () => saveDraftNote(credit)],
    ['deleteDraftNote', () => deleteDraftNote({ kind: 'credit', id: NOTE })],
    ['postNote', () => postNote({ kind: 'credit', id: NOTE })],
    ['cancelNote', () => cancelNote({ kind: 'credit', id: NOTE, reason: 'entered twice' })],
  ];
  for (const [name, run] of calls) {
    it(`${name}: a counter user is refused before the database is touched`, async () => {
      reset(asCounter());
      healthy();
      expect(await run()).toEqual(forbidden);
      expect(state.calls).toEqual([]);
    });
    it(`${name}: an owner who has not passed the authenticator step is refused`, async () => {
      reset(asAdmin('aal1'));
      healthy();
      expect(await run()).toEqual(forbidden);
      expect(state.calls).toEqual([]);
    });
    it(`${name}: nobody signed in is refused`, async () => {
      reset(null);
      healthy();
      expect(await run()).toEqual(forbidden);
      expect(state.calls).toEqual([]);
    });
  }
});

describe('saveDraftNote', () => {
  it('credit note: takes party and place of supply from the invoice, snapshots the invoice line, computes no money', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote(credit)).toEqual({ ok: true, data: { id: NOTE, updatedAt: STAMP } });
    const header = find('credit_notes', 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({
      status: 'draft', party_id: PARTY, place_of_supply: '36', against_invoice_id: INVOICE, note_date: '2026-09-19',
      reason: 'Damaged bags', stock_effect: true, created_by: 'u-admin',
    });
    for (const k of ['taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'grand_total', 'round_off', 'note_no', 'journal_entry_id']) expect(header).not.toHaveProperty(k);
    const lines = find('credit_note_lines', 'insert')!.payload as Record<string, unknown>[];
    // A return takes the invoice line's own rate (the database re-derives it); taxable_value 0 is a placeholder it overwrites.
    expect(lines).toEqual([{
      note_id: NOTE, line_no: 1, item_id: ITEM, against_line_id: LINE, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg',
      gst_rate: 18, qty: '10.000', rate: 52.5, taxable_value: 0,
    }]);
    for (const l of lines) for (const k of ['cgst_amt', 'sgst_amt', 'igst_amt']) expect(l).not.toHaveProperty(k);
    expect(state.revalidated).toEqual([]);
  });

  it('debit note: works on bills, and its place of supply is our own state', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote(debit)).toMatchObject({ ok: true });
    expect(find('debit_notes', 'insert')!.payload).toMatchObject({ place_of_supply: '37', party_id: PARTY, against_invoice_id: INVOICE });
    expect(find('debit_note_lines', 'insert')).toBeDefined();
    expect(find('credit_notes', 'insert')).toBeUndefined();
  });

  it('a value-only note keeps the typed rate and needs one', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote({ ...credit, stockEffect: false, lines: [{ againstLineId: LINE, qty: '10', rate: '2.5000' }] })).toMatchObject({ ok: true });
    expect((find('credit_note_lines', 'insert')!.payload as Record<string, unknown>[])[0]).toMatchObject({ rate: '2.5000' });
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote({ ...credit, stockEffect: false })).toEqual({ ok: false, code: 'validation', error: 'field.rate_positive' });
    expect(state.calls).toEqual([]);
  });

  it('refuses a line twice, no lines, a short reason, a bad quantity, a future date and an unknown kind before touching the database', async () => {
    const cases: [unknown, string][] = [
      [{ ...credit, lines: [credit.lines[0], credit.lines[0]] }, 'field.line_duplicate'],
      [{ ...credit, lines: [] }, 'field.lines_required'],
      [{ ...credit, reason: 'x' }, 'field.reason_required'],
      [{ ...credit, lines: [{ againstLineId: LINE, qty: '0', rate: '' }] }, 'field.qty_positive'],
      [{ ...credit, lines: [{ againstLineId: LINE, qty: '1.2345', rate: '' }] }, 'field.qty_invalid'],
      [{ ...credit, kind: 'refund' }, 'validation.generic'],
    ];
    for (const [bad, error] of cases) {
      reset(asAdmin());
      healthy();
      expect(await saveDraftNote(bad)).toEqual({ ok: false, code: 'validation', error });
      expect(state.calls).toEqual([]);
    }
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote({ ...credit, noteDate: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.note_date_future' });
    expect(find('credit_notes', 'insert')).toBeUndefined();
  });

  it('refuses a missing, draft or cancelled invoice, a date before it, and a line from another invoice', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoices' ? { data: [] } : undefined));
    expect(await saveDraftNote(credit)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_invoice' });
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' ? { data: [] } : undefined));
    expect(await saveDraftNote(debit)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_bill' });
    for (const status of ['draft', 'cancelled']) {
      reset(asAdmin());
      healthy((c) => (c.table === 'sales_invoices' ? { data: [{ id: INVOICE, status, party_id: PARTY, invoice_date: '2026-09-10' }] } : undefined));
      expect(await saveDraftNote(credit)).toEqual({ ok: false, code: 'validation', error: 'validation.invoice_not_posted' });
    }
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoices' ? { data: [{ id: INVOICE, status: 'posted', party_id: PARTY, invoice_date: '2026-09-25' }] } : undefined));
    expect(await saveDraftNote(credit)).toEqual({ ok: false, code: 'validation', error: 'validation.note_before_invoice' });
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoice_lines' ? { data: [{ ...invLine, id: '66666666-6666-4666-8666-666666666666' }] } : undefined));
    expect(await saveDraftNote(credit)).toEqual({ ok: false, code: 'validation', error: 'validation.line_not_on_invoice' });
    expect(find('credit_notes', 'insert')).toBeUndefined();
  });

  it('editing sends the loaded updated_at and replaces the lines; a stale version is a conflict', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: STAMP })).toMatchObject({ ok: true });
    expect(find('credit_notes', 'update')!.filters).toEqual(expect.arrayContaining([['id', NOTE], ['status', 'draft'], ['updated_at', STAMP]]));
    expect(find('credit_note_lines', 'delete')).toBeDefined();
    expect(find('credit_note_lines', 'insert')).toBeDefined();

    reset(asAdmin());
    healthy((c) => (c.table === 'credit_notes' && c.op === 'update' ? { data: [] } : undefined));
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: 'old' })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
    expect(find('credit_note_lines', 'delete')).toBeUndefined();

    reset(asAdmin());
    healthy();
    expect(await saveDraftNote({ ...credit, id: NOTE })).toMatchObject({ ok: false, code: 'validation', error: 'field.stale_version_missing' });
  });

  it('a posted note cannot be edited, and a draft cannot be moved to another invoice', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'credit_notes' && c.op === 'select' ? { data: [{ id: NOTE, status: 'posted', against_invoice_id: INVOICE }] } : undefined));
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(find('credit_notes', 'update')).toBeUndefined();
    reset(asAdmin());
    healthy((c) => (c.table === 'credit_notes' && c.op === 'select' ? { data: [{ id: NOTE, status: 'draft', against_invoice_id: '77777777-7777-4777-8777-777777777777' }] } : undefined));
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: STAMP })).toEqual({ ok: false, code: 'validation', error: 'validation.note_invoice_locked' });
  });

  it('if the new lines are refused, the previous lines are put back', async () => {
    reset(asAdmin());
    const old = { id: 'l1', created_at: 'x', note_id: NOTE, line_no: 1, item_id: ITEM, qty: 5 };
    let inserts = 0;
    healthy((c) => {
      if (c.table === 'credit_note_lines' && c.op === 'select') return { data: [old] };
      if (c.table === 'credit_note_lines' && c.op === 'insert') return ++inserts === 1 ? dbError('check violation', '23514') : { data: null, error: null };
      return undefined;
    });
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'validation' });
    const restore = state.calls.filter((c) => c.table === 'credit_note_lines' && c.op === 'insert')[1]!.payload as Record<string, unknown>[];
    expect(restore).toEqual([{ note_id: NOTE, line_no: 1, item_id: ITEM, qty: 5 }]);
  });

  it('if the old lines cannot be put back either, the person is told the save was partial', async () => {
    reset(asAdmin());
    let inserts = 0;
    healthy((c) => {
      if (c.table === 'credit_note_lines' && c.op === 'select') return { data: [{ id: 'l1', created_at: 'x', note_id: NOTE, line_no: 1, item_id: ITEM, qty: 5 }] };
      if (c.table === 'credit_note_lines' && c.op === 'insert') return ++inserts === 1 ? dbError('check violation', '23514') : dbError('still broken', '23514');
      return undefined;
    });
    expect(await saveDraftNote({ ...credit, id: NOTE, expectedUpdatedAt: STAMP })).toEqual({ ok: false, code: 'partial', error: 'partial' });
  });

  it('a new draft whose lines are refused is removed, not left empty', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'credit_note_lines' && c.op === 'insert' ? dbError('numeric field overflow', '22003') : undefined));
    expect(await saveDraftNote(credit)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
    expect(find('credit_notes', 'delete')?.filters).toEqual([['id', NOTE]]);
  });
});

describe('deleteDraftNote', () => {
  it('deletes only a draft, and says so when nothing was a draft', async () => {
    reset(asAdmin());
    healthy();
    expect(await deleteDraftNote({ kind: 'debit', id: NOTE })).toEqual({ ok: true, data: null });
    expect(find('debit_notes', 'delete')!.filters).toEqual(expect.arrayContaining([['id', NOTE], ['status', 'draft']]));
    reset(asAdmin());
    healthy((c) => (c.op === 'delete' ? { data: [] } : undefined));
    expect(await deleteDraftNote({ kind: 'credit', id: NOTE })).toMatchObject({ ok: false, code: 'not_draft' });
  });
});

describe('postNote', () => {
  it('calls the matching posting function and passes nothing but the id', async () => {
    reset(asAdmin());
    healthy();
    expect(await postNote({ kind: 'credit', id: NOTE })).toEqual({ ok: true, data: { id: NOTE } });
    expect(rpc('post_credit_note')!.payload).toEqual({ p_note_id: NOTE });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales', `/sales/credit-notes/${NOTE}/view`, `/sales/${INVOICE}/view`, '/parties', '/stock', '/reports']));
    reset(asAdmin());
    healthy();
    expect(await postNote({ kind: 'debit', id: NOTE })).toMatchObject({ ok: true });
    expect(rpc('post_debit_note')!.payload).toEqual({ p_note_id: NOTE });
    expect(rpc('post_credit_note')).toBeUndefined();
  });

  it('a note that is not a draft is not posted again', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'credit_notes' ? { data: [{ status: 'posted', against_invoice_id: INVOICE }] } : undefined));
    expect(await postNote({ kind: 'credit', id: NOTE })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(rpc('post_credit_note')).toBeUndefined();
  });

  it('maps the database refusals to sentences', async () => {
    const cases: [string, string, string][] = [
      ['DN_VALIDATION:qty_exceeds_invoice', 'validation', 'validation.qty_exceeds_invoice'],
      ['DN_VALIDATION:value_exceeds_invoice', 'validation', 'validation.value_exceeds_invoice'],
      ['DN_VALIDATION:exceeds_open_amount', 'validation', 'validation.exceeds_open_amount'],
      ['DN_VALIDATION:note_before_invoice', 'validation', 'validation.note_before_invoice'],
      ['DN_VALIDATION:reason_required', 'validation', 'validation.reason_required'],
      ['DN_PERIOD_LOCKED', 'period_locked', 'period_locked'],
      ['DN_NEGATIVE_STOCK', 'negative_stock', 'negative_stock'],
      ['DN_FORBIDDEN', 'forbidden', 'forbidden'],
    ];
    for (const [message, code, error] of cases) {
      reset(asAdmin());
      healthy((c) => (c.rpc ? dbError(message) : undefined));
      expect(await postNote({ kind: 'debit', id: NOTE })).toEqual({ ok: false, code, error });
    }
  });

  it('raw database text never reaches the person', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc ? dbError('relation "x" does not exist: secret') : undefined));
    expect(await postNote({ kind: 'credit', id: NOTE })).toEqual({ ok: false, code: 'internal', error: 'internal' });
  });
});

describe('cancelNote', () => {
  it('cancels through cancel_document with the note source type and the reason', async () => {
    reset(asAdmin());
    healthy();
    expect(await cancelNote({ kind: 'credit', id: NOTE, reason: 'entered twice' })).toEqual({ ok: true, data: { id: NOTE } });
    expect(rpc('cancel_document')!.payload).toEqual({ p_source_type: 'credit_note', p_source_id: NOTE, p_reason: 'entered twice' });
    reset(asAdmin());
    healthy();
    await cancelNote({ kind: 'debit', id: NOTE, reason: 'entered twice' });
    expect(rpc('cancel_document')!.payload).toMatchObject({ p_source_type: 'debit_note' });
  });

  it('needs a reason', async () => {
    reset(asAdmin());
    healthy();
    expect(await cancelNote({ kind: 'credit', id: NOTE, reason: 'ab' })).toMatchObject({ ok: false, code: 'validation', error: 'field.reason_required' });
    expect(rpc('cancel_document')).toBeUndefined();
  });

  it('later notes standing, and later stock movement, each get their own sentence (never "not enough stock")', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc ? dbError('DN_VALIDATION:later_notes') : undefined));
    expect(await cancelNote({ kind: 'credit', id: NOTE, reason: 'entered twice' })).toEqual({ ok: false, code: 'validation', error: 'validation.later_notes' });
    reset(asAdmin());
    healthy((c) => (c.rpc ? dbError('DN_NEGATIVE_STOCK') : undefined));
    expect(await cancelNote({ kind: 'credit', id: NOTE, reason: 'entered twice' })).toEqual({ ok: false, code: 'negative_stock', error: 'validation.note_cancel_stock_moved' });
  });

  it('a locked month is reported as such', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc ? dbError('DN_PERIOD_LOCKED') : undefined));
    expect(await cancelNote({ kind: 'debit', id: NOTE, reason: 'entered twice' })).toEqual({ ok: false, code: 'period_locked', error: 'period_locked' });
  });
});
