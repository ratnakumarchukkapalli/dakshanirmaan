import 'server-only';
import ExcelJS from 'exceljs';
import type { AgeingReport, CashBook, DayBookRow, StockReport } from '@/lib/reports-data';
import { formatDate } from '@/lib/format';
import { safeCells, stripXmlIllegal } from '@/lib/safe-text';

// The report workbooks (exceljs; the `xlsx` package is banned). Money is written as numbers with a
// number format and dates as dates, never as pre-formatted text, so a sheet can be summed and
// filtered. Every figure is the loader's own value — nothing here is recomputed — and the builders
// take the same data the screens render, so a workbook always equals its screen.

export type Translate = ((key: string, values?: Record<string, string | number>) => string) & { has: (key: string) => boolean };

export const MONEY = '#,##0.00';
const RATE = '#,##0.0000';
const QTY = '#,##0.000';
export const DATE = 'dd-mm-yyyy';
export const isoDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
// A decimal string is written as the number Excel will hold; the string itself is exact.
export const num = (v: string) => Number(v);

export interface Sheet { wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet }

export function start(orgName: string, title: string, sub: string[]): Sheet {
  const wb = new ExcelJS.Workbook();
  wb.creator = stripXmlIllegal(orgName);
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow(safeCells([orgName])).font = { bold: true, size: 14 };
  ws.addRow(safeCells([title])).font = { bold: true };
  for (const line of sub) ws.addRow(safeCells([line]));
  ws.addRow([]);
  return { wb, ws };
}

export const finish = async ({ wb }: Sheet) => Buffer.from(await wb.xlsx.writeBuffer());

export function headerRow(ws: ExcelJS.Worksheet, labels: string[]) {
  const row = ws.addRow(safeCells(labels));
  row.font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: row.number }];
  return row;
}

export const reportFilename = (name: string, suffix: string) => `DN-${name}-${suffix}.xlsx`;

export async function buildAgeingWorkbook(report: AgeingReport, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [t('hint')]);
  headerRow(s.ws, [t('colParty'), t('b0_30'), t('b31_60'), t('b61_90'), t('b90_plus'), t('onAccount'), t('interest'), t('colReceivable')]);
  const push = (cells: (string | number)[], bold = false) => {
    const row = s.ws.addRow(safeCells(cells));
    for (let c = 2; c <= 8; c++) row.getCell(c).numFmt = MONEY;
    if (bold) row.font = { bold: true };
  };
  for (const r of report.rows) push([r.name, num(r.b0_30), num(r.b31_60), num(r.b61_90), num(r.b90_plus), num(r.onAccount), num(r.interest), num(r.receivable)]);
  const x = report.totals;
  push([t('total'), num(x.b0_30), num(x.b31_60), num(x.b61_90), num(x.b90_plus), num(x.onAccount), num(x.interest), num(x.receivable)], true);
  s.ws.columns = [{ width: 34 }, ...Array.from({ length: 7 }, () => ({ width: 15 }))];
  return finish(s);
}

export async function buildStockWorkbook(report: StockReport, isAdmin: boolean, org: string, t: Translate, title: string): Promise<Buffer> {
  const godown = report.selected === 'all' ? t('allGodowns') : (report.godowns.find((g) => g.id === report.selected)?.name ?? '');
  const s = start(org, title, [godown]);
  headerRow(s.ws, [t('colItem'), t('colGodown'), t('colUom'), t('colQty'), ...(isAdmin ? [t('colAvg'), t('colValue')] : [])]);
  for (const r of report.rows) {
    const row = s.ws.addRow(safeCells([r.itemName, r.godown, r.baseUom, num(r.qty), ...(isAdmin ? [r.avgRate === null ? null : num(r.avgRate), r.value === null ? null : num(r.value)] : [])]));
    row.getCell(4).numFmt = QTY;
    if (isAdmin) {
      row.getCell(5).numFmt = RATE;
      row.getCell(6).numFmt = MONEY;
    }
  }
  if (isAdmin && report.totalValue !== null) {
    const row = s.ws.addRow(safeCells([t('total'), '', '', null, null, num(report.totalValue)]));
    row.font = { bold: true };
    row.getCell(6).numFmt = MONEY;
  }
  s.ws.columns = [{ width: 32 }, { width: 18 }, { width: 8 }, { width: 14 }, ...(isAdmin ? [{ width: 14 }, { width: 16 }] : [])];
  return finish(s);
}

export async function buildDayBookWorkbook(rows: DayBookRow[], range: { from: string; to: string }, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, title, [`${formatDate(range.from)} – ${formatDate(range.to)}`]);
  headerRow(s.ws, [t('colDate'), t('colEntry'), t('colDoc'), t('colType'), t('colNarration'), t('colAmount'), t('colFlag')]);
  for (const r of rows) {
    const row = s.ws.addRow(safeCells([
      isoDate(r.date), Number(r.entryNo), r.docNo ?? '', t.has(`types.${r.sourceType}`) ? t(`types.${r.sourceType}`) : r.sourceType, r.narration ?? '', num(r.amount),
      r.isReversal ? t('reversal') : r.isReversed ? t('reversed') : '',
    ]));
    row.getCell(1).numFmt = DATE;
    row.getCell(6).numFmt = MONEY;
  }
  s.ws.columns = [{ width: 12 }, { width: 10 }, { width: 20 }, { width: 20 }, { width: 50 }, { width: 16 }, { width: 12 }];
  return finish(s);
}

export async function buildCashBookWorkbook(book: CashBook, range: { from: string; to: string }, org: string, t: Translate, title: string): Promise<Buffer> {
  const s = start(org, `${title} – ${book.account.name}`, [`${formatDate(range.from)} – ${formatDate(range.to)}`]);
  headerRow(s.ws, [t('colDate'), t('colDoc'), t('colDetails'), t('in'), t('out'), t('colBalance')]);
  const money = (row: ExcelJS.Row) => [4, 5, 6].forEach((c) => (row.getCell(c).numFmt = MONEY));
  const opening = s.ws.addRow(safeCells([isoDate(range.from), t('opening'), '', null, null, num(book.opening)]));
  opening.getCell(1).numFmt = DATE;
  opening.font = { italic: true };
  money(opening);
  for (const r of book.rows) {
    const row = s.ws.addRow(safeCells([
      isoDate(r.date), r.docNo ?? '', [r.narration, r.isReversal ? t('reversal') : null].filter(Boolean).join(' · '),
      num(r.debit) || null, num(r.credit) || null, num(r.balance),
    ]));
    row.getCell(1).numFmt = DATE;
    money(row);
  }
  const closing = s.ws.addRow(safeCells([null, t('closing'), '', num(book.totalIn), num(book.totalOut), num(book.closing)]));
  closing.font = { bold: true };
  money(closing);
  s.ws.columns = [{ width: 12 }, { width: 20 }, { width: 50 }, { width: 15 }, { width: 15 }, { width: 16 }];
  return finish(s);
}
