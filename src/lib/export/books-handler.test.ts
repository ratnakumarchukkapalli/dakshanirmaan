import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, fakeSupabase, type FakeDb } from '@/test/export-fake';

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

const owner = { userId: 'u-owner', role: 'admin' as const, name: 'Test Owner', aal: 'aal2' as const };
const counter = { userId: 'u-counter', role: 'user' as const, name: 'Counter', aal: 'aal1' as const };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEETS = [
  'README', 'Chart of accounts', 'Trial balance', 'Journal', 'Party ledger', 'Parties', 'Sales invoices', 'Sales invoice lines', 'Purchase invoices',
  'Purchase invoice lines', 'Credit notes', 'Credit note lines', 'Debit notes', 'Debit note lines', 'Payments', 'Allocations', 'Cash deposits',
  'Expense vouchers', 'Stock movements', 'Stock on hand', 'Items', 'Warehouses', 'GST monthly (3B)', 'GSTR-1 HSN summary', 'Day closes',
  'Bank statement lines', 'Checks',
];

const OLD = '2020-01-01T00:00:00Z';
const ACCOUNTS = [
  { id: 'a-cash', code: '1110', name: 'Cash', type: 'asset', parent_id: null, system_key: 'cash', is_group: false, is_control: false, is_money: true },
  { id: 'a-ar', code: '1200', name: 'Accounts Receivable', type: 'asset', parent_id: null, system_key: 'ar', is_group: false, is_control: true, is_money: false },
  { id: 'a-sales', code: '4100', name: 'Sales', type: 'income', parent_id: null, system_key: null, is_group: false, is_control: false, is_money: false },
];
const party = (id: string, name: string, gstin: string | null = null) => ({
  id, name, type: 'customer', gstin, state_code: '37', phone: '+919848012345', whatsapp_phone: null, credit_limit: '50000.00', credit_days: 30,
  interest_rate_pm: '1.50', is_active: true, is_walk_in: false, created_at: OLD,
});
const PARTIES = [party('p1', 'Sri Venkateswara Constructions', '37ABCFS1234K1Z6'), party('p2', '=HYPERLINK("http://x","y")'), party('p3', '@SUM(1)')];

/** `n` entries of two lines each: Dr receivable (party) / Cr sales. Amount i is deliberately awkward (1234567.89, 0.07, ...). */
function journal(n: number) {
  const amounts = ['1234567.89', '0.07', '0.10', '0.20', '99.99'];
  const entries = [];
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const amount = amounts[i % amounts.length]!;
    const day = String((i % 28) + 1).padStart(2, '0');
    const pid = PARTIES[i % 3]!.id;
    const mk = (line_no: number, account_id: string, debit: string, credit: string, party_id: string | null) => ({ id: `l-${i}-${line_no}`, line_no, account_id, party_id, debit, credit });
    const jl = [mk(1, 'a-ar', amount, '0.00', pid), mk(2, 'a-sales', '0.00', amount, null)];
    entries.push({
      id: `e-${i}`, entry_no: i + 1, entry_date: `2026-09-${day}`, narration: i === 0 ? '=cmd|calc' : `Sale ${i + 1}`, source_type: 'sales_invoice', source_id: `inv-${i}`,
      status: 'posted', reversed_by: i === 1 ? 'e-2' : null, posted_by: owner.userId, posted_at: '2026-09-01T10:00:00Z', created_at: OLD, journal_lines: jl,
    });
    for (const l of jl) lines.push({ ...l, created_at: OLD, journal_entries: { entry_date: `2026-09-${day}`, status: 'posted' } });
  }
  // an entry in the previous financial year: it counts towards the party's opening balance only
  lines.push({ id: 'l-old', line_no: 1, account_id: 'a-ar', party_id: 'p1', debit: '1000.00', credit: '0.00', created_at: OLD, journal_entries: { entry_date: '2026-03-15', status: 'posted' } });
  return { entries, lines };
}

