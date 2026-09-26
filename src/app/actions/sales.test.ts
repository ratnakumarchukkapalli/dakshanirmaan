import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { cancelInvoice, deleteDraftInvoice, postCashSale, postInvoice, recordInvoiceEwb, saveDraftInvoice } from './sales';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const INV = '11111111-1111-4111-8111-111111111111';
const PARTY = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const ACC = '55555555-5555-4555-8555-555555555555';
const STAMP = '2026-09-20T10:00:00.123456+00:00';

const form = {
  partyId: PARTY, invoiceDate: '2026-09-19', placeOfSupply: '37', siteId: SITE, vehicleNo: 'ap 16 tc 4455', transporterName: '',
  lines: [{ itemId: ITEM, qty: '1200.000', altQty: '113', rate: '58.0000', discountPct: '' }],
};
const addresses = [
  { id: 'a-bill', label: 'Head office', state_code: '37', is_default: true, address: { line1: '1 Main Rd', city: 'Vijayawada', pincode: '520001' } },
  { id: SITE, label: 'Poranki site', state_code: '37', is_default: false, address: { line1: 'NH16', line2: null, city: 'Poranki', district: 'Krishna', pincode: '521137' } },
];
const item = { id: ITEM, name: 'Tata Tiscon 12mm', hsn_code: '7214', gst_rate: 18, base_uom: 'kg', alt_uom: 'pcs', is_active: true };

