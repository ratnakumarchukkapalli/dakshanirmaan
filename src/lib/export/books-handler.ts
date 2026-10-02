import 'server-only';
import { formatThousands } from './numbers';
import { buildBooksTables, prepareBooks, type BooksPrep } from './books-tables';
import { countExpected, streamBooksWorkbook } from './books-workbook';
import { recordExport, textResponse } from './guard';
import { exportFileName } from './period';
import { openExport } from './session';
import { EXPORT_ROW_CAP, RowCapError } from './types';

// GET /api/backup/books.xlsx?fy=2026 — the full-books workbook. Owner at aal2 only (403 for anyone else,
// before any book is read). Order of events, so that nothing is sent unless everything is right:
//   1. gate + organisation + financial year          -> 403 / 400 / 500
//   2. trial balance and GST summaries               -> 500
//   3. row counts, the 200,000-row cap               -> 422
//   4. the audit row (`log_export`)                  -> 500 and no file when it fails
//   5. the workbook, streamed

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const INTERNAL = 'Something went wrong and nothing was sent. Please try again.';

export async function booksResponse(fyParam: string | null, fetchSite?: string | null): Promise<Response> {
  const opened = await openExport(fyParam, fetchSite);
  if (opened.response) return opened.response;
  const { ctx } = opened;

  let prep: BooksPrep;
  try {
    prep = await prepareBooks(ctx);
  } catch (e) {
    console.error('[export] books: preparation failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  const built = buildBooksTables(ctx, prep);
  let expected: (number | null)[];
  try {
    expected = await countExpected(built.tables);
  } catch (e) {
    if (e instanceof RowCapError) {
      return textResponse(422, `The "${e.table}" sheet has more than ${formatThousands(EXPORT_ROW_CAP)} rows, more than one workbook sheet can hold. This year is too large to export as one workbook.`);
    }
    console.error('[export] books: counting failed:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  if (!(await recordExport(ctx.supabase, 'books', ctx.fy.startYear))) return textResponse(500, INTERNAL);

  return new Response(streamBooksWorkbook(ctx, prep, built, expected), {
    headers: {
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="${exportFileName('books', ctx.fy, 'xlsx')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
