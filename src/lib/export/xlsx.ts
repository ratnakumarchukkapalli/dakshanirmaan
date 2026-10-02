import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { safeText } from '@/lib/safe-text';
import { exactCellNumber } from './decimal';
import { EXPORT_ROW_CAP, RowCapError, type ColumnType, type ExportCell, type ExportColumn, type ExportRow, type ExportTable } from './types';

// The Excel side of the export layer (exceljs only; the `xlsx` package is banned). Sheets are streamed:
// a row is committed as soon as it is built, so memory does not grow with the book. Money, quantities
// and rates are written as numbers parsed from the database's decimal text at this last step, with a
// number format; dates are real dates; text is always text, and text that a spreadsheet could take
// for a formula is defused (see `safeText`).

export const NUMBER_FORMAT: Partial<Record<ColumnType, string>> = {
  money: '#,##0.00',
  qty: '#,##0.000',
  rate: '#,##0.0000',
  int: '0',
  date: 'dd-mm-yyyy',
  datetime: 'dd-mm-yyyy hh:mm',
};

const DEFAULT_WIDTH: Record<ColumnType, number> = { text: 22, int: 9, money: 15, qty: 13, rate: 13, date: 12, datetime: 17, bool: 8 };

export { safeText };

/** An instant as a spreadsheet date-time that reads the organisation's wall clock (a workbook has no zone). */
export function wallClock(iso: string, timeZone: string): Date {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error(`export: not a date-time: ${iso}`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false })
      .formatToParts(instant).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)));
}

const isoDate = (iso: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`export: not an ISO date: ${iso}`);
  return new Date(`${iso}T00:00:00.000Z`);
};

/** One cell value as exceljs wants it, by the column's type. */
export function cellValue(value: ExportCell, type: ColumnType, timeZone: string): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'money': case 'qty': case 'rate': {
      const text = String(value);
      const n = exactCellNumber(text);
      return n === null ? safeText(text) : n;
    }
    case 'int': return typeof value === 'number' ? value : Number(value);
    case 'date': return isoDate(String(value));
    case 'datetime': return wallClock(String(value), timeZone);
    case 'bool': return Boolean(value);
    default: return safeText(String(value));
  }
}

export type SheetWriter = ExcelJS.Worksheet;

export function createWorkbook(stream: Writable, creator: string): ExcelJS.stream.xlsx.WorkbookWriter {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
  wb.creator = safeText(creator);
  wb.created = new Date();
  return wb;
}

/** A sheet of free text lines (the README, the checks): bold first column, long second column wraps. */
export function writeTextSheet(wb: ExcelJS.stream.xlsx.WorkbookWriter, name: string, rows: { cells: (string | number | null)[]; bold?: boolean }[], widths: number[]): void {
  const ws = wb.addWorksheet(name);
  ws.columns = widths.map((width) => ({ width }));
  for (const r of rows) {
    const row = ws.addRow(r.cells.map((c) => (typeof c === 'string' ? safeText(c) : c)));
    if (r.bold) row.font = { bold: true };
    row.alignment = { vertical: 'top', wrapText: true };
    row.commit();
  }
  ws.commit();
}

/**
 * Writes a table as a sheet: frozen bold header, filter over the data, typed cells. Returns the number
 * of data rows written. Throws RowCapError the moment a sheet would pass the cap (the caller has
 * normally refused earlier using `expectedRows`; this is the backstop).
 */
export async function writeTableSheet(
  wb: ExcelJS.stream.xlsx.WorkbookWriter, table: ExportTable, timeZone: string, cap: number = EXPORT_ROW_CAP,
): Promise<number> {
  const ws = wb.addWorksheet(table.name, { views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }] });
  ws.columns = table.columns.map((c: ExportColumn) => ({ width: c.width ?? DEFAULT_WIDTH[c.type] }));
  const header = ws.addRow(table.columns.map((c) => c.header));
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
  header.commit();

  let count = 0;
  for await (const row of table.rows()) {
    if (row.length !== table.columns.length) {
      throw new Error(`export ${table.name}: a row has ${row.length} cells for ${table.columns.length} columns`);
    }
    if (count >= cap) throw new RowCapError(table.name, cap);
    addTypedRow(ws, row, table.columns, timeZone).commit();
    count += 1;
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, count + 1), column: table.columns.length } };

  const footer = table.footer ? await table.footer() : [];
  if (footer.length > 0) {
    ws.addRow([]).commit();
    for (const f of footer) {
      const row = addTypedRow(ws, f, table.columns, timeZone);
      row.font = { bold: true };
      row.commit();
    }
  }
  ws.commit();
  return count;
}

/** Adds one typed row: values by column type, number formats on the cells that need one. */
function addTypedRow(ws: SheetWriter, row: ExportRow, columns: ExportColumn[], timeZone: string): ExcelJS.Row {
  const added = ws.addRow(row.map((v, i) => cellValue(v, columns[i]!.type, timeZone)));
  columns.forEach((c, i) => {
    const format = NUMBER_FORMAT[c.type];
    if (format && row[i] !== null && row[i] !== undefined) added.getCell(i + 1).numFmt = format;
  });
  return added;
}
