import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let member: { userId: string; role: 'admin' | 'user'; name: string; aal: 'aal1' | 'aal2' } | null = null;
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => member }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { legal_name: 'DNT', timezone: 'Asia/Kolkata' }, error: null }) }) }),
  }),
}));
const loadCashBook = vi.fn();
const loadStockReport = vi.fn();
const loadDayBookAll = vi.fn();
const loadAgeing = vi.fn();
vi.mock('@/lib/reports-data', () => ({
  loadCashBook: (...a: unknown[]) => loadCashBook(...a),
  loadStockReport: (...a: unknown[]) => loadStockReport(...a),
  loadDayBookAll: (...a: unknown[]) => loadDayBookAll(...a),
  loadAgeing: (...a: unknown[]) => loadAgeing(...a),
  parseDayBookType: (v: string | undefined) => (v === 'payment' ? 'payment' : null),
}));

const admin = { userId: 'a', role: 'admin' as const, name: 'Owner', aal: 'aal2' as const };
const counter = { userId: 'c', role: 'user' as const, name: 'Counter', aal: 'aal1' as const };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeEach(() => {
  member = null;
  for (const f of [loadCashBook, loadStockReport, loadDayBookAll, loadAgeing]) f.mockReset();
});

async function call(name: string, qs = '') {
  const { reportXlsxResponse } = await import('./handler');
  return reportXlsxResponse(name, new URLSearchParams(qs));
}

describe('report Excel route', () => {
  it('404 for an unknown report, before anything is read', async () => {
    member = admin;
    expect((await call('trial-balance')).status).toBe(404);
    expect((await call('../secrets')).status).toBe(404);
  });

  it('401 without a session, and for an owner who has not passed the authenticator step', async () => {
    expect((await call('aging')).status).toBe(401);
    member = { ...admin, aal: 'aal1' };
    expect((await call('aging')).status).toBe(401);
    expect(loadAgeing).not.toHaveBeenCalled();
  });

  it('the cash & bank book is 403 for a counter and never queried', async () => {
    member = counter;
    const res = await call('cash-bank');
    expect(res.status).toBe(403);
    expect(loadCashBook).not.toHaveBeenCalled();
  });

  it('a counter gets the stock workbook without cost: the loader is told isAdmin = false', async () => {
    member = counter;
    loadStockReport.mockResolvedValue({
      godowns: [], selected: 'all', totalValue: null, reconciliation: null,
      rows: [{ itemId: 'i', itemName: 'Cement', category: 'cement', godown: 'Main', baseUom: 'bag', qty: '5.000', avgRate: null, value: null }],
    });
    const res = await call('stock');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(XLSX);
    expect(loadStockReport.mock.calls[0]![1]).toMatchObject({ isAdmin: false });
  });

  it('an owner downloads the cash book with the screen\'s filters', async () => {
    member = admin;
    loadCashBook.mockResolvedValue({
      accounts: [{ id: 'a1', name: 'Cash', key: 'cash' }], account: { id: 'a1', name: 'Cash' },
      opening: '0.00', rows: [], totalIn: '0.00', totalOut: '0.00', closing: '0.00',
    });
    const res = await call('cash-bank', 'account=a1&from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('DN-CashBook-Cash-2026-09-01_2026-09-30.xlsx');
    expect(loadCashBook.mock.calls[0]![1]).toEqual({ account: 'a1', from: '2026-09-01', to: '2026-09-30' });
  });

  it('a range past the export cap is a clear 422, not a partial file', async () => {
    member = admin;
    loadDayBookAll.mockRejectedValue(new Error('too_many'));
    const res = await call('day-book', 'from=2020-01-01&to=2026-09-30');
    expect(res.status).toBe(422);
  });

  it('an unexpected failure is a plain 500 that leaks nothing', async () => {
    member = admin;
    loadAgeing.mockRejectedValue(new Error('relation "secret_table" does not exist'));
    const res = await call('aging');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret_table');
  });
});
