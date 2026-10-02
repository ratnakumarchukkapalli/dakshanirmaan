import 'server-only';
import { PassThrough, Readable, type Writable } from 'node:stream';
import type { TrialBalance } from '@/lib/books-data';
import { formatDate } from '@/lib/format';
import { fromScaled } from './decimal';
import { createWorkbook, writeTableSheet, writeTextSheet } from './xlsx';
import { generatedAtText } from './period';
import { type BooksPrep, type BooksTables, type JournalStats } from './books-tables';
import { EXPORT_ROW_CAP, RowCapError, type ExportContext, type ExportTable } from './types';

// Assembles the full-books workbook (change 25, part A): README first, then every table in order, then a
// Checks sheet with what could only be known after the data had been read. Sheets are written one at a
// time straight into the response stream.

type Ctx = ExportContext;

/** Row counts taken before anything is sent (null = not known cheaply). Refuses a sheet over the cap. */
export async function countExpected(tables: ExportTable[], cap: number = EXPORT_ROW_CAP): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  // A few head requests at a time: they are cheap, but a free-tier database has few connections.
  for (let i = 0; i < tables.length; i += 4) {
    const batch = await Promise.all(tables.slice(i, i + 4).map((t) => (t.expectedRows ? t.expectedRows() : Promise.resolve(null))));
    batch.forEach((n, j) => {
      if (n !== null && n > cap) throw new RowCapError(tables[i + j]!.name, cap);
    });
    out.push(...batch);
  }
  return out;
}

/**
 * Rows that changed (a cancellation, a cheque status, a bank line matched) after the as-of instant: the
 * sheets may then differ from each other. Cash deposits and day closes keep no change timestamp, so a
 * change to those cannot be counted (stated on the Checks sheet).
 */
export async function countChangedAfter(ctx: Pick<Ctx, 'supabase' | 'asOf'>): Promise<number> {
  let total = 0;
  for (const table of ['sales_invoices', 'purchase_invoices', 'credit_notes', 'debit_notes', 'payments', 'expense_vouchers']) {
    const res = await ctx.supabase.from(table).select('id', { count: 'exact', head: true }).gt('updated_at', ctx.asOf).lte('created_at', ctx.asOf).neq('status', 'draft');
    if (res.error || typeof res.count !== 'number') throw new Error(`export changed-after ${table}: ${res.error?.message ?? 'no count'}`);
    total += res.count;
  }
  const bank = await ctx.supabase.from('bank_statement_lines').select('id', { count: 'exact', head: true }).gt('matched_at', ctx.asOf).lte('created_at', ctx.asOf);
  if (bank.error || typeof bank.count !== 'number') throw new Error(`export changed-after bank_statement_lines: ${bank.error?.message ?? 'no count'}`);
  return total + bank.count;
}

const when = (iso: string, tz: string) => generatedAtText(new Date(iso), tz);

export function readmeRows(ctx: Ctx, built: BooksTables, expected: (number | null)[], tb: TrialBalance) {
  const fy = ctx.fy;
  const rows: { cells: (string | number | null)[]; bold?: boolean }[] = [
    { cells: [`${ctx.orgName} — full books, financial year ${fy.label}`, null, null], bold: true },
    { cells: ['Financial year', `${fy.label} (${formatDate(fy.from)} to ${formatDate(fy.to)})`, null] },
    { cells: ['Generated', `${generatedAtText(new Date(), ctx.timeZone)} by ${ctx.generatedBy}`, null] },
    { cells: ['Data as of', `${when(ctx.asOf, ctx.timeZone)}. The journal and document sheets leave out anything created after this moment. The trial balance and GST sheets are read from the database reports a moment later. A document cancelled while the export was running is counted on the Checks sheet.`, null] },
    { cells: ['Trial balance check', tb.balanced ? `Total debits ${tb.totalDebit} equal total credits ${tb.totalCredit} on ${formatDate(fy.to)}: OK` : `CHECK FAILED: total debits ${tb.totalDebit} differ from total credits ${tb.totalCredit} on ${formatDate(fy.to)}`, null] },
    { cells: ['More checks', 'The last sheet, "Checks", has the journal totals, the row count of every sheet against the count taken before the export, and any document that changed while the export ran.', null] },
    { cells: ['Amounts', 'Rupees to the paisa. Money, quantities and rates are real numbers (not text), so you can sum, sort and filter them. Rates keep 4 decimal places and quantities 3.', null] },
    { cells: ['Cancelled documents', 'Cancelled documents and the entries that reverse them are included and marked in the Status columns. Drafts (documents never posted) are not included.', null] },
    { cells: ['Names and snapshots', 'Document lines show the item name, HSN code and GST rate as they were when the document was posted. Party and godown names are the names in the masters today. Sales invoices and credit notes show the buyer GSTIN saved on the document (empty = unregistered buyer); purchase invoices and debit notes keep none, so their Party GSTIN (master today) column is the GSTIN in the party master now.', null] },
    { cells: ['Text safety', 'A text that starts with = + - @, a tab or a carriage return is shown with a leading apostrophe, so no spreadsheet or CSV import can run it as a formula.', null] },
    { cells: ['Not included', 'Bill photos and other attachments, sign-in accounts and security settings, per-person salary rates, quotations, and delivery-challan and stock-transfer headers (their effect on the books is in the Journal and Stock movements sheets).', null] },
    { cells: ['Opening balances', 'Balances entered at go-live are in the Journal as entries from source "opening".', null] },
    ...built.skipped.map((s) => ({ cells: ['Sheet not included', `${s.sheet}: ${s.reason}`, null] as (string | number | null)[] })),
    { cells: [null, null, null] },
    { cells: ['Sheet', 'What it holds', 'Rows'], bold: true },
    ...built.tables.map((t, i) => ({ cells: [t.name, t.description, expected[i] ?? null] as (string | number | null)[] })),
    { cells: ['Checks', 'Journal totals, row counts written against row counts expected, documents changed during the export.', null] },
  ];
  return rows;
}

