import 'server-only';
import { renderToBuffer } from '@react-pdf/renderer';
import { Readable } from 'node:stream';
import { registerFonts } from '@/lib/invoice-pdf/fonts';
import { buildGstr1File } from '@/lib/gstr1-file';
import { prepareReports } from './archive-reports';
import { planGstr1, readmeText } from './archive-readme';
import { buildBooksTables, prepareBooks, type BooksPrep } from './books-tables';
import { countExpected, writeBooksWorkbook } from './books-workbook';
import { recordExport, textResponse } from './guard';
import { Lookups } from './lookups';
import { exportFileName } from './period';
import { reportDocument } from './report-pdf';
import { openExport } from './session';
import { buildTallyModel, TallyExportError } from './tally-model';
import { renderMasters, renderVouchers, utf16Chunks } from './tally-render';
import { rowObjects } from './table';
import { formatThousands } from './numbers';
import { EXPORT_ROW_CAP, RowCapError, type ExportContext, type ExportRow, type ExportTable } from './types';
import { ZipStream } from './zip';

// GET /api/backup/archive.zip?fy=2026 — the year as one self-contained, offline-readable ZIP: README.txt,
// books.xlsx, tally/*.xml, data/*.json (+ schema.json), reports/*.pdf, gst/*.json and MANIFEST.sha256.
// Owner at aal2 only. Streamed straight into the response (nothing touches the disk). Order of events,
// so that nothing is sent unless everything that can be checked beforehand is right:
//   1. gate + organisation + financial year           -> 403 / 400 / 500
//   2. trial balance and GST summaries                -> 500
//   3. row counts, the 200,000-row cap                -> 422
//   4. the Tally model: every voucher balanced        -> 422 naming the entry / 500
//   5. the statements' data (P&L, balance sheet, ageing, stock) -> 500
//   6. the audit row (`log_export`)                   -> 500 and no file when it fails
//   7. the zip, streamed; a failure after this point destroys the stream (the download fails, it never
//      ends as a file that looks complete).

const INTERNAL = 'Something went wrong and nothing was sent. Please try again.';

/** 'Sales invoice lines' -> 'sales-invoice-lines' */
export const dataFileName = (tableName: string): string => `${tableName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.json`;

const COLUMN_TYPES: Record<string, string> = {
  text: 'string', int: 'number (whole)', money: 'string: decimal text, 2 places, may be negative', qty: 'string: decimal text, 3 places',
  rate: 'string: decimal text, 4 places', date: 'string: ISO date YYYY-MM-DD', datetime: 'string: ISO 8601 instant', bool: 'boolean',
};

/** One table as a JSON array, in chunks of about 64 KB. `count` is filled as it goes. */
export async function* jsonChunks(table: ExportTable, count: { rows: number }): AsyncGenerator<string> {
  let buffer = '[';
  for await (const obj of rowObjects(table)) {
    buffer += `${count.rows === 0 ? '\n' : ',\n'}${JSON.stringify(obj)}`;
    count.rows += 1;
    if (buffer.length >= 65_536) {
      yield buffer;
      buffer = '';
    }
  }
  yield `${buffer}${count.rows === 0 ? '' : '\n'}]\n`;
}

/** A table whose rows were already read once (stock on hand): replayed from memory. */
const replay = (table: ExportTable, rows: ExportRow[]): ExportTable => ({
  ...table,
  async *rows() {
    yield* rows;
  },
});

