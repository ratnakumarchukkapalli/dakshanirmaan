import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseHdfcStatement, type ParseResult } from './hdfc';
import {
  DELIMITED_HEADER,
  EXCEL_HEADER,
  OPENING,
  PREAMBLE,
  R0,
  R1,
  ROWS,
  RULE,
  delimitedLine,
  delimitedText,
  excelCsvText,
  fromPaise,
  indian,
  toPaise,
  withBalances,
  type FxLine,
  type FxRow,
} from './__fixtures__/hdfc-fixtures';

const enc = (s: string) => new TextEncoder().encode(s);
const run = (name: string, text: string) => parseHdfcStatement({ name, bytes: enc(text) });

function ok(r: ParseResult) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}
function err(r: ParseResult): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
}

const LINES = withBalances(ROWS);
const SERIAL_OCT_1 = (Date.UTC(2026, 9, 1) - Date.UTC(1899, 11, 30)) / 86400000;

async function xlsxBytes(lines: FxLine[], opts: { opening?: string; closingRule?: boolean } = {}): Promise<Uint8Array> {
  const opening = opts.opening ?? OPENING;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const p of PREAMBLE) ws.addRow([p.split(',')[0]]);
  ws.addRow(EXCEL_HEADER.split(','));
  ws.addRow(RULE.split(','));
  lines.forEach((r, i) => {
    const date = i === 0 ? new Date(Date.UTC(2026, 9, 1)) : i === 1 ? SERIAL_OCT_1 : r.date;
    // Mix real numbers and Indian-grouped text, as the real downloads do.
    const amt = (v: string) => (v === '' ? null : i % 2 === 1 ? Number(v) : indian(v));
    const rowObj = ws.addRow([
      date,
      r.narration,
      i === 1 ? Number(r.ref) : r.ref === '' ? null : r.ref,
      r.valueDate,
      amt(r.debit),
      amt(r.credit),
      i % 2 === 1 ? Number(r.balance) : indian(r.balance),
    ]);
    if (i === 0) rowObj.getCell(1).numFmt = 'dd/mm/yy';
  });
  if (opts.closingRule !== false) ws.addRow(RULE.split(','));
  ws.addRow(['STATEMENT SUMMARY  :-']);
  ws.addRow(['Opening Balance', 'Dr Count', 'Cr Count', 'Debits', 'Credits', 'Closing Bal']);
  ws.addRow([Number(opening), 5, 9, 1, 1, Number(lines[lines.length - 1]?.balance)]);
  ws.addRow(['This is a computer generated statement and does not require a signature.']);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