function baseDb(n = 5): FakeDb {
  const j = journal(n);
  const d = fakeDb({
    organization: [{ legal_name: 'Daksha Nirmaan Traders', timezone: 'Asia/Kolkata' }],
    fiscal_periods: [{ year_label: '2026-27' }, { year_label: '2025-26' }],
    accounts: ACCOUNTS, parties: PARTIES, party_addresses: [{ party_id: 'p1', label: 'Shop', address: { line1: 'Shop 11', city: 'Vijayawada', pincode: '520001' }, is_default: true }],
    warehouses: [{ id: 'w1', name: 'Head Godown', address: null, is_default: true, is_transit: false }],
    items: [{ id: 'i1', name: 'UltraTech PPC 50kg', brand: 'UltraTech', category: 'cement', hsn_code: '2523', gst_rate: '18.00', base_uom: 'bag', alt_uom: null, conversion_factor: null, reorder_level: '100.000', sale_rate: '365.0000', is_active: true, is_stock: true }],
    app_users: [{ user_id: owner.userId, name: 'Test Owner' }],
    v_document_refs: j.entries.map((e) => ({ source_type: 'sales_invoice', source_id: e.source_id, doc_no: `DN/26-27/${String(e.entry_no).padStart(4, '0')}`, doc_date: e.entry_date })),
    journal_entries: j.entries, journal_lines: j.lines,
    sales_invoices: [
      { id: 'inv-0', invoice_no: 'DN/26-27/0001', invoice_date: '2026-09-01', status: 'posted', party_id: 'p1', buyer_gstin: '37ABCFS1234K1Z6', place_of_supply: '37', warehouse_id: 'w1', taxable_total: '1000.00', cgst_total: '90.00', sgst_total: '90.00', igst_total: '0.00', round_off: '0.00', grand_total: '1180.00', vehicle_no: null, transporter_name: null, ewb_no: null, irn: null, created_at: OLD, updated_at: OLD },
      { id: 'inv-1', invoice_no: 'DN/26-27/0002', invoice_date: '2026-09-02', status: 'cancelled', party_id: 'p2', buyer_gstin: null, place_of_supply: '37', warehouse_id: 'w1', taxable_total: '0.07', cgst_total: '0.00', sgst_total: '0.00', igst_total: '0.00', round_off: '0.00', grand_total: '0.07', vehicle_no: null, transporter_name: null, ewb_no: null, irn: null, created_at: OLD, updated_at: OLD },
      { id: 'inv-d', invoice_no: null, invoice_date: '2026-09-03', status: 'draft', party_id: 'p1', place_of_supply: '37', taxable_total: '5.00', created_at: OLD },
    ],
    sales_invoice_lines: [
      { id: 'sl-1', line_no: 1, item_name: 'UltraTech PPC 50kg', hsn_code: '2523', uom: 'bag', qty: '10.000', alt_qty: null, rate: '100.0000', discount_pct: '0.00', taxable_value: '1000.00', gst_rate: '18.00', cgst_amt: '90.00', sgst_amt: '90.00', igst_amt: '0.00', created_at: OLD, sales_invoices: { invoice_no: 'DN/26-27/0001', invoice_date: '2026-09-01', status: 'posted' } },
      { id: 'sl-d', line_no: 1, item_name: 'draft line', hsn_code: '2523', uom: 'bag', qty: '1.000', rate: '1.0000', taxable_value: '1.00', gst_rate: '18.00', created_at: OLD, sales_invoices: { invoice_no: null, invoice_date: '2026-09-03', status: 'draft' } },
    ],
    purchase_invoices: [], purchase_invoice_lines: [], credit_notes: [], credit_note_lines: [], debit_notes: [], debit_note_lines: [],
    payments: [], payment_allocations: [], cash_deposits: [], expense_voucher_lines: [], expense_vouchers: [], day_closes: [], bank_statement_lines: [],
    stock_movements: [
      { id: 'm1', item_id: 'i1', warehouse_id: 'w1', movement_date: '2026-09-01', qty: '100.000', source_type: 'purchase_invoice', source_id: 'x', reversal_of: null, created_at: OLD },
      { id: 'm2', item_id: 'i1', warehouse_id: 'w1', movement_date: '2026-09-02', qty: '-10.000', source_type: 'sales_invoice', source_id: 'inv-0', reversal_of: null, created_at: OLD },
      { id: 'm0', item_id: 'i1', warehouse_id: 'w1', movement_date: '2026-03-01', qty: '5.000', source_type: 'opening', source_id: null, reversal_of: null, created_at: OLD },
    ],
  });
  d.rpcs.stock_movement_cost = () => [
    { movement_id: 'm0', rate: '90.0000', value: '450.00' }, { movement_id: 'm1', rate: '100.0000', value: '10000.00' }, { movement_id: 'm2', rate: '100.0000', value: '-1000.00' },
  ];
  d.rpcs.trial_balance_asat = () => [
    { account_id: 'a-cash', code: '1110', name: 'Cash', account_type: 'asset', total_debit: 1234567.89, total_credit: 0, closing: 1234567.89 },
    { account_id: 'a-sales', code: '4100', name: 'Sales', account_type: 'income', total_debit: 0, total_credit: 1234567.89, closing: -1234567.89 },
  ];
  d.rpcs.gstr3b_summary = () => [{ row_key: '3.1a', taxable: 1000, igst: 0, cgst: 90, sgst: 90, cess: 0 }];
  d.rpcs.gstr1_data = (args) => ({
    period: '', fp: '', gstin: null, b2b: [], b2cl: [], b2cs: [], cdnr: [], nil: { inv: [] }, doc_issue: { doc_det: [] }, totals: {}, summary: {}, warnings: [],
    hsn: {
      hsn_b2b: args?.p_month === '2026-09-01' ? [{ num: 1, hsn_sc: '2523', desc: 'UltraTech PPC 50kg', uqc: 'BAG', qty: 10, rt: 18, txval: 1000, iamt: 0, camt: 90, samt: 90, csamt: 0 }] : [],
      hsn_b2c: [],
    },
  });
  d.rpcs.log_export = () => [];
  return d;
}

