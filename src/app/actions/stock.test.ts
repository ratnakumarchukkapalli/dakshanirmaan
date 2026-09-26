import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { receiveTransfer, recordAdjustment, recordTransfer } from './stock';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const WH1 = '11111111-1111-4111-8111-111111111111';
const WH2 = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';

const adjustment = { id: DOC, adjDate: '2026-09-20', warehouseId: WH1, reason: 'Torn in rain', lines: [{ itemId: ITEM, direction: 'loss' as const, qty: '12', rate: '' }] };
const transfer = { id: DOC, transferDate: '2026-09-20', fromWarehouseId: WH1, toWarehouseId: WH2, vehicleNo: 'AP 16 TC 4455', lines: [{ itemId: ITEM, qty: '500' }] };

function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table ?? call.rpc}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'warehouses:select': return { data: call.filters.some(([c]) => c === 'id') && Array.isArray(call.filters.find(([c]) => c === 'id')?.[1]) ? [{ id: WH1, is_transit: false }, { id: WH2, is_transit: false }] : [{ id: WH1, is_transit: false }] };
      case 'items:select': return { data: [{ id: ITEM, name: 'UltraTech PPC', base_uom: 'bag', is_stock: true, is_active: true }] };
      case 'stock_adjustments:insert':
      case 'stock_transfers:insert': return { data: [{ id: DOC }] };
      default: return { data: [], error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

describe('idempotent retry (client draft id)', () => {
  it('the same adjustment id twice posts once; the repeat answers with the recorded id', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordAdjustment(adjustment)).toEqual({ ok: true, data: { id: DOC } });
    expect(find('stock_adjustments', 'insert')!.payload).toMatchObject({ id: DOC });
    state.calls.length = 0;
    healthy((c) => (c.table === 'stock_adjustments' && c.op === 'select' ? { data: [{ id: DOC, status: 'posted' }] } : undefined));
    expect(await recordAdjustment(adjustment)).toEqual({ ok: true, data: { id: DOC } });
    expect(state.calls.filter((c) => c.rpc || c.op === 'insert')).toHaveLength(0);
  });

  it('the same transfer id twice posts once', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'stock_transfers' && c.op === 'select' ? { data: [{ id: DOC, status: 'posted' }] } : undefined));
    expect(await recordTransfer(transfer)).toEqual({ ok: true, data: { id: DOC } });
    expect(state.calls.filter((c) => c.rpc || c.op === 'insert')).toHaveLength(0);
  });

  it('losing the primary-key race to an in-flight call is a conflict, and a request without an id is refused', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'stock_transfers' && c.op === 'insert' ? dbError('duplicate key value', '23505') : undefined));
    expect(await recordTransfer(transfer)).toMatchObject({ ok: false, code: 'conflict' });
    expect(state.calls.filter((c) => c.rpc)).toHaveLength(0);
    expect(await recordTransfer({ ...transfer, id: undefined })).toMatchObject({ ok: false, code: 'validation' });
  });
});