describe('Delimited layout', () => {
  it('parses every example row with exact money strings', async () => {
    const r = ok(await run('stmt.txt', delimitedText(LINES)));
    expect(r.lines).toHaveLength(14);
    expect(r.lines[0]).toEqual({
      lineNo: 1,
      txnDate: '2026-10-01',
      valueDate: '2026-10-01',
      narration: 'UPI-ACME TRADERS-acmetr01@okicici-ICIC0DC0099-427510653284-NA',
      reference: '427510653284',
      refHint: '427510653284',
      debit: '0.00',
      credit: '147418.35',
      balance: '397418.35',
      kind: 'other',
    });
    expect(r.summary).toMatchObject({
      firstDate: '2026-10-01',
      lastDate: '2026-10-07',
      openingBalance: '250000.00',
      closingBalance: LINES[LINES.length - 1]?.balance,
      rowCount: 14,
      warnings: [],
    });
    expect(r.lines.map((l) => l.lineNo)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('treats 0.00 on the unused side as zero and keeps two decimals', async () => {
    const r = ok(await run('stmt.txt', delimitedText(LINES)));
    expect(r.lines[4]).toMatchObject({ debit: '25000.00', credit: '0.00' });
    expect(r.lines[8]).toMatchObject({ debit: '5.90', credit: '0.00' });
  });

  it('repairs an unquoted comma inside the narration', async () => {
    const r = ok(await run('stmt.txt', delimitedText(LINES)));
    expect(r.lines[4]).toMatchObject({
      narration: 'NEFT DR-SBIN0000999-PAYEE-NETBANK, MUM-N199262615',
      reference: 'N199262615',
      debit: '25000.00',
      balance: LINES[4]?.balance,
    });
  });

  it('repairs several unquoted commas', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,PAID TO A, B, C LTD,01/10/26,0.00,100.00,0000123456789012,250100.00'].join('\n');
    const r = ok(await run('stmt.txt', text));
    expect(r.lines[0]).toMatchObject({ narration: 'PAID TO A, B, C LTD', credit: '100.00', reference: '123456789012', balance: '250100.00' });
  });

  it('keeps commas inside a quoted narration', async () => {
    const text = [
      DELIMITED_HEADER,
      '01/10/26,"UPI-A, B-x@y-123456789012-NA",01/10/26,0.00,100.00,0000123456789012,250100.00',
      '01/10/26,"SAYS ""HI"", OK",01/10/26,10.00,0.00,0000000000000000,250090.00',
    ].join('\n');
    const r = ok(await run('stmt.txt', text));
    expect(r.lines[0]?.narration).toBe('UPI-A, B-x@y-123456789012-NA');
    expect(r.lines[1]?.narration).toBe('SAYS "HI", OK');
    expect(r.lines[1]?.reference).toBeNull();
  });

  it('strips a UTF-8 BOM and accepts CRLF', async () => {
    const plain = ok(await run('stmt.txt', delimitedText(LINES)));
    const odd = ok(await run('stmt.txt', '﻿' + delimitedText(LINES, '\r\n')));
    expect(odd.lines).toEqual(plain.lines);
  });

  it('accepts a .csv name for the same content', async () => {
    const r = ok(await run('stmt.csv', delimitedText(LINES)));
    expect(r.lines).toHaveLength(14);
  });

  it('strips a leading apostrophe from dates, references and amounts', async () => {
    const text = [DELIMITED_HEADER, "'01/10/26,UPI TEST,'01/10/26,0.00,'100.00,'0000123456789012,250100.00"].join('\n');
    const r = ok(await run('stmt.txt', text));
    expect(r.lines[0]).toMatchObject({ txnDate: '2026-10-01', credit: '100.00', reference: '123456789012' });
  });

  it('trims the narration but leaves internal whitespace alone', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,   CASH   DEPOSIT    BY SELF  ,01/10/26,0.00,100.00,0000000000000000,250100.00'].join('\n');
    expect(ok(await run('stmt.txt', text)).lines[0]?.narration).toBe('CASH   DEPOSIT    BY SELF');
  });
});

describe('Excel layout as CSV', () => {
  it('skips the preamble and the summary footer and equals the Delimited result', async () => {
    const d = ok(await run('stmt.txt', delimitedText(LINES)));
    const x = ok(await run('stmt.csv', excelCsvText(LINES)));
    expect(x.lines).toEqual(d.lines);
    expect(x.summary).toEqual(d.summary);
    expect(x.summary.rowCount).toBe(14);
  });

  it('reads Indian-grouped quoted numbers', async () => {
    const x = ok(await run('stmt.csv', excelCsvText(LINES)));
    expect(x.lines[0]).toMatchObject({ credit: '147418.35', debit: '0.00', balance: '397418.35' });
    expect(x.lines[5]).toMatchObject({ credit: '75000.00', valueDate: '2026-10-05' });
  });

  it('survives CRLF and a BOM', async () => {
    const a = ok(await run('stmt.csv', excelCsvText(LINES)));
    const b = ok(await run('stmt.csv', '﻿' + excelCsvText(LINES, '\r\n')));
    expect(b.lines).toEqual(a.lines);
  });

  it('warns, but does not refuse, when the summary opening balance differs', async () => {
    const x = ok(await run('stmt.csv', excelCsvText(LINES, '\n', '249999.00')));
    expect(x.summary.warnings).toHaveLength(1);
    expect(x.summary.warnings[0]).toMatch(/opening balance/i);
    expect(x.lines).toHaveLength(14);
  });
});

describe('.xlsx', () => {
  it('reads Date cells, Excel serials, text dates, numeric and grouped-text amounts', async () => {
    const d = ok(await run('stmt.txt', delimitedText(LINES)));
    const x = ok(await parseHdfcStatement({ name: 'stmt.xlsx', bytes: await xlsxBytes(LINES) }));
    expect(x.lines).toEqual(d.lines);
    expect(x.summary).toEqual(d.summary);
  });

  it('stops at the summary even without a closing rule (opening balance in the Date column is not a row)', async () => {
    const lines = withBalances(ROWS, '50000.00');
    const x = ok(await parseHdfcStatement({ name: 'stmt.xlsx', bytes: await xlsxBytes(lines, { opening: '50000.00', closingRule: false }) }));
    expect(x.summary.rowCount).toBe(14);
    expect(x.summary.openingBalance).toBe('50000.00');
    expect(x.summary.warnings).toEqual([]);
  });

  it('accepts a zip-based file even when it is named .xls', async () => {
    const x = ok(await parseHdfcStatement({ name: 'stmt.xls', bytes: await xlsxBytes(LINES) }));
    expect(x.lines).toHaveLength(14);
  });

  it('refuses a workbook that is not an HDFC statement', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(['Item', 'Qty']);
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(err(await parseHdfcStatement({ name: 'a.xlsx', bytes }))).toMatch(/does not look like an HDFC statement/);
  });

  it('refuses a damaged .xlsx with a plain sentence', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const e = err(await parseHdfcStatement({ name: 'a.xlsx', bytes }));
    expect(e).toMatch(/Excel/);
    expect(e).not.toMatch(/at |Error:/);
  });
});

