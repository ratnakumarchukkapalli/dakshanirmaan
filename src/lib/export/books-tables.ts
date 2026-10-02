import 'server-only';
import { loadGstr1, loadGstr3b, loadTrialBalance, type Gstr3bRow, type TrialBalance } from '@/lib/books-data';
import type { Gstr1Data } from '@/lib/gstr1-file';
import { decimalString, divideDecimal, fromScaled, toScaled } from './decimal';
import { Lookups, addressText } from './lookups';
import { countRows, readPaged, readRpcPaged, type PagedSpec } from './paged';
import { fyMonths } from './period';
import { col, memoryTable, queryTable } from './table';
import type { ExportContext, ExportRow, ExportTable } from './types';

// The table descriptions of the full-books workbook (change 25, part A). Each one is an `ExportTable`:
// the workbook writer turns it into a sheet, and the year archive (part C) will turn the same
// description into a JSON file. Every figure is the database's own: NUMERIC columns are read as text
// (`col::text`) and handed on as text; the only arithmetic here is exact (BigInt) and only for the sheets
// that are aggregates by nature (party ledger, stock on hand), which the README names.

type Ctx = Pick<ExportContext, 'supabase' | 'asOf' | 'fy'>;

const m2 = (v: unknown) => decimalString(v as string | number | null | undefined, 2);
const q3 = (v: unknown) => decimalString(v as string | number | null | undefined, 3);
const r4 = (v: unknown) => decimalString(v as string | number | null | undefined, 4);
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Everything the workbook needs that is read once, before the first byte is sent. */
export interface BooksPrep {
  trialBalance: TrialBalance;
  gst: GstBundle;
}

export type GstBundle =
  | { ok: true; months: { month: string; rows3b: Gstr3bRow[]; hsn: HsnRow[]; /** The month's whole GSTR-1 data (the year archive writes the portal file from it). */ gstr1: Gstr1Data }[] }
  | { ok: false; reason: string };

export interface HsnRow { section: 'b2b' | 'b2c'; hsn: string; description: string | null; uqc: string | null; qty: string | null; rate: string | null; taxable: string | null; igst: string | null; cgst: string | null; sgst: string | null }

/** The trial balance at the FY end and the 12 months of GST summaries (skipped, with a reason, when they cannot be read). */
export async function prepareBooks(ctx: Pick<ExportContext, 'supabase' | 'fy'>): Promise<BooksPrep> {
  const trialBalance = await loadTrialBalance(ctx.supabase, ctx.fy.to);
  const gst = await loadGst(ctx);
  return { trialBalance, gst };
}

async function loadGst(ctx: Pick<ExportContext, 'supabase' | 'fy'>): Promise<GstBundle> {
  try {
    const months: Extract<GstBundle, { ok: true }>['months'] = [];
    for (const month of fyMonths(ctx.fy)) {
      const [rows3b, gstr1] = await Promise.all([loadGstr3b(ctx.supabase, month), loadGstr1(ctx.supabase, month)]);
      const hsn: HsnRow[] = [];
      for (const section of ['b2b', 'b2c'] as const) {
        const list = (section === 'b2b' ? gstr1.hsn.hsn_b2b : gstr1.hsn.hsn_b2c) as Record<string, unknown>[];
        for (const h of list) {
          hsn.push({
            section, hsn: String(h.hsn_sc ?? ''), description: txt(h.desc), uqc: txt(h.uqc), qty: q3(h.qty as number | string | null),
            rate: m2(h.rt as number | string | null), taxable: m2(h.txval as number | string | null), igst: m2(h.iamt as number | string | null),
            cgst: m2(h.camt as number | string | null), sgst: m2(h.samt as number | string | null),
          });
        }
      }
      months.push({ month, rows3b, hsn, gstr1 });
    }
    return { ok: true, months };
  } catch (e) {
    console.error('[export] GST summaries unavailable:', e instanceof Error ? e.message : e);
    return { ok: false, reason: 'The GST summaries could not be read when this file was made.' };
  }
}

const GST_ROW_LABEL: Record<string, string> = {
  '3.1a': 'Outward taxable supplies (invoices less credit notes)',
  '3.1c': 'Nil-rated / exempt outward supplies',
  '3.1d': 'Inward supplies liable to reverse charge',
  '4A3': 'ITC on reverse charge',
  '4A5': 'All other ITC (eligible purchase invoices)',
  '4D': 'Ineligible ITC',
  books_output: 'Ledger: net output tax of the month',
  books_input: 'Ledger: input tax of the month',
  recon_output: 'Return minus ledger (output)',
  recon_input: 'Return minus ledger (input)',
};
const gstLabel = (key: string) => (key.startsWith('3.2:') ? `Inter-state supplies to unregistered buyers, place of supply ${key.slice(4)}` : (GST_ROW_LABEL[key] ?? key));

// ---------------------------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------------------------

export function accountsTable(ctx: Ctx, lk: Lookups): ExportTable {
  return memoryTable({
    name: 'Chart of accounts',
    description: 'Every ledger account: code, name, type, the group it sits under and its system key.',
    columns: [
      col('code', 'Code', 'text', 10), col('name', 'Name', 'text', 36), col('type', 'Type', 'text', 11), col('parent_code', 'Group code', 'text', 11),
      col('system_key', 'System key', 'text', 18), col('is_group', 'Is a group', 'bool'), col('is_control', 'Control account', 'bool'), col('is_money', 'Cash / bank', 'bool'),
    ],
    async rows() {
      const [list, byId] = await Promise.all([lk.accountRows(), lk.accounts()]);
      return list.map((a): ExportRow => [a.code, a.name, a.type, a.parent_id ? (byId.get(a.parent_id)?.code ?? null) : null, a.system_key, a.is_group, a.is_control, a.is_money]);
    },
    expected: async () => (await lk.accountRows()).length,
  });
}

