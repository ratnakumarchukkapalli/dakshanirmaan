import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Gstr1Data } from '@/lib/gstr1-file';

vi.mock('server-only', () => ({}));
let member: { userId: string; role: 'admin' | 'user'; name: string; aal: 'aal1' | 'aal2' } | null = null;
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => member }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { legal_name: 'DNT', timezone: 'Asia/Kolkata' }, error: null }) }) }),
  }),
}));
const loadGstr1 = vi.fn();
vi.mock('@/lib/books-data', () => ({ loadGstr1: (...a: unknown[]) => loadGstr1(...a) }));

const admin = { userId: 'a', role: 'admin' as const, name: 'Owner', aal: 'aal2' as const };
const data: Gstr1Data = {
  period: '2026-09', fp: '092026', gstin: '37AAPFU0939F1ZU',
  b2b: [{ ctin: '37ABCDE1234F1ZZ', inv: [{ inum: 'DN/26-27/0001', idt: '05-09-2026', val: 5120, pos: '37', rchrg: 'N', inv_typ: 'R', itms: [{ num: 1, itm_det: { rt: 28, txval: 4000, iamt: 0, camt: 560, samt: 560, csamt: 0 } }] }] }],
  b2cl: [], b2cs: [], cdnr: [], nil: { inv: [] }, hsn: { hsn_b2b: [], hsn_b2c: [] }, doc_issue: { doc_det: [] },
  totals: { invoices: 1, notes: 0, taxable: 4000, igst: 0, cgst: 560, sgst: 560 },
  summary: { b2b: { count: 1, txval: 4000, iamt: 0, camt: 560, samt: 560 }, b2cl: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 }, b2cs: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 }, cdnr: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 }, nil: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 }, hsn: { count: 0, txval: 0, iamt: 0, camt: 0, samt: 0 } },
  warnings: [],
};

beforeEach(() => {
  member = null;
  loadGstr1.mockReset();
});

async function get(qs = '') {
  const { GET } = await import('./route');
  const { NextRequest } = await import('next/server');
  return GET(new NextRequest(`http://localhost/api/reports/gstr1${qs}`));
}

describe('GET /api/reports/gstr1', () => {
  it('401 without a session or at step 1, 403 for a counter, and nothing is queried', async () => {
    expect((await get('?period=2026-09')).status).toBe(401);
    member = { ...admin, aal: 'aal1' };
    expect((await get('?period=2026-09')).status).toBe(401);
    member = { userId: 'c', role: 'user', name: 'Counter', aal: 'aal1' };
    expect((await get('?period=2026-09')).status).toBe(403);
    expect(loadGstr1).not.toHaveBeenCalled();
  });

  it('an owner downloads the portal JSON named GSTR1-YYYY-MM.json', async () => {
    member = admin;
    loadGstr1.mockResolvedValue(data);
    const res = await get('?period=2026-09');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Content-Disposition')).toContain('GSTR1-2026-09.json');
    const file = JSON.parse(await res.text());
    expect(file).toMatchObject({ gstin: '37AAPFU0939F1ZU', fp: '092026', gt: 0, cur_gt: 0, hash: 'hash' });
    expect(file.b2b[0].inv[0].itms[0].itm_det).toEqual({ rt: 28, txval: 4000, iamt: 0, camt: 560, samt: 560, csamt: 0 });
    expect('b2cl' in file).toBe(false);
    expect(loadGstr1.mock.calls[0]![1]).toBe('2026-09');
  });

  it('an owner downloads the Excel version', async () => {
    member = admin;
    loadGstr1.mockResolvedValue(data);
    const res = await get('?period=2026-09&format=xlsx');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('GSTR1-2026-09.xlsx');
  });

  it('withholds a month with a problem the portal would reject, and says which', async () => {
    member = admin;
    loadGstr1.mockResolvedValue({ ...data, warnings: [{ key: 'no_hsn', count: 2 }] });
    const res = await get('?period=2026-09');
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('no_hsn');
  });

  it('a bad period falls back to last month instead of reaching the database as-is', async () => {
    member = admin;
    loadGstr1.mockResolvedValue(data);
    await get('?period=../../x');
    expect(loadGstr1.mock.calls[0]![1]).toMatch(/^\d{4}-\d{2}$/);
  });

  it('an unexpected failure is a plain 500 that leaks nothing', async () => {
    member = admin;
    loadGstr1.mockRejectedValue(new Error('relation "secret" does not exist'));
    const res = await get('?period=2026-09');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret');
  });
});
