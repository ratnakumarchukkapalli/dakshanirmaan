import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeDb } from '@/test/export-fake';
import { buildDb, owner } from '@/test/tally-fixture';
import { ageParty, loadAgeingAsAt } from './ageing-asat';
import { Lookups } from './lookups';
import { fiscalYear } from './period';
import { dataFileName, jsonChunks } from './archive-handler';
import { groupIndian } from './report-pdf';
import { ZipStream } from './zip';

vi.mock('server-only', () => ({}));
let member: { userId: string; role: 'admin' | 'user'; name: string; aal: 'aal1' | 'aal2' } | null = null;
let db: FakeDb;
let clientsOpened = 0;
vi.mock('@/lib/auth/current', () => ({ getCurrentMember: async () => member }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    clientsOpened += 1;
    return fakeSupabase(db);
  },
}));

const counter = { userId: 'u-counter', role: 'user' as const, name: 'Counter', aal: 'aal1' as const };
const OLD = '2020-01-01T00:00:00Z';

/** The Tally fixture's books plus the empty and small tables the rest of the archive reads. */
function archiveDb(): FakeDb {
  const d = buildDb();
  Object.assign(d.tables, {
    party_addresses: [], warehouses: [{ id: 'w1', name: 'Head Godown', address: null, is_default: true, is_transit: false }],
    items: [{ id: 'i1', name: 'UltraTech PPC 50kg', brand: 'UltraTech', category: 'cement', hsn_code: '2523', gst_rate: '18.00', base_uom: 'bag', alt_uom: null, conversion_factor: null, reorder_level: '100.000', sale_rate: '365.0000', is_active: true, is_stock: true }],
    app_users: [{ user_id: owner.userId, name: 'Test Owner' }],
    sales_invoices: [], sales_invoice_lines: [], purchase_invoices: [], purchase_invoice_lines: [], credit_notes: [], credit_note_lines: [], debit_notes: [], debit_note_lines: [],
    payments: [], payment_allocations: [], cash_deposits: [], expense_voucher_lines: [], expense_vouchers: [], day_closes: [], bank_statement_lines: [],
    stock_movements: [
      { id: 'm1', item_id: 'i1', warehouse_id: 'w1', movement_date: '2026-09-01', qty: '100.000', source_type: 'purchase_invoice', source_id: 'x', reversal_of: null, created_at: OLD },
      { id: 'm2', item_id: 'i1', warehouse_id: 'w1', movement_date: '2026-09-02', qty: '-10.000', source_type: 'sales_invoice', source_id: 'inv-1', reversal_of: null, created_at: OLD },
    ],
  });
  d.rpcs.stock_movement_cost = () => [{ movement_id: 'm1', rate: '100.0000', value: '10000.00' }, { movement_id: 'm2', rate: '100.0000', value: '-1000.00' }];
  d.rpcs.gstr3b_summary = () => [{ row_key: '3.1a', taxable: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 }];
  d.rpcs.gstr1_data = (args) => {
    const month = String(args?.p_month);
    const base = { period: month, fp: '', gstin: '37AAPFU0939F1ZV', b2b: [], b2cl: [], b2cs: [], cdnr: [], nil: { inv: [] }, doc_issue: { doc_det: [] }, hsn: { hsn_b2b: [], hsn_b2c: [] }, summary: {}, warnings: [] as { key: string; count: number }[] };
    if (month === '2026-09-01') return { ...base, fp: '092026', b2b: [{ ctin: '37ABCFS1234K1Z6', inv: [] }], totals: { invoices: 3, notes: 0, taxable: 10000, igst: 0, cgst: 900, sgst: 900 } };
    if (month === '2026-10-01') return { ...base, fp: '102026', totals: { invoices: 1, notes: 0, taxable: 1000, igst: 0, cgst: 90, sgst: 90 }, warnings: [{ key: 'no_hsn', count: 1 }] };
    return { ...base, totals: { invoices: 0, notes: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 } };
  };
  d.rpcs.pnl_range = () => [
    { account_id: 'a-sales', code: '4100', name: 'Sales - Cement', account_type: 'income', amount: 11200, profit_effect: 11200 },
    { account_id: 'a-rent', code: '5400', name: 'Godown Rent', account_type: 'expense', amount: 510, profit_effect: -510 },
  ];
  d.rpcs.balance_sheet_asat = () => [
    { section: 'asset', account_id: 'a-bank', code: '1120', name: 'Bank', amount: 5300, is_current_profit: false },
    { section: 'equity', account_id: 'a-cap', code: '3100', name: 'Capital - Dad', amount: 5300, is_current_profit: false },
  ];
  return d;
}

