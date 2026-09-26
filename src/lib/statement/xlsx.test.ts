import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import type { PartyLedger } from '@/lib/party-ledger';
import { buildStatementWorkbook, statementFilename } from './xlsx';

vi.mock('server-only', () => ({}));

const labels = {
  title: 'Account statement', party: 'Party', gstin: 'GSTIN', period: 'Period', allTime: 'All time', date: 'Date', document: 'Document',
  account: 'Account', details: 'Details', debit: 'Debit', credit: 'Credit', balance: 'Balance', broughtForward: 'Balance brought forward',
  closing: 'Closing balance', receivable: 'Receivable', payable: 'Payable', reversal: 'Reversal',
};

const ledger: PartyLedger = {
  party: { id: 'p1', name: 'Sri Venkateswara Constructions', type: 'customer', gstin: '37AABCS1234A1Z5', phone: null, whatsappPhone: null, isActive: true, stateCode: '37' },
  period: { from: '2026-04-01', to: '2027-03-31' },
  broughtForward: { ar: '1000.50' },
  rows: [
    { key: 'a', date: '2026-06-11', docNo: 'DN/26-27/0307', sourceType: 'sales_invoice', sourceId: 'x', narration: '220 bags', isReversal: false, accountKey: 'ar', debit: '93400.00', credit: '0.00', balance: '94400.50' },
    { key: 'b', date: '2026-06-19', docNo: 'RCPT/26-27/0146', sourceType: 'payment', sourceId: 'y', narration: 'Cheque', isReversal: true, accountKey: 'ar', debit: '0.00', credit: '100000.00', balance: '-5599.50' },
  ],
  closing: { ar: '-5599.50' },
  truncated: false,
};
const org = { legalName: 'Daksha Nirmaan Traders', gstin: '37ABCDE1234F1Z5' };

async function read(l: PartyLedger) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildStatementWorkbook(l, org, labels) as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}

describe('party statement workbook', () => {
  it('writes money as numbers with a money format and dates as dates', async () => {
    const ws = await read(ledger);
    const header = ws.getRows(1, ws.rowCount)!.find((r) => r.getCell(1).value === 'Date')!;
    const first = ws.getRow(header.number + 2); // after the brought-forward line
    expect(first.getCell(1).value).toBeInstanceOf(Date);
    expect(first.getCell(1).numFmt).toBe('dd-mm-yyyy');
    expect(first.getCell(4).value).toBe(93400);
    expect(first.getCell(4).numFmt).toBe('#,##0.00');
    expect(first.getCell(6).value).toBe(94400.5);
    const second = ws.getRow(header.number + 3);
    expect(second.getCell(5).value).toBe(100000);
    expect(second.getCell(3).value).toContain('Reversal');
  });

  it('carries the brought-forward line and a closing line that matches the ledger', async () => {
    const ws = await read(ledger);
    const values: unknown[][] = [];
    ws.eachRow((r) => values.push(r.values as unknown[]));
    const bf = values.find((v) => v.includes('Balance brought forward'))!;
    expect(bf[6]).toBe(1000.5);
    const closing = values.find((v) => v.includes('Closing balance'))!;
    expect(closing[6]).toBe(-5599.5);
  });

  it('adds an account column only for a customer-and-supplier party', async () => {
    const both = { ...ledger, party: { ...ledger.party, type: 'both' as const } };
    const ws = await read(both);
    const header = ws.getRows(1, ws.rowCount)!.find((r) => r.getCell(1).value === 'Date')!;
    expect(header.getCell(3).value).toBe('Account');
    expect(header.getCell(7).value).toBe('Balance');
  });

  it('names the file after the party and the financial year', () => {
    expect(statementFilename(ledger, 'xlsx')).toBe('DN-Statement-Sri-Venkateswara-Constructions-2026-27.xlsx');
    expect(statementFilename({ ...ledger, period: null }, 'pdf')).toBe('DN-Statement-Sri-Venkateswara-Constructions-all.pdf');
  });

  it('refuses a truncated ledger instead of writing a wrong closing balance', async () => {
    await expect(buildStatementWorkbook({ ...ledger, truncated: true }, org, labels)).rejects.toThrow(/truncated/);
  });
});
