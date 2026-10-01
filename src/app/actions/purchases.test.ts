import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { addBillFreight, cancelBill, deleteDraftBill, postBill, saveDraftBill } from './purchases';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const BILL = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const STAMP = '2026-09-20T10:00:00.123456+00:00';

const form = {
  partyId: SUPPLIER, invoiceDate: '2026-09-19', supplierBillNo: 'SUP/2026/001', supplierBillDate: '2026-09-18', itcEligible: true,
  lines: [{ itemId: ITEM, qty: '1200.000', altQty: '113', rate: '52.5000', discountPct: '' }],
};
const item = { id: ITEM, name: 'Tata Tiscon 12mm', hsn_code: '7214', gst_rate: 18, base_uom: 'kg', alt_uom: 'pcs', is_active: true, is_stock: true };

const VOUCHER = '66666666-6666-4666-8666-666666666666';
const TRANSPORTER = '77777777-7777-4777-8777-777777777777';
const PAY = '88888888-8888-4888-8888-888888888888';
const freight = { id: VOUCHER, billId: BILL, voucherDate: '2026-09-19', transporterId: TRANSPORTER, amount: '12000.00', payAccountId: PAY, note: 'lorry AP16 TC 4455' };

const isDuplicateCheck = (c: Call) => c.table === 'purchase_invoices' && c.op === 'select' && c.filters.some(([k, v]) => k === 'status' && v === 'posted');