async function call(qs: string | null = '2026') {
  const { booksResponse } = await import('./books-handler');
  return booksResponse(qs);
}
async function workbook(res: Response) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
  return wb;
}

beforeEach(() => {
  member = owner;
  db = baseDb();
  clientsOpened = 0;
});

describe('GET /api/backup/books.xlsx — who may download', () => {
  it('403 for a counter user, an owner at aal1 and a signed-out visitor, with no database read', async () => {
    for (const m of [counter, { ...owner, aal: 'aal1' as const }, null]) {
      member = m;
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('content-disposition')).toBeNull();
    }
    expect(db.requests).toHaveLength(0);
    expect(clientsOpened).toBe(0);
  });

  it('400 for a year that is not set up, before any book is read', async () => {
    for (const fy of ['2030', 'abc', '26', '2026-27']) expect((await call(fy)).status).toBe(400);
    expect(db.requests.some((r) => r.name === 'journal_entries')).toBe(false);
    expect(db.rpcs.log_export).toBeDefined();
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });
});

describe('GET /api/backup/books.xlsx — the file', () => {
  it('streams an xlsx with a safe name, every sheet in order, and writes one audit row first', async () => {
    const res = await call('2026');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="daksha-books-FY26-27.xlsx"');
    expect(res.headers.get('cache-control')).toContain('no-store');
    const audit = db.requests.filter((r) => r.name === 'log_export');
    expect(audit).toHaveLength(1);
    const wb = await workbook(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(SHEETS);
  });

  it('defaults to a year that is set up when ?fy is missing', async () => {
    const res = await call(null);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/daksha-books-FY2[56]-2[67]\.xlsx/);
  });

  it('README comes first with the year, the as-of moment, the row counts and the trial balance check', async () => {
    const wb = await workbook(await call());
    const readme = wb.getWorksheet('README')!;
    const text = (r: number) => `${readme.getRow(r).getCell(1).value} | ${readme.getRow(r).getCell(2).value}`;
    expect(text(1)).toContain('Daksha Nirmaan Traders');
    expect(text(2)).toContain('2026-27 (01-04-2026 to 31-03-2027)');
    expect(text(3)).toMatch(/Generated \| \d\d-\d\d-\d{4} \d\d:\d\d .* by Test Owner/);
    expect(text(4)).toContain('Data as of');
    expect(text(5)).toContain('Total debits 1234567.89 equal total credits 1234567.89 on 31-03-2027: OK');
    const listed = new Map<string, unknown>();
    readme.eachRow((row) => { if (SHEETS.includes(String(row.getCell(1).value)) && row.getCell(3).value !== null) listed.set(String(row.getCell(1).value), row.getCell(3).value); });
    expect(listed.get('Journal')).toBe(10);
    expect(listed.get('Sales invoices')).toBe(2); // the draft is not counted
    expect(listed.get('Parties')).toBe(3);
  });

  it('GSTIN: a sales invoice shows only the GSTIN saved on it, even if the party later gets one; purchases show the master and say so', async () => {
    // inv-1 is a B2C sale to p2, who has since been given a GSTIN in the master
    (db.tables.parties![1] as Record<string, unknown>).gstin = '37AAAAA0000A1Z5';
    db.tables.purchase_invoices = [{ id: 'pi-1', invoice_no: 'PB/26-27/0001', invoice_date: '2026-09-05', status: 'posted', party_id: 'p2', place_of_supply: '37', warehouse_id: 'w1', taxable_total: '10.00', cgst_total: '0.00', sgst_total: '0.00', igst_total: '0.00', round_off: '0.00', grand_total: '10.00', supplier_bill_no: 'S1', rcm: false, itc_eligible: true, created_at: OLD }];
    const wb = await workbook(await call());
    const sales = wb.getWorksheet('Sales invoices')!;
    expect(sales.getRow(1).getCell(5).value).toBe('Party GSTIN (on document)');
    expect(sales.getRow(2).getCell(5).value).toBe('37ABCFS1234K1Z6');
    expect(sales.getRow(3).getCell(5).value).toBeNull();
    const purchases = wb.getWorksheet('Purchase invoices')!;
    expect(purchases.getRow(1).getCell(5).value).toBe('Party GSTIN (master today)');
    expect(purchases.getRow(2).getCell(5).value).toBe('37AAAAA0000A1Z5');
    let note = '';
    wb.getWorksheet('README')!.eachRow((row) => { if (row.getCell(1).value === 'Names and snapshots') note = String(row.getCell(2).value); });
    expect(note).toContain('Party GSTIN (master today)');
  });

  it('README states the as-of limits accurately and lists every defused character', async () => {
    const wb = await workbook(await call());
    const lines = new Map<string, string>();
    wb.getWorksheet('README')!.eachRow((row) => lines.set(String(row.getCell(1).value), String(row.getCell(2).value)));
    expect(lines.get('Data as of')).toContain('leave out anything created after this moment');
    expect(lines.get('Data as of')).toContain('read from the database reports a moment later');
    expect(lines.get('Data as of')).not.toContain('never change');
    expect(lines.get('Text safety')).toContain('= + - @, a tab or a carriage return');
  });

  it('counts a bank line matched after the as-of moment as a change', async () => {
    db.tables.bank_statement_lines = [{ id: 'b1', line_no: 1, txn_date: '2026-09-01', match_status: 'matched', matched_at: '2999-01-01T00:00:00Z', created_at: OLD }];
    const wb = await workbook(await call());
    let result = '';
    wb.getWorksheet('Checks')!.eachRow((row) => { if (row.getCell(1).value === 'Changed while exporting') result = String(row.getCell(2).value); });
    expect(result).toBe('CHECK');
  });

  it('trial balance sheet has the figures, a total row and the check', async () => {
    const ws = (await workbook(await call())).getWorksheet('Trial balance')!;
    expect(ws.getRow(2).values).toEqual([undefined, '1110', 'Cash', 'asset', 1234567.89, 0]);
    expect(ws.getRow(3).values).toEqual([undefined, '4100', 'Sales', 'income', 0, 1234567.89]);
    expect(ws.getRow(5).getCell(2).value).toBe('Total');
    expect(ws.getRow(5).getCell(4).value).toBe(1234567.89);
    expect(ws.getRow(5).getCell(5).value).toBe(1234567.89);
    expect(ws.getRow(6).getCell(2).value).toBe('Check: total debits equal total credits');
  });

  it('says so when the trial balance does not balance', async () => {
    db.rpcs.trial_balance_asat = () => [
      { account_id: 'a-cash', code: '1110', name: 'Cash', account_type: 'asset', total_debit: 100, total_credit: 0, closing: 100 },
      { account_id: 'a-sales', code: '4100', name: 'Sales', account_type: 'income', total_debit: 0, total_credit: 99, closing: -99 },
    ];
    const wb = await workbook(await call());
    expect(String(wb.getWorksheet('README')!.getRow(5).getCell(2).value)).toContain('CHECK FAILED');
    expect(String(wb.getWorksheet('Trial balance')!.getRow(6).getCell(2).value)).toContain('CHECK FAILED');
  });

  it('journal: one row per line with real numbers and dates, a reversal flag, document numbers, and totals that balance', async () => {
    const wb = await workbook(await call());
    const ws = wb.getWorksheet('Journal')!;
    expect(ws.rowCount).toBe(1 + 10 + 2); // header, 5 entries x 2 lines, gap, total
    expect(ws.getRow(1).getCell(1).value).toBe('Entry no');
    const first = ws.getRow(2);
    expect(first.getCell(1).value).toBe(1);
    expect(first.getCell(2).value).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(first.getCell(4).value).toBe('DN/26-27/0001');
    expect(first.getCell(5).value).toBe("'=cmd|calc"); // narration defused
    expect(first.getCell(10).value).toBe('1200');
    expect(first.getCell(12).value).toBe('Sri Venkateswara Constructions');
    expect(first.getCell(13).value).toBe(1234567.89);
    expect(first.getCell(14).value).toBe(0);
    expect(first.getCell(15).value).toBe('Test Owner');
    // entry 2 was reversed later by entry 3: flagged on both
    expect(ws.getRow(4).getCell(7).value).toBe(true);
    expect(ws.getRow(4).getCell(8).value).toBe(false);
    expect(ws.getRow(6).getCell(8).value).toBe(true);
    let dr = 0n; let cr = 0n;
    for (let r = 2; r <= 11; r += 1) {
      dr += BigInt(Math.round(Number(ws.getRow(r).getCell(13).value) * 100));
      cr += BigInt(Math.round(Number(ws.getRow(r).getCell(14).value) * 100));
    }
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0n);
    expect(ws.getRow(13).getCell(13).value).toBe(ws.getRow(13).getCell(14).value);
  });

  it('a party named like a formula comes out as inert text', async () => {
    const wb = await workbook(await call());
    const parties = wb.getWorksheet('Parties')!;
    const names = [2, 3, 4].map((r) => parties.getRow(r).getCell(1).value);
    expect(names).toContain(`'=HYPERLINK("http://x","y")`);
    expect(names).toContain("'@SUM(1)");
    for (const r of [2, 3, 4]) expect(parties.getRow(r).getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(parties.getRow(2).getCell(5).value).toBe("'+919848012345"); // a phone starting with + is protected too
    expect(parties.getRow(4).getCell(7).value).toBe('Shop 11, Vijayawada, 520001');
    // and in the journal and the party ledger
    expect(wb.getWorksheet('Journal')!.getRow(3).getCell(12).value).toBeNull();
    const ledger = wb.getWorksheet('Party ledger')!;
    expect([2, 3, 4].map((r) => ledger.getRow(r).getCell(1).value)).toContain("'@SUM(1)");
  });

  it('party ledger: opening from the year before, movement in the year, closing, exact', async () => {
    const ws = (await workbook(await call())).getWorksheet('Party ledger')!;
    const byName = new Map<string, unknown[]>();
    ws.eachRow((row, i) => { if (i > 1) byName.set(String(row.getCell(1).value), (row.values as unknown[]).slice(1)); });
    // p1 owes 1000.00 from before the year; entries 1 and 4 (index 0 and 3) are p1's: 1234567.89 + 0.20
    expect(byName.get('Sri Venkateswara Constructions')).toEqual(['Sri Venkateswara Constructions', 'customer', 1000, 1234568.09, 0, 1235568.09, 'Dr']);
    // p2: entries index 1 and 4 -> 0.07 + 99.99 = 100.06
    expect(byName.get("'=HYPERLINK(\"http://x\",\"y\")")).toEqual(["'=HYPERLINK(\"http://x\",\"y\")", 'customer', 0, 100.06, 0, 100.06, 'Dr']);
  });

  it('flags the cancelled invoice, leaves the draft out, and keeps tax split and lines as posted', async () => {
    const wb = await workbook(await call());
    const inv = wb.getWorksheet('Sales invoices')!;
    expect(inv.rowCount).toBe(3);
    expect(inv.getRow(2).values).toEqual(expect.arrayContaining(['DN/26-27/0001', 'posted', 1000, 90, 1180]));
    expect(inv.getRow(3).getCell(3).value).toBe('cancelled');
    expect(inv.getRow(3).getCell(7).value).toBe(0.07);
    const lines = wb.getWorksheet('Sales invoice lines')!;
    expect(lines.rowCount).toBe(2);
    expect(lines.getRow(2).values).toEqual(expect.arrayContaining(['UltraTech PPC 50kg', '2523', 'bag', 10, 100, 18]));
  });

  it('stock: movements with in/out, owner-only cost, and stock on hand summed from every earlier movement', async () => {
    const wb = await workbook(await call());
    const mv = wb.getWorksheet('Stock movements')!;
    expect(mv.rowCount).toBe(3); // the opening movement is before the year
    expect(mv.getRow(2).values).toEqual(expect.arrayContaining(['UltraTech PPC 50kg', 'Head Godown', 100, 100, 10000]));
    expect(mv.getRow(3).getCell(8).value).toBeNull();
    expect(mv.getRow(3).getCell(9).value).toBe(10);
    expect(mv.getRow(3).getCell(11).value).toBe(-1000);
    const soh = wb.getWorksheet('Stock on hand')!;
    // 5 + 100 - 10 = 95 bags; 450 + 10000 - 1000 = 9450.00; average 99.4737
    expect(soh.getRow(2).values).toEqual([undefined, 'UltraTech PPC 50kg', 'bag', 'Head Godown', false, 95, 99.4737, 9450]);
  });

  it('GST sheets carry the monthly figures', async () => {
    const wb = await workbook(await call());
    const gst = wb.getWorksheet('GST monthly (3B)')!;
    expect(gst.rowCount).toBe(13); // 12 months x 1 row + header
    expect(gst.getRow(2).values).toEqual([undefined, '2026-04', '3.1a', 'Outward taxable supplies (invoices less credit notes)', 1000, 0, 90, 90]);
  });

  it('Checks sheet: journal totals agree, every sheet\'s rows written equal the count taken before', async () => {
    const wb = await workbook(await call());
    const ws = wb.getWorksheet('Checks')!;
    const rows = new Map<string, unknown[]>();
    ws.eachRow((row) => rows.set(String(row.getCell(1).value), (row.values as unknown[]).slice(1)));
    expect(rows.get('Journal debits equal credits')?.[1]).toBe('OK');
    expect(rows.get('Every journal entry balances')?.[1]).toBe('OK');
    expect(rows.get('Trial balance debits equal credits')?.[1]).toBe('OK');
    expect(rows.get('Changed while exporting')?.[1]).toBe('OK');
    expect(rows.get('Journal')).toEqual(['Journal', 'OK', 10, 10]);
    expect(rows.get('Sales invoice lines')).toEqual(['Sales invoice lines', 'OK', 1, 1]);
    expect(rows.get('Stock on hand')?.[1]).toBe('n/a');
    const mismatches = [...rows.values()].filter((v) => v[1] === 'MISMATCH');
    expect(mismatches).toEqual([]);
  });

  it('reads more than one page of a big journal (2,600 lines) without losing or repeating a row', async () => {
    db = baseDb(1300);
    const wb = await workbook(await call());
    const ws = wb.getWorksheet('Journal')!;
    expect(ws.rowCount).toBe(1 + 2600 + 2);
    const seen = new Set<string>();
    for (let r = 2; r <= 2601; r += 1) seen.add(`${ws.getRow(r).getCell(1).value}:${ws.getRow(r).getCell(9).value}`);
    expect(seen.size).toBe(2600);
    const pages = db.requests.filter((q) => q.name === 'journal_entries' && q.range && q.select?.includes('journal_lines(')).map((q) => q.range);
    expect(pages).toEqual([[0, 999], [1000, 1999]]);
  });
});