describe('dates', () => {
  const one = (date: string, extra: Partial<FxRow> = {}) =>
    delimitedText(withBalances([{ ...R0, date, valueDate: date, ...extra }]));

  it.each([
    ['01/10/26', '2026-10-01'],
    ['01/10/2026', '2026-10-01'],
    ['2026-10-01', '2026-10-01'],
    ["'01/10/26", '2026-10-01'],
    [String(SERIAL_OCT_1), '2026-10-01'],
    ['03/04/26', '2026-04-03'], // dd/mm, never mm/dd
    ['29/02/28', '2028-02-29'],
  ])('reads %s as %s', async (input, iso) => {
    expect(ok(await run('s.txt', one(input))).lines[0]?.txnDate).toBe(iso);
  });

  it.each(['31/02/26', '10/13/26', '00/10/26', '29/02/27'])('refuses the impossible date %s with its row number', async (bad) => {
    const e = err(await run('s.txt', one(bad)));
    expect(e).toMatch(/^Row 2:/);
    expect(e).toMatch(/not a real date/);
  });

  it('refuses an impossible value date', async () => {
    const e = err(await run('s.txt', one('01/10/26', { valueDate: '32/10/26' })));
    expect(e).toMatch(/^Row 2:.*value date/);
  });
});

describe('order and chain', () => {
  it('reverses a newest-first file to oldest-first', async () => {
    const reversed = [DELIMITED_HEADER, ...[...LINES].reverse().map(delimitedLine)].join('\n');
    const a = ok(await run('s.txt', delimitedText(LINES)));
    const b = ok(await run('s.txt', reversed));
    expect(b.lines).toEqual(a.lines);
    expect(b.summary.openingBalance).toBe('250000.00');
  });

  it('keeps file order for same-day identical amounts with distinct references', async () => {
    const r = ok(await run('s.txt', delimitedText(LINES)));
    expect(r.lines.slice(1, 3).map((l) => [l.lineNo, l.credit, l.reference])).toEqual([
      [2, '10000.00', '428708302983'],
      [3, '10000.00', '428708302984'],
    ]);
  });

  it('refuses a broken balance chain, naming the row', async () => {
    const broken = LINES.map((l, i) => (i === 3 ? { ...l, balance: '1.00' } : l));
    const e = err(await run('s.txt', delimitedText(broken)));
    expect(e).toMatch(/^Row 5:/);
    expect(e).toMatch(/balance/);
  });

  it('refuses a broken chain in the Excel layout too (row number = line in the file)', async () => {
    const broken = LINES.map((l, i) => (i === 2 ? { ...l, balance: '2.00' } : l));
    const e = err(await run('s.csv', excelCsvText(broken)));
    expect(e).toMatch(new RegExp(`^Row ${PREAMBLE.length + 2 + 2 + 1}:`));
  });

  it('computes the opening balance from the first row', async () => {
    const r = ok(await run('s.txt', delimitedText(withBalances(ROWS, '1234.50'))));
    expect(r.summary.openingBalance).toBe('1234.50');
  });

  it('refuses a row with both a debit and a credit', async () => {
    const both = LINES.map((l, i) => (i === 2 ? { ...l, debit: '5.00' } : l));
    const e = err(await run('s.txt', delimitedText(both)));
    expect(e).toMatch(/^Row 4 has both a debit and a credit/);
  });

  it('refuses a row with neither a debit nor a credit', async () => {
    const none = LINES.map((l, i) => (i === 2 ? { ...l, credit: '' } : l));
    expect(err(await run('s.txt', delimitedText(none)))).toMatch(/^Row 4 has neither/);
  });

  it('refuses a file where a blank line hides more transactions', async () => {
    const lines = delimitedText(LINES).split('\n');
    lines.splice(6, 0, '');
    const e = err(await run('s.txt', lines.join('\n')));
    expect(e).toMatch(/^Row 7 has no date/);
  });

  it('refuses a row with an empty closing balance, naming the row', async () => {
    const text = [
      DELIMITED_HEADER,
      '01/10/26,A,01/10/26,0.00,100.00,0000000000000001,250100.00',
      '02/10/26,B,02/10/26,40.00,0.00,0000000000000002,',
    ].join('\n');
    expect(err(await run('s.txt', text))).toMatch(/^Row 3 has no closing balance/);
  });

  it('does not take a file without a Closing Balance column for an HDFC statement', async () => {
    const text = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.\n01/10/26,A,1,01/10/26,,10.00\n';
    expect(err(await run('s.csv', text))).toMatch(/does not look like an HDFC statement/);
  });

  it('orders a same-day newest-first file by the balance chain', async () => {
    const day = withBalances(ROWS.slice(0, 3));
    const reversed = [DELIMITED_HEADER, ...[...day].reverse().map(delimitedLine)].join('\n');
    const r = ok(await run('s.txt', reversed));
    expect(r.lines.map((l) => l.reference)).toEqual(['427510653284', '428708302983', '428708302984']);
    expect(r.summary.openingBalance).toBe('250000.00');
    expect(r.summary.closingBalance).toBe(day[2]?.balance);
  });

  it('still reports a broken chain in a newest-first file', async () => {
    const broken = LINES.map((l, i) => (i === 3 ? { ...l, balance: '1.00' } : l));
    const reversed = [DELIMITED_HEADER, ...[...broken].reverse().map(delimitedLine)].join('\n');
    expect(err(await run('s.txt', reversed))).toMatch(/^Row \d+:.*balance/);
  });
});