export function checksRows(ctx: Ctx, built: BooksTables, expected: (number | null)[], written: number[], changed: number, tb: TrialBalance) {
  const j: JournalStats = built.journalStats;
  const journalOk = j.debit === j.credit;
  const rows: { cells: (string | number | null)[]; bold?: boolean }[] = [
    { cells: ['Check', 'Result', 'Detail', null], bold: true },
    { cells: ['Journal debits equal credits', journalOk ? 'OK' : 'FAILED', `Debits ${fromScaled(j.debit, 2)}, credits ${fromScaled(j.credit, 2)}, over ${j.lines} lines in ${j.entries} entries dated ${formatDate(ctx.fy.from)} to ${formatDate(ctx.fy.to)}.`, null] },
    { cells: ['Every journal entry balances', j.unbalanced.length === 0 ? 'OK' : 'FAILED', j.unbalanced.length === 0 ? 'No entry has debits different from credits.' : `Entry numbers: ${j.unbalanced.join(', ')}`, null] },
    { cells: ['Trial balance debits equal credits', tb.balanced ? 'OK' : 'FAILED', `Debits ${tb.totalDebit}, credits ${tb.totalCredit} on ${formatDate(ctx.fy.to)}.`, null] },
    { cells: ['Changed while exporting', changed === 0 ? 'OK' : 'CHECK', changed === 0 ? 'No document or bank line changed after the as-of moment. (Cash deposits and day closes keep no change time, so a change to those cannot be detected.)' : `${changed} document(s) or bank line(s) changed after the as-of moment (a cancellation, a cheque status, a match). Export again if you need sheets that agree to the last rupee.`, null] },
    { cells: [null, null, null, null] },
    { cells: ['Sheet', 'Result', 'Rows written', 'Rows expected (counted before the export)'], bold: true },
    ...built.tables.map((t, i) => {
      const e = expected[i] ?? null;
      return { cells: [t.name, e === null ? 'n/a' : e === written[i] ? 'OK' : 'MISMATCH', written[i] ?? 0, e] as (string | number | null)[] };
    }),
  ];
  return rows;
}

/**
 * Writes the whole workbook into `out` (any Node writable: the response stream here, a zip entry in the
 * year archive). Resolves when the workbook is complete; a failure rejects, and the caller must then
 * destroy `out` so that the download fails instead of ending as a file that looks complete.
 */
export async function writeBooksWorkbook(ctx: Ctx, prep: BooksPrep, built: BooksTables, expected: (number | null)[], out: Writable): Promise<void> {
  const wb = createWorkbook(out, ctx.orgName);
  writeTextSheet(wb, 'README', readmeRows(ctx, built, expected, prep.trialBalance), [26, 100, 12]);
  const written: number[] = [];
  for (const [i, table] of built.tables.entries()) {
    const n = await writeTableSheet(wb, table, ctx.timeZone);
    written.push(n);
    // A short read (an API row limit lower than a page, a row removed meanwhile) must never become a file that looks complete.
    const wanted = expected[i] ?? null;
    if (wanted !== null && wanted !== n) throw new Error(`export: the "${table.name}" sheet got ${n} rows but ${wanted} were counted`);
  }
  const changed = await countChangedAfter(ctx);
  writeTextSheet(wb, 'Checks', checksRows(ctx, built, expected, written, changed, prep.trialBalance), [36, 12, 90, 36]);
  await wb.commit();
}

/** The workbook as a byte stream for an HTTP response. Everything that can fail cleanly (counts, the row cap) has been done by the caller. */
export function streamBooksWorkbook(ctx: Ctx, prep: BooksPrep, built: BooksTables, expected: (number | null)[]): ReadableStream<Uint8Array> {
  const out = new PassThrough();
  void writeBooksWorkbook(ctx, prep, built, expected, out).catch((e: unknown) => {
    console.error('[export] books workbook failed mid-stream:', e instanceof Error ? e.message : e);
    out.destroy(e instanceof Error ? e : new Error(String(e)));
  });
  return Readable.toWeb(out) as unknown as ReadableStream<Uint8Array>;
}
