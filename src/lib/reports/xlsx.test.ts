import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { AgeingReport, CashBook, DayBookRow, StockReport } from '@/lib/reports-data';
import en from '@/messages/en.json';
import { buildAgeingWorkbook, buildCashBookWorkbook, buildDayBookWorkbook, buildStockWorkbook, reportFilename, type Translate } from './xlsx';

vi.mock('server-only', () => ({}));

const scoped = (ns: 'aging' | 'stock' | 'dayBook' | 'cashBook'): Translate => {
  const lookup = (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], (en.reports as Record<string, unknown>)[ns]);
  return Object.assign((key: string) => String(lookup(key) ?? key), { has: (key: string) => typeof lookup(key) === 'string' });
};

async function sheet(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}
const rowsOf = (ws: ExcelJS.Worksheet, header: string) => {
  const head = ws.getRows(1, ws.rowCount)!.find((r) => r.getCell(1).value === header)!;
  return { head, body: ws.getRows(head.number + 1, ws.rowCount - head.number)! };
};

describe('ageing workbook', () => {
  const report: AgeingReport = {
    rows: [
      { partyId: 'p1', name: 'Sri Venkateswara Constructions', b0_30: '1000.50', b31_60: '0.00', b61_90: '0.00', b90_plus: '250.00', onAccount: '100.00', interest: '12.34', receivable: '1150.50' },
      { partyId: 'p2', name: 'Ravi Traders', b0_30: '0.00', b31_60: '500.00', b61_90: '0.00', b90_plus: '0.00', onAccount: '0.00', interest: '0.00', receivable: '500.00' },
    ],
    totals: { b0_30: '1000.50', b31_60: '500.00', b61_90: '0.00', b90_plus: '250.00', onAccount: '100.00', interest: '12.34', receivable: '1650.50' },
    reconciliation: null,
  };
  it('writes each party and a totals row, money as numbers with a money format', async () => {
    const t = scoped('aging');
    const ws = await sheet(await buildAgeingWorkbook(report, 'Daksha Nirmaan Traders', t, t('title')));
    const { head, body } = rowsOf(ws, 'Party');
    expect(head.getCell(8).value).toBe('Owes us');
    expect(body[0]!.getCell(1).value).toBe('Sri Venkateswara Constructions');
    expect(body[0]!.getCell(2).value).toBe(1000.5);
    expect(body[0]!.getCell(2).numFmt).toBe('#,##0.00');
    expect(body[0]!.getCell(7).value).toBe(12.34);
    const total = body[2]!;
    expect(total.getCell(1).value).toBe('Total');
    expect(total.getCell(8).value).toBe(1650.5);
    // The workbook total equals the sum of its own rows (screen = workbook).
    expect(Number(body[0]!.getCell(8).value) + Number(body[1]!.getCell(8).value)).toBe(Number(total.getCell(8).value));
  });
});

describe('stock workbook', () => {
  const report: StockReport = {
    godowns: [{ id: 'g1', name: 'Main godown' }],
    selected: 'all',
    rows: [{ itemId: 'i1', itemName: 'Cement 50kg', category: 'cement', godown: 'Main godown', baseUom: 'bag', qty: '1000.000', avgRate: '300.0000', value: '300000.00' }],
    totalValue: '300000.00',
    reconciliation: null,
  };
  it('owner workbook carries cost and a total', async () => {
    const t = scoped('stock');
    const ws = await sheet(await buildStockWorkbook(report, true, 'DNT', t, t('title')));
    const { head, body } = rowsOf(ws, 'Item');
    expect(head.getCell(6).value).toBe('Value');
    expect(body[0]!.getCell(4).value).toBe(1000);
    expect(body[0]!.getCell(5).value).toBe(300);
    expect(body[0]!.getCell(6).value).toBe(300000);
    expect(body[1]!.getCell(6).value).toBe(300000);
  });
  it('a counter workbook has no cost column at all', async () => {
    const t = scoped('stock');
    const counter: StockReport = { ...report, totalValue: null, rows: report.rows.map((r) => ({ ...r, avgRate: null, value: null })) };
    const ws = await sheet(await buildStockWorkbook(counter, false, 'DNT', t, t('title')));
    const { head, body } = rowsOf(ws, 'Item');
    expect(head.actualCellCount).toBe(4);
    expect(head.values).not.toContain('Value');
    expect(body).toHaveLength(1);
    expect(JSON.stringify(ws.getSheetValues())).not.toContain('300000');
  });
});

describe('day book workbook', () => {
  const rows: DayBookRow[] = [
    { entryId: 'e1', date: '2026-09-05', entryNo: 12, sourceType: 'sales_invoice', docNo: 'DN/26-27/0001', narration: 'Invoice', amount: '12329.00', isReversal: false, isReversed: true },
    { entryId: 'e2', date: '2026-09-06', entryNo: 13, sourceType: 'sales_invoice', docNo: 'DN/26-27/0001', narration: 'Cancel', amount: '12329.00', isReversal: true, isReversed: false },
  ];
  it('lists every entry with dates as dates and flags reversals', async () => {
    const t = scoped('dayBook');
    const ws = await sheet(await buildDayBookWorkbook(rows, { from: '2026-09-01', to: '2026-09-30' }, 'DNT', t, t('title')));
    const { body } = rowsOf(ws, 'Date');
    expect(body[0]!.getCell(1).value).toBeInstanceOf(Date);
    expect(body[0]!.getCell(1).numFmt).toBe('dd-mm-yyyy');
    expect(body[0]!.getCell(4).value).toBe('Sales invoice');
    expect(body[0]!.getCell(6).value).toBe(12329);
    expect(body[0]!.getCell(7).value).toBe('Reversed');
    expect(body[1]!.getCell(7).value).toBe('Reversal');
  });
});

describe('cash book workbook', () => {
  const book: CashBook = {
    accounts: [{ id: 'a1', name: 'Cash', key: 'cash' }],
    account: { id: 'a1', name: 'Cash' },
    opening: '2000.00',
    rows: [
      { key: 'l1', date: '2026-09-05', entryNo: 1, docNo: 'RCPT/1', narration: 'Receipt', isReversal: false, debit: '5000.00', credit: '0.00', balance: '7000.00' },
      { key: 'l2', date: '2026-09-05', entryNo: 2, docNo: null, narration: 'Rent', isReversal: false, debit: '0.00', credit: '3000.00', balance: '4000.00' },
    ],
    totalIn: '5000.00', totalOut: '3000.00', closing: '4000.00',
  };
  it('opening + in − out = closing, and the sheet says so', async () => {
    const t = scoped('cashBook');
    const ws = await sheet(await buildCashBookWorkbook(book, { from: '2026-09-01', to: '2026-09-30' }, 'DNT', t, t('title')));
    const { body } = rowsOf(ws, 'Date');
    expect(body[0]!.getCell(6).value).toBe(2000);
    expect(body[1]!.getCell(4).value).toBe(5000);
    expect(body[1]!.getCell(5).value).toBeNull();
    expect(body[2]!.getCell(5).value).toBe(3000);
    const closing = body[3]!;
    expect(closing.getCell(6).value).toBe(4000);
    expect(2000 + Number(closing.getCell(4).value) - Number(closing.getCell(5).value)).toBe(Number(closing.getCell(6).value));
  });
});

describe('filenames', () => {
  it('are safe and dated', () => {
    expect(reportFilename('DayBook', '2026-09-01_2026-09-30')).toBe('DN-DayBook-2026-09-01_2026-09-30.xlsx');
  });
});
