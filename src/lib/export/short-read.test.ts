import { describe, expect, it, vi } from 'vitest';
import { fakeDb, fakeSupabase, type FakeDb } from '@/test/export-fake';

vi.mock('server-only', () => ({}));

import { Lookups } from './lookups';
import { collect, readPaged, readRpcPaged, ShortReadError } from './paged';
import { partyLedgerTable, stockOnHandTable, journalTable, newJournalStats } from './books-tables';
import { fiscalYear } from './period';
import type { Supabase } from './types';

// A source that hands back fewer rows than the database counted (an API row limit below the page size)
// must stop the export, whichever reader hits it: a sheet, an aggregate or a lookup.

const OLD = '2020-01-01T00:00:00Z';
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(4, '0'), created_at: OLD }));
const ctxOf = (db: FakeDb) => ({ supabase: fakeSupabase(db) as unknown as Supabase, asOf: '2026-10-02T00:00:00Z', fy: fiscalYear(2026) });

describe('readPaged / readRpcPaged count check', () => {
  it('a source that returns fewer rows than it counted aborts the read', async () => {
    const db = fakeDb({ things: mk(2000) });
    db.maxRows = 500;
    await expect(collect(readPaged(ctxOf(db), { from: 'things', select: 'id', order: ['id'] }))).rejects.toBeInstanceOf(ShortReadError);
    await expect(collect(readPaged(ctxOf(db), { from: 'things', select: 'id', order: ['id'] }))).rejects.toThrow(/read 500 rows but the database counted 2000/);
  });

  it('asks for the exact count on the first page only, and a complete read passes', async () => {
    const db = fakeDb({ things: mk(2350) });
    expect(await collect(readPaged(ctxOf(db), { from: 'things', select: 'id', order: ['id'] }))).toHaveLength(2350);
    expect(db.requests.length).toBe(3);
  });

  it('a short rpc read aborts too, and a complete one passes', async () => {
    const db = fakeDb();
    db.rpcs.costs = () => mk(1500).map((r) => ({ movement_id: r.id }));
    expect(await collect(readRpcPaged(ctxOf(db).supabase, 'costs', 'movement_id', ['movement_id']))).toHaveLength(1500);
    db.maxRows = 400;
    await expect(collect(readRpcPaged(ctxOf(db).supabase, 'costs', 'movement_id', ['movement_id']))).rejects.toBeInstanceOf(ShortReadError);
  });

  it('a missing count is an error, not a pass', async () => {
    const supabase = { from: () => ({ select: () => ({ lte: () => ({ order: () => ({ range: async () => ({ data: [], error: null }) }) }) }) }) };
    await expect(collect(readPaged({ supabase: supabase as never, asOf: 'x' }, { from: 't', select: 'id', order: ['id'] }))).rejects.toThrow(/no count/);
  });
});

describe('every reader is covered', () => {
  const partyLine = (i: number) => ({ id: `l${i}`, party_id: 'p1', debit: '1.00', credit: '0.00', created_at: OLD, journal_entries: { entry_date: '2026-09-01', status: 'posted' } });
  const world = (): FakeDb => {
    const db = fakeDb({
      journal_lines: Array.from({ length: 10 }, (_, i) => partyLine(i)),
      parties: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, type: 'customer', state_code: '37', credit_days: 0, is_active: true, is_walk_in: false, created_at: OLD })),
      journal_entries: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, entry_no: i, entry_date: '2026-09-01', source_type: 'manual', status: 'posted', reversed_by: i === 0 ? 'e1' : null, journal_lines: [], created_at: OLD })),
      stock_movements: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, item_id: 'i', warehouse_id: 'w', movement_date: '2026-09-01', qty: '1.000', source_type: 'manual', source_id: null, reversal_of: null, created_at: OLD })),
      items: [], warehouses: [], accounts: [], app_users: [], v_document_refs: [], party_addresses: [],
    });
    db.rpcs.stock_movement_cost = () => Array.from({ length: 10 }, (_, i) => ({ movement_id: `m${i}`, rate: '1.0000', value: '1.00' }));
    return db;
  };

  it('works on a complete source (control)', async () => {
    const c = ctxOf(world());
    expect(await collect(partyLedgerTable(c, new Lookups(c)).rows())).toHaveLength(6);
    expect((await collect(stockOnHandTable(c, new Lookups(c)).rows())).length).toBeGreaterThan(0);
  });

  it('party ledger aggregate (journal_lines read)', async () => {
    const db = world(); db.maxRows = 4; const c = ctxOf(db);
    await expect(collect(partyLedgerTable(c, new Lookups(c)).rows())).rejects.toBeInstanceOf(ShortReadError);
  });

  it('stock on hand aggregate (movements and cost reads)', async () => {
    const db = world(); db.maxRows = 4; const c = ctxOf(db);
    await expect(collect(stockOnHandTable(c, new Lookups(c)).rows())).rejects.toBeInstanceOf(ShortReadError);
  });

  it('the journal sheet read', async () => {
    const db = world(); db.maxRows = 3; const c = ctxOf(db);
    await expect(collect(journalTable(c, new Lookups(c), newJournalStats()).rows())).rejects.toBeInstanceOf(ShortReadError);
  });

  it('master lookups', async () => {
    const db = world(); db.maxRows = 4; const c = ctxOf(db);
    await expect(new Lookups(c).parties()).rejects.toBeInstanceOf(ShortReadError);
  });
});