async function call(fy: string | null = '2026') {
  const { archiveResponse } = await import('./archive-handler');
  return archiveResponse(fy);
}
async function unzip(res: Response): Promise<Record<string, Uint8Array>> {
  expect(res.status).toBe(200);
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

beforeEach(() => {
  member = owner;
  db = archiveDb();
  clientsOpened = 0;
});

describe('GET /api/backup/archive.zip — who may download, and what is refused', () => {
  it('403 for a counter user, an owner at aal1 and a signed-out visitor, with no database read', async () => {
    for (const m of [counter, { ...owner, aal: 'aal1' as const }, null]) {
      member = m;
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.headers.get('content-disposition')).toBeNull();
    }
    expect(db.requests).toHaveLength(0);
    expect(clientsOpened).toBe(0);
  });

  it('400 for a year that is not set up, before any book is read', async () => {
    for (const fy of ['2030', 'abc', '2026-27']) expect((await call(fy)).status).toBe(400);
    expect(db.requests.some((r) => r.name === 'journal_entries' || r.name === 'log_export')).toBe(false);
  });

  it('422 when a table is over the row cap: nothing sent, nothing logged', async () => {
    db.counts.journal_lines = 200_001;
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('quarter');
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('422 naming the entry when a voucher does not balance; no file, no audit row', async () => {
    const d = archiveDb();
    (d.tables.journal_entries![5] as { journal_lines: { credit: string }[] }).journal_lines[1]!.credit = '499.99';
    db = d;
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('EXP/26-27/0001');
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('500 and no file when the audit row cannot be written', async () => {
    db.rpcs.log_export = () => new Error('boom');
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('a failure after the first byte makes the download fail instead of ending as a complete-looking file', async () => {
    db.readErrors.day_closes = 'connection reset';
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});

describe('the archive', () => {
  it('is a zip with a safe name, every file in order, and one audit row', async () => {
    const res = await call();
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="daksha-archive-FY26-27.zip"');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const files = await unzip(res);
    expect(db.requests.filter((r) => r.name === 'log_export')).toHaveLength(1);
    const names = Object.keys(files);
    expect(names[0]).toBe('README.txt');
    expect(names[1]).toBe('books.xlsx');
    expect(names.slice(2, 4)).toEqual(['tally/masters.xml', 'tally/vouchers.xml']);
    expect(names.at(-1)).toBe('MANIFEST.sha256');
    expect(names.filter((n) => n.startsWith('reports/'))).toEqual([
      'reports/trial-balance.pdf', 'reports/profit-and-loss.pdf', 'reports/balance-sheet.pdf', 'reports/receivables-ageing.pdf', 'reports/stock-valuation.pdf', 'reports/gst-summary.pdf',
    ]);
    expect(names).toContain('data/journal.json');
    expect(names).toContain('data/sales-invoice-lines.json');
    expect(names).toContain('data/schema.json');
    expect(names).toContain('gst/gstr1-2026-09.json');
    expect(names).not.toContain('gst/gstr1-2026-10.json'); // blocked: no HSN
    expect(names.filter((n) => n.startsWith('gst/'))).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it('MANIFEST.sha256 lists every other file once, in sha256sum format, and each hash matches', async () => {
    const files = await unzip(await call());
    const manifest = text(files['MANIFEST.sha256']);
    const lines = manifest.trimEnd().split('\n');
    const listed = new Map<string, string>();
    for (const line of lines) {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      expect(m, line).not.toBeNull();
      listed.set(m![2]!, m![1]!);
    }
    expect([...listed.keys()].sort()).toEqual(Object.keys(files).filter((n) => n !== 'MANIFEST.sha256').sort());
    for (const [path, hash] of listed) expect(sha(files[path]!), path).toBe(hash);
    expect(manifest.endsWith('\n')).toBe(true);
  });

  it('README is plain English with the year, who made it, the as-of time, the Tally note and the invoice PDF note', async () => {
    const readme = text((await unzip(await call()))['README.txt']);
    expect(readme).toContain('Daksha Nirmaan Traders - books for financial year 2026-27');
    expect(readme).toContain('(01-04-2026 to 31-03-2027)');
    expect(readme).toMatch(/Generated\s+: \d\d-\d\d-\d{4} \d\d:\d\d \S+, by Test Owner/);
    expect(readme).toMatch(/Data as of\s+: \d\d-\d\d-\d{4} \d\d:\d\d \S+/);
    expect(readme).toContain('NOT yet been imported into a live Tally');
    expect(readme).toContain('test-import');
    expect(readme).toContain('Manual numbering');
    expect(readme).toContain('INVOICE PDFs ARE NOT IN HERE');
    expect(readme).toContain('shasum -a 256 -c MANIFEST.sha256');
    expect(readme).toContain('sha256sum -c MANIFEST.sha256');
    expect(readme).toContain('2026-10: no GSTR-1 file');
    expect(readme).toContain('(2026-09)'); // the month that has a file
    expect(readme).toContain('data/journal.json (');
    expect(readme).toContain('The trial balance on 31-03-2027 balances');
    expect(readme).not.toMatch(/\n{3,}/);
  });

  it('books.xlsx is the part A workbook, opened from inside the zip', async () => {
    const files = await unzip(await call());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(files['books.xlsx']!) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name).slice(0, 4)).toEqual(['README', 'Chart of accounts', 'Trial balance', 'Journal']);
    expect(wb.worksheets.at(-1)!.name).toBe('Checks');
  });

  it('the Tally files are the very bytes the Tally route sends: UTF-16LE with a byte-order mark, masters before vouchers', async () => {
    const files = await unzip(await call());
    for (const [part, path] of [['masters', 'tally/masters.xml'], ['vouchers', 'tally/vouchers.xml']] as const) {
      const bytes = files[path]!;
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
      const { tallyResponse } = await import('./tally-handler');
      const direct = new Uint8Array(await (await tallyResponse('2026', part, null)).arrayBuffer());
      expect(Buffer.from(bytes).equals(Buffer.from(direct)), path).toBe(true);
    }
    expect(new TextDecoder('utf-16le').decode(files['tally/vouchers.xml']!)).toContain('<VOUCHERNUMBER>OPENING</VOUCHERNUMBER>');
  });

  it('data files: one JSON file per table, money as decimal text, dates ISO, row counts that match schema.json', async () => {
    const files = await unzip(await call());
    const schema = JSON.parse(text(files['data/schema.json'])) as { financial_year: string; data_as_of: string; files: Record<string, { table: string; rows: number; columns: { key: string; type: string; format: string }[] }> };
    expect(schema.financial_year).toBe('2026-27');
    expect(Object.keys(schema.files).sort()).toEqual(Object.keys(files).filter((n) => n.startsWith('data/') && n !== 'data/schema.json').sort());
    for (const [path, info] of Object.entries(schema.files)) {
      const rows = JSON.parse(text(files[path])) as Record<string, unknown>[];
      expect(rows.length, path).toBe(info.rows);
      for (const r of rows) expect(Object.keys(r), path).toEqual(info.columns.map((c) => c.key));
    }
    const journal = JSON.parse(text(files['data/journal.json'])) as Record<string, unknown>[];
    expect(journal.length).toBeGreaterThan(20);
    const sale = journal.find((r) => r.doc_no === 'DN/26-27/0001' && r.party === 'Ram & Sons')!;
    expect(sale).toMatchObject({ entry_date: '2026-09-15', debit: '11800.00', credit: '0.00', source_type: 'sales_invoice' });
    expect(typeof sale.debit).toBe('string');
    expect(schema.files['data/journal.json']!.columns.find((c) => c.key === 'debit')).toMatchObject({ type: 'money', format: expect.stringContaining('decimal text') });
    const tb = JSON.parse(text(files['data/trial-balance.json'])) as { code: string }[];
    expect(tb.length).toBeGreaterThan(3);
    const stock = JSON.parse(text(files['data/stock-on-hand.json'])) as { item: string; qty: string; value: string }[];
    expect(stock).toMatchObject([{ item: 'UltraTech PPC 50kg', qty: '90.000', value: '9000.00' }]);
  });

  it('PDFs are real PDFs, one per statement', async () => {
    const files = await unzip(await call());
    const pdfs = Object.keys(files).filter((n) => n.endsWith('.pdf'));
    expect(pdfs).toHaveLength(6);
    for (const p of pdfs) {
      const bytes = files[p]!;
      expect(text(bytes.slice(0, 5)), p).toBe('%PDF-');
      expect(bytes.length, p).toBeGreaterThan(1500);
      expect(text(bytes.slice(-1024)), p).toContain('%%EOF');
    }
  });

  it('GSTR-1 files are the portal file for months with sales and nothing the portal would reject', async () => {
    const files = await unzip(await call());
    const g = JSON.parse(text(files['gst/gstr1-2026-09.json'])) as Record<string, unknown>;
    expect(g).toMatchObject({ gstin: '37AAPFU0939F1ZV', fp: '092026', version: 'GST3.2.2' });
    expect(Array.isArray(g.b2b)).toBe(true);
  });

  it('says so, and still produces the archive, when the GST figures cannot be read', async () => {
    db.errors.gstr3b_summary = 'timeout';
    const files = await unzip(await call());
    expect(Object.keys(files).some((n) => n.startsWith('gst/'))).toBe(false);
    expect(Object.keys(files)).not.toContain('reports/gst-summary.pdf');
    const readme = text(files['README.txt']);
    expect(readme).toContain('no GSTR-1 files');
    expect(readme).toContain('LEFT OUT OF THIS ARCHIVE');
    expect(readme).toContain('reports/gst-summary.pdf');
  });
});

describe('ageing as at the year end (FIFO on the ledger)', () => {
  const ev = (date: string, entryNo: number, rupees: number) => ({ date, entryNo, signed: BigInt(rupees * 100) });

  it('ages what is left of the oldest debits and sets receipts against the oldest first', () => {
    const r = ageParty([ev('2027-03-20', 4, 300), ev('2027-01-01', 1, 1000), ev('2026-12-01', 2, 500), ev('2027-02-01', 3, -1200)], '2027-03-31');
    // debits oldest first: 500 (Dec), 1000 (Jan), 300 (Mar); the 1200 receipt clears the 500 and 700 of January,
    // leaving January's 300 (89 days old) and March's 300 (11 days old)
    expect(r.buckets).toEqual([30000n, 0n, 30000n, 0n]);
    expect(r.onAccount).toBe(0n);
  });

  it('buckets by age in days: 0-30, 31-60, 61-90, over 90', () => {
    const r = ageParty([ev('2027-03-31', 1, 1), ev('2027-03-01', 2, 10), ev('2027-02-15', 3, 100), ev('2027-01-15', 4, 1000), ev('2026-06-01', 5, 10000)], '2027-03-31');
    expect(r.buckets).toEqual([1100n, 10000n, 100000n, 1000000n]);
  });

  it('credits beyond the debits are on account, and a later debit uses them up', () => {
    expect(ageParty([ev('2027-01-01', 1, 100), ev('2027-01-02', 2, -250)], '2027-03-31')).toEqual({ buckets: [0n, 0n, 0n, 0n], onAccount: 15000n });
    expect(ageParty([ev('2027-01-02', 1, -250), ev('2027-03-30', 2, 100)], '2027-03-31')).toEqual({ buckets: [0n, 0n, 0n, 0n], onAccount: 15000n });
  });
});

describe('ageing: cancelled documents and credit notes', () => {
  const entry = (id: string, no: number, date: string, source: string, sourceId: string, dr: string, cr: string, reversedBy: string | null = null) => ({
    id: `l-${id}`, party_id: 'p1', account_id: 'a-ar', debit: dr, credit: cr, created_at: OLD,
    journal_entries: { id, entry_date: date, entry_no: no, status: 'posted', source_type: source, source_id: sourceId, reversed_by: reversedBy },
  });
  async function age(lines: ReturnType<typeof entry>[], creditNotes: { id: string; against_invoice_id: string }[] = []) {
    const d = buildDb([]);
    d.tables.journal_lines = lines;
    d.tables.credit_notes = creditNotes;
    const ctx = { supabase: fakeSupabase(d), asOf: '2030-01-01T00:00:00Z', fy: fiscalYear(2026) };
    return loadAgeingAsAt(ctx as never, new Lookups(ctx as never), () => 0n);
  }

  it('an invoice cancelled in March does not use up an older unpaid invoice: the pair is taken out before matching', async () => {
    const r = await age([
      entry('a', 1, '2026-12-01', 'sales_invoice', 'sA', '1000.00', '0.00'),
      entry('b', 2, '2027-03-25', 'sales_invoice', 'sB', '500.00', '0.00', 'r'),
      entry('r', 3, '2027-03-26', 'sales_invoice', 'sB', '0.00', '500.00'),
    ]);
    expect(r.rows).toEqual([{ party: 'Ram & Sons', b0_30: '0.00', b31_60: '0.00', b61_90: '0.00', b90_plus: '1000.00', onAccount: '0.00', net: '1000.00' }]);
  });

  it('an invoice cancelled after the year end stays (its reversal is not read)', async () => {
    const r = await age([
      entry('a', 1, '2027-03-25', 'sales_invoice', 'sA', '500.00', '0.00', 'later'),
    ]);
    expect(r.totals).toMatchObject({ b0_30: '500.00', net: '500.00' });
  });

  it('a credit note is set against the invoice it was raised against, not the oldest debit', async () => {
    const r = await age([
      entry('a', 1, '2026-12-01', 'sales_invoice', 'sA', '1000.00', '0.00'),
      entry('c', 2, '2027-03-01', 'sales_invoice', 'sC', '500.00', '0.00'),
      entry('n', 3, '2027-03-10', 'credit_note', 'cn1', '0.00', '500.00'),
    ], [{ id: 'cn1', against_invoice_id: 'sC' }]);
    expect(r.totals).toMatchObject({ b0_30: '0.00', b90_plus: '1000.00', net: '1000.00' });
    // the same entries without the link fall back to oldest first
    const plain = await age([
      entry('a', 1, '2026-12-01', 'sales_invoice', 'sA', '1000.00', '0.00'),
      entry('c', 2, '2027-03-01', 'sales_invoice', 'sC', '500.00', '0.00'),
      entry('n', 3, '2027-03-10', 'credit_note', 'cn1', '0.00', '500.00'),
    ]);
    expect(plain.totals).toMatchObject({ b0_30: '500.00', b90_plus: '500.00' });
  });
});

describe('archive: the trial balance self-check', () => {
  it('refuses the whole archive (422, no audit row) when the vouchers do not match the trial balance', async () => {
    const real = db.rpcs.trial_balance_asat!;
    db.rpcs.trial_balance_asat = (args) => {
      const rows = real(args) as { code: string; closing: number }[];
      return String(args?.p_date) === '2027-03-31' ? rows.map((r) => (r.code === '4100' ? { ...r, closing: r.closing - 0.01 } : r)) : rows;
    };
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Account 4100');
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('README no longer claims files agree because posted entries never change, nor states the Tally match as fact', async () => {
    const readme = text((await unzip(await call()))['README.txt']);
    expect(readme).not.toContain('Posted entries never change');
    expect(readme).toContain('Checks');
    expect(readme).toContain('should match the app');
    expect(readme).toContain('not yet been confirmed in a live Tally');
    expect(readme).toContain('"Profit and Loss brought forward"');
    expect(readme).toContain('Current Assets, not Stock-in-Hand');
  });
});

describe('small pieces', () => {
  it('groupIndian refuses more decimals than it was asked to show, instead of cutting them', () => {
    expect(() => groupIndian('1.234', 2)).toThrow('decimal places');
    expect(groupIndian('1.230', 2)).toBe('1.23');
    expect(groupIndian('1.2', 3)).toBe('1.200');
  });

  it('groups rupees the Indian way without a float', () => {
    expect(groupIndian('1234567.8')).toBe('12,34,567.80');
    expect(groupIndian('-100000.00')).toBe('-1,00,000.00');
    expect(groupIndian('999.5', 2)).toBe('999.50');
    expect(groupIndian('90.000', 3)).toBe('90.000');
    expect(groupIndian('5', 0)).toBe('5');
    expect(groupIndian(null)).toBe('');
  });

  it('turns a table name into a file name', () => {
    expect(dataFileName('Sales invoice lines')).toBe('sales-invoice-lines.json');
    expect(dataFileName('GST monthly (3B)')).toBe('gst-monthly-3b.json');
    expect(dataFileName('GSTR-1 HSN summary')).toBe('gstr-1-hsn-summary.json');
  });

  it('writes a table as a JSON array and counts the rows', async () => {
    const table = { name: 't', description: '', columns: [{ key: 'a', header: 'A', type: 'text' as const }, { key: 'b', header: 'B', type: 'money' as const }], async *rows() { yield ['x', '1.50']; yield [null, '0.00']; } };
    const count = { rows: 0 };
    let out = '';
    for await (const c of jsonChunks(table, count)) out += c;
    expect(JSON.parse(out)).toEqual([{ a: 'x', b: '1.50' }, { a: null, b: '0.00' }]);
    expect(count.rows).toBe(2);
    const none = { rows: 0 };
    let empty = '';
    for await (const c of jsonChunks({ ...table, async *rows() { /* nothing */ } }, none)) empty += c;
    expect(JSON.parse(empty)).toEqual([]);
  });

  it('ZipStream: hashes what went in, in sha256sum format, stores and deflates, and refuses a repeated name', async () => {
    const zip = new ZipStream();
    const chunks: Buffer[] = [];
    zip.out.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => zip.out.on('end', resolve));
    const big = 'ledger,line\n'.repeat(50_000);
    await zip.add('a/big.csv', [big.slice(0, 1000), big.slice(1000)]);
    await zip.add('b.bin', [new Uint8Array([1, 2, 3])], { store: true });
    await expect(zip.add('b.bin', ['x'])).rejects.toThrow('already');
    await zip.add('MANIFEST.sha256', [zip.manifestText()]);
    zip.finish();
    await done;
    const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
    expect(text(files['a/big.csv'])).toBe(big);
    expect([...files['b.bin']!]).toEqual([1, 2, 3]);
    expect(text(files['MANIFEST.sha256'])).toBe(`${createHash('sha256').update(big).digest('hex')}  a/big.csv\n${createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex')}  b.bin\n`);
    expect(Buffer.concat(chunks).length).toBeLessThan(big.length / 5); // deflated
  });

  it('ZipStream: a reader that goes away stops the writer with an error', async () => {
    const zip = new ZipStream();
    zip.out.on('error', () => undefined);
    async function* endless() { for (;;) yield 'x'.repeat(100_000); }
    const writing = zip.add('x.txt', endless());
    setTimeout(() => zip.out.destroy(), 20);
    await expect(writing).rejects.toThrow('closed');
  });
});