export function partiesTable(ctx: Ctx, lk: Lookups): ExportTable {
  return memoryTable({
    name: 'Parties',
    description: 'Customers, suppliers and staff: name, type, GSTIN, state, phone and default address.',
    columns: [
      col('name', 'Name', 'text', 34), col('type', 'Type', 'text', 10), col('gstin', 'GSTIN', 'text', 17), col('state_code', 'State code', 'text', 8),
      col('phone', 'Phone', 'text', 15), col('whatsapp_phone', 'WhatsApp', 'text', 15), col('address', 'Default address', 'text', 44),
      col('credit_limit', 'Credit limit', 'money'), col('credit_days', 'Credit days', 'int'), col('interest_rate_pm', 'Interest % per month', 'money'),
      col('is_active', 'Active', 'bool'), col('is_walk_in', 'Walk-in', 'bool'),
    ],
    async rows() {
      const [list, addresses] = await Promise.all([lk.partyRows(), lk.partyAddresses()]);
      return list.map((p): ExportRow => [p.name, p.type, p.gstin, p.state_code, p.phone, p.whatsapp_phone, addresses.get(p.id) ?? null, m2(p.credit_limit), p.credit_days, m2(p.interest_rate_pm), p.is_active, p.is_walk_in]);
    },
    expected: async () => (await lk.partyRows()).length,
  });
}

export function itemsTable(ctx: Ctx, lk: Lookups): ExportTable {
  return memoryTable({
    name: 'Items',
    description: 'The item master: name, brand, category, HSN, GST rate, units, reorder level and sale rate.',
    columns: [
      col('name', 'Name', 'text', 34), col('brand', 'Brand', 'text', 16), col('category', 'Category', 'text', 10), col('hsn_code', 'HSN', 'text', 10),
      col('gst_rate', 'GST %', 'money', 8), col('base_uom', 'Unit', 'text', 8), col('alt_uom', 'Alternate unit', 'text', 10),
      col('conversion_factor', 'Base units per alternate unit', 'rate'), col('reorder_level', 'Reorder level', 'qty'), col('sale_rate', 'Sale rate', 'rate'),
      col('is_active', 'Active', 'bool'), col('is_stock', 'Stocked', 'bool'),
    ],
    async rows() {
      return (await lk.itemRows()).map((i): ExportRow => [i.name, i.brand, i.category, i.hsn_code, m2(i.gst_rate), i.base_uom, i.alt_uom, r4(i.conversion_factor), q3(i.reorder_level), r4(i.sale_rate), i.is_active, i.is_stock]);
    },
    expected: async () => (await lk.itemRows()).length,
  });
}

export function warehousesTable(ctx: Ctx, lk: Lookups): ExportTable {
  return memoryTable({
    name: 'Warehouses',
    description: 'Godowns and the in-transit place.',
    columns: [col('name', 'Name', 'text', 28), col('address', 'Address', 'text', 44), col('is_default', 'Default', 'bool'), col('is_transit', 'In transit', 'bool')],
    async rows() {
      return (await lk.warehouseRows()).map((w): ExportRow => [w.name, addressText(w.address), w.is_default, w.is_transit]);
    },
    expected: async () => (await lk.warehouseRows()).length,
  });
}

// ---------------------------------------------------------------------------------------------
// Trial balance, journal, party ledger
// ---------------------------------------------------------------------------------------------

