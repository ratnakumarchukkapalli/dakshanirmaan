import ExcelJS from 'exceljs';
// exceljs's own zip reader; used here only to look at the XML the writer produced.
import JSZip from 'jszip';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { col } from './table';
import { RowCapError, type ExportRow, type ExportTable } from './types';
import { cellValue, createWorkbook, safeText, wallClock, writeTableSheet, writeTextSheet } from './xlsx';

async function build(fill: (wb: ReturnType<typeof createWorkbook>) => Promise<void>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => { out.on('end', resolve); out.on('error', reject); });
  const wb = createWorkbook(out, 'Test Org');
  await fill(wb);
  await wb.commit();
  await done;
  return Buffer.concat(chunks);
}

const table = (rows: ExportRow[], extra: Partial<ExportTable> = {}): ExportTable => ({
  name: 'T',
  description: 'test',
  columns: [col('name', 'Name', 'text'), col('amount', 'Amount', 'money'), col('qty', 'Qty', 'qty'), col('rate', 'Rate', 'rate'), col('d', 'Date', 'date'), col('at', 'At', 'datetime'), col('n', 'N', 'int'), col('ok', 'OK', 'bool')],
  async *rows() { yield* rows; },
  ...extra,
});

describe('safeText', () => {
  it('defuses anything a spreadsheet could take for a formula', () => {
    expect(safeText('=HYPERLINK("http://x","y")')).toBe(`'=HYPERLINK("http://x","y")`);
    expect(safeText('@SUM(1)')).toBe("'@SUM(1)");
    expect(safeText('+91 98480 12345')).toBe("'+91 98480 12345");
    expect(safeText('-5')).toBe("'-5");
    expect(safeText('\tcmd')).toBe("'\tcmd");
    expect(safeText('\rcmd')).toBe("'\rcmd");
  });
  it('leaves ordinary text alone, and removes characters XML cannot carry', () => {
    expect(safeText('Sri Venkateswara Constructions')).toBe('Sri Venkateswara Constructions');
    expect(safeText('శ్రీ వెంకటేశ్వర 🏗 & <Co>')).toBe('శ్రీ వెంకటేశ్వర 🏗 & <Co>');
    expect(safeText('a\u0001b\u0000c')).toBe('abc');
    expect(safeText('a=b')).toBe('a=b');
  });
});