describe('references and kind', () => {
  it('normalises the reference column', async () => {
    const r = ok(await run('s.txt', delimitedText(LINES))).lines;
    expect(r[0]?.reference).toBe('427510653284'); // zero padding stripped
    expect(r[3]?.reference).toBe('YESIB42752289400');
    expect(r[5]?.reference).toBe('819021'); // cheque number
    expect(r[6]?.reference).toBeNull(); // cash deposit, all zeros
    expect(r[13]?.reference).toBe('AOR2531733136080');
  });

  it('upper-cases the reference', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,X,01/10/26,0.00,100.00,abc123,250100.00'].join('\n');
    expect(ok(await run('s.txt', text)).lines[0]?.reference).toBe('ABC123');
  });

  it('puts a UPI RRN or NEFT UTR found in the narration in refHint, not reference', async () => {
    const r = ok(await run('s.txt', delimitedText(LINES))).lines;
    expect(r[11]).toMatchObject({ reference: null, refHint: '427510653999' });
    expect(r[12]).toMatchObject({ reference: null, refHint: 'HDFCN52026100612345' });
  });

  it('extracts an IMPS RRN when the column is empty', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,IMPS-428708302983-A CO-HDFC-XXXX1234-NA,01/10/26,0.00,100.00,,250100.00'].join('\n');
    expect(ok(await run('s.txt', text)).lines[0]).toMatchObject({ reference: null, refHint: '428708302983' });
  });

  it('does not invent a reference for a cash deposit or a charge', async () => {
    const r = ok(await run('s.txt', delimitedText(LINES))).lines;
    expect(r[6]).toMatchObject({ reference: null, refHint: null });
    expect(r[8]).toMatchObject({ reference: null, refHint: null }); // the RRN inside a charge narration is not this row's
  });

  it('tags charges', async () => {
    const r = ok(await run('s.txt', delimitedText(LINES))).lines;
    const kinds = r.map((l) => l.kind);
    expect(kinds[8]).toBe('charge'); // leading dot + CHARGES + INCL GST
    expect(kinds[13]).toBe('charge'); // FEE-
    expect(kinds.filter((k) => k === 'charge')).toHaveLength(2);
    expect(kinds[0]).toBe('other');
    expect(kinds[9]).toBe('other'); // ACH debit is not a charge
  });

  it.each([
    ['SMS CHARGES FOR QTR ENDED JUN 2026 INCL GST', 'charge'],
    ['DC ANNUAL FEE 416021XXXXXX4321 INCL GST', 'charge'],
    ['fee-atm cash', 'charge'],
    ['.SOMETHING', 'charge'],
    ['Cheque book charges', 'charge'],
    ['UPI-SHOP-x@y-123456789012-NA', 'other'],
  ])('narration %s is %s', async (narration, kind) => {
    const text = [DELIMITED_HEADER, `01/10/26,${narration},01/10/26,5.00,0.00,0000000000000000,249995.00`].join('\n');
    expect(ok(await run('s.txt', text)).lines[0]?.kind).toBe(kind);
  });
});

