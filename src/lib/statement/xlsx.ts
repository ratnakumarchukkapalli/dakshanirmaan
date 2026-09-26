import 'server-only';
import ExcelJS from 'exceljs';
import { fyName, fyStartYear } from '@/lib/fy';
import type { PartyLedger } from '@/lib/party-ledger';

// Party statement as an Excel workbook (exceljs; the `xlsx` package is banned). Money and dates are
// written as numbers and dates with a number format, never as pre-formatted text, so the sheet can be
// summed and filtered. The figures are the ledger view's own stored numbers: nothing is recomputed.

export interface StatementOrg { legalName: string; gstin: string | null }

const MONEY = '#,##0.00';
const DATE = 'dd-mm-yyyy';
const isoDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
// A 2-decimal decimal string is written as the number Excel will hold; the string itself is exact.
const num = (v: string) => Number(v);

export function statementFilename(ledger: PartyLedger, ext: 'xlsx' | 'pdf'): string {
  const name = ledger.party.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'party';
  const span = ledger.period ? fyName(fyStartYear(ledger.period.from)) : 'all';
  return `DN-Statement-${name}-${span}.${ext}`;
}

export async function buildStatementWorkbook(ledger: PartyLedger, org: StatementOrg, labels: {
  title: string; party: string; gstin: string; period: string; allTime: string; date: string; document: string; account: string;
  details: string; debit: string; credit: string; balance: string; broughtForward: string; closing: string; receivable: string; payable: string; reversal: string;
}): Promise<Buffer> {
  if (ledger.truncated) throw new Error('statement: the ledger was truncated; refusing to export a partial statement');
  const wb = new ExcelJS.Workbook();
  wb.creator = org.legalName;
  const ws = wb.addWorksheet(labels.title.slice(0, 31));
  const showAccount = ledger.party.type === 'both';
  const acct = (k: 'ar' | 'ap') => (k === 'ar' ? labels.receivable : labels.payable);

  ws.addRow([org.legalName]).font = { bold: true, size: 14 };
  ws.addRow([labels.title]).font = { bold: true };
  ws.addRow([labels.party, ledger.party.name]);
  if (ledger.party.gstin) ws.addRow([labels.gstin, ledger.party.gstin]);
  ws.addRow([labels.period, ledger.period ? `${fyName(fyStartYear(ledger.period.from))} (${ledger.period.from} to ${ledger.period.to})` : labels.allTime]);
  ws.addRow([]);

  const header = [labels.date, labels.document, ...(showAccount ? [labels.account] : []), labels.details, labels.debit, labels.credit, labels.balance];
  const head = ws.addRow(header);
  head.font = { bold: true };
  const first = head.number;
  const cols = header.length;
  const moneyCols = [cols - 2, cols - 1, cols];

  const push = (cells: (string | number | Date | null)[]) => {
    const row = ws.addRow(cells);
    row.getCell(1).numFmt = DATE;
    for (const c of moneyCols) row.getCell(c).numFmt = MONEY;
    return row;
  };

  if (ledger.period) {
    for (const k of ['ar', 'ap'] as const) {
      const bf = ledger.broughtForward[k];
      if (bf === undefined) continue;
      push([isoDate(ledger.period.from), labels.broughtForward, ...(showAccount ? [acct(k)] : []), '', null, null, num(bf)]).font = { italic: true };
    }
  }
  for (const r of ledger.rows) {
    push([
      isoDate(r.date), r.docNo ?? '', ...(showAccount ? [acct(r.accountKey)] : []),
      [r.narration, r.isReversal ? labels.reversal : null].filter(Boolean).join(' · '),
      num(r.debit) || null, num(r.credit) || null, num(r.balance),
    ]);
  }
  for (const k of ['ar', 'ap'] as const) {
    const c = ledger.closing[k];
    if (c === undefined) continue;
    const row = push([null, `${labels.closing}${showAccount ? ` · ${acct(k)}` : ''}`, ...(showAccount ? [''] : []), '', null, null, num(c)]);
    row.font = { bold: true };
  }

  ws.columns = [
    { width: 12 }, { width: 22 }, ...(showAccount ? [{ width: 12 }] : []), { width: 46 }, { width: 14 }, { width: 14 }, { width: 16 },
  ];
  ws.views = [{ state: 'frozen', ySplit: first }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
