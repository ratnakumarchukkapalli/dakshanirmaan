import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { convertChallanToInvoice, postChallan, saveDraftChallan } from './challans';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const DC = '11111111-1111-4111-8111-111111111111';
const PARTY = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const INV = '66666666-6666-4666-8666-666666666666';
const STAMP = '2026-09-20T10:00:00.123456+00:00';

const form = {
  partyId: PARTY, challanDate: '2026-09-19', siteId: SITE, vehicleNo: 'ap 16 tc 4455',
  lines: [{ itemId: ITEM, qty: '500.000', altQty: '47', rate: '58.0000', discountPct: '' }],
};
const addresses = [
  { id: 'a-bill', label: 'Head office', state_code: '37', is_default: true, address: { line1: '1 Main Rd', city: 'Vijayawada', pincode: '520001' } },
  { id: SITE, label: 'Poranki site', state_code: '37', is_default: false, address: { line1: 'NH16', line2: null, city: 'Poranki', district: 'Krishna', pincode: '521137' } },
];
const item = { id: ITEM, name: 'Tata Tiscon 12mm', hsn_code: '7214', gst_rate: 18, base_uom: 'kg', alt_uom: 'pcs', is_active: true, is_stock: true };

/** Answers each table like a healthy database; a test overrides what it wants to break. */
function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'parties:select': return { data: [{ id: PARTY, type: 'customer', is_active: true, state_code: '37' }] };
      case 'party_addresses:select': return { data: addresses };
      case 'items:select': return { data: [item] };
      case 'warehouses:select': return { data: [{ id: 'wh-1' }] };
      case 'delivery_challans:insert': return { data: [{ id: DC, updated_at: STAMP }] };
      case 'delivery_challans:update': return { data: [{ id: DC, updated_at: STAMP }] };
      case 'delivery_challans:select': return { data: [{ id: DC, status: 'draft', party_id: PARTY }] };
      case 'delivery_challan_lines:select': return { data: [] };
      case 'delivery_challans:delete': return { data: [{ id: DC }] };
      default: return { data: null, error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

describe('saveDraftChallan', () => {
  it('creates a draft: default warehouse, site snapshot, item snapshot on each line, no value column', async () => {
    reset(asCounter());
    healthy();
    expect(await saveDraftChallan(form)).toEqual({ ok: true, data: { id: DC, updatedAt: STAMP } });
    const header = find('delivery_challans', 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({ warehouse_id: 'wh-1', status: 'draft', party_id: PARTY, challan_date: '2026-09-19', created_by: 'u-counter' });
    expect(header.vehicle_no).toBe('AP 16 TC 4455');
    expect(header.site_address).toMatchObject({ label: 'Poranki site', district: 'Krishna' });

    const lines = find('delivery_challan_lines', 'insert')!.payload as Record<string, unknown>[];
    expect(lines).toEqual([{
      challan_id: DC, line_no: 1, item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', gst_rate: 18,
      qty: '500.000', alt_qty: '47', rate: '58.0000', discount_pct: '0',
    }]);
    for (const l of lines) expect(l).not.toHaveProperty('value');
    expect(state.revalidated).toEqual([]);
  });

  it('no site chosen ships to the party\'s registered (default) address', async () => {
    reset(asAdmin());
    healthy();
    expect((await saveDraftChallan({ ...form, siteId: undefined })).ok).toBe(true);
    expect(find('delivery_challans', 'insert')!.payload).toMatchObject({ site_address: { label: 'Head office', city: 'Vijayawada' } });
  });

  it('a non-stock item is refused: a challan is a goods-out note', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'items' ? { data: [{ ...item, is_stock: false }] } : undefined));
    expect(await saveDraftChallan(form)).toEqual({ ok: false, code: 'validation', error: 'validation.item_not_stock' });
  });

  it('editing sends the loaded updated_at and replaces the lines', async () => {
    reset(asAdmin());
    healthy();
    const r = await saveDraftChallan({ ...form, id: DC, expectedUpdatedAt: STAMP });
    expect(r).toMatchObject({ ok: true });
    const upd = find('delivery_challans', 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', DC], ['status', 'draft'], ['updated_at', STAMP]]));
    expect(find('delivery_challan_lines', 'delete')).toBeDefined();
    expect(find('delivery_challan_lines', 'insert')).toBeDefined();
  });

  it('a stale version is a conflict and touches no lines', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'delivery_challans' && c.op === 'update' ? { data: [] } : undefined));
    expect(await saveDraftChallan({ ...form, id: DC, expectedUpdatedAt: 'old' })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
    expect(find('delivery_challan_lines', 'delete')).toBeUndefined();
  });

  it('posted challans cannot be edited', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'delivery_challans' && c.op === 'select' ? { data: [{ id: DC, status: 'posted', party_id: PARTY }] } : undefined));
    expect(await saveDraftChallan({ ...form, id: DC, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(find('delivery_challans', 'update')).toBeUndefined();
  });

  it('a new draft whose lines are refused is removed, not left empty', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'delivery_challan_lines' && c.op === 'insert' ? dbError('numeric field overflow', '22003') : undefined));
    expect(await saveDraftChallan(form)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
    expect(find('delivery_challans', 'delete')?.filters).toEqual([['id', DC]]);
  });

  it('refuses a future date, a wrong party, a foreign site and a missing item', async () => {
    reset(asAdmin()); healthy();
    expect(await saveDraftChallan({ ...form, challanDate: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.date_future' });
    reset(asAdmin()); healthy((c) => (c.table === 'parties' ? { data: [{ id: PARTY, type: 'supplier', is_active: true }] } : undefined));
    expect(await saveDraftChallan(form)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_party' });
    reset(asAdmin()); healthy();
    expect(await saveDraftChallan({ ...form, siteId: '77777777-7777-4777-8777-777777777777' })).toEqual({ ok: false, code: 'validation', error: 'validation.site_invalid' });
    reset(asAdmin()); healthy((c) => (c.table === 'items' ? { data: [] } : undefined));
    expect(await saveDraftChallan(form)).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
  });

  it('bad input never reaches the database', async () => {
    reset(asAdmin());
    for (const [patch, key] of [
      [{ lines: [{ ...form.lines[0], qty: '0' }] }, 'field.qty_positive'],
      [{ lines: [] }, 'field.lines_required'],
      [{ challanDate: '19-09-2026' }, 'field.date_invalid'],
      [{ partyId: 'nope' }, 'field.party_required'],
    ] as const) {
      expect(await saveDraftChallan({ ...form, ...patch })).toMatchObject({ ok: false, code: 'validation', error: key });
    }
    expect(state.calls).toHaveLength(0);
  });

  it('owner at aal1 and signed-out callers are refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    expect(await saveDraftChallan(form)).toMatchObject({ ok: false, code: 'forbidden' });
    reset(null);
    expect(await saveDraftChallan(form)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('postChallan', () => {
  it('any active member posts through the user-scoped RPC and stock/dashboard paths are refreshed', async () => {
    reset(asCounter());
    expect(await postChallan({ id: DC })).toEqual({ ok: true, data: { id: DC } });
    expect(rpc('post_delivery_challan')?.payload).toEqual({ p_challan_id: DC });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/sales', '/sales/challans/new', '/stock', '/']));
  });

  it('maps the database refusals to codes with a friendly sentence', async () => {
    for (const [db, code] of [['DN_NEGATIVE_STOCK', 'negative_stock'], ['DN_PERIOD_LOCKED', 'period_locked'], ['DN_NOT_DRAFT', 'not_draft'], ['DN_FORBIDDEN', 'forbidden']] as const) {
      reset(asCounter());
      state.respond = () => dbError(db);
      expect(await postChallan({ id: DC })).toEqual({ ok: false, code, error: code });
    }
  });
});

describe('convertChallanToInvoice', () => {
  const challanRow = { id: DC, status: 'posted', invoice_id: null as string | null, party_id: PARTY, warehouse_id: 'wh-1', site_address: null, vehicle_no: null };
  const line = { item_id: ITEM, item_name: 'Tata Tiscon 12mm', hsn_code: '7214', uom: 'kg', gst_rate: 18, qty: 500, alt_qty: null, rate: 58, discount_pct: 0, line_no: 1 };

  it('is idempotent: calling it twice before the draft is posted returns the same invoice id and creates only one row', async () => {
    reset(asCounter());
    let created = false;
    state.respond = (call) => {
      switch (`${call.table}:${call.op}`) {
        case 'delivery_challans:select': return { data: [challanRow] };
        case 'sales_invoices:select': return { data: created ? [{ id: INV }] : [] };
        case 'parties:select': return { data: [{ state_code: '37', type: 'customer', is_active: true }] };
        case 'party_addresses:select': return { data: [] };
        case 'delivery_challan_lines:select': return { data: [line] };
        case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
        case 'sales_invoices:insert': created = true; return { data: [{ id: INV }] };
        case 'sales_invoice_lines:insert': return { data: [], error: null };
        default: return { data: null, error: null };
      }
    };

    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: true, data: { id: INV } });
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: true, data: { id: INV } });
    expect(state.calls.filter((c) => c.table === 'sales_invoices' && c.op === 'insert')).toHaveLength(1);
    expect(state.calls.filter((c) => c.table === 'sales_invoice_lines' && c.op === 'insert')).toHaveLength(1);

    const header = state.calls.find((c) => c.table === 'sales_invoices' && c.op === 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({ party_id: PARTY, warehouse_id: 'wh-1', place_of_supply: '37', challan_id: DC, status: 'draft', created_by: 'u-counter' });
  });

  it('recovers from a genuine race: a unique-violation on insert returns the winning draft instead of failing', async () => {
    reset(asCounter());
    // Simulates the loser of a race: its own "no existing draft yet" read finds nothing (another
    // call hasn't been seen yet), its insert then hits the database's unique index because that
    // other call won in between, and the recovery re-select finds the winner's row.
    let selects = 0;
    state.respond = (call) => {
      switch (`${call.table}:${call.op}`) {
        case 'delivery_challans:select': return { data: [challanRow] };
        case 'sales_invoices:select': selects += 1; return { data: selects === 1 ? [] : [{ id: INV }] };
        case 'parties:select': return { data: [{ state_code: '37', type: 'customer', is_active: true }] };
        case 'party_addresses:select': return { data: [] };
        case 'delivery_challan_lines:select': return { data: [line] };
        case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
        case 'sales_invoices:insert': return dbError('duplicate key value violates unique constraint "sales_invoices_one_draft_per_challan"', '23505');
        default: return { data: null, error: null };
      }
    };
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: true, data: { id: INV } });
    expect(state.calls.filter((c) => c.table === 'sales_invoices' && c.op === 'insert')).toHaveLength(1);
    expect(selects).toBe(2);
  });

  it('a unique-violation with no winner visible yet (a genuinely unknown state) is a plain failure, not a crash', async () => {
    reset(asCounter());
    state.respond = (call) => {
      switch (`${call.table}:${call.op}`) {
        case 'delivery_challans:select': return { data: [challanRow] };
        case 'sales_invoices:select': return { data: [] };
        case 'parties:select': return { data: [{ state_code: '37', type: 'customer', is_active: true }] };
        case 'party_addresses:select': return { data: [] };
        case 'delivery_challan_lines:select': return { data: [line] };
        case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
        case 'sales_invoices:insert': return dbError('duplicate key value violates unique constraint "sales_invoices_one_draft_per_challan"', '23505');
        default: return { data: null, error: null };
      }
    };
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: false, code: 'validation', error: 'validation.duplicate' });
  });

  it('once the invoice is posted, the challan itself carries the id and no new draft is ever considered', async () => {
    reset(asCounter());
    state.respond = (call) =>
      call.table === 'delivery_challans' && call.op === 'select' ? { data: [{ ...challanRow, invoice_id: INV }] } : { data: null, error: null };
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: true, data: { id: INV } });
    expect(state.calls.filter((c) => c.table === 'sales_invoices')).toHaveLength(0);
  });

  it('a challan that is not posted (still a draft) is refused', async () => {
    reset(asCounter());
    state.respond = (call) =>
      call.table === 'delivery_challans' && call.op === 'select' ? { data: [{ ...challanRow, status: 'draft' }] } : { data: null, error: null };
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: false, code: 'not_posted', error: 'not_posted' });
  });

  it('an unknown challan is a friendly validation message', async () => {
    reset(asCounter());
    state.respond = () => ({ data: [] });
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_challan' });
  });

  it('a disabled or non-customer party refuses the conversion', async () => {
    reset(asCounter());
    state.respond = (call) => {
      if (call.table === 'delivery_challans' && call.op === 'select') return { data: [challanRow] };
      if (call.table === 'sales_invoices' && call.op === 'select') return { data: [] };
      if (call.table === 'parties') return { data: [{ state_code: '37', type: 'customer', is_active: false }] };
      return { data: null, error: null };
    };
    expect(await convertChallanToInvoice({ id: DC })).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_party' });
  });

  it('owner at aal1 and signed-out callers are refused before the database', async () => {
    reset(asAdmin('aal1'));
    expect(await convertChallanToInvoice({ id: DC })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(null);
    expect(await convertChallanToInvoice({ id: DC })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
});
