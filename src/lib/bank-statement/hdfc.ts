// Pure parser for HDFC NetBanking current-account statements (Delimited .txt/.csv, Excel-layout .csv, .xlsx).
// Format contract: docs/research/hdfc-statement-format.md. No I/O, no database, no floats for money:
// every amount is read into integer paise (BigInt) and written back as a two-decimal string.
// The banned `xlsx` package is not used; `.xlsx` goes through exceljs (loaded lazily).

export type ParsedLine = {
  lineNo: number;
  txnDate: string; // ISO yyyy-mm-dd
  valueDate: string | null;
  narration: string;
  reference: string | null; // the Chq/Ref column only: zero padding stripped, upper-case, null if empty or all zeros
  refHint: string | null; // 12-digit UPI/IMPS RRN or NEFT/RTGS UTR found in the narration (null for charges); the app decides whether to use it
  debit: string; // two decimals, '0.00' on the unused side
  credit: string;
  balance: string | null;
  kind: 'charge' | 'other';
};

export type ParseResult =
  | {
      ok: true;
      lines: ParsedLine[];
      summary: {
        firstDate: string;
        lastDate: string;
        openingBalance: string | null;
        closingBalance: string | null;
        rowCount: number;
        warnings: string[];
      };
    }
  | { ok: false; error: string };

const XLS_MESSAGE = 'Save the statement as .xlsx, or download the Delimited (.txt) format.';
const PDF_MESSAGE =
  'A PDF statement cannot be imported. Download the Excel (.xlsx) or Delimited (.txt) format from NetBanking.';
const OTHER_MESSAGE =
  'This file type cannot be imported. Use the Delimited (.txt or .csv) or Excel (.xlsx) statement from NetBanking.';
const NOT_HDFC = 'This does not look like an HDFC statement. Download Excel or Delimited from NetBanking.';
const GENERIC =
  'The file could not be read. Download the statement again from NetBanking and try once more.';

class ParseFail extends Error {}

type Cell = string | number | Date | null;
type GridRow = { rowNo: number; cells: Cell[] };
type Grid = { rows: GridRow[]; isText: boolean };

// ---------------------------------------------------------------- entry point

export async function parseHdfcStatement(input: { name: string; bytes: Uint8Array }): Promise<ParseResult> {
  try {
    const grids = await readGrids(input);
    return parseGrids(grids);
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: e.message };
    return { ok: false, error: GENERIC };
  }
}

// ---------------------------------------------------------------- file type and grids

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_COLS = 30;
const TOO_BIG = 'This file is too large to be a bank statement. Download a shorter period from NetBanking.';

async function readGrids(input: { name: string; bytes: Uint8Array }): Promise<Grid[]> {
  const { name, bytes } = input;
  if (!bytes || bytes.length === 0) throw new ParseFail('The file is empty.');
  if (bytes.length > MAX_BYTES) throw new ParseFail(TOO_BIG);
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).trim().toLowerCase() : '';

  const biff = startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]);
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  const pdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);

  if (biff) throw new ParseFail(XLS_MESSAGE);
  if (pdf || ext === 'pdf') throw new ParseFail(PDF_MESSAGE);
  // A file named .xls that is really a zip package is an .xlsx with the wrong extension: read it.
  if (ext === 'xls' && !zip) throw new ParseFail(XLS_MESSAGE);
  if (zip || ext === 'xlsx') return readWorkbook(bytes);
  if (ext === 'txt' || ext === 'csv') return [readText(bytes)];
  throw new ParseFail(OTHER_MESSAGE);
}

function readText(bytes: Uint8Array): Grid {
  if (bytes.includes(0)) throw new ParseFail(NOT_HDFC); // binary, not a text statement
  let text = new TextDecoder('utf-8').decode(bytes);
  text = text.replace(/^﻿/, '');
  const textLines = text.split(/\r\n|\n|\r/);
  if (textLines.length > MAX_ROWS) throw new ParseFail(TOO_BIG);
  const rows: GridRow[] = textLines.map((line, i) => ({ rowNo: i + 1, cells: splitCsvLine(line) }));
  return { rows, isText: true };
}