/** Answers each table like a healthy database; a test overrides what it wants to break. */
function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'parties:select': return { data: [{ id: PARTY, type: 'customer', is_active: true }] };
      case 'party_addresses:select': return { data: addresses };
      case 'items:select': return { data: [item] };
      case 'warehouses:select': return { data: [{ id: 'wh-1' }] };
      case 'sales_invoices:insert': return { data: [{ id: INV, updated_at: STAMP }] };
      case 'sales_invoices:update': return { data: [{ id: INV, updated_at: STAMP }] };
      case 'sales_invoices:select': return { data: [{ id: INV, status: 'draft', party_id: PARTY }] };
      case 'sales_invoice_lines:select': return { data: [] };
      case 'sales_invoices:delete': return { data: [{ id: INV }] };
      default: return { data: null, error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

describe('saveDraftInvoice', () => {
  it('creates a draft: default warehouse, address snapshots, item snapshot on each line, and no totals at all', async () => {
    reset(asCounter());
    healthy();
    expect(await saveDraftInvoice(form)).toEqual({ ok: true, data: { id: INV, updatedAt: STAMP } });
    const header = find('sales_invoices', 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({ warehouse_id: 'wh-1', status: 'draft', place_of_supply: '37', party_id: PARTY, invoice_date: '2026-09-19', created_by: 'u-counter' });
    expect(header.vehicle_no).toBe('AP 16 TC 4455');
    expect(header.billing_address).toMatchObject({ label: 'Head office', city: 'Vijayawada', state_code: '37' });
    expect(header.shipping_address).toMatchObject({ label: 'Poranki site', district: 'Krishna' });
    for (const money of ['taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'grand_total', 'round_off', 'invoice_no', 'journal_entry_id'])
      expect(header).not.toHaveProperty(money);

    const lines = find('sales_invoice_lines', 'insert')!.payload as Record<string, unknown>[];
    expect(lines).toEqual([{
      invoice_id: INV, line_no: 1, item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', gst_rate: 18,
      qty: '1200.000', alt_qty: '113', rate: '58.0000', discount_pct: '0',
    }]);
    for (const l of lines) for (const k of ['taxable_value', 'cgst_amt', 'sgst_amt', 'igst_amt']) expect(l).not.toHaveProperty(k);
    // Saving a draft must not revalidate (it would remount the form under the person's hands).
    expect(state.revalidated).toEqual([]);
  });

  it('a walk-in with no addresses saves with null address snapshots; no site chosen ships to billing', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'party_addresses' ? { data: [] } : undefined));
    expect((await saveDraftInvoice({ ...form, siteId: undefined })).ok).toBe(true);
    expect(find('sales_invoices', 'insert')!.payload).toMatchObject({ billing_address: null, shipping_address: null });
  });

  it('a second unit is only kept for an item that has one', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'items' ? { data: [{ ...item, alt_uom: null }] } : undefined));
    await saveDraftInvoice(form);
    expect((find('sales_invoice_lines', 'insert')!.payload as Record<string, unknown>[])[0]).toHaveProperty('alt_qty', null);
  });

  it('editing sends the loaded updated_at and replaces the lines', async () => {
    reset(asAdmin());
    healthy();
    const r = await saveDraftInvoice({ ...form, id: INV, expectedUpdatedAt: STAMP });
    expect(r).toMatchObject({ ok: true });
    const upd = find('sales_invoices', 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', INV], ['status', 'draft'], ['updated_at', STAMP]]));
    expect(find('sales_invoice_lines', 'delete')).toBeDefined();
    expect(find('sales_invoice_lines', 'insert')).toBeDefined();
  });

  it('a stale version is a conflict and touches no lines', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoices' && c.op === 'update' ? { data: [] } : undefined));
    expect(await saveDraftInvoice({ ...form, id: INV, expectedUpdatedAt: 'old' })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
    expect(find('sales_invoice_lines', 'delete')).toBeUndefined();
  });

  it('editing needs the loaded version; posted invoices cannot be edited', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftInvoice({ ...form, id: INV })).toMatchObject({ ok: false, code: 'validation', error: 'field.stale_version_missing' });
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoices' && c.op === 'select' ? { data: [{ id: INV, status: 'posted', party_id: PARTY }] } : undefined));
    expect(await saveDraftInvoice({ ...form, id: INV, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(find('sales_invoices', 'update')).toBeUndefined();
  });

  it('if the new lines are refused, the previous lines are put back', async () => {
    reset(asAdmin());
    const old = { id: 'l1', created_at: 'x', invoice_id: INV, line_no: 1, item_id: ITEM, item_name: 'Old', qty: 5 };
    let inserts = 0;
    healthy((c) => {
      if (c.table === 'sales_invoice_lines' && c.op === 'select') return { data: [old] };
      if (c.table === 'sales_invoice_lines' && c.op === 'insert') return ++inserts === 1 ? dbError('check violation', '23514') : { data: null, error: null };
      return undefined;
    });
    expect(await saveDraftInvoice({ ...form, id: INV, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'validation' });
    const restore = state.calls.filter((c) => c.table === 'sales_invoice_lines' && c.op === 'insert')[1]!.payload as Record<string, unknown>[];
    expect(restore).toEqual([{ invoice_id: INV, line_no: 1, item_id: ITEM, item_name: 'Old', qty: 5 }]);
  });

  it('a new draft whose lines are refused is removed, not left empty', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'sales_invoice_lines' && c.op === 'insert' ? dbError('numeric field overflow', '22003') : undefined));
    expect(await saveDraftInvoice(form)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
    expect(find('sales_invoices', 'delete')?.filters).toEqual([['id', INV]]);
  });

  it('refuses a future date, a disabled item on a new draft, a wrong party, a foreign site and a missing item', async () => {
    reset(asAdmin()); healthy();
    expect(await saveDraftInvoice({ ...form, invoiceDate: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.date_future' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [{ ...item, is_active: false }] } : undefined));
    expect(await saveDraftInvoice(form)).toEqual({ ok: false, code: 'validation', error: 'validation.item_inactive' });
    reset(asAdmin()); healthy((c) => (c.table === 'parties' ? { data: [{ id: PARTY, type: 'supplier', is_active: true }] } : undefined));
    expect(await saveDraftInvoice(form)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_party' });
    reset(asAdmin()); healthy();
    expect(await saveDraftInvoice({ ...form, siteId: '66666666-6666-4666-8666-666666666666' })).toEqual({ ok: false, code: 'validation', error: 'validation.site_invalid' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [] } : undefined));
    expect(await saveDraftInvoice(form)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
  });

  it('a disabled item already on the draft may stay when the draft is saved again', async () => {
    reset(asAdmin());
    healthy((c) => {
      if (c.table === 'items') return { data: [{ ...item, is_active: false }] };
      if (c.table === 'sales_invoice_lines' && c.op === 'select') return { data: [{ id: 'l1', item_id: ITEM, invoice_id: INV }] };
      return undefined;
    });
    expect((await saveDraftInvoice({ ...form, id: INV, expectedUpdatedAt: STAMP })).ok).toBe(true);
  });

  it('bad input never reaches the database', async () => {
    reset(asAdmin());
    for (const [patch, key] of [
      [{ lines: [{ ...form.lines[0], qty: '0' }] }, 'field.qty_positive'],
      [{ lines: [{ ...form.lines[0], rate: '1.23456' }] }, 'field.rate_invalid'],
      [{ lines: [{ ...form.lines[0], discountPct: '101' }] }, 'field.discount_invalid'],
      [{ lines: [] }, 'field.lines_required'],
      [{ invoiceDate: '19-09-2026' }, 'field.date_invalid'],
      [{ invoiceDate: '2026-02-30' }, 'field.date_invalid'],
      [{ partyId: 'nope' }, 'field.party_required'],
    ] as const) {
      expect(await saveDraftInvoice({ ...form, ...patch })).toMatchObject({ ok: false, code: 'validation', error: key });
    }
    expect(state.calls).toHaveLength(0);
  });

  it('owner at aal1 and signed-out callers are refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await saveDraftInvoice(form)).toMatchObject({ ok: false, code: 'forbidden' });
    reset(null);
    expect(await saveDraftInvoice(form)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });

  it('row-level-security refusal is forbidden; an unknown failure is hidden', async () => {
    reset(asCounter());
    healthy((c) => (c.table === 'sales_invoices' && c.op === 'insert' ? dbError('new row violates row-level security policy', '42501') : undefined));
    expect(await saveDraftInvoice(form)).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asCounter());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    healthy((c) => (c.table === 'sales_invoices' && c.op === 'insert' ? dbError('connection to 10.0.0.5 lost') : undefined));
    expect(await saveDraftInvoice(form)).toEqual({ ok: false, code: 'internal', error: 'internal' });
    spy.mockRestore();
  });
});

describe('postInvoice', () => {
  it('any active member posts through the user-scoped RPC; the database numbers it', async () => {
    reset(asCounter());
    expect(await postInvoice({ id: INV })).toEqual({ ok: true, data: { id: INV } });
    expect(rpc('post_sales_invoice')?.payload).toEqual({ p_invoice_id: INV, p_override_credit: false });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales', `/sales/${INV}/view`, '/parties', '/stock']));
  });
  it('an owner may ask for the credit override', async () => {
    reset(asAdmin());
    await postInvoice({ id: INV, overrideCredit: true });
    expect(rpc('post_sales_invoice')?.payload).toEqual({ p_invoice_id: INV, p_override_credit: true });
  });
  it('a counter user asking for the override is refused, not quietly downgraded', async () => {
    reset(asCounter());
    expect(await postInvoice({ id: INV, overrideCredit: true })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('maps the database refusals to codes with a friendly sentence', async () => {
    const cases: [string, string][] = [
      ['DN_CREDIT_LIMIT', 'credit_limit'], ['DN_NEGATIVE_STOCK', 'negative_stock'], ['DN_PERIOD_LOCKED', 'period_locked'],
      ['DN_NOT_DRAFT', 'not_draft'], ['DN_NO_PERIOD', 'no_period'], ['DN_UNBALANCED', 'unbalanced'], ['DN_FORBIDDEN', 'forbidden'],
    ];
    for (const [db, code] of cases) {
      reset(asAdmin());
      state.respond = () => dbError(db);
      expect(await postInvoice({ id: INV })).toEqual({ ok: false, code, error: code });
    }
    for (const detail of ['no_lines', 'invalid_party', 'no_cost_basis', 'missing_account']) {
      reset(asAdmin());
      state.respond = () => dbError(`DN_VALIDATION:${detail}`);
      expect(await postInvoice({ id: INV })).toEqual({ ok: false, code: 'validation', error: `validation.${detail}` });
    }
    reset(asAdmin());
    state.respond = () => dbError('new row for relation "journal_lines" violates check constraint "journal_lines_check"', '23514');
    expect(await postInvoice({ id: INV })).toEqual({ ok: false, code: 'validation', error: 'validation.zero_total' });
  });
  it('a draft that no longer matches its delivery challan gets the specific, actionable sentence, not the generic one', async () => {
    for (const detail of ['challan_mismatch', 'invoice_before_challan', 'challan_not_posted']) {
      reset(asCounter());
      state.respond = () => dbError(`DN_VALIDATION:${detail}`);
      const res = await postInvoice({ id: INV });
      expect(res).toEqual({ ok: false, code: 'validation', error: `validation.${detail}` });
      expect(res).not.toMatchObject({ error: 'validation.generic' });
    }
  });
  it('rejects a malformed id without calling the database', async () => {
    reset(asAdmin());
    expect(await postInvoice({ id: 'x' })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('postCashSale', () => {
  it('posts with the chosen cash/bank account', async () => {
    reset(asCounter());
    expect(await postCashSale({ id: INV, accountId: ACC })).toEqual({ ok: true, data: { id: INV } });
    expect(rpc('post_cash_sale')?.payload).toEqual({ p_invoice_id: INV, p_account_id: ACC });
    expect(state.revalidated).toContain('/payments');
  });
  it('a bad account is a friendly validation message; a missing account never reaches the database', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_VALIDATION:invalid_account');
    expect(await postCashSale({ id: INV, accountId: ACC })).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_account' });
    reset(asCounter());
    expect(await postCashSale({ id: INV })).toMatchObject({ ok: false, code: 'validation', error: 'field.account_required' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('cancelInvoice', () => {
  it('owner cancels by reversal, with the reason kept for the audit trail', async () => {
    reset(asAdmin());
    expect(await cancelInvoice({ id: INV, reason: '  Wrong customer  ' })).toEqual({ ok: true, data: { id: INV } });
    expect(rpc('cancel_document')?.payload).toEqual({ p_source_type: 'sales_invoice', p_source_id: INV, p_reason: 'Wrong customer' });
  });
  it('counter staff and half-signed-in owners are refused before the database', async () => {
    reset(asCounter());
    expect(await cancelInvoice({ id: INV, reason: 'Wrong customer' })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin('aal1'));
    expect(await cancelInvoice({ id: INV, reason: 'Wrong customer' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('a reason is required; database refusals are mapped', async () => {
    reset(asAdmin());
    expect(await cancelInvoice({ id: INV, reason: ' ' })).toMatchObject({ ok: false, code: 'validation', error: 'field.reason_required' });
    for (const [db, code] of [['DN_HAS_ALLOCATIONS', 'has_allocations'], ['DN_NOT_POSTED', 'not_posted'], ['DN_PERIOD_LOCKED', 'period_locked']] as const) {
      reset(asAdmin());
      state.respond = () => dbError(db);
      expect(await cancelInvoice({ id: INV, reason: 'Wrong customer' })).toEqual({ ok: false, code, error: code });
    }
  });
});

describe('deleteDraftInvoice', () => {
  it('deletes only a draft', async () => {
    reset(asCounter());
    healthy();
    expect(await deleteDraftInvoice({ id: INV })).toEqual({ ok: true, data: null });
    expect(find('sales_invoices', 'delete')?.filters).toEqual([['id', INV], ['status', 'draft']]);
    reset(asCounter());
    healthy((c) => (c.op === 'delete' ? { data: [] } : undefined));
    expect(await deleteDraftInvoice({ id: INV })).toMatchObject({ ok: false, code: 'not_draft' });
  });
});

describe('transport details on a draft', () => {
  it('saves mode, distance and transporter GSTIN (capitalised), and blanks become null', async () => {
    reset(asCounter());
    healthy();
    await saveDraftInvoice({ ...form, transportMode: 'road', distanceKm: '28', transporterGstin: '37abcfs1234k1z5' });
    expect(find('sales_invoices', 'insert')!.payload).toMatchObject({ transport_mode: 'road', distance_km: 28, transporter_gstin: '37ABCFS1234K1Z5' });
    reset(asCounter());
    healthy();
    await saveDraftInvoice({ ...form, transportMode: '', distanceKm: '', transporterGstin: '' });
    expect(find('sales_invoices', 'insert')!.payload).toMatchObject({ transport_mode: null, distance_km: null, transporter_gstin: null });
  });
  it('refuses a bad mode, distance, GSTIN or vehicle number before the database', async () => {
    for (const [patch, key] of [
      [{ transportMode: 'boat' }, 'transport_mode_invalid'],
      [{ distanceKm: '5001' }, 'distance_invalid'],
      [{ distanceKm: '12.5' }, 'distance_invalid'],
      [{ transporterGstin: 'NOTAGSTIN' }, 'gstin_invalid'],
      [{ vehicleNo: 'A!' }, 'vehicle_invalid'],
    ] as const) {
      reset(asCounter());
      healthy();
      expect(await saveDraftInvoice({ ...form, ...patch })).toMatchObject({ ok: false, code: 'validation', error: `field.${key}` });
      expect(state.calls).toHaveLength(0);
    }
  });
});

describe('recordInvoiceEwb', () => {
  const ewb = { id: INV, vehicleNo: 'ap 16 tc 4455', transporterName: 'Own vehicle', transportMode: 'road', distanceKm: '28', transporterGstin: '', ewbNo: '123456789012', ewbDate: '2026-09-20', ewbValidUntil: '2026-09-22' };

  it('any active member records it through the database function, and only that function', async () => {
    reset(asCounter());
    expect(await recordInvoiceEwb(ewb)).toEqual({ ok: true, data: { id: INV } });
    expect(state.calls).toHaveLength(1);
    expect(rpc('record_invoice_ewb')?.payload).toEqual({
      p_invoice_id: INV, p_transport_mode: 'road', p_distance_km: 28, p_transporter_name: 'Own vehicle', p_transporter_gstin: null,
      p_vehicle_no: 'AP 16 TC 4455', p_ewb_no: '123456789012', p_ewb_date: '2026-09-20', p_ewb_valid_until: '2026-09-22T23:59:59+05:30',
    });
    expect(state.revalidated).toEqual(expect.arrayContaining([`/sales/${INV}/view`]));
  });
  it('an e-way bill number, date and valid-until go together, in order', async () => {
    reset(asAdmin());
    expect(await recordInvoiceEwb({ ...ewb, ewbValidUntil: '' })).toMatchObject({ ok: false, code: 'validation', error: 'field.ewb_incomplete' });
    expect(await recordInvoiceEwb({ ...ewb, ewbValidUntil: '2026-09-19' })).toMatchObject({ ok: false, code: 'validation', error: 'field.ewb_dates' });
    expect(await recordInvoiceEwb({ ...ewb, ewbNo: '12345' })).toMatchObject({ ok: false, code: 'validation', error: 'field.ewb_no_invalid' });
    expect(state.calls).toHaveLength(0);
    // Clearing everything is allowed (the bill was cancelled on the portal).
    expect(await recordInvoiceEwb({ id: INV })).toMatchObject({ ok: true });
  });
  it('an owner at step one of sign-in is refused before the database', async () => {
    reset(asAdmin('aal1'));
    expect(await recordInvoiceEwb(ewb)).toMatchObject({ ok: false, code: 'forbidden' });
    reset(null);
    expect(await recordInvoiceEwb(ewb)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('database refusals are mapped to friendly results', async () => {
    for (const [db, code, error] of [
      ['DN_NOT_POSTED', 'not_posted', 'not_posted'],
      ['DN_FORBIDDEN', 'forbidden', 'forbidden'],
      ['DN_VALIDATION:ewb_no', 'validation', 'validation.ewb_no'],
      ['DN_VALIDATION:ewb_dates', 'validation', 'validation.ewb_dates'],
    ] as const) {
      reset(asCounter());
      state.respond = () => dbError(db);
      expect(await recordInvoiceEwb(ewb)).toEqual({ ok: false, code, error });
    }
  });
});