export function trialBalanceTable(ctx: Ctx, tb: TrialBalance): ExportTable {
  return memoryTable({
    name: 'Trial balance',
    description: `Closing balance of every ledger account on ${ctx.fy.to} (all entries up to that date), as debit or credit, with the check that debits equal credits.`,
    columns: [col('code', 'Code', 'text', 10), col('name', 'Account', 'text', 38), col('type', 'Type', 'text', 11), col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money')],
    async rows() {
      return tb.rows.map((r): ExportRow => [r.code, r.name, r.type, m2(r.debit), m2(r.credit)]);
    },
    expected: async () => tb.rows.length,
    footer: () => [
      [null, 'Total', null, m2(tb.totalDebit), m2(tb.totalCredit)],
      [null, tb.balanced ? 'Check: total debits equal total credits' : 'CHECK FAILED: total debits differ from total credits', null, null, null],
    ],
  });
}

export interface JournalStats { entries: number; lines: number; debit: bigint; credit: bigint; unbalanced: number[] }
export const newJournalStats = (): JournalStats => ({ entries: 0, lines: 0, debit: 0n, credit: 0n, unbalanced: [] });

export interface EntryRow {
  id: string; entry_no: number; entry_date: string; narration: string | null; source_type: string; source_id: string | null; status: string;
  reversed_by: string | null; posted_by: string | null; posted_at: string | null;
  journal_lines: { id: string; line_no: number; account_id: string; party_id: string | null; debit: string; credit: string }[];
}

/**
 * Journal entries of the financial year in entry order, each with its lines embedded (`EntryRow`). The
 * workbook's Journal sheet reads it; the Tally voucher export (part B) reads the same thing.
 */
export const journalEntriesSpec = (ctx: Ctx): PagedSpec => ({
  from: 'journal_entries',
  select: 'id, entry_no, entry_date, narration, source_type, source_id, status, reversed_by, posted_by, posted_at, journal_lines(id, line_no, account_id, party_id, debit::text, credit::text)',
  order: ['entry_no', 'id'], dateColumn: 'entry_date', range: { from: ctx.fy.from, to: ctx.fy.to },
});

/** The journal: one row per line, in entry order. Fills `stats` as it goes (the Checks sheet reads it afterwards). */
export function journalTable(ctx: Ctx, lk: Lookups, stats: JournalStats): ExportTable {
  const range = { from: ctx.fy.from, to: ctx.fy.to };
  const spec = journalEntriesSpec(ctx);
  const lineCount: PagedSpec = { from: 'journal_lines', select: 'id, journal_entries!inner(entry_date)', order: ['id'], dateColumn: 'journal_entries.entry_date', range };
  return {
    name: 'Journal',
    description: `Every journal entry dated in ${ctx.fy.label}, one row per line, including cancelled documents and their reversals (flagged).`,
    columns: [
      col('entry_no', 'Entry no', 'int'), col('entry_date', 'Date', 'date'), col('source_type', 'Source', 'text', 16), col('doc_no', 'Document no', 'text', 18),
      col('narration', 'Narration', 'text', 40), col('status', 'Entry status', 'text', 10), col('reversed', 'Reversed later', 'bool'), col('is_reversal', 'Is a reversal', 'bool'),
      col('line_no', 'Line', 'int'), col('account_code', 'Account code', 'text', 11), col('account_name', 'Account', 'text', 32), col('party', 'Party', 'text', 30),
      col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('posted_by', 'Posted by', 'text', 16), col('posted_at', 'Posted at', 'datetime'),
    ],
    async *rows() {
      const [accounts, parties, users, docs] = await Promise.all([lk.accounts(), lk.parties(), lk.users(), lk.docNumbers()]);
      // Entries that reverse another (an entry's id sits in some other entry's reversed_by), whatever year the original is in.
      const reversalIds = new Set<string>();
      for await (const r of readPaged<{ reversed_by: string }>(ctx, {
        from: 'journal_entries', select: 'id, reversed_by', order: ['id'], filter: (q) => q.not('reversed_by', 'is', null),
      })) reversalIds.add(r.reversed_by);

      for await (const e of readPaged<EntryRow>(ctx, spec)) {
        const lines = [...e.journal_lines].sort((a, b) => a.line_no - b.line_no);
        let dr = 0n;
        let cr = 0n;
        stats.entries += 1;
        for (const l of lines) {
          const debit = m2(l.debit) ?? '0.00';
          const credit = m2(l.credit) ?? '0.00';
          dr += toScaled(debit, 2);
          cr += toScaled(credit, 2);
          stats.lines += 1;
          const account = accounts.get(l.account_id);
          yield [
            e.entry_no, e.entry_date, e.source_type, (e.source_id && docs.get(`${e.source_type}:${e.source_id}`)) || null, e.narration, e.status,
            e.reversed_by !== null, reversalIds.has(e.id), l.line_no, account?.code ?? null, account?.name ?? null,
            l.party_id ? (parties.get(l.party_id)?.name ?? null) : null, debit, credit, e.posted_by ? (users.get(e.posted_by) ?? null) : null, e.posted_at,
          ];
        }
        stats.debit += dr;
        stats.credit += cr;
        if (dr !== cr) stats.unbalanced.push(e.entry_no);
      }
    },
    expectedRows: () => countRows(ctx, lineCount),
    footer: () => [[null, null, null, null, 'Total', null, null, null, null, null, null, null, fromScaled(stats.debit, 2), fromScaled(stats.credit, 2), null, null]],
  };
}

/** Per party: opening balance (entries before the year), the year's debits and credits, and the closing balance. Debit-positive. */
export function partyLedgerTable(ctx: Ctx, lk: Lookups): ExportTable {
  const spec: PagedSpec = {
    from: 'journal_lines',
    select: 'id, party_id, debit::text, credit::text, journal_entries!inner(entry_date, status)',
    order: ['id'], dateColumn: 'journal_entries.entry_date', range: { to: ctx.fy.to },
    filter: (q) => q.not('party_id', 'is', null).eq('journal_entries.status', 'posted'),
  };
  return memoryTable({
    name: 'Party ledger',
    description: `Each party's balance: before ${ctx.fy.from}, the year's debits and credits, and the closing balance on ${ctx.fy.to}. Positive is owed by the party, negative is owed to the party.`,
    columns: [
      col('party', 'Party', 'text', 34), col('type', 'Type', 'text', 10), col('opening', 'Opening balance (Dr+ / Cr-)', 'money', 20), col('debit', 'Debits in year', 'money'),
      col('credit', 'Credits in year', 'money'), col('closing', 'Closing balance (Dr+ / Cr-)', 'money', 20), col('side', 'Closing side', 'text', 8),
    ],
    async *rows() {
      const totals = new Map<string, { open: bigint; dr: bigint; cr: bigint }>();
      for await (const l of readPaged<{ party_id: string; debit: string; credit: string; journal_entries: { entry_date: string } }>(ctx, spec)) {
        const t = totals.get(l.party_id) ?? { open: 0n, dr: 0n, cr: 0n };
        const dr = toScaled(m2(l.debit) ?? '0.00', 2);
        const cr = toScaled(m2(l.credit) ?? '0.00', 2);
        if (l.journal_entries.entry_date < ctx.fy.from) t.open += dr - cr;
        else { t.dr += dr; t.cr += cr; }
        totals.set(l.party_id, t);
      }
      for (const p of await lk.partyRows()) {
        const t = totals.get(p.id) ?? { open: 0n, dr: 0n, cr: 0n };
        const closing = t.open + t.dr - t.cr;
        yield [p.name, p.type, fromScaled(t.open, 2), fromScaled(t.dr, 2), fromScaled(t.cr, 2), fromScaled(closing, 2), closing > 0n ? 'Dr' : closing < 0n ? 'Cr' : null];
      }
    },
    expected: async () => (await lk.partyRows()).length,
  });
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

const TOTAL_COLUMNS = [
  col('taxable_total', 'Taxable value', 'money'), col('cgst_total', 'CGST', 'money'), col('sgst_total', 'SGST', 'money'), col('igst_total', 'IGST', 'money'),
  col('round_off', 'Round off', 'money'), col('grand_total', 'Grand total', 'money'),
];
const totalsCells = (r: Record<string, unknown>): ExportRow => [m2(r.taxable_total), m2(r.cgst_total), m2(r.sgst_total), m2(r.igst_total), m2(r.round_off), m2(r.grand_total)];
const TOTALS_SELECT = 'taxable_total::text, cgst_total::text, sgst_total::text, igst_total::text, round_off::text, grand_total::text';

const LINE_TAX_COLUMNS = [col('taxable_value', 'Taxable value', 'money'), col('gst_rate', 'GST %', 'money', 8), col('cgst_amt', 'CGST', 'money'), col('sgst_amt', 'SGST', 'money'), col('igst_amt', 'IGST', 'money')];
const LINE_TAX_SELECT = 'taxable_value::text, gst_rate::text, cgst_amt::text, sgst_amt::text, igst_amt::text';
const lineTaxCells = (l: Record<string, unknown>): ExportRow => [m2(l.taxable_value), m2(l.gst_rate), m2(l.cgst_amt), m2(l.sgst_amt), m2(l.igst_amt)];

const notDraft = (parent?: string) => (q: Parameters<NonNullable<PagedSpec['filter']>>[0]) => q.neq(parent ? `${parent}.status` : 'status', 'draft');

type Row = Record<string, unknown>;

interface Refs { docs: Map<string, string>; warehouses: Map<string, { name: string }> }

/** Header sheet + line sheet for one kind of invoice or note. */
interface DocKind {
  table: string;
  lineTable: string;
  numberColumn: string;
  dateColumn: string;
  title: string;
  lineTitle: string;
  noun: string;
  /** 'snapshot': only the GSTIN saved on the document (empty = unregistered buyer). 'master': the party master today (the document keeps none). */
  gstin: 'snapshot' | 'master';
  extraColumns: ReturnType<typeof col>[];
  extraSelect: string;
  extraCells: (r: Row, refs: Refs) => ExportRow;
  lineQtyColumns: ReturnType<typeof col>[];
  lineSelect: string;
  lineCells: (l: Row) => ExportRow;
}

function docTables(ctx: Ctx, lk: Lookups, k: DocKind): [ExportTable, ExportTable] {
  const range = { from: ctx.fy.from, to: ctx.fy.to };
  const headerSpec: PagedSpec = {
    from: k.table,
    select: `id, ${k.numberColumn}, ${k.dateColumn}, status, party_id, place_of_supply, ${TOTALS_SELECT}, ${k.extraSelect}, created_at`,
    order: [k.dateColumn, k.numberColumn, 'id'], dateColumn: k.dateColumn, range, filter: notDraft(),
  };
  const header = queryTable<Row>(ctx, {
    name: k.title,
    description: `Every ${k.noun} dated in ${ctx.fy.label} with its totals and tax split, cancelled ones included and flagged. Party names are today's names in the party master.`,
    columns: [
      col('doc_no', 'Number', 'text', 18), col('doc_date', 'Date', 'date'), col('status', 'Status', 'text', 10), col('party', 'Party', 'text', 32), col('party_gstin', k.gstin === 'snapshot' ? 'Party GSTIN (on document)' : 'Party GSTIN (master today)', 'text', 22),
      col('place_of_supply', 'Place of supply', 'text', 9), ...TOTAL_COLUMNS, ...k.extraColumns, col('created_at', 'Created', 'datetime'),
    ],
    spec: headerSpec,
    async map(r) {
      const [parties, docs, warehouses] = await Promise.all([lk.parties(), lk.docNumbers(), lk.warehouses()]);
      const party = parties.get(String(r.party_id));
      return [[
        txt(r[k.numberColumn]), txt(r[k.dateColumn]), txt(r.status), party?.name ?? null, k.gstin === 'snapshot' ? txt(r.buyer_gstin) : (party?.gstin ?? null), txt(r.place_of_supply),
        ...totalsCells(r), ...k.extraCells(r, { docs, warehouses }), txt(r.created_at),
      ]];
    },
  });

  const parent = k.table;
  const lineSpec: PagedSpec = {
    from: k.lineTable,
    select: `id, line_no, item_name, hsn_code, uom, ${k.lineSelect}, ${LINE_TAX_SELECT}, ${parent}!inner(${k.numberColumn}, ${k.dateColumn}, status)`,
    order: [`${parent}(${k.dateColumn})`, `${parent}(${k.numberColumn})`, 'line_no', 'id'],
    dateColumn: `${parent}.${k.dateColumn}`, range, filter: notDraft(parent),
  };
  const lines = queryTable<Row>(ctx, {
    name: k.lineTitle,
    description: `The lines of those ${k.noun}s with the item name, HSN, unit and GST rate as they were when the document was posted.`,
    columns: [
      col('doc_no', 'Number', 'text', 18), col('doc_date', 'Date', 'date'), col('doc_status', 'Document status', 'text', 10), col('line_no', 'Line', 'int'),
      col('item_name', 'Item (as posted)', 'text', 32), col('hsn_code', 'HSN', 'text', 10), col('uom', 'Unit', 'text', 7), ...k.lineQtyColumns, ...LINE_TAX_COLUMNS,
    ],
    spec: lineSpec,
    map(l) {
      const p = l[parent] as Row;
      return [[txt(p[k.numberColumn]), txt(p[k.dateColumn]), txt(p.status), l.line_no as number, txt(l.item_name), txt(l.hsn_code), txt(l.uom), ...k.lineCells(l), ...lineTaxCells(l)]];
    },
  });
  return [header, lines];
}

const invoiceLineQty = [col('qty', 'Quantity', 'qty'), col('alt_qty', 'Alternate quantity', 'qty'), col('rate', 'Rate', 'rate'), col('discount_pct', 'Discount %', 'money', 9)];
const invoiceLineCells = (l: Row): ExportRow => [q3(l.qty), q3(l.alt_qty), r4(l.rate), m2(l.discount_pct)];
const invoiceLineSelect = 'qty::text, alt_qty::text, rate::text, discount_pct::text';
const noteLineQty = [col('qty', 'Quantity', 'qty'), col('rate', 'Rate', 'rate')];
const noteLineCells = (l: Row): ExportRow => [q3(l.qty), r4(l.rate)];
const noteLineSelect = 'qty::text, rate::text';

export function salesInvoiceTables(ctx: Ctx, lk: Lookups) {
  return docTables(ctx, lk, {
    table: 'sales_invoices', lineTable: 'sales_invoice_lines', numberColumn: 'invoice_no', dateColumn: 'invoice_date',
    title: 'Sales invoices', lineTitle: 'Sales invoice lines', noun: 'sales invoice', gstin: 'snapshot',
    extraColumns: [col('warehouse', 'Godown', 'text', 16), col('vehicle_no', 'Vehicle', 'text', 12), col('transporter_name', 'Transporter', 'text', 20), col('ewb_no', 'E-way bill', 'text', 14), col('irn', 'IRN', 'text', 20)],
    extraSelect: 'buyer_gstin, warehouse_id, vehicle_no, transporter_name, ewb_no, irn',
    extraCells: (r, refs) => [refs.warehouses.get(String(r.warehouse_id))?.name ?? null, txt(r.vehicle_no), txt(r.transporter_name), txt(r.ewb_no), txt(r.irn)],
    lineQtyColumns: invoiceLineQty, lineSelect: invoiceLineSelect, lineCells: invoiceLineCells,
  });
}

export function purchaseInvoiceTables(ctx: Ctx, lk: Lookups) {
  return docTables(ctx, lk, {
    table: 'purchase_invoices', lineTable: 'purchase_invoice_lines', numberColumn: 'invoice_no', dateColumn: 'invoice_date',
    title: 'Purchase invoices', lineTitle: 'Purchase invoice lines', noun: 'purchase invoice', gstin: 'master',
    extraColumns: [
      col('supplier_bill_no', 'Supplier bill no', 'text', 18), col('supplier_bill_date', 'Supplier bill date', 'date'), col('rcm', 'Reverse charge', 'bool'),
      col('itc_eligible', 'ITC eligible', 'bool'), col('warehouse', 'Godown', 'text', 16), col('vehicle_no', 'Vehicle', 'text', 12), col('transporter_name', 'Transporter', 'text', 20),
    ],
    extraSelect: 'supplier_bill_no, supplier_bill_date, rcm, itc_eligible, warehouse_id, vehicle_no, transporter_name',
    extraCells: (r, refs) => [txt(r.supplier_bill_no), txt(r.supplier_bill_date), r.rcm === true, r.itc_eligible === true, refs.warehouses.get(String(r.warehouse_id))?.name ?? null, txt(r.vehicle_no), txt(r.transporter_name)],
    lineQtyColumns: invoiceLineQty, lineSelect: invoiceLineSelect, lineCells: invoiceLineCells,
  });
}

export function creditNoteTables(ctx: Ctx, lk: Lookups) {
  return docTables(ctx, lk, {
    table: 'credit_notes', lineTable: 'credit_note_lines', numberColumn: 'note_no', dateColumn: 'note_date',
    title: 'Credit notes', lineTitle: 'Credit note lines', noun: 'credit note', gstin: 'snapshot',
    extraColumns: [col('against', 'Against invoice', 'text', 18), col('reason', 'Reason', 'text', 30), col('stock_effect', 'Goods returned', 'bool')],
    extraSelect: 'buyer_gstin, against_invoice_id, reason, stock_effect',
    extraCells: (r, refs) => [r.against_invoice_id ? (refs.docs.get(`sales_invoice:${r.against_invoice_id}`) ?? null) : null, txt(r.reason), r.stock_effect === true],
    lineQtyColumns: noteLineQty, lineSelect: noteLineSelect, lineCells: noteLineCells,
  });
}

export function debitNoteTables(ctx: Ctx, lk: Lookups) {
  return docTables(ctx, lk, {
    table: 'debit_notes', lineTable: 'debit_note_lines', numberColumn: 'note_no', dateColumn: 'note_date',
    title: 'Debit notes', lineTitle: 'Debit note lines', noun: 'debit note', gstin: 'master',
    extraColumns: [col('against', 'Against invoice', 'text', 18), col('reason', 'Reason', 'text', 30), col('stock_effect', 'Goods returned', 'bool')],
    extraSelect: 'against_invoice_id, reason, stock_effect',
    extraCells: (r, refs) => [r.against_invoice_id ? (refs.docs.get(`purchase_invoice:${r.against_invoice_id}`) ?? null) : null, txt(r.reason), r.stock_effect === true],
    lineQtyColumns: noteLineQty, lineSelect: noteLineSelect, lineCells: noteLineCells,
  });
}

// ---------------------------------------------------------------------------------------------
// Money in and out
// ---------------------------------------------------------------------------------------------

export function paymentsTable(ctx: Ctx, lk: Lookups): ExportTable {
  const range = { from: ctx.fy.from, to: ctx.fy.to };
  return queryTable<Row>(ctx, {
    name: 'Payments',
    description: `Receipts from customers and payments to suppliers dated in ${ctx.fy.label}: mode, reference, cheque status and any discount allowed.`,
    columns: [
      col('voucher_no', 'Voucher no', 'text', 16), col('payment_date', 'Date', 'date'), col('direction', 'Direction', 'text', 9), col('status', 'Status', 'text', 10), col('party', 'Party', 'text', 32),
      col('mode', 'Mode', 'text', 8), col('instrument_no', 'Reference / cheque no', 'text', 18), col('instrument_date', 'Instrument date', 'date'), col('amount', 'Amount', 'money'),
      col('discount', 'Discount', 'money'), col('account', 'Cash / bank account', 'text', 24), col('cheque_status', 'Cheque status', 'text', 11), col('cheque_bank', 'Cheque bank', 'text', 16),
      col('deposited_on', 'Deposited on', 'date'), col('cleared_on', 'Cleared on', 'date'), col('bounced_on', 'Bounced on', 'date'), col('note', 'Note', 'text', 30),
    ],
    spec: {
      from: 'payments',
      select: 'id, voucher_no, payment_date, direction, status, party_id, mode, instrument_no, instrument_date, amount::text, discount::text, account_id, cheque_status, cheque_bank, deposited_on, cleared_on, bounced_on, note',
      order: ['payment_date', 'voucher_no', 'id'], dateColumn: 'payment_date', range, filter: notDraft(),
    },
    async map(r) {
      const [parties, accounts] = await Promise.all([lk.parties(), lk.accounts()]);
      return [[
        txt(r.voucher_no), txt(r.payment_date), txt(r.direction), txt(r.status), parties.get(String(r.party_id))?.name ?? null, txt(r.mode), txt(r.instrument_no), txt(r.instrument_date),
        m2(r.amount), m2(r.discount), accounts.get(String(r.account_id))?.name ?? null, txt(r.cheque_status), txt(r.cheque_bank), txt(r.deposited_on), txt(r.cleared_on), txt(r.bounced_on), txt(r.note),
      ]];
    },
  });
}

export function allocationsTable(ctx: Ctx, lk: Lookups): ExportTable {
  return queryTable<Row>(ctx, {
    name: 'Allocations',
    description: 'Which invoice each receipt or payment was set against, and how much.',
    columns: [
      col('voucher_no', 'Voucher no', 'text', 16), col('payment_date', 'Date', 'date'), col('direction', 'Direction', 'text', 9), col('payment_status', 'Payment status', 'text', 10), col('party', 'Party', 'text', 32),
      col('invoice_type', 'Against', 'text', 16), col('invoice_no', 'Invoice no', 'text', 18), col('amount', 'Amount allocated', 'money'),
    ],
    spec: {
      from: 'payment_allocations',
      select: 'id, invoice_type, invoice_id, amount::text, payments!inner(voucher_no, payment_date, direction, status, party_id)',
      order: ['payments(payment_date)', 'payments(voucher_no)', 'id'], dateColumn: 'payments.payment_date', range: { from: ctx.fy.from, to: ctx.fy.to }, filter: notDraft('payments'),
    },
    async map(r) {
      const [parties, docs] = await Promise.all([lk.parties(), lk.docNumbers()]);
      const p = r.payments as Row;
      return [[
        txt(p.voucher_no), txt(p.payment_date), txt(p.direction), txt(p.status), parties.get(String(p.party_id))?.name ?? null, txt(r.invoice_type),
        docs.get(`${r.invoice_type}:${r.invoice_id}`) ?? null, m2(r.amount),
      ]];
    },
  });
}

export function cashDepositsTable(ctx: Ctx, lk: Lookups): ExportTable {
  return queryTable<Row>(ctx, {
    name: 'Cash deposits',
    description: 'Cash taken from the till to the bank.',
    columns: [col('deposit_date', 'Date', 'date'), col('amount', 'Amount', 'money'), col('reference', 'Reference', 'text', 20), col('note', 'Note', 'text', 30), col('status', 'Status', 'text', 10), col('created_by', 'Entered by', 'text', 16)],
    spec: {
      from: 'cash_deposits', select: 'id, deposit_date, amount::text, reference, note, status, created_by', order: ['deposit_date', 'id'],
      dateColumn: 'deposit_date', range: { from: ctx.fy.from, to: ctx.fy.to }, filter: notDraft(),
    },
    async map(r) {
      const users = await lk.users();
      return [[txt(r.deposit_date), m2(r.amount), txt(r.reference), txt(r.note), txt(r.status), r.created_by ? (users.get(String(r.created_by)) ?? null) : null]];
    },
  });
}

export function expenseVouchersTable(ctx: Ctx, lk: Lookups): ExportTable {
  const range = { from: ctx.fy.from, to: ctx.fy.to };
  return queryTable<Row>(ctx, {
    name: 'Expense vouchers',
    description: `Expense, salary and wage vouchers dated in ${ctx.fy.label}, one row per voucher line.`,
    columns: [
      col('voucher_no', 'Voucher no', 'text', 16), col('voucher_date', 'Date', 'date'), col('status', 'Status', 'text', 10), col('voucher_type', 'Type', 'text', 12), col('voucher_party', 'Paid to / for', 'text', 28),
      col('pay_account', 'Paid from', 'text', 22), col('line_no', 'Line', 'int'), col('account_code', 'Expense code', 'text', 11), col('account_name', 'Expense account', 'text', 28),
      col('line_party', 'Line party', 'text', 26), col('amount', 'Amount', 'money'), col('narration', 'Narration', 'text', 34), col('rcm', 'Reverse charge', 'bool'), col('advance_recovered', 'Advance recovered (voucher)', 'money'),
    ],
    spec: {
      from: 'expense_voucher_lines',
      select: 'id, line_no, account_id, party_id, amount::text, narration, rcm, expense_vouchers!inner(voucher_no, voucher_date, status, voucher_type, party_id, pay_account_id, advance_recovered::text)',
      order: ['expense_vouchers(voucher_date)', 'expense_vouchers(voucher_no)', 'line_no', 'id'], dateColumn: 'expense_vouchers.voucher_date', range, filter: notDraft('expense_vouchers'),
    },
    async map(r) {
      const [parties, accounts] = await Promise.all([lk.parties(), lk.accounts()]);
      const v = r.expense_vouchers as Row;
      const account = accounts.get(String(r.account_id));
      return [[
        txt(v.voucher_no), txt(v.voucher_date), txt(v.status), txt(v.voucher_type), v.party_id ? (parties.get(String(v.party_id))?.name ?? null) : null,
        v.pay_account_id ? (accounts.get(String(v.pay_account_id))?.name ?? null) : null, r.line_no as number, account?.code ?? null, account?.name ?? null,
        r.party_id ? (parties.get(String(r.party_id))?.name ?? null) : null, m2(r.amount), txt(r.narration), r.rcm === true, m2(v.advance_recovered),
      ]];
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------

interface MovementRow { id: string; item_id: string; warehouse_id: string; movement_date: string; qty: string; source_type: string; source_id: string | null; reversal_of: string | null }

const movementSpec = (ctx: Ctx, from?: string): PagedSpec => ({
  // rate/value are owner-only columns the database hands out through stock_movement_cost() alone.
  from: 'stock_movements',
  select: 'id, item_id, warehouse_id, movement_date, qty::text, source_type, source_id, reversal_of',
  order: ['movement_date', 'id'], dateColumn: 'movement_date', range: { ...(from ? { from } : {}), to: ctx.fy.to },
});

/** Cost per movement id: [rate, value]. Every movement has a row for an owner at aal2; a gap is an error, not a zero. */
async function movementCosts(ctx: Ctx): Promise<Map<string, { rate: string; value: string }>> {
  const out = new Map<string, { rate: string; value: string }>();
  for await (const r of readRpcPaged<{ movement_id: string; rate: string; value: string }>(ctx.supabase, 'stock_movement_cost', 'movement_id, rate::text, value::text', ['movement_id'])) {
    out.set(r.movement_id, { rate: r4(r.rate) ?? '0.0000', value: m2(r.value) ?? '0.00' });
  }
  return out;
}

export function stockMovementsTable(ctx: Ctx, lk: Lookups): ExportTable {
  const spec = movementSpec(ctx, ctx.fy.from);
  return {
    name: 'Stock movements',
    description: `Every stock movement dated in ${ctx.fy.label}: quantity in or out, the rate and the value, with reversals flagged.`,
    columns: [
      col('movement_date', 'Date', 'date'), col('item', 'Item', 'text', 32), col('uom', 'Unit', 'text', 7), col('warehouse', 'Godown', 'text', 16), col('source_type', 'Source', 'text', 16),
      col('doc_no', 'Document no', 'text', 18), col('is_reversal', 'Is a reversal', 'bool'), col('qty_in', 'Quantity in', 'qty'), col('qty_out', 'Quantity out', 'qty'), col('rate', 'Rate', 'rate'), col('value', 'Value (in +, out -)', 'money'),
    ],
    async *rows() {
      const [items, warehouses, docs, costs] = await Promise.all([lk.items(), lk.warehouses(), lk.docNumbers(), movementCosts(ctx)]);
      for await (const m of readPaged<MovementRow>(ctx, spec)) {
        const cost = costs.get(m.id);
        if (!cost) throw new Error(`export: no stock cost for movement ${m.id}`);
        const qty = q3(m.qty) ?? '0.000';
        const out = qty.startsWith('-');
        const item = items.get(m.item_id);
        yield [
          m.movement_date, item?.name ?? null, item?.base_uom ?? null, warehouses.get(m.warehouse_id)?.name ?? null, m.source_type, (m.source_id && docs.get(`${m.source_type}:${m.source_id}`)) || null,
          m.reversal_of !== null, out ? null : qty, out ? qty.slice(1) : null, cost.rate, cost.value,
        ];
      }
    },
    expectedRows: () => countRows(ctx, spec),
  };
}

/** Quantity and value on hand per item and godown on the last day of the year, from every movement up to that day. */
export function stockOnHandTable(ctx: Ctx, lk: Lookups): ExportTable {
  const spec = movementSpec(ctx);
  return memoryTable({
    name: 'Stock on hand',
    description: `What was in stock on ${ctx.fy.to}, per item and godown, summed from every stock movement up to that day. Average rate is value divided by quantity.`,
    columns: [
      col('item', 'Item', 'text', 32), col('uom', 'Unit', 'text', 7), col('warehouse', 'Godown', 'text', 16), col('in_transit', 'In transit', 'bool'),
      col('qty', 'Quantity', 'qty'), col('avg_rate', 'Average rate', 'rate'), col('value', 'Value', 'money'),
    ],
    async *rows() {
      const [items, warehouses, costs] = await Promise.all([lk.items(), lk.warehouses(), movementCosts(ctx)]);
      const sums = new Map<string, { item: string; wh: string; qty: bigint; value: bigint }>();
      for await (const m of readPaged<MovementRow>(ctx, spec)) {
        const cost = costs.get(m.id);
        if (!cost) throw new Error(`export: no stock cost for movement ${m.id}`);
        const key = `${m.item_id}:${m.warehouse_id}`;
        const s = sums.get(key) ?? { item: m.item_id, wh: m.warehouse_id, qty: 0n, value: 0n };
        s.qty += toScaled(q3(m.qty) ?? '0.000', 3);
        s.value += toScaled(cost.value, 2);
        sums.set(key, s);
      }
      const named = [...sums.values()]
        .filter((s) => s.qty !== 0n || s.value !== 0n)
        .map((s) => ({ ...s, itemName: items.get(s.item)?.name ?? '', whName: warehouses.get(s.wh)?.name ?? '' }))
        .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.whName.localeCompare(b.whName));
      for (const s of named) {
        yield [s.itemName, items.get(s.item)?.base_uom ?? null, s.whName, warehouses.get(s.wh)?.is_transit ?? false, fromScaled(s.qty, 3), divideDecimal(s.value, s.qty, 2, 3, 4), fromScaled(s.value, 2)];
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// GST, day closes, bank statement lines
// ---------------------------------------------------------------------------------------------

export function gstMonthlyTable(ctx: Ctx, gst: Extract<GstBundle, { ok: true }>): ExportTable {
  return memoryTable({
    name: 'GST monthly (3B)',
    description: 'For each month: taxable value and tax by GSTR-3B row (output tax, input tax credit), and the ledger figure it is compared with. These are the figures the GST screens show.',
    columns: [col('month', 'Month', 'text', 9), col('row', 'GSTR-3B row', 'text', 10), col('what', 'What', 'text', 52), col('taxable', 'Taxable value', 'money'), col('igst', 'IGST', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money')],
    async rows() {
      return gst.months.flatMap((m) => m.rows3b.map((r): ExportRow => [m.month, r.key, gstLabel(r.key), m2(r.taxable), m2(r.igst), m2(r.cgst), m2(r.sgst)]));
    },
    expected: async () => gst.months.reduce((n, m) => n + m.rows3b.length, 0),
  });
}

export function gstHsnTable(ctx: Ctx, gst: Extract<GstBundle, { ok: true }>): ExportTable {
  return memoryTable({
    name: 'GSTR-1 HSN summary',
    description: 'For each month: outward supplies by HSN code and rate, split between business (B2B) and consumer (B2C) buyers, as the GSTR-1 file reports them.',
    columns: [
      col('month', 'Month', 'text', 9), col('section', 'Buyers', 'text', 8), col('hsn', 'HSN', 'text', 10), col('description', 'Description', 'text', 30), col('uqc', 'Unit code', 'text', 9),
      col('qty', 'Quantity', 'qty'), col('rate', 'GST %', 'money', 8), col('taxable', 'Taxable value', 'money'), col('igst', 'IGST', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'),
    ],
    async rows() {
      return gst.months.flatMap((m) => m.hsn.map((h): ExportRow => [m.month, h.section.toUpperCase(), h.hsn, h.description, h.uqc, h.qty, h.rate, h.taxable, h.igst, h.cgst, h.sgst]));
    },
    expected: async () => gst.months.reduce((n, m) => n + m.hsn.length, 0),
  });
}

export function dayClosesTable(ctx: Ctx, lk: Lookups): ExportTable {
  return queryTable<Row>(ctx, {
    name: 'Day closes',
    description: 'The daily cash count: opening cash, cash in and out, deposits, what the books expected, what was counted and the difference.',
    columns: [
      col('close_date', 'Date', 'date'), col('status', 'Status', 'text', 10), col('opening_cash', 'Opening cash', 'money'), col('cash_in', 'Cash in', 'money'), col('cash_out', 'Cash out', 'money'),
      col('deposited', 'Deposited', 'money'), col('expected', 'Expected', 'money'), col('counted', 'Counted', 'money'), col('difference', 'Difference', 'money'), col('note', 'Note', 'text', 30),
      col('closed_by', 'Closed by', 'text', 16), col('closed_at', 'Closed at', 'datetime'),
    ],
    spec: {
      from: 'day_closes',
      select: 'id, close_date, status, opening_cash::text, cash_in::text, cash_out::text, deposited::text, expected::text, counted::text, difference::text, note, closed_by, closed_at',
      order: ['close_date', 'id'], dateColumn: 'close_date', range: { from: ctx.fy.from, to: ctx.fy.to },
    },
    async map(r) {
      const users = await lk.users();
      return [[
        txt(r.close_date), txt(r.status), m2(r.opening_cash), m2(r.cash_in), m2(r.cash_out), m2(r.deposited), m2(r.expected), m2(r.counted), m2(r.difference), txt(r.note),
        r.closed_by ? (users.get(String(r.closed_by)) ?? null) : null, txt(r.closed_at),
      ]];
    },
  });
}

export function bankLinesTable(ctx: Ctx, lk: Lookups): ExportTable {
  return queryTable<Row>(ctx, {
    name: 'Bank statement lines',
    description: 'The imported bank statement lines dated in the year, with whether each is matched to a book entry, left unmatched or ignored.',
    columns: [
      col('account', 'Bank account', 'text', 22), col('source_file', 'Statement file', 'text', 24), col('line_no', 'Line', 'int'), col('txn_date', 'Date', 'date'), col('value_date', 'Value date', 'date'),
      col('narration', 'Narration', 'text', 44), col('reference', 'Reference', 'text', 18), col('debit', 'Withdrawal', 'money'), col('credit', 'Deposit', 'money'), col('balance', 'Balance', 'money'),
      col('match_status', 'Match status', 'text', 11), col('matched_payment', 'Matched payment', 'text', 16), col('ignore_reason', 'Reason ignored', 'text', 28),
    ],
    spec: {
      from: 'bank_statement_lines',
      select: 'id, line_no, txn_date, value_date, narration, reference, debit::text, credit::text, balance::text, match_status, ignore_reason, account_id, bank_statements(source_file), payments(voucher_no)',
      order: ['txn_date', 'statement_id', 'line_no', 'id'], dateColumn: 'txn_date', range: { from: ctx.fy.from, to: ctx.fy.to },
    },
    async map(r) {
      const accounts = await lk.accounts();
      return [[
        accounts.get(String(r.account_id))?.name ?? null, txt((r.bank_statements as Row | null)?.source_file), r.line_no as number, txt(r.txn_date), txt(r.value_date), txt(r.narration), txt(r.reference),
        m2(r.debit), m2(r.credit), m2(r.balance), txt(r.match_status), txt((r.payments as Row | null)?.voucher_no), txt(r.ignore_reason),
      ]];
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The workbook's table list, in sheet order (after the README)
// ---------------------------------------------------------------------------------------------

export interface BooksTables {
  tables: ExportTable[];
  journalStats: JournalStats;
  /** Sheets left out, and why (shown on the README). */
  skipped: { sheet: string; reason: string }[];
}

export function buildBooksTables(ctx: Ctx, prep: BooksPrep): BooksTables {
  const lk = new Lookups(ctx);
  const journalStats = newJournalStats();
  const [sales, salesLines] = salesInvoiceTables(ctx, lk);
  const [purchases, purchaseLines] = purchaseInvoiceTables(ctx, lk);
  const [credits, creditLines] = creditNoteTables(ctx, lk);
  const [debits, debitLines] = debitNoteTables(ctx, lk);
  const skipped: BooksTables['skipped'] = [];
  const gst: ExportTable[] = [];
  if (prep.gst.ok) gst.push(gstMonthlyTable(ctx, prep.gst), gstHsnTable(ctx, prep.gst));
  else skipped.push({ sheet: 'GST monthly (3B), GSTR-1 HSN summary', reason: prep.gst.reason });

  const tables = [
    accountsTable(ctx, lk), trialBalanceTable(ctx, prep.trialBalance), journalTable(ctx, lk, journalStats), partyLedgerTable(ctx, lk), partiesTable(ctx, lk),
    sales, salesLines, purchases, purchaseLines, credits, creditLines, debits, debitLines,
    paymentsTable(ctx, lk), allocationsTable(ctx, lk), cashDepositsTable(ctx, lk), expenseVouchersTable(ctx, lk),
    stockMovementsTable(ctx, lk), stockOnHandTable(ctx, lk), itemsTable(ctx, lk), warehousesTable(ctx, lk),
    ...gst, dayClosesTable(ctx, lk), bankLinesTable(ctx, lk),
  ];
  return { tables, journalStats, skipped };
}