// Quote-aware split of one line. Fields keep their raw spacing (trimmed later) so a re-joined
// unquoted-comma narration keeps its original text.
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    let j = i;
    while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
    if (j < n && line[j] === '"') {
      let k = j + 1;
      let value = '';
      for (;;) {
        if (k >= n) break; // unterminated quote: take the rest of the line
        if (line[k] === '"') {
          if (line[k + 1] === '"') {
            value += '"';
            k += 2;
            continue;
          }
          k++;
          break;
        }
        value += line[k];
        k++;
      }
      while (k < n && line[k] !== ',') k++; // skip padding after the closing quote
      fields.push(value);
      if (k >= n) return fields;
      i = k + 1;
    } else {
      const comma = line.indexOf(',', i);
      if (comma < 0) {
        fields.push(line.slice(i));
        return fields;
      }
      fields.push(line.slice(i, comma));
      i = comma + 1;
    }
  }
}

function cellValue(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellValue(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('');
    if (typeof o.text === 'string') return o.text;
    if ('error' in o) return null;
  }
  return null;
}

async function readWorkbook(bytes: Uint8Array): Promise<Grid[]> {
  const mod = await import('exceljs');
  const ExcelJS = (mod as { default?: typeof import('exceljs') }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new ParseFail('This is not a readable Excel (.xlsx) file. Download the statement again from NetBanking.');
  }
  const grids: Grid[] = [];
  wb.eachSheet((ws) => {
    if (ws.rowCount > MAX_ROWS || ws.columnCount > MAX_COLS) throw new ParseFail(TOO_BIG);
    const rows: GridRow[] = [];
    const width = Math.max(ws.columnCount, 1);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: Cell[] = [];
      for (let c = 1; c <= width; c++) cells.push(cellValue(row.getCell(c).value));
      rows.push({ rowNo: r, cells });
    }
    grids.push({ rows, isText: false });
  });
  return grids;
}

// ---------------------------------------------------------------- cell helpers

const clean = (s: string) => s.replace(/^﻿/, '').trim();

function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined || c instanceof Date) return '';
  return clean(String(c));
}

const at = (cells: Cell[], idx: number): Cell => (idx < 0 ? null : (cells[idx] ?? null));

const isBlankRow = (cells: Cell[]) => cells.every((c) => cellText(c) === '');

function isRuleRow(cells: Cell[]): boolean {
  const first = cells.map(cellText).find((t) => t !== '');
  return first !== undefined && /^\*{2,}/.test(first);
}

function isSummaryRow(cells: Cell[]): boolean {
  return cells.some((c) => /statement summary|opening balance/i.test(cellText(c)));
}

const headerKey = (c: Cell): string => (typeof c === 'string' ? c.toLowerCase().replace(/[\s./_\-:]+/g, '') : '');

// ---------------------------------------------------------------- money (integer paise, never floats)

type Money = { kind: 'blank' } | { kind: 'ok'; paise: bigint } | { kind: 'bad' };

function readMoney(cell: Cell, allowNegative: boolean): Money {
  if (cell === null || cell === undefined) return { kind: 'blank' };
  if (cell instanceof Date) return { kind: 'bad' };
  let s: string;
  let numeric = false;
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return { kind: 'bad' };
    s = String(cell); // shortest decimal text of the cell; no arithmetic on the float
    numeric = true;
  } else {
    s = clean(cell).replace(/^'+/, '').replace(/[,'\s]/g, '');
  }
  if (s === '') return { kind: 'blank' };
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return { kind: 'bad' };
  const intPart = m[2] ?? '';
  const frac = m[3] ?? '';
  if (intPart === '' && frac === '') return { kind: 'bad' };
  if (m[1] && !allowNegative) return { kind: 'bad' };
  let paise = BigInt(intPart === '' ? '0' : intPart) * 100n + BigInt((frac + '00').slice(0, 2));
  if (frac.length > 2) {
    const rest = frac.slice(2);
    if (numeric) {
      if ((rest[0] ?? '0') >= '5') paise += 1n; // a float cell with binary noise: round the text half-up
    } else if (/[^0]/.test(rest)) {
      return { kind: 'bad' }; // typed text with more than two decimals is not a rupee amount
    }
  }
  return { kind: 'ok', paise: m[1] ? -paise : paise };
}