/** Answers each table like a healthy database; a test overrides what it wants to break. */
function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    if (isDuplicateCheck(call)) return { data: [] };
    switch (`${call.table}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata', state_code: '37' }] };
      case 'parties:select': return { data: [{ id: SUPPLIER, type: 'supplier', is_active: true }] };
      case 'items:select': return { data: [item] };
      case 'warehouses:select': return { data: [{ id: 'wh-1' }] };
      case 'purchase_invoices:insert': return { data: [{ id: BILL, updated_at: STAMP }] };
      case 'purchase_invoices:update': return { data: [{ id: BILL, updated_at: STAMP }] };
      case 'purchase_invoices:select': return { data: [{ id: BILL, status: 'draft', party_id: SUPPLIER, supplier_bill_no: 'SUP/2026/001' }] };
      case 'purchase_invoice_lines:select': return { data: [] };
      case 'purchase_invoices:delete': return { data: [{ id: BILL }] };
      default: return { data: null, error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);
const forbidden = { ok: false, code: 'forbidden', error: 'forbidden' };

describe('every purchase action is owner-only', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['saveDraftBill', () => saveDraftBill(form)],
    ['deleteDraftBill', () => deleteDraftBill({ id: BILL })],
    ['postBill', () => postBill({ id: BILL })],
    ['cancelBill', () => cancelBill({ id: BILL, reason: 'wrong supplier' })],
    ['addBillFreight', () => addBillFreight(freight)],
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

describe('saveDraftBill', () => {
  it('creates a draft: own state as place of supply, snapshots on each line, rcm off, and no money computed', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftBill(form)).toEqual({ ok: true, data: { id: BILL, updatedAt: STAMP } });
    const header = find('purchase_invoices', 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({
      warehouse_id: 'wh-1', status: 'draft', place_of_supply: '37', party_id: SUPPLIER, invoice_date: '2026-09-19',
      supplier_bill_no: 'SUP/2026/001', supplier_bill_date: '2026-09-18', itc_eligible: true, rcm: false, created_by: 'u-admin',
    });
    for (const money of ['taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'grand_total', 'round_off', 'invoice_no', 'journal_entry_id'])
      expect(header).not.toHaveProperty(money);

    const lines = find('purchase_invoice_lines', 'insert')!.payload as Record<string, unknown>[];
    // taxable_value is a NOT NULL column with no default: 0 is a placeholder the posting function overwrites.
    expect(lines).toEqual([{
      invoice_id: BILL, line_no: 1, item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', gst_rate: 18,
      qty: '1200.000', alt_qty: '113', rate: '52.5000', discount_pct: '0', taxable_value: 0,
    }]);
    for (const l of lines) for (const k of ['cgst_amt', 'sgst_amt', 'igst_amt']) expect(l).not.toHaveProperty(k);
    // Saving a draft must not revalidate (it would remount the form under the person's hands).
    expect(state.revalidated).toEqual([]);
  });

  it('a form cannot switch on reverse charge, whatever it sends', async () => {
    reset(asAdmin());
    healthy();
    await saveDraftBill({ ...form, rcm: true });
    expect(find('purchase_invoices', 'insert')!.payload).toMatchObject({ rcm: false });
  });

  it('a second unit is only kept for an item that has one', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'items' ? { data: [{ ...item, alt_uom: null }] } : undefined));
    await saveDraftBill(form);
    expect((find('purchase_invoice_lines', 'insert')!.payload as Record<string, unknown>[])[0]).toHaveProperty('alt_qty', null);
  });

  it('editing sends the loaded updated_at and replaces the lines', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: STAMP })).toMatchObject({ ok: true });
    const upd = find('purchase_invoices', 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', BILL], ['status', 'draft'], ['updated_at', STAMP]]));
    expect(find('purchase_invoice_lines', 'delete')).toBeDefined();
    expect(find('purchase_invoice_lines', 'insert')).toBeDefined();
  });

  it('a stale version is a conflict and touches no lines', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' && c.op === 'update' ? { data: [] } : undefined));
    expect(await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: 'old' })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
    expect(find('purchase_invoice_lines', 'delete')).toBeUndefined();
  });

  it('editing needs the loaded version; a posted bill cannot be edited', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftBill({ ...form, id: BILL })).toMatchObject({ ok: false, code: 'validation', error: 'field.stale_version_missing' });
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' && c.op === 'select' && !isDuplicateCheck(c) ? { data: [{ id: BILL, status: 'posted', party_id: SUPPLIER }] } : undefined));
    expect(await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(find('purchase_invoices', 'update')).toBeUndefined();
  });

  it('if the new lines are refused, the previous lines are put back', async () => {
    reset(asAdmin());
    const old = { id: 'l1', created_at: 'x', invoice_id: BILL, line_no: 1, item_id: ITEM, item_name: 'Old', qty: 5 };
    let inserts = 0;
    healthy((c) => {
      if (c.table === 'purchase_invoice_lines' && c.op === 'select') return { data: [old] };
      if (c.table === 'purchase_invoice_lines' && c.op === 'insert') return ++inserts === 1 ? dbError('check violation', '23514') : { data: null, error: null };
      return undefined;
    });
    expect(await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'validation' });
    const restore = state.calls.filter((c) => c.table === 'purchase_invoice_lines' && c.op === 'insert')[1]!.payload as Record<string, unknown>[];
    expect(restore).toEqual([{ invoice_id: BILL, line_no: 1, item_id: ITEM, item_name: 'Old', qty: 5 }]);
  });

  it('a new draft whose lines are refused is removed, not left empty', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoice_lines' && c.op === 'insert' ? dbError('numeric field overflow', '22003') : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
    expect(find('purchase_invoices', 'delete')?.filters).toEqual([['id', BILL]]);
  });

  it('refuses a future date, a customer as supplier, a disabled supplier, a service item, a disabled item and a missing item', async () => {
    reset(asAdmin()); healthy();
    expect(await saveDraftBill({ ...form, invoiceDate: '2999-01-01', supplierBillDate: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.bill_date_future' });
    reset(asAdmin()); healthy((c) => (c.table === 'parties' ? { data: [{ id: SUPPLIER, type: 'customer', is_active: true }] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_supplier' });
    reset(asAdmin()); healthy((c) => (c.table === 'parties' ? { data: [{ id: SUPPLIER, type: 'supplier', is_active: false }] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_supplier' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [{ ...item, is_stock: false }] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.bill_item_not_stock' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [{ ...item, is_active: false }] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.bill_item_inactive' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
    reset(asAdmin()); healthy((c) => (c.table === 'warehouses' ? { data: [] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.no_default_warehouse' });
  });

  it('an existing draft may keep a supplier or item that was disabled since', async () => {
    reset(asAdmin());
    healthy((c) => {
      if (c.table === 'parties') return { data: [{ id: SUPPLIER, type: 'supplier', is_active: false }] };
      if (c.table === 'items') return { data: [{ ...item, is_active: false }] };
      if (c.table === 'purchase_invoice_lines' && c.op === 'select') return { data: [{ item_id: ITEM }] };
      return undefined;
    });
    expect(await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: STAMP })).toMatchObject({ ok: true });
  });

  it('refuses a supplier bill number that is already posted for this supplier', async () => {
    reset(asAdmin());
    healthy((c) => (isDuplicateCheck(c) ? { data: [{ id: 'other-bill' }] } : undefined));
    expect(await saveDraftBill(form)).toEqual({ ok: false, code: 'validation', error: 'validation.duplicate_supplier_bill' });
    expect(find('purchase_invoices', 'insert')).toBeUndefined();
    // The check is scoped to this supplier, and to posted bills only.
    const check = state.calls.find(isDuplicateCheck)!;
    expect(check.filters).toEqual(expect.arrayContaining([['party_id', SUPPLIER], ['status', 'posted']]));
  });

  it('when editing, the draft itself is not a duplicate of itself', async () => {
    reset(asAdmin());
    healthy();
    await saveDraftBill({ ...form, id: BILL, expectedUpdatedAt: STAMP });
    expect(state.calls.find(isDuplicateCheck)!.filters).toEqual(expect.arrayContaining([['id', BILL]]));
  });

  it('input the schema refuses never reaches the database', async () => {
    reset(asAdmin()); healthy();
    expect(await saveDraftBill({ ...form, lines: [] })).toMatchObject({ ok: false, code: 'validation', error: 'field.lines_required' });
    expect(await saveDraftBill({ ...form, supplierBillNo: '  ' })).toMatchObject({ ok: false, code: 'validation', error: 'field.supplier_bill_no_required' });
    expect(await saveDraftBill({ ...form, supplierBillNo: "1'; drop table x;--" })).toMatchObject({ ok: false, code: 'validation', error: 'field.supplier_bill_no_invalid' });
    expect(await saveDraftBill({ ...form, supplierBillDate: '2026-09-20' })).toMatchObject({ ok: false, code: 'validation', error: 'field.supplier_bill_after_receipt' });
    expect(await saveDraftBill({ ...form, itcEligible: 'yes' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await saveDraftBill({ ...form, lines: [{ ...form.lines[0], qty: '12.5e3' }] })).toMatchObject({ ok: false, code: 'validation', error: 'field.qty_invalid' });
    expect(await saveDraftBill({ ...form, lines: [{ ...form.lines[0], rate: '-5' }] })).toMatchObject({ ok: false, code: 'validation', error: 'field.rate_invalid' });
    expect(find('purchase_invoices', 'insert')).toBeUndefined();
  });
});

describe('deleteDraftBill', () => {
  it('deletes a draft only', async () => {
    reset(asAdmin());
    healthy();
    expect(await deleteDraftBill({ id: BILL })).toEqual({ ok: true, data: null });
    expect(find('purchase_invoices', 'delete')!.filters).toEqual(expect.arrayContaining([['id', BILL], ['status', 'draft']]));
    expect(state.revalidated).toContain('/purchases');
  });
  it('a bill that is not a draft is refused with not_draft', async () => {
    reset(asAdmin());
    healthy((c) => (c.op === 'delete' ? { data: [] } : undefined));
    expect(await deleteDraftBill({ id: BILL })).toMatchObject({ ok: false, code: 'not_draft' });
  });
});

describe('postBill', () => {
  it('posts through post_purchase_invoice on the user-scoped client and revalidates what changes', async () => {
    reset(asAdmin());
    healthy();
    expect(await postBill({ id: BILL })).toEqual({ ok: true, data: { id: BILL } });
    expect(rpc('post_purchase_invoice')!.payload).toEqual({ p_invoice_id: BILL });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/purchases', `/purchases/${BILL}/view`, '/parties', '/stock', '/payments', '/']));
  });

  it('refuses when the supplier bill number was posted elsewhere in the meantime, before calling the database function', async () => {
    reset(asAdmin());
    healthy((c) => (isDuplicateCheck(c) ? { data: [{ id: 'other-bill' }] } : undefined));
    expect(await postBill({ id: BILL })).toEqual({ ok: false, code: 'validation', error: 'validation.duplicate_supplier_bill' });
    expect(rpc('post_purchase_invoice')).toBeUndefined();
  });

  it('two owners posting the same supplier bill at once: the unique index answer becomes the same friendly message', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_purchase_invoice' ? dbError('duplicate key value violates unique constraint "purchase_invoices_supplier_bill_uniq"', '23505') : undefined));
    expect(await postBill({ id: BILL })).toEqual({ ok: false, code: 'validation', error: 'validation.duplicate_supplier_bill' });
  });

  it('refuses a draft with no supplier bill number and a bill that is not a draft', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' && c.op === 'select' && !isDuplicateCheck(c) ? { data: [{ party_id: SUPPLIER, supplier_bill_no: '  ', status: 'draft' }] } : undefined));
    expect(await postBill({ id: BILL })).toEqual({ ok: false, code: 'validation', error: 'validation.supplier_bill_no_missing' });
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' && c.op === 'select' && !isDuplicateCheck(c) ? { data: [{ party_id: SUPPLIER, supplier_bill_no: 'X1', status: 'posted' }] } : undefined));
    expect(await postBill({ id: BILL })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(rpc('post_purchase_invoice')).toBeUndefined();
  });

  it('refuses a stored bill number the form would never have accepted (a draft written around the form), before posting', async () => {
    for (const odd of ['SUP/100\t', 'SUP\u00a0100', 'ЅUP/100', '../x']) {
      reset(asAdmin());
      healthy((c) => (c.table === 'purchase_invoices' && c.op === 'select' && !isDuplicateCheck(c) ? { data: [{ party_id: SUPPLIER, supplier_bill_no: odd, status: 'draft' }] } : undefined));
      expect(await postBill({ id: BILL })).toEqual({ ok: false, code: 'validation', error: 'validation.supplier_bill_no_invalid' });
      expect(rpc('post_purchase_invoice')).toBeUndefined();
    }
  });

  it.each([
    ['DN_PERIOD_LOCKED', 'period_locked'],
    ['DN_NOT_DRAFT', 'not_draft'],
    ['DN_FORBIDDEN', 'forbidden'],
    ['DN_UNBALANCED', 'unbalanced'],
  ])('maps %s to %s', async (raise, code) => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_purchase_invoice' ? dbError(raise) : undefined));
    expect(await postBill({ id: BILL })).toMatchObject({ ok: false, code });
  });

  it('a validation raise from the database reaches the person as its own sentence; anything unknown does not leak', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_purchase_invoice' ? dbError('DN_VALIDATION:non_stock_line') : undefined));
    expect(await postBill({ id: BILL })).toMatchObject({ ok: false, code: 'validation', error: 'validation.non_stock_line' });
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_purchase_invoice' ? dbError('relation "secret_table" does not exist', '42P01') : undefined));
    const r = await postBill({ id: BILL });
    expect(r).toMatchObject({ ok: false, code: 'internal', error: 'internal' });
    expect(JSON.stringify(r)).not.toContain('secret_table');
  });

  it('a malformed id never reaches the database', async () => {
    reset(asAdmin());
    healthy();
    expect(await postBill({ id: 'not-a-uuid' })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toEqual([]);
  });
});

describe('cancelBill', () => {
  it('reverses through cancel_document with the reason', async () => {
    reset(asAdmin());
    healthy();
    expect(await cancelBill({ id: BILL, reason: '  entered twice ' })).toEqual({ ok: true, data: { id: BILL } });
    expect(rpc('cancel_document')!.payload).toEqual({ p_source_type: 'purchase_invoice', p_source_id: BILL, p_reason: 'entered twice' });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/purchases', `/purchases/${BILL}/view`, '/stock']));
  });

  it('a reason of under 3 letters is refused', async () => {
    reset(asAdmin());
    healthy();
    expect(await cancelBill({ id: BILL, reason: 'no' })).toMatchObject({ ok: false, code: 'validation', error: 'field.reason_required' });
    expect(rpc('cancel_document')).toBeUndefined();
  });

  it('goods already sold: the answer points at a debit note, not "reduce the quantity"', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'cancel_document' ? dbError('DN_NEGATIVE_STOCK') : undefined));
    expect(await cancelBill({ id: BILL, reason: 'wrong bill' })).toEqual({ ok: false, code: 'negative_stock', error: 'validation.bill_cancel_stock_sold' });
  });

  it('a payment allocated to the bill blocks the cancel', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'cancel_document' ? dbError('DN_HAS_ALLOCATIONS') : undefined));
    expect(await cancelBill({ id: BILL, reason: 'wrong bill' })).toMatchObject({ ok: false, code: 'has_allocations' });
  });
});

describe('deleteDraftBill and photos', () => {
  it('removes the draft\'s photos (rows, then files) before deleting the bill', async () => {
    reset(asAdmin());
    healthy((c) => {
      if (c.table === 'attachments' && c.op === 'select') return { data: [{ id: 'a1', storage_path: `purchase_invoice/${BILL}/x.jpg` }] };
      if (c.table === 'attachments' && c.op === 'delete') return { data: [{ id: 'a1' }] };
      return undefined;
    });
    expect(await deleteDraftBill({ id: BILL })).toEqual({ ok: true, data: null });
    const order = state.calls.map((c) => `${c.table}:${c.op}`);
    expect(order.indexOf('attachments:delete')).toBeLessThan(order.indexOf('purchase_invoices:delete'));
    expect(state.storageCalls.map((c) => c.fn)).toEqual(['remove']);
  });
  it('a posted or cancelled bill is refused before any photo is touched', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'purchase_invoices' && c.op === 'select' ? { data: [{ id: BILL, status: 'cancelled' }] } : undefined));
    expect(await deleteDraftBill({ id: BILL })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(state.calls.some((c) => c.table === 'attachments')).toBe(false);
    expect(state.storageCalls).toEqual([]);
  });
  it('a database refusal while removing a photo stops the delete', async () => {
    reset(asAdmin());
    healthy((c) => {
      if (c.table === 'attachments' && c.op === 'select') return { data: [{ id: 'a1', storage_path: 'p' }] };
      if (c.table === 'attachments' && c.op === 'delete') return dbError('DN_VALIDATION:attachment_bill_posted');
      return undefined;
    });
    expect(await deleteDraftBill({ id: BILL })).toMatchObject({ ok: false, error: 'validation.attachment_bill_posted' });
    expect(find('purchase_invoices', 'delete')).toBeUndefined();
  });
});

describe('addBillFreight (reverse-charge freight on a posted bill)', () => {
  const freightWorld = (over: (call: Call) => Answer | undefined = () => undefined) =>
    healthy((c) => {
      const o = over(c);
      if (o) return o;
      if (c.table === 'expense_vouchers' && c.op === 'select') return { data: [] };
      if (c.table === 'purchase_invoices' && c.op === 'select') return { data: [{ id: BILL, status: 'posted' }] };
      if (c.table === 'parties' && c.op === 'select') return { data: [{ id: TRANSPORTER, type: 'supplier', is_active: true, state_code: '37' }] };
      if (c.table === 'accounts' && c.filters.some(([k]) => k === 'system_key')) return { data: [{ id: 'acc-freight', is_group: false }] };
      if (c.table === 'accounts') return { data: [{ id: PAY, is_money: true }] };
      return undefined;
    });

  it('links a voucher to the bill, flags the line reverse-charge, posts it, and computes no tax itself', async () => {
    reset(asAdmin());
    freightWorld();
    expect(await addBillFreight(freight)).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(find('expense_vouchers', 'insert')!.payload).toMatchObject({
      id: VOUCHER, party_id: TRANSPORTER, purchase_invoice_id: BILL, voucher_type: 'expense', pay_account_id: PAY, status: 'draft', created_by: 'u-admin',
    });
    expect(find('expense_voucher_lines', 'insert')!.payload).toEqual({ voucher_id: VOUCHER, line_no: 1, account_id: 'acc-freight', amount: '12000.00', narration: 'lorry AP16 TC 4455', rcm: true });
    expect(rpc('post_expense_voucher')!.payload).toEqual({ p_voucher_id: VOUCHER });
    expect(state.revalidated).toEqual(expect.arrayContaining([`/purchases/${BILL}/view`]));
  });
  it('a transporter in another state is refused before anything is written', async () => {
    reset(asAdmin());
    freightWorld((c) => (c.table === 'parties' ? { data: [{ id: TRANSPORTER, type: 'supplier', is_active: true, state_code: '36' }] } : undefined));
    expect(await addBillFreight(freight)).toMatchObject({ ok: false, code: 'validation', error: 'validation.rcm_interstate' });
    expect(find('expense_vouchers', 'insert')).toBeUndefined();
  });
  it('a bill that is not posted takes no freight', async () => {
    reset(asAdmin());
    freightWorld((c) => (c.table === 'purchase_invoices' ? { data: [{ id: BILL, status: 'draft' }] } : undefined));
    expect(await addBillFreight(freight)).toMatchObject({ ok: false, code: 'not_posted' });
    expect(find('expense_vouchers', 'insert')).toBeUndefined();
  });
  it('a customer or a disabled party is not a transporter; a non-money account is not a way to pay', async () => {
    reset(asAdmin());
    freightWorld((c) => (c.table === 'parties' ? { data: [{ id: TRANSPORTER, type: 'customer', is_active: true, state_code: '37' }] } : undefined));
    expect(await addBillFreight(freight)).toMatchObject({ ok: false, error: 'validation.invalid_supplier' });
    reset(asAdmin());
    freightWorld((c) => (c.table === 'accounts' && !c.filters.some(([k]) => k === 'system_key') ? { data: [{ id: PAY, is_money: false }] } : undefined));
    expect(await addBillFreight(freight)).toMatchObject({ ok: false, error: 'validation.invalid_account' });
  });
  it('a refused post removes the draft so nothing is left half done', async () => {
    reset(asAdmin());
    freightWorld((c) => (c.rpc === 'post_expense_voucher' ? dbError('DN_PERIOD_LOCKED') : undefined));
    expect(await addBillFreight(freight)).toMatchObject({ ok: false, code: 'period_locked' });
    expect(state.calls.some((c) => c.table === 'expense_vouchers' && c.op === 'delete')).toBe(true);
  });
  it('a retry of a request that already posted answers with the same voucher and writes nothing', async () => {
    reset(asAdmin());
    freightWorld((c) => (c.table === 'expense_vouchers' && c.op === 'select' ? { data: [{ id: VOUCHER, status: 'posted' }] } : undefined));
    expect(await addBillFreight(freight)).toEqual({ ok: true, data: { id: VOUCHER } });
    expect(find('expense_vouchers', 'insert')).toBeUndefined();
    expect(rpc('post_expense_voucher')).toBeUndefined();
  });
  it('refuses a zero or malformed amount and a future date', async () => {
    reset(asAdmin());
    freightWorld();
    expect(await addBillFreight({ ...freight, amount: '0' })).toMatchObject({ ok: false, error: 'field.money_positive' });
    expect(await addBillFreight({ ...freight, amount: '12,000' })).toMatchObject({ ok: false, error: 'field.money_invalid' });
    expect(await addBillFreight({ ...freight, voucherDate: '2999-01-01' })).toMatchObject({ ok: false, error: 'validation.doc_date_future' });
  });
});