describe('money', () => {
  it('handles large grouped amounts without float error', async () => {
    const rows: FxRow[] = [
      { ...R0, credit: '99999999999.99' },
      { ...R1, credit: '0.01' },
    ];
    const lines = withBalances(rows, '0.10');
    const r = ok(await run('s.csv', excelCsvText(lines)));
    expect(r.lines[0]?.credit).toBe('99999999999.99');
    expect(r.lines[1]?.balance).toBe(fromPaise(toPaise('0.10') + toPaise('99999999999.99') + 1n));
  });

  it('refuses text amounts with more than two decimals', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,A,01/10/26,0.00,100.005,0000000000000001,250100.00'].join('\n');
    expect(err(await run('s.txt', text))).toMatch(/^Row 2:.*not a valid amount/);
  });

  it('refuses a negative debit', async () => {
    const text = [DELIMITED_HEADER, '01/10/26,A,01/10/26,-5.00,0.00,0000000000000001,249995.00'].join('\n');
    expect(err(await run('s.txt', text))).toMatch(/^Row 2:/);
  });
});

describe('refusals', () => {
  it('refuses legacy .xls by extension with the exact sentence', async () => {
    const r = await parseHdfcStatement({ name: 'Statement.XLS', bytes: new Uint8Array([1, 2, 3, 4, 5]) });
    expect(err(r)).toBe('Save the statement as .xlsx, or download the Delimited (.txt) format.');
  });

  it('refuses BIFF bytes whatever the name', async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const r = await parseHdfcStatement({ name: 'statement.txt', bytes });
    expect(err(r)).toBe('Save the statement as .xlsx, or download the Delimited (.txt) format.');
  });

  it('refuses a PDF by name or by bytes', async () => {
    const byName = await parseHdfcStatement({ name: 'a.pdf', bytes: enc('anything') });
    expect(err(byName)).toMatch(/PDF/);
    const byBytes = await parseHdfcStatement({ name: 'a.txt', bytes: enc('%PDF-1.4\n1 0 obj') });
    expect(err(byBytes)).toMatch(/PDF/);
  });

  it('refuses other file types with a plain sentence', async () => {
    const e = err(await run('stmt.docx', delimitedText(LINES)));
    expect(e).toMatch(/cannot be imported/);
  });

  it('refuses a text file that is not an HDFC statement', async () => {
    const e = err(await run('a.csv', 'name,qty\nbolt,3\n'));
    expect(e).toBe('This does not look like an HDFC statement. Download Excel or Delimited from NetBanking.');
  });

  it('refuses binary content named .txt as not an HDFC statement', async () => {
    const r = await parseHdfcStatement({ name: 'a.txt', bytes: new Uint8Array([0, 1, 2, 3, 0, 0]) });
    expect(err(r)).toMatch(/does not look like an HDFC statement/);
  });

  it('refuses a file over 5 MB', async () => {
    const r = await parseHdfcStatement({ name: 'big.txt', bytes: new Uint8Array(5 * 1024 * 1024 + 1).fill(65) });
    expect(err(r)).toMatch(/too large/);
  });

  it('refuses a text file with more than 20,000 rows', async () => {
    const text = DELIMITED_HEADER + '\n' + '\n'.repeat(20001);
    expect(err(await run('a.txt', text))).toMatch(/too large/);
  });

  it('refuses a workbook with too many columns', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('S').addRow(Array.from({ length: 31 }, (_, i) => `c${i}`));
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(err(await parseHdfcStatement({ name: 'a.xlsx', bytes }))).toMatch(/too large/);
  });

  it('refuses an empty file', async () => {
    const r = await parseHdfcStatement({ name: 'a.txt', bytes: new Uint8Array() });
    expect(err(r)).toBe('The file is empty.');
  });

  it('refuses a header with no transactions', async () => {
    expect(err(await run('a.txt', DELIMITED_HEADER + '\n'))).toBe('No transactions were found in this file.');
  });
});