describe('cellValue', () => {
  it('writes money, quantity and rate as numbers with the database digits', () => {
    expect(cellValue('1234567.89', 'money', 'UTC')).toBe(1234567.89);
    expect(cellValue('0.07', 'money', 'UTC')).toBe(0.07);
    expect(cellValue('62.5375', 'rate', 'UTC')).toBe(62.5375);
    expect(cellValue('-3.500', 'qty', 'UTC')).toBe(-3.5);
  });
  it('keeps a figure as text when a number could not hold it exactly', () => {
    expect(cellValue('12345678901234567890.12', 'money', 'UTC')).toBe('12345678901234567890.12');
  });
  it('writes dates as dates at midnight UTC, and instants as the wall clock of the organisation', () => {
    expect((cellValue('2026-09-19', 'date', 'Asia/Kolkata') as Date).toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect(wallClock('2026-10-02T20:30:00Z', 'Asia/Kolkata').toISOString()).toBe('2026-10-03T02:00:00.000Z');
    expect(wallClock('2026-10-02T20:30:00Z', 'UTC').toISOString()).toBe('2026-10-02T20:30:00.000Z');
    expect(() => cellValue('02-10-2026', 'date', 'UTC')).toThrow();
  });
  it('writes empty as empty, text as protected text, flags as booleans', () => {
    expect(cellValue(null, 'money', 'UTC')).toBeNull();
    expect(cellValue('=1+1', 'text', 'UTC')).toBe("'=1+1");
    expect(cellValue(true, 'bool', 'UTC')).toBe(true);
    expect(cellValue(7, 'int', 'UTC')).toBe(7);
  });
});

describe('writeTableSheet', () => {
  const rows: ExportRow[] = [
    ['=HYPERLINK("http://x","y")', '1234567.89', '12.500', '62.5375', '2026-09-19', '2026-10-02T08:35:00Z', 7, true],
    ['@SUM(1)', '0.07', '0.001', '0.0100', '2027-03-31', null, 8, false],
    ['శ్రీ & <Co> "x" 🏗', '-0.10', '0.000', '300.7693', '2026-04-01', '2026-04-01T00:00:00Z', 9, true],
  ];

  it('writes a frozen bold header, a filter over the data, typed cells and protected text', async () => {
    const buf = await build(async (wb) => { await writeTableSheet(wb, table(rows), 'Asia/Kolkata'); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('T')!;
    expect(ws.rowCount).toBe(4);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBe('A1:H4');
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.getRow(1).values).toEqual([undefined, 'Name', 'Amount', 'Qty', 'Rate', 'Date', 'At', 'N', 'OK']);

    const r2 = ws.getRow(2);
    expect(r2.getCell(1).value).toBe(`'=HYPERLINK("http://x","y")`);
    expect(r2.getCell(1).type).toBe(ExcelJS.ValueType.String); // never a formula
    expect(r2.getCell(2).value).toBe(1234567.89);
    expect(r2.getCell(2).numFmt).toBe('#,##0.00');
    expect(r2.getCell(3).numFmt).toBe('#,##0.000');
    expect(r2.getCell(4).numFmt).toBe('#,##0.0000');
    expect(r2.getCell(5).value).toEqual(new Date('2026-09-19T00:00:00.000Z'));
    expect(r2.getCell(5).numFmt).toBe('dd-mm-yyyy');
    expect(r2.getCell(6).value).toEqual(new Date('2026-10-02T14:05:00.000Z')); // 14:05 on the wall clock in India
    expect(r2.getCell(8).value).toBe(true);
    const r3 = ws.getRow(3);
    expect(r3.getCell(1).value).toBe("'@SUM(1)");
    expect(r3.getCell(2).value).toBe(0.07);
    expect(r3.getCell(3).value).toBe(0.001);
    expect(r3.getCell(6).value).toBeNull();
    expect(ws.getRow(4).getCell(1).value).toBe('శ్రీ & <Co> "x" 🏗');
    expect(ws.getRow(4).getCell(2).value).toBe(-0.1);
  });

  it('stores the database digits in the file, not a rounded approximation', async () => {
    const buf = await build(async (wb) => { await writeTableSheet(wb, table(rows), 'UTC'); });
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('<v>1234567.89</v>');
    expect(xml).toContain('<v>0.07</v>');
    expect(xml).toContain('<v>62.5375</v>');
    expect(xml).toContain('<v>300.7693</v>');
    expect(xml).toContain('<v>-0.1</v>');
    expect(xml).not.toMatch(/<f[ >]/); // no formulas anywhere
  });

  it('reads back sums that are exact when summed as decimals (0.1 + 0.2 style)', async () => {
    const amounts: ExportRow[] = ['0.10', '0.20', '1234567.89', '0.07'].map((a) => ['x', a, null, null, null, null, null, null]);
    const buf = await build(async (wb) => { await writeTableSheet(wb, table(amounts), 'UTC'); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values = [2, 3, 4, 5].map((r) => wb.getWorksheet('T')!.getRow(r).getCell(2).value as number);
    expect(values).toEqual([0.1, 0.2, 1234567.89, 0.07]);
    // Each stored value prints back as the digits the database sent.
    expect(values.map(String)).toEqual(['0.1', '0.2', '1234567.89', '0.07']);
  });

  it('adds footer rows after a gap, outside the filter', async () => {
    const t = table(rows.slice(0, 1), { footer: () => [['Total', '1234567.89', null, null, null, null, null, null]] });
    const buf = await build(async (wb) => { await writeTableSheet(wb, t, 'UTC'); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('T')!;
    expect(ws.getRow(4).getCell(1).value).toBe('Total');
    expect(ws.getRow(4).font?.bold).toBe(true);
    expect(ws.autoFilter).toBe('A1:H2');
  });

  it('refuses a sheet over the row cap and a row of the wrong width', async () => {
    const big = table(Array.from({ length: 6 }, (): ExportRow => ['x', '1.00', null, null, null, null, null, null]));
    await expect(build(async (wb) => { await writeTableSheet(wb, big, 'UTC', 5); })).rejects.toBeInstanceOf(RowCapError);
    const narrow = table([['only one cell'] as ExportRow]);
    await expect(build(async (wb) => { await writeTableSheet(wb, narrow, 'UTC'); })).rejects.toThrow(/1 cells for 8 columns/);
  });

  it('writes an empty table as just its header', async () => {
    const buf = await build(async (wb) => { expect(await writeTableSheet(wb, table([]), 'UTC')).toBe(0); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.getWorksheet('T')!.rowCount).toBe(1);
  });
});

describe('writeTextSheet', () => {
  it('defuses text lines too', async () => {
    const buf = await build(async (wb) => { writeTextSheet(wb, 'README', [{ cells: ['=Org', '+Generated', 5], bold: true }], [20, 40, 8]); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.getWorksheet('README')!.getRow(1).values).toEqual([undefined, "'=Org", "'+Generated", 5]);
  });
});
