import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import {
  addOpeningMoneyLine, addOpeningPartyLine, addOpeningStockLine, cancelOpening, importOpeningStock, postOpening, removeOpeningLine,
} from './cutover';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const PARTY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const GODOWN = '44444444-4444-4444-8444-444444444444';
const LINE = '55555555-5555-4555-8555-555555555555';
const calls = (table: string, op: Call['op']) => state.calls.filter((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

/** A draft batch already exists unless `batch` says otherwise. */
function healthy(batch: 'draft' | 'posted' | 'none' = 'draft', over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table ?? call.rpc}:${call.op}`) {
      case 'opening_batches:select': return { data: batch === 'none' ? [] : [{ id: 'batch-1', status: batch }] };
      case 'opening_batches:insert': return { data: [{ id: 'batch-new' }] };
      case 'items:select': return { data: [{ id: ITEM, name: 'UltraTech PPC 50kg' }] };
      case 'warehouses:select': return { data: [{ id: GODOWN, name: 'Head Godown' }] };
      default: return { data: null, error: null };
    }
  };
}

describe('adding lines', () => {
  it('stages a party due on the draft batch with the amount as text', async () => {
    reset(asAdmin());
    healthy();
    expect(await addOpeningPartyLine({ partyId: PARTY, side: 'receivable', amount: '100000.50' })).toEqual({ ok: true, data: null });
    expect(calls('opening_lines', 'insert')[0]?.payload).toEqual({ batch_id: 'batch-1', kind: 'party', party_id: PARTY, side: 'receivable', amount: '100000.50' });
    expect(calls('opening_batches', 'insert')).toHaveLength(0);
    expect(state.revalidated).toContain('/settings/cutover');
  });

  it('starts the draft batch on first use', async () => {
    reset(asAdmin());
    healthy('none');
    await addOpeningMoneyLine({ accountId: ACCOUNT, amount: '25000' });
    expect(calls('opening_batches', 'insert')).toHaveLength(1);
    expect(calls('opening_lines', 'insert')[0]?.payload).toEqual({ batch_id: 'batch-new', kind: 'money', account_id: ACCOUNT, amount: '25000' });
  });

  it('stages stock with quantity and rate as text', async () => {
    reset(asAdmin());
    healthy();
    await addOpeningStockLine({ itemId: ITEM, warehouseId: GODOWN, qty: '120', rate: '315.5000' });
    expect(calls('opening_lines', 'insert')[0]?.payload).toEqual({ batch_id: 'batch-1', kind: 'stock', item_id: ITEM, warehouse_id: GODOWN, qty: '120', rate: '315.5000' });
  });

  it('refuses counter staff and an owner at step 1 before touching the database', async () => {
    for (const member of [asCounter(), asAdmin('aal1')]) {
      reset(member);
      healthy();
      expect(await addOpeningPartyLine({ partyId: PARTY, side: 'receivable', amount: '1' })).toMatchObject({ ok: false, code: 'forbidden' });
      expect(state.calls).toHaveLength(0);
    }
  });

  it('rejects bad input with a field message and does nothing', async () => {
    reset(asAdmin());
    healthy();
    expect(await addOpeningPartyLine({ partyId: PARTY, side: 'receivable', amount: '0' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await addOpeningStockLine({ itemId: ITEM, warehouseId: GODOWN, qty: '1', rate: 'abc' })).toMatchObject({ ok: false, code: 'validation' });
    expect(await addOpeningPartyLine({ partyId: 'nope', side: 'receivable', amount: '5' })).toMatchObject({ ok: false, code: 'validation' });
    expect(calls('opening_lines', 'insert')).toHaveLength(0);
  });

  it('says the opening is already posted rather than adding to it', async () => {
    reset(asAdmin());
    healthy('posted');
    expect(await addOpeningMoneyLine({ accountId: ACCOUNT, amount: '5' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.opening_batch_not_draft' });
    expect(calls('opening_lines', 'insert')).toHaveLength(0);
  });

  it('maps a duplicate line to the duplicate sentence', async () => {
    reset(asAdmin());
    healthy('draft', (c) => (c.table === 'opening_lines' ? dbError('duplicate key', '23505') : undefined));
    expect(await addOpeningPartyLine({ partyId: PARTY, side: 'payable', amount: '5' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.duplicate' });
  });
});

describe('removeOpeningLine', () => {
  it('deletes the line for an owner and is refused for anyone else', async () => {
    reset(asAdmin());
    healthy();
    expect(await removeOpeningLine({ id: LINE })).toEqual({ ok: true, data: null });
    expect(calls('opening_lines', 'delete')[0]?.filters).toEqual([['id', LINE]]);
    reset(asCounter());
    expect(await removeOpeningLine({ id: LINE })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('maps the database refusing a posted batch line', async () => {
    reset(asAdmin());
    healthy('draft', (c) => (c.op === 'delete' ? dbError('DN_VALIDATION:opening_batch_not_draft') : undefined));
    expect(await removeOpeningLine({ id: LINE })).toMatchObject({ ok: false, code: 'validation', error: 'validation.opening_batch_not_draft' });
  });
});

describe('importOpeningStock', () => {
  const csv = 'item,godown,qty,rate\nultratech ppc 50kg,HEAD GODOWN,120,315.50\n';

  it('resolves names case-insensitively and stages every row in one insert', async () => {
    reset(asAdmin());
    healthy();
    expect(await importOpeningStock({ csv })).toEqual({ ok: true, data: { added: 1 } });
    expect(calls('opening_lines', 'insert')).toHaveLength(1);
    expect(calls('opening_lines', 'insert')[0]?.payload).toEqual([{ batch_id: 'batch-1', kind: 'stock', item_id: ITEM, warehouse_id: GODOWN, qty: '120', rate: '315.50' }]);
  });

  it('stages nothing when a row is unreadable, and names the line', async () => {
    reset(asAdmin());
    healthy();
    const res = await importOpeningStock({ csv: 'item,godown,qty,rate\nA,G,x,1\n' });
    expect(res).toMatchObject({ ok: false, code: 'validation', error: 'csv.qty' });
    expect(calls('opening_lines', 'insert')).toHaveLength(0);
  });

  it('stages nothing when an item or godown is not in the app', async () => {
    reset(asAdmin());
    healthy();
    expect(await importOpeningStock({ csv: 'item,godown,qty,rate\nMystery,Head Godown,1,1\n' })).toMatchObject({ ok: false, error: 'csv.unknown_item' });
    expect(await importOpeningStock({ csv: 'item,godown,qty,rate\nUltraTech PPC 50kg,Nowhere,1,1\n' })).toMatchObject({ ok: false, error: 'csv.unknown_godown' });
    expect(calls('opening_lines', 'insert')).toHaveLength(0);
  });

  it('refuses a name that more than one item or godown has, rather than picking one', async () => {
    reset(asAdmin());
    healthy('draft', (c) => {
      if (c.table === 'items') return { data: [{ id: ITEM, name: 'UltraTech PPC 50kg' }, { id: 'other-item', name: 'ultratech ppc 50kg' }] };
      if (c.table === 'warehouses') return { data: [{ id: GODOWN, name: 'Head Godown' }, { id: 'other-godown', name: 'Head Godown' }] };
      return undefined;
    });
    expect(await importOpeningStock({ csv })).toMatchObject({ ok: false, error: 'csv.ambiguous_item' });
    healthy('draft', (c) => (c.table === 'warehouses' ? { data: [{ id: GODOWN, name: 'Head Godown' }, { id: 'other-godown', name: 'HEAD GODOWN' }] } : undefined));
    expect(await importOpeningStock({ csv })).toMatchObject({ ok: false, error: 'csv.ambiguous_godown' });
    expect(calls('opening_lines', 'insert')).toHaveLength(0);
  });

  it('is owner-only', async () => {
    reset(asCounter());
    healthy();
    expect(await importOpeningStock({ csv })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('postOpening / cancelOpening', () => {
  it('posts with the date and the figure the screen showed', async () => {
    reset(asAdmin());
    healthy();
    expect(await postOpening({ date: '2026-09-25', expectedEquity: '195000.00' })).toEqual({ ok: true, data: null });
    expect(rpc('post_opening_balances')?.payload).toEqual({ p_date: '2026-09-25', p_expected_equity: '195000.00' });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/settings/cutover', '/']));
  });

  it('maps a stale preview, a locked month and a non-owner', async () => {
    reset(asAdmin());
    healthy('draft', () => dbError('DN_VALIDATION:stale_preview'));
    expect(await postOpening({ date: '2026-09-25', expectedEquity: '1.00' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.stale_preview' });
    healthy('draft', () => dbError('DN_PERIOD_LOCKED'));
    expect(await postOpening({ date: '2026-09-25', expectedEquity: '1.00' })).toMatchObject({ ok: false, code: 'period_locked' });
    reset(asAdmin('aal1'));
    expect(await postOpening({ date: '2026-09-25', expectedEquity: '1.00' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('cancels with a reason, and says why it cannot once bills are posted', async () => {
    reset(asAdmin());
    healthy();
    expect(await cancelOpening({ reason: 'Wrong cash' })).toEqual({ ok: true, data: null });
    expect(rpc('cancel_opening_balances')?.payload).toEqual({ p_reason: 'Wrong cash' });
    healthy('posted', () => dbError('DN_VALIDATION:books_in_use'));
    expect(await cancelOpening({ reason: 'Too late' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.books_in_use' });
    expect(await cancelOpening({ reason: 'x' })).toMatchObject({ ok: false, code: 'validation' });
  });
});
