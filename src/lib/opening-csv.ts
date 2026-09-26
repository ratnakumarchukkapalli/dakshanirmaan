// Opening-stock CSV: one row per item and godown, with a header row.
//   item,godown,qty,rate
//   UltraTech PPC 50kg,Head Godown,120,315.50
// Pure text handling. Quantities and rates stay text (never a float); the database re-checks everything.

export interface OpeningCsvRow {
  /** 1-based line number in the file, for error messages. */
  line: number;
  item: string;
  godown: string;
  qty: string;
  rate: string;
}

export type OpeningCsvProblemKey = 'empty' | 'header' | 'columns' | 'blank' | 'qty' | 'rate' | 'too_many' | 'repeated';
export interface OpeningCsvProblem { line: number; key: OpeningCsvProblemKey }

export const MAX_OPENING_CSV_ROWS = 500;

/** Splits CSV text into rows of cells: quoted cells (with "" escapes and embedded commas) and CRLF/LF. */
function splitCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowLine, cells });
    cells = [];
    cell = '';
  };
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else if (ch === '\r') { /* handled with the \n */ }
    else if (ch === '\n') { endRow(); line++; rowLine = line; }
    else cell += ch;
  }
  endRow();
  return rows;
}

const HEADERS: Record<'item' | 'godown' | 'qty' | 'rate', string[]> = {
  item: ['item', 'item name', 'name'],
  godown: ['godown', 'warehouse', 'location'],
  qty: ['qty', 'quantity'],
  rate: ['rate', 'cost', 'cost rate', 'unit cost'],
};

/** Parses the file. Any problem means nothing should be staged: callers use `rows` only when `problems` is empty. */
export function parseOpeningCsv(text: string): { rows: OpeningCsvRow[]; problems: OpeningCsvProblem[] } {
  const all = splitCsv(text);
  if (all.length === 0) return { rows: [], problems: [{ line: 1, key: 'empty' }] };

  const head = all[0]!.cells.map((c) => c.trim().toLowerCase());
  const at = (k: keyof typeof HEADERS) => head.findIndex((h) => HEADERS[k].includes(h));
  const idx = { item: at('item'), godown: at('godown'), qty: at('qty'), rate: at('rate') };
  if (Object.values(idx).some((i) => i < 0)) return { rows: [], problems: [{ line: all[0]!.line, key: 'header' }] };

  const body = all.slice(1);
  if (body.length === 0) return { rows: [], problems: [{ line: all[0]!.line, key: 'empty' }] };
  if (body.length > MAX_OPENING_CSV_ROWS) return { rows: [], problems: [{ line: body[MAX_OPENING_CSV_ROWS]!.line, key: 'too_many' }] };

  const rows: OpeningCsvRow[] = [];
  const problems: OpeningCsvProblem[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of body) {
    if (cells.length !== head.length) { problems.push({ line, key: 'columns' }); continue; }
    const row: OpeningCsvRow = {
      line,
      item: cells[idx.item]!.trim(),
      godown: cells[idx.godown]!.trim(),
      qty: cells[idx.qty]!.trim(),
      rate: cells[idx.rate]!.trim(),
    };
    if (!row.item || !row.godown) problems.push({ line, key: 'blank' });
    else if (!/^\d+(\.\d{1,3})?$/.test(row.qty) || !/[1-9]/.test(row.qty)) problems.push({ line, key: 'qty' });
    else if (!/^\d+(\.\d{1,4})?$/.test(row.rate) || !/[1-9]/.test(row.rate)) problems.push({ line, key: 'rate' });
    else {
      const key = `${row.item.toLowerCase()}|${row.godown.toLowerCase()}`;
      if (seen.has(key)) problems.push({ line, key: 'repeated' });
      seen.add(key);
      rows.push(row);
    }
  }
  return { rows, problems };
}