describe('recordAdjustment', () => {
  it('saves the draft, then posts it; a loss is stored as a negative quantity with no rate', async () => {
    reset(asAdmin());
    healthy();
    const res = await recordAdjustment(adjustment);
    expect(res).toEqual({ ok: true, data: { id: DOC } });
    expect(find('stock_adjustments', 'insert')!.payload).toMatchObject({ warehouse_id: WH1, reason: 'Torn in rain', status: 'draft', created_by: 'u-admin' });
    expect(find('stock_adjustment_lines', 'insert')!.payload).toEqual([{ adjustment_id: DOC, line_no: 1, item_id: ITEM, item_name: 'UltraTech PPC', qty: '-12', rate: null }]);
    expect(rpc('post_stock_adjustment')!.payload).toEqual({ p_adjustment_id: DOC });
    expect(state.revalidated).toContain('/stock');
  });

  it('found stock keeps its rate, positive', async () => {
    reset(asAdmin());
    healthy();
    await recordAdjustment({ ...adjustment, lines: [{ itemId: ITEM, direction: 'found', qty: '3.5', rate: '310.5' }] });
    expect(find('stock_adjustment_lines', 'insert')!.payload).toMatchObject([{ qty: '3.5', rate: '310.5' }]);
  });

  it('is owner-only: a counter user and an owner who has not passed the authenticator are refused before any query', async () => {
    for (const member of [asCounter(), asAdmin('aal1')]) {
      reset(member);
      healthy();
      const res = await recordAdjustment(adjustment);
      expect(res).toMatchObject({ ok: false, code: 'forbidden' });
      expect(state.calls).toHaveLength(0);
    }
  });

  it('maps DN_NEGATIVE_STOCK and removes the draft it just saved', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'post_stock_adjustment' ? dbError('DN_NEGATIVE_STOCK') : undefined));
    const res = await recordAdjustment(adjustment);
    expect(res).toMatchObject({ ok: false, code: 'negative_stock' });
    const del = find('stock_adjustments', 'delete');
    expect(del).toBeTruthy();
    expect(del!.filters).toContainEqual(['id', DOC]);
  });

  it('refuses a rate on a loss, a future date, a non-stock item and the transit godown', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordAdjustment({ ...adjustment, lines: [{ itemId: ITEM, direction: 'loss', qty: '1', rate: '5' }] })).toMatchObject({ ok: false, code: 'validation' });
    expect(await recordAdjustment({ ...adjustment, adjDate: '2999-01-01' })).toMatchObject({ ok: false, error: 'validation.doc_date_future' });
    healthy((c) => (c.table === 'items' ? { data: [{ id: ITEM, name: 'Freight', is_stock: false, is_active: true }] } : undefined));
    expect(await recordAdjustment(adjustment)).toMatchObject({ ok: false, error: 'validation.non_stock_line' });
    healthy((c) => (c.table === 'warehouses' ? { data: [{ id: WH1, is_transit: true }] } : undefined));
    expect(await recordAdjustment(adjustment)).toMatchObject({ ok: false, error: 'validation.transit_warehouse' });
    expect(find('stock_adjustments', 'insert')).toBeUndefined();
  });
});

describe('recordTransfer', () => {
  it('saves the draft with base-unit lines, then posts it', async () => {
    reset(asAdmin());
    healthy();
    const res = await recordTransfer(transfer);
    expect(res).toEqual({ ok: true, data: { id: DOC } });
    expect(find('stock_transfers', 'insert')!.payload).toMatchObject({ from_warehouse_id: WH1, to_warehouse_id: WH2, vehicle_no: 'AP 16 TC 4455', status: 'draft' });
    expect(find('stock_transfer_lines', 'insert')!.payload).toEqual([{ transfer_id: DOC, line_no: 1, item_id: ITEM, item_name: 'UltraTech PPC', uom: 'bag', qty: '500' }]);
    expect(rpc('post_stock_transfer')!.payload).toEqual({ p_transfer_id: DOC });
  });

  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await recordTransfer(transfer)).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('refuses the same godown twice, and maps a locked month (removing the draft)', async () => {
    reset(asAdmin());
    healthy();
    expect(await recordTransfer({ ...transfer, toWarehouseId: WH1 })).toMatchObject({ ok: false, code: 'validation' });
    healthy((c) => (c.rpc === 'post_stock_transfer' ? dbError('DN_PERIOD_LOCKED') : undefined));
    expect(await recordTransfer(transfer)).toMatchObject({ ok: false, code: 'period_locked' });
    expect(find('stock_transfers', 'delete')).toBeTruthy();
  });
});

describe('receiveTransfer', () => {
  it('calls receive_stock_transfer for an owner', async () => {
    reset(asAdmin());
    healthy();
    expect(await receiveTransfer({ id: DOC })).toEqual({ ok: true, data: { id: DOC } });
    expect(rpc('receive_stock_transfer')!.payload).toEqual({ p_transfer_id: DOC });
  });
  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await receiveTransfer({ id: DOC })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('receive_stock_transfer')).toBeUndefined();
  });
  it('maps DN_TRANSFER_STATE (already received) to its own code', async () => {
    reset(asAdmin());
    healthy((c) => (c.rpc === 'receive_stock_transfer' ? dbError('DN_TRANSFER_STATE') : undefined));
    expect(await receiveTransfer({ id: DOC })).toMatchObject({ ok: false, code: 'transfer_state', error: 'transfer_state' });
  });
});