export async function archiveResponse(fyParam: string | null): Promise<Response> {
  const opened = await openExport(fyParam);
  if (opened.response) return opened.response;
  const { ctx } = opened;

  // ---- everything that can fail cleanly, before a byte is sent
  let prep: BooksPrep;
  try {
    prep = await prepareBooks(ctx);
  } catch (e) {
    console.error('[export] archive: preparation failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }
  const built = buildBooksTables(ctx, prep);
  let expected: (number | null)[];
  try {
    expected = await countExpected(built.tables);
  } catch (e) {
    if (e instanceof RowCapError) {
      return textResponse(422, `The "${e.table}" table has more than ${formatThousands(EXPORT_ROW_CAP)} rows. This year is too large to archive in one piece; export it quarter by quarter from the Excel and Tally downloads instead.`);
    }
    console.error('[export] archive: counting failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  let tally;
  try {
    tally = await buildTallyModel(ctx, prep.trialBalance);
  } catch (e) {
    if (e instanceof TallyExportError) return textResponse(422, e.message);
    console.error('[export] archive: tally model failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  let reports;
  try {
    reports = await prepareReports(ctx, prep, new Lookups(ctx));
  } catch (e) {
    console.error('[export] archive: statements failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  if (!(await recordExport(ctx.supabase, 'archive', ctx.fy.startYear))) return textResponse(500, INTERNAL);

  const zip = new ZipStream();
  void writeArchive(ctx, zip, { prep, built, expected, tally, reports }).catch((e: unknown) => {
    console.error('[export] archive failed mid-stream:', e instanceof Error ? e.message : e);
    zip.abort(e instanceof Error ? e : new Error(String(e)));
  });

  return new Response(Readable.toWeb(zip.out) as unknown as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${exportFileName('archive', ctx.fy, 'zip')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

interface Parts {
  prep: BooksPrep;
  built: ReturnType<typeof buildBooksTables>;
  expected: (number | null)[];
  tally: Awaited<ReturnType<typeof buildTallyModel>>;
  reports: Awaited<ReturnType<typeof prepareReports>>;
}

/** Writes every file into the zip, README first and MANIFEST last. Rejects on any failure; the caller aborts the stream. */
export async function writeArchive(ctx: ExportContext, zip: ZipStream, parts: Parts): Promise<void> {
  const { prep, built, expected, tally, reports } = parts;
  const gstr1 = planGstr1(prep.gst);

  // Tables for the JSON files: a fresh set (its own journal counters), with stock on hand replayed from the read the PDF already made.
  const fresh = buildBooksTables(ctx, prep);
  const tables = fresh.tables.map((t) => (t.name === 'Stock on hand' ? replay(t, reports.stockRows) : t));
  const files = tables.map((t) => ({ table: t, path: `data/${dataFileName(t.name)}` }));
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error('archive: two tables share a file name');

  // ---- README.txt
  const readme = readmeText({
    ctx,
    dataFiles: [
      ...files.map((f, i) => ({ path: f.path, description: f.table.description, rows: expected[i] ?? null })),
      { path: 'data/schema.json', description: 'Every data file: its table, row count and each column with its type.', rows: null },
    ],
    reportPaths: reports.files.map((r) => r.path),
    omittedReports: reports.omitted,
    gstr1,
    tally: { ledgers: tally.ledgers.filter((l) => !l.skipMaster).length, vouchers: tally.vouchers.length, hasOpeningVoucher: tally.stats.hasOpeningVoucher },
    trialBalanceBalanced: prep.trialBalance.balanced,
    skippedSheets: built.skipped,
  });
  await zip.add('README.txt', [readme]);

  // ---- books.xlsx (the workbook of part A, written into the zip entry)
  await zip.addFromWriter('books.xlsx', (out) => writeBooksWorkbook(ctx, prep, built, expected, out), { store: true });

  // ---- tally/
  await zip.add('tally/masters.xml', utf16Chunks(renderMasters(tally.ledgers, null)));
  await zip.add('tally/vouchers.xml', utf16Chunks(renderVouchers(tally.vouchers, null)));

  // ---- data/*.json and schema.json
  const schema: Record<string, unknown> = {};
  for (const [i, f] of files.entries()) {
    const count = { rows: 0 };
    await zip.add(f.path, jsonChunks(f.table, count));
    const wanted = expected[i] ?? null;
    if (wanted !== null && wanted !== count.rows) throw new Error(`archive: ${f.path} got ${count.rows} rows but ${wanted} were counted`);
    schema[f.path] = {
      table: f.table.name,
      description: f.table.description,
      rows: count.rows,
      columns: f.table.columns.map((c) => ({ key: c.key, heading: c.header, type: c.type, format: COLUMN_TYPES[c.type] })),
    };
  }
  await zip.add('data/schema.json', [JSON.stringify({
    organisation: ctx.orgName,
    financial_year: ctx.fy.label,
    from: ctx.fy.from,
    to: ctx.fy.to,
    data_as_of: ctx.asOf,
    conventions: 'Money, quantities and rates are decimal text; dates are ISO dates; instants are ISO 8601. A null is an empty value. Trial balance, stock on hand, GST and party ledger are computed tables; the others are rows of the books.',
    files: schema,
  }, null, 2), '\n']);

  // ---- reports/*.pdf
  registerFonts();
  for (const r of reports.files) {
    const pdf = await renderToBuffer(reportDocument(r.spec));
    await zip.add(r.path, [pdf], { store: true });
  }

  // ---- gst/*.json
  for (const g of gstr1.include) await zip.add(g.path, [JSON.stringify(buildGstr1File(g.data), null, 2), '\n']);

  // ---- MANIFEST.sha256 (every file above, not itself)
  await zip.add('MANIFEST.sha256', [zip.manifestText()]);
  zip.finish();
}
