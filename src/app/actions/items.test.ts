import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

import { createItem, deactivateItem, reactivateItem, updateItem } from './items';

const ID = '11111111-1111-4111-8111-111111111111';
const item = { name: 'Tiscon 12mm', brand: '', category: 'steel', hsnCode: '7214', gstRate: '18', baseUom: 'kg', altUom: '', conversionFactor: '', reorderLevel: '', saleRate: '62.5375', isStock: true };
const sent = () => state.calls.find((c) => c.op === 'insert' || c.op === 'update')?.payload;

describe('items are owner-only', () => {
  it('owner (aal2) can create, edit, disable and enable', async () => {
    reset(asAdmin());
    expect(await createItem(item)).toEqual({ ok: true, data: { id: 'row-1' } });
    expect(sent()).toMatchObject({ name: 'Tiscon 12mm', sale_rate: '62.5375', reorder_level: '0', alt_uom: null });
    expect(state.revalidated).toContain('/settings/items');
    expect((await updateItem({ id: ID, ...item })).ok).toBe(true);
    expect((await deactivateItem({ itemId: ID })).ok).toBe(true);
    expect((await reactivateItem({ itemId: ID })).ok).toBe(true);
  });
  it('owner at aal1 is refused everywhere, and the database is never touched', async () => {
    reset(asAdmin('aal1'));
    expect(await createItem(item)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await updateItem({ id: ID, ...item })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await deactivateItem({ itemId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await reactivateItem({ itemId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
  it('counter user is refused everywhere', async () => {
    reset(asCounter());
    expect(await createItem(item)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await deactivateItem({ itemId: ID })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('item database rules', () => {
  it('maps "units locked" without showing Postgres text', async () => {
    reset(asAdmin());
    state.respond = () => dbError('DN_VALIDATION:item_units_locked');
    expect(await updateItem({ id: ID, ...item })).toEqual({ ok: false, code: 'validation', error: 'validation.item_units_locked' });
  });
  it('a missing item says so, for edit and for disable/enable', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: [], error: null });
    expect(await updateItem({ id: ID, ...item })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
    expect(await deactivateItem({ itemId: ID })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
    expect(await reactivateItem({ itemId: ID })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_item' });
  });
  it('a number too large for its column is a validation problem, not internal', async () => {
    reset(asAdmin());
    state.respond = () => dbError('numeric field overflow', '22003');
    expect(await createItem(item)).toEqual({ ok: false, code: 'validation', error: 'validation.number_too_large' });
  });
  it('a bad number is caught before the database', async () => {
    reset(asAdmin());
    expect(await createItem({ ...item, saleRate: '99999999999' })).toEqual({ ok: false, code: 'validation', error: 'field.number_too_large' });
    expect(state.calls).toHaveLength(0);
  });
});
