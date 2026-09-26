import 'server-only';
import ExcelJS from 'exceljs';
import type { BalanceSheet, Gstr3bRow, Pnl, TrialBalance } from '@/lib/books-data';
import type { Gstr1Data } from '@/lib/gstr1-file';
import { formatDate } from '@/lib/format';
import { DATE, MONEY, finish, headerRow, isoDate, num, start, type Translate } from './xlsx';

// Workbooks for the self-audit screens (change 18). Same rule as xlsx.ts: numbers as numbers, dates as
// dates, nothing recomputed — the GSTR-1 workbook lays out the portal sections the database built.

const asDate = (ddmmyyyy: string) => {
  const [d, m, y] = ddmmyyyy.split('-');
  return isoDate(`${y}-${m}-${d}`);
};
const n = (v: unknown) => Number(v ?? 0);

export async function buildTrialBalanceWorkbook(tb: TrialBalance, asAt: string, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [t('asAt', { date: formatDate(asAt) })]);
  headerRow(s.ws, [t('colCode'), t('colAccount'), t('colDebit'), t('colCredit')]);
  for (const r of tb.rows) {
    const row = s.ws.addRow([r.code, r.name, num(r.debit) || null, num(r.credit) || null]);
    row.getCell(3).numFmt = MONEY; row.getCell(4).numFmt = MONEY;
  }
  const total = s.ws.addRow(['', t('total'), num(tb.totalDebit), num(tb.totalCredit)]);
  total.font = { bold: true };
  total.getCell(3).numFmt = MONEY; total.getCell(4).numFmt = MONEY;
  s.ws.columns = [{ width: 10 }, { width: 38 }, { width: 18 }, { width: 18 }];
  return finish(s);
}

export async function buildPnlWorkbook(p: Pnl, range: { from: string; to: string }, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [`${formatDate(range.from)} – ${formatDate(range.to)}`]);
  headerRow(s.ws, [t('colCode'), t('colAccount'), t('colAmount')]);
  const block = (label: string, list: { code: string | null; name: string; amount: string }[], total: string) => {
    s.ws.addRow([label]).font = { bold: true };
    for (const r of list) s.ws.addRow([r.code ?? '', r.name, num(r.amount)]).getCell(3).numFmt = MONEY;
    const row = s.ws.addRow(['', label, num(total)]);
    row.font = { bold: true };
    row.getCell(3).numFmt = MONEY;
  };
  block(t('income'), p.income, p.totalIncome);
  block(t('expenses'), p.expenses, p.totalExpenses);
  const net = s.ws.addRow(['', t('net'), num(p.net)]);
  net.font = { bold: true };
  net.getCell(3).numFmt = MONEY;
  s.ws.columns = [{ width: 10 }, { width: 38 }, { width: 18 }];
  return finish(s);
}

export async function buildBalanceSheetWorkbook(b: BalanceSheet, asAt: string, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [t('asAt', { date: formatDate(asAt) })]);
  headerRow(s.ws, [t('colCode'), t('colAccount'), t('colAmount')]);
  const block = (label: string, list: { code: string | null; name: string; amount: string; isProfit?: boolean }[], total: string) => {
    s.ws.addRow([label]).font = { bold: true };
    for (const r of list) s.ws.addRow([r.code ?? '', r.isProfit ? t('profitRow') : r.name, num(r.amount)]).getCell(3).numFmt = MONEY;
    const row = s.ws.addRow(['', label, num(total)]);
    row.font = { bold: true };
    row.getCell(3).numFmt = MONEY;
  };
  block(t('assets'), b.assets, b.totalAssets);
  block(t('liabilities'), b.liabilities, b.totalLiabilities);
  block(t('equity'), b.equity, b.totalEquity);
  const check = s.ws.addRow(['', t('liabilitiesEquity'), num(b.totalLiabilitiesEquity)]);
  check.font = { bold: true };
  check.getCell(3).numFmt = MONEY;
  s.ws.columns = [{ width: 10 }, { width: 44 }, { width: 18 }];
  return finish(s);
}

/** Label for a 3B row key: `3.2:36` becomes the 3.2 label plus the place of supply code. */
export const gstr3bLabel = (t: Translate, key: string): string =>
  key.startsWith('3.2:') ? `${t('rows.3.2')} ${key.slice(4)}` : t.has(`rows.${key}`) ? t(`rows.${key}`) : key;

export async function buildGstr3bWorkbook(list: Gstr3bRow[], period: string, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [t('period', { period }), t('summaryOnly')]);
  headerRow(s.ws, [t('colRow'), t('colTaxable'), t('colIgst'), t('colCgst'), t('colSgst')]);
  for (const r of list) {
    const row = s.ws.addRow([gstr3bLabel(t, r.key), num(r.taxable), num(r.igst), num(r.cgst), num(r.sgst)]);
    for (let c = 2; c <= 5; c++) row.getCell(c).numFmt = MONEY;
  }
  s.ws.columns = [{ width: 58 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 }];
  return finish(s);
}

type Rec = Record<string, unknown>;