function formatPaise(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------- dates

type DateResult = { kind: 'ok'; iso: string } | { kind: 'none' } | { kind: 'bad' };

const pad2 = (n: number) => String(n).padStart(2, '0');

function ymd(y: number, m: number, d: number): DateResult {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return { kind: 'bad' };
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return { kind: 'bad' };
  return { kind: 'ok', iso: `${y}-${pad2(m)}-${pad2(d)}` };
}

const SERIAL_MIN = 36526; // 2000-01-01
const SERIAL_MAX = 73415; // 2100-12-31
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function fromSerial(n: number): DateResult {
  if (n < SERIAL_MIN || n > SERIAL_MAX) return { kind: 'none' };
  const d = new Date(EXCEL_EPOCH + Math.floor(n) * 86400000);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function readDate(cell: Cell | undefined): DateResult {
  if (cell === null || cell === undefined) return { kind: 'none' };
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return { kind: 'bad' };
    return ymd(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
  }
  if (typeof cell === 'number') return fromSerial(cell);
  const s = clean(cell).replace(/^'+/, '').trim();
  if (s === '') return { kind: 'none' };
  let m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3] ?? '';
    const yr = y.length === 2 ? 2000 + Number(y) : Number(y);
    return ymd(yr, Number(m[2]), Number(m[1])); // dd/mm only, never mm/dd
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d{5}$/.test(s)) return fromSerial(Number(s));
  return { kind: 'none' };
}

// ---------------------------------------------------------------- narration, reference, kind

function readNarration(cell: Cell | undefined): string {
  if (cell === null || cell === undefined || cell instanceof Date) return '';
  return clean(String(cell));
}

function readRef(cell: Cell | undefined): string | null {
  let s = '';
  if (typeof cell === 'number') s = String(cell);
  else if (typeof cell === 'string') s = cell;
  s = clean(s).replace(/^'+/, '').trim().toUpperCase().replace(/^0+/, '');
  return s === '' ? null : s;
}

function isCharge(narration: string): boolean {
  const u = narration.toUpperCase();
  return u.startsWith('FEE-') || u.startsWith('.') || u.includes('CHARGES') || u.includes('INCL GST');
}

// 12-digit UPI/IMPS RRN or NEFT/RTGS UTR from the narration, used only when the ref column is empty.
function extractReference(narration: string): string | null {
  const u = narration.toUpperCase();
  if (/^(?:REV-)?(?:UPI|IMPS)\b/.test(u)) {
    const seg = u.split('-').map((x) => x.trim()).find((x) => /^\d{12}$/.test(x));
    return seg ?? null;
  }
  if (/^(?:NEFT|RTGS)\s+(?:CR|DR)\s*-/.test(u)) {
    const segs = u.split('-');
    const last = (segs[segs.length - 1] ?? '').trim();
    if (/^[A-Z][A-Z0-9]{7,21}$/.test(last) && (last.match(/\d/g) ?? []).length >= 6) return last;
  }
  return null;
}

// ---------------------------------------------------------------- header and rows

type Cols = { date: number; narration: number; ref: number; valueDate: number; debit: number; credit: number; balance: number };
type Header = { index: number; cols: Cols; width: number };

const ALIASES: Record<keyof Cols, string[]> = {
  date: ['date'],
  narration: ['narration'],
  ref: ['chqrefno', 'chqrefnumber'],
  valueDate: ['valuedt', 'valuedat', 'valuedate'],
  debit: ['withdrawalamt', 'withdrawalamount', 'debitamount'],
  credit: ['depositamt', 'depositamount', 'creditamount'],
  balance: ['closingbalance', 'closingbal'],
};

function findHeader(rows: GridRow[]): Header | null {
  for (let i = 0; i < rows.length; i++) {
    const hr = rows[i];
    if (!hr) continue;
    const keys = hr.cells.map(headerKey);
    const cols = {} as Cols;
    for (const k of Object.keys(ALIASES) as (keyof Cols)[]) {
      cols[k] = keys.findIndex((key) => key !== '' && ALIASES[k].includes(key));
    }
    if (cols.date >= 0 && cols.narration >= 0 && cols.debit >= 0 && cols.credit >= 0 && cols.balance >= 0) {
      let width = hr.cells.length;
      while (width > 0 && cellText(hr.cells[width - 1]) === '') width--;
      return { index: i, cols, width };
    }
  }
  return null;
}

// Unquoted commas inside a narration add fields. The date stays at the left and the columns to the
// right of the narration stay at the right; everything in between is the narration.
function repairFields(cells: Cell[], h: Header): Cell[] {
  const f = [...cells];
  while (f.length > h.width && cellText(f[f.length - 1]) === '') f.pop();
  if (f.length <= h.width) return f;
  const extra = f.length - h.width;
  const n = h.cols.narration;
  const joined = f.slice(n, n + extra + 1).map((c) => (c === null ? '' : String(c))).join(',');
  return [...f.slice(0, n), joined, ...f.slice(n + extra + 1)];
}

type Draft = {
  rowNo: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  refHint: string | null;
  debit: bigint;
  credit: bigint;
  balance: bigint;
  kind: 'charge' | 'other';
};

function fail(msg: string): never {
  throw new ParseFail(msg);
}

// previous balance + credit - debit = balance, checked down the list in the given order.
function firstChainBreak(list: Draft[]): { draft: Draft; expected: bigint } | null {
  for (let i = 1; i < list.length; i++) {
    const before = list[i - 1];
    const cur = list[i];
    if (!before || !cur) continue;
    const expected = before.balance + cur.credit - cur.debit;
    if (expected !== cur.balance) return { draft: cur, expected };
  }
  return null;
}

function buildDraft(rowNo: number, cells: Cell[], h: Header, txnDate: string): Draft {
  const c = h.cols;
  let valueDate: string | null = null;
  const vCell = at(cells, c.valueDate);
  if (cellText(vCell) !== '') {
    const v = readDate(vCell);
    if (v.kind !== 'ok') fail(`Row ${rowNo}: the value date "${cellText(vCell)}" is not a real date.`);
    else valueDate = v.iso;
  }
  const narration = readNarration(at(cells, c.narration));
  const kind = isCharge(narration) ? 'charge' : 'other';
  const reference = readRef(at(cells, c.ref));
  const refHint = kind === 'charge' ? null : extractReference(narration);

  const money = (idx: number, label: string, allowNegative: boolean): bigint | null => {
    const m = readMoney(at(cells, idx), allowNegative);
    if (m.kind === 'bad') return fail(`Row ${rowNo}: the ${label} "${cellText(at(cells, idx))}" is not a valid amount.`);
    return m.kind === 'ok' ? m.paise : null;
  };
  const debit = money(c.debit, 'debit amount', false) ?? 0n;
  const credit = money(c.credit, 'credit amount', false) ?? 0n;
  const balance = money(c.balance, 'closing balance', true);
  if (balance === null) fail(`Row ${rowNo} has no closing balance. Every row of an HDFC statement has one, so the file may be damaged.`);
  if (debit !== 0n && credit !== 0n) fail(`Row ${rowNo} has both a debit and a credit amount. Each row must have only one.`);
  if (debit === 0n && credit === 0n) fail(`Row ${rowNo} has neither a debit nor a credit amount.`);
  return { rowNo, txnDate, valueDate, narration, reference, refHint, debit, credit, balance: balance as bigint, kind };
}

type Footer = { opening: bigint | null; closing: bigint | null };

function readFooter(rows: GridRow[], from: number): Footer {
  for (let i = from; i < rows.length; i++) {
    const fr = rows[i];
    if (!fr) continue;
    const keys = fr.cells.map(headerKey);
    const oi = keys.indexOf('openingbalance');
    if (oi < 0) continue;
    const ci = keys.findIndex((k) => k === 'closingbal' || k === 'closingbalance');
    for (let j = i + 1; j < rows.length && j <= i + 3; j++) {
      const vr = rows[j];
      if (!vr || isBlankRow(vr.cells)) continue;
      const o = readMoney(at(vr.cells, oi), true);
      const cl = ci >= 0 ? readMoney(at(vr.cells, ci), true) : ({ kind: 'blank' } as Money);
      return { opening: o.kind === 'ok' ? o.paise : null, closing: cl.kind === 'ok' ? cl.paise : null };
    }
    break;
  }
  return { opening: null, closing: null };
}

// ---------------------------------------------------------------- the statement

function parseGrids(grids: Grid[]): ParseResult {
  for (const grid of grids) {
    const h = findHeader(grid.rows);
    if (h) return parseGrid(grid, h);
  }
  return { ok: false, error: NOT_HDFC };
}

function parseGrid(grid: Grid, h: Header): ParseResult {
  const { rows } = grid;
  const drafts: Draft[] = [];
  let stopAt = rows.length;

  for (let i = h.index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    const cells = grid.isText ? repairFields(row.cells, h) : row.cells;
    const blank = isBlankRow(cells);
    const rule = !blank && isRuleRow(cells);
    if ((blank || rule) && drafts.length === 0) continue; // blank line or **** rule between header and data
    let stopped = blank || rule;
    let date: DateResult = { kind: 'none' };
    if (!stopped) {
      date = readDate(at(cells, h.cols.date));
      if (date.kind === 'bad') fail(`Row ${row.rowNo}: "${cellText(at(cells, h.cols.date))}" is not a real date.`);
      stopped = date.kind === 'none';
    }
    if (stopped) {
      stopAt = i;
      if (!rule && !isSummaryRow(cells)) guardAgainstCutOff(grid, h, i);
      break;
    }
    drafts.push(buildDraft(row.rowNo, cells, h, (date as { iso: string }).iso));
  }

  if (drafts.length === 0) return { ok: false, error: 'No transactions were found in this file.' };

  const warnings: string[] = [];

  // Oldest first. The balance chain decides the direction; the dates only break a tie
  // (a file where both directions chain, which needs ties or zero-sum rows).
  const reversedDrafts = [...drafts].reverse();
  const breakAsIs = firstChainBreak(drafts);
  const breakReversed = firstChainBreak(reversedDrafts);
  let datesDescending = true;
  for (let i = 1; i < drafts.length; i++) {
    const a = drafts[i - 1];
    const b = drafts[i];
    if (a && b && b.txnDate > a.txnDate) datesDescending = false;
  }
  const firstDraft = drafts[0];
  const lastDraft = drafts[drafts.length - 1];
  const looksNewestFirst = !!firstDraft && !!lastDraft && datesDescending && firstDraft.txnDate > lastDraft.txnDate;

  let ordered: Draft[];
  if (!breakAsIs && !breakReversed) ordered = looksNewestFirst ? reversedDrafts : drafts;
  else if (!breakAsIs) ordered = drafts;
  else if (!breakReversed) ordered = reversedDrafts;
  else {
    const bad = looksNewestFirst ? breakReversed : breakAsIs;
    return {
      ok: false,
      error: `Row ${bad.draft.rowNo}: the balance does not follow from the row above (expected ${formatPaise(bad.expected)}, the file shows ${formatPaise(bad.draft.balance)}). The statement may have been edited or have rows missing.`,
    };
  }
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    if (a && b && b.txnDate < a.txnDate) {
      warnings.push('The dates in this file are not in order. Check the balances before importing.');
      break;
    }
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return { ok: false, error: 'No transactions were found in this file.' };
  const opening = first.balance - first.credit + first.debit;
  const closing = last.balance;

  const footer = readFooter(rows, stopAt);
  if (footer.opening !== null && footer.opening !== opening) {
    warnings.push(
      `The opening balance worked out from the first row (${formatPaise(opening)}) differs from the statement summary (${formatPaise(footer.opening)}).`,
    );
  }
  if (footer.closing !== null && footer.closing !== closing) {
    warnings.push(
      `The closing balance on the last row (${formatPaise(closing)}) differs from the statement summary (${formatPaise(footer.closing)}).`,
    );
  }

  const lines: ParsedLine[] = ordered.map((d, i) => ({
    lineNo: i + 1,
    txnDate: d.txnDate,
    valueDate: d.valueDate,
    narration: d.narration,
    reference: d.reference,
    refHint: d.refHint,
    debit: formatPaise(d.debit),
    credit: formatPaise(d.credit),
    balance: formatPaise(d.balance),
    kind: d.kind,
  }));

  return {
    ok: true,
    lines,
    summary: {
      firstDate: first.txnDate,
      lastDate: last.txnDate,
      openingBalance: formatPaise(opening),
      closingBalance: formatPaise(closing),
      rowCount: lines.length,
      warnings,
    },
  };
}

// A row with no date ended the table. If dated transactions follow it (before any rule or summary),
// the file is damaged and silently dropping them would lose money rows, so refuse.
function guardAgainstCutOff(grid: Grid, h: Header, stopIndex: number): void {
  for (let j = stopIndex + 1; j < grid.rows.length; j++) {
    const gr = grid.rows[j];
    if (!gr) continue;
    const cells = grid.isText ? repairFields(gr.cells, h) : gr.cells;
    if (isRuleRow(cells) || isSummaryRow(cells)) return;
    if (readDate(at(cells, h.cols.date)).kind !== 'ok') continue;
    const d = readMoney(at(cells, h.cols.debit), false);
    const c = readMoney(at(cells, h.cols.credit), false);
    const nonZero = (m: Money) => m.kind === 'ok' && m.paise !== 0n;
    if (nonZero(d) || nonZero(c)) {
      fail(
        `Row ${grid.rows[stopIndex]?.rowNo ?? stopIndex + 1} has no date, but more transactions follow it, so the file may be damaged. Download the statement again from NetBanking.`,
      );
    }
  }
}
