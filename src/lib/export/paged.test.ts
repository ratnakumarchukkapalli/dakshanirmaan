import { describe, expect, it } from 'vitest';
import { fakeDb, fakeSupabase } from '@/test/export-fake';
import { collect, countRows, readPaged, readRpcPaged } from './paged';
import type { Supabase } from './types';

const ASOF = '2026-10-02T10:00:00.000Z';
const make = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), created_at: '2026-09-01T00:00:00Z', ...extra(i) }));
const ctx = (db: ReturnType<typeof fakeDb>) => ({ supabase: fakeSupabase(db) as unknown as Supabase, asOf: ASOF });

describe('readPaged', () => {
  it('reads 2,350 rows in three requests of at most 1,000, in order, none twice', async () => {
    const db = fakeDb({ things: make(2350).reverse() });
    const out = await collect(readPaged<{ id: string }>(ctx(db), { from: 'things', select: 'id', order: ['id'] }));
    expect(out).toHaveLength(2350);
    expect(out[0]!.id).toBe('00000');
    expect(out[2349]!.id).toBe('02349');
    expect(new Set(out.map((r) => r.id)).size).toBe(2350);
    expect(db.requests.map((r) => r.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it('asks once more only when a page is full, and not at all for an empty table', async () => {
    const exact = fakeDb({ things: make(1000) });
    expect(await collect(readPaged(ctx(exact), { from: 'things', select: 'id', order: ['id'] }))).toHaveLength(1000);
    expect(exact.requests).toHaveLength(2); // the second page is empty and ends the read
    const none = fakeDb({ things: [] });
    expect(await collect(readPaged(ctx(none), { from: 'things', select: 'id', order: ['id'] }))).toHaveLength(0);
    expect(none.requests).toHaveLength(1);
  });
  it('filters to the date range and to rows created by the as-of instant', async () => {
    const db = fakeDb({
      docs: [
        { id: 'a', d: '2026-03-31', created_at: '2026-04-01T00:00:00Z' },
        { id: 'b', d: '2026-04-01', created_at: '2026-04-02T00:00:00Z' },
        { id: 'c', d: '2027-03-31', created_at: '2026-09-02T00:00:00Z' },
        { id: 'd', d: '2027-04-01', created_at: '2026-09-02T00:00:00Z' },
        { id: 'late', d: '2026-10-01', created_at: '2026-10-02T10:00:01.000Z' }, // created after the export began
      ],
    });
    const out = await collect(readPaged<{ id: string }>(ctx(db), { from: 'docs', select: 'id', order: ['id'], dateColumn: 'd', range: { from: '2026-04-01', to: '2027-03-31' } }));
    expect(out.map((r) => r.id)).toEqual(['b', 'c']);
    expect(db.requests[0]!.filters).toEqual(['d>=2026-04-01', 'd<=2027-03-31', `created_at<=${ASOF}`]);
  });
  it('does not filter by created_at for a view that has none, and applies extra filters', async () => {
    const db = fakeDb({ v_refs: [{ id: 'x', s: 'posted' }, { id: 'y', s: 'draft' }] });
    const out = await collect(readPaged<{ id: string }>(ctx(db), { from: 'v_refs', select: 'id', order: ['id'], createdAt: false, filter: (q) => q.neq('s', 'draft') }));
    expect(out.map((r) => r.id)).toEqual(['x']);
    expect(db.requests[0]!.filters).toEqual(['s!=draft']);
  });
  it('fails loudly instead of returning a short list', async () => {
    const db = fakeDb({ things: make(5) });
    db.errors.things = 'permission denied';
    await expect(collect(readPaged(ctx(db), { from: 'things', select: 'id', order: ['id'] }))).rejects.toThrow(/things: permission denied/);
  });
});

describe('countRows', () => {
  it('asks for the count with the same filters and moves no rows', async () => {
    const db = fakeDb({ things: make(2350) });
    expect(await countRows(ctx(db), { from: 'things', select: 'id', order: ['id'] })).toBe(2350);
    expect(db.requests[0]!.head).toBe(true);
    expect(db.requests[0]!.filters).toEqual([`created_at<=${ASOF}`]);
  });
  it('fails when the database gives no count', async () => {
    const db = fakeDb({ things: make(2) });
    db.errors.things = 'boom';
    await expect(countRows(ctx(db), { from: 'things', select: 'id', order: ['id'] })).rejects.toThrow(/boom/);
  });
});

describe('readRpcPaged', () => {
  it('pages a set-returning function the same way', async () => {
    const db = fakeDb();
    db.rpcs.costs = () => make(1500).map((r) => ({ movement_id: r.id }));
    const out = await collect(readRpcPaged(ctx(db).supabase, 'costs', 'movement_id', ['movement_id']));
    expect(out).toHaveLength(1500);
    expect(db.requests.map((r) => r.range)).toEqual([[0, 999], [1000, 1999]]);
  });
});