/** GSTR-1 as a workbook: one sheet per portal section (b2b, b2cl, b2cs, cdnr, nil, hsn, docs), the same rows as the JSON. */
export async function buildGstr1Workbook(d: Gstr1Data, org: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = org;
  const sheet = (name: string, header: string[], widths: number[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(header).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns = widths.map((width) => ({ width }));
    return ws;
  };
  const money = (row: ExcelJS.Row, cols: number[]) => cols.forEach((c) => (row.getCell(c).numFmt = MONEY));

  const summary = sheet('summary', ['Section', 'Documents', 'Taxable value', 'IGST', 'CGST', 'SGST'], [14, 12, 16, 14, 14, 14]);
  summary.addRow([`GSTR-1 ${d.period}`, '', '', '', '', d.gstin ?? '']).font = { bold: true };
  for (const k of ['b2b', 'b2cl', 'b2cs', 'cdnr', 'nil'] as const) {
    const x = d.summary[k];
    money(summary.addRow([k, x.count, n(x.txval), n(x.iamt), n(x.camt), n(x.samt)]), [3, 4, 5, 6]);
  }
  const totals = summary.addRow(['net total', d.totals.invoices, n(d.totals.taxable), n(d.totals.igst), n(d.totals.cgst), n(d.totals.sgst)]);
  totals.font = { bold: true };
  money(totals, [3, 4, 5, 6]);

  const inv = sheet('b2b', ['GSTIN', 'Invoice no', 'Date', 'Invoice value', 'Place of supply', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST'], [18, 18, 12, 16, 10, 8, 16, 14, 14, 14]);
  for (const c of d.b2b as Rec[]) for (const i of c.inv as Rec[]) for (const it of i.itms as Rec[]) {
    const x = it.itm_det as Rec;
    const row = inv.addRow([c.ctin, i.inum, asDate(String(i.idt)), n(i.val), i.pos, n(x.rt), n(x.txval), n(x.iamt), n(x.camt), n(x.samt)]);
    row.getCell(3).numFmt = DATE;
    money(row, [4, 7, 8, 9, 10]);
  }

  const large = sheet('b2cl', ['Place of supply', 'Invoice no', 'Date', 'Invoice value', 'Rate', 'Taxable value', 'IGST'], [10, 18, 12, 16, 8, 16, 14]);
  for (const g of d.b2cl as Rec[]) for (const i of g.inv as Rec[]) for (const it of i.itms as Rec[]) {
    const x = it.itm_det as Rec;
    const row = large.addRow([g.pos, i.inum, asDate(String(i.idt)), n(i.val), n(x.rt), n(x.txval), n(x.iamt)]);
    row.getCell(3).numFmt = DATE;
    money(row, [4, 6, 7]);
  }

  const small = sheet('b2cs', ['Supply', 'Place of supply', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST'], [10, 10, 8, 16, 14, 14, 14]);
  for (const r of d.b2cs as Rec[]) money(small.addRow([r.sply_ty, r.pos, n(r.rt), n(r.txval), n(r.iamt), n(r.camt), n(r.samt)]), [4, 5, 6, 7]);

  const notes = sheet('cdnr', ['GSTIN', 'Note no', 'Date', 'Type', 'Note value', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST'], [18, 18, 12, 6, 16, 8, 16, 14, 14, 14]);
  for (const c of d.cdnr as Rec[]) for (const nt of c.nt as Rec[]) for (const it of nt.itms as Rec[]) {
    const x = it.itm_det as Rec;
    const row = notes.addRow([c.ctin, nt.nt_num, asDate(String(nt.nt_dt)), nt.ntty, n(nt.val), n(x.rt), n(x.txval), n(x.iamt), n(x.camt), n(x.samt)]);
    row.getCell(3).numFmt = DATE;
    money(row, [5, 7, 8, 9, 10]);
  }

  const nil = sheet('nil', ['Supply', 'Nil rated', 'Exempted', 'Non-GST'], [14, 16, 16, 16]);
  for (const r of d.nil.inv as Rec[]) money(nil.addRow([r.sply_ty, n(r.nil_amt), n(r.expt_amt), n(r.ngsup_amt)]), [2, 3, 4]);

  const hsn = sheet('hsn', ['Table', 'HSN', 'Description', 'UQC', 'Quantity', 'Rate', 'Taxable value', 'IGST', 'CGST', 'SGST'], [10, 12, 32, 8, 14, 8, 16, 14, 14, 14]);
  for (const [table, list] of [['B2B', d.hsn.hsn_b2b], ['B2C', d.hsn.hsn_b2c]] as const) {
    for (const r of list as Rec[]) {
      const row = hsn.addRow([table, r.hsn_sc, r.desc, r.uqc, n(r.qty), n(r.rt), n(r.txval), n(r.iamt), n(r.camt), n(r.samt)]);
      row.getCell(5).numFmt = '#,##0.000';
      money(row, [7, 8, 9, 10]);
    }
  }

  const docs = sheet('docs', ['Nature', 'From', 'To', 'Issued', 'Cancelled', 'Net issued'], [10, 20, 20, 10, 10, 10]);
  for (const g of d.doc_issue.doc_det as Rec[]) for (const r of g.docs as Rec[]) docs.addRow([g.doc_num, r.from, r.to, n(r.totnum), n(r.cancel), n(r.net_issue)]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