describe('GET /api/backup/books.xlsx — refusals before a byte is sent', () => {
  it('422 with a plain message when a sheet would pass 200,000 rows, and no audit row', async () => {
    db.counts.journal_lines = 200_001;
    const res = await call();
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/"Journal" sheet has more than 2,00,000 rows/);
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });

  it('exactly 200,000 rows is allowed', async () => {
    db.counts.journal_lines = 200_000;
    const res = await call();
    expect(res.status).toBe(200);
    await res.arrayBuffer().catch(() => undefined);
  });

  it('500 and no file when the audit row cannot be written', async () => {
    db.rpcs.log_export = () => new Error('permission denied for function log_export');
    const res = await call();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).not.toMatch(/log_export|permission/);
    // nothing of the books was read for the file
    expect(db.requests.some((r) => r.name === 'journal_entries')).toBe(false);
  });

  it('500 when the trial balance cannot be read', async () => {
    db.rpcs.trial_balance_asat = () => new Error('boom');
    expect((await call()).status).toBe(500);
    expect(db.requests.some((r) => r.name === 'log_export')).toBe(false);
  });
});

describe('GET /api/backup/books.xlsx — data that cannot be read', () => {
  it('leaves the GST sheets out and says so on the README, never inventing numbers', async () => {
    db.rpcs.gstr3b_summary = () => new Error('boom');
    const wb = await workbook(await call());
    expect(wb.worksheets.map((w) => w.name)).not.toContain('GST monthly (3B)');
    expect(wb.worksheets.map((w) => w.name)).not.toContain('GSTR-1 HSN summary');
    let note = '';
    wb.getWorksheet('README')!.eachRow((row) => { if (row.getCell(1).value === 'Sheet not included') note = String(row.getCell(2).value); });
    expect(note).toContain('GST monthly (3B)');
  });

  it('a sheet that comes up short of its counted rows aborts the download', async () => {
    db.counts.sales_invoices = 5; // five were counted, two come back
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('a failure while writing destroys the stream, so the download fails instead of looking complete', async () => {
    db.readErrors.payments = 'connection reset';
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
});
