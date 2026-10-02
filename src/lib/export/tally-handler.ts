import 'server-only';
import { loadTrialBalance } from '@/lib/books-data';
import { Readable } from 'node:stream';
import { recordExport, textResponse } from './guard';
import { TALLY_PARTS, type TallyPart } from './kinds';
import { exportFileName } from './period';
import { openExport } from './session';
import { buildTallyModel, TallyExportError } from './tally-model';
import { renderMasters, renderVouchers, utf16Chunks } from './tally-render';
import { singleLine } from './tally-xml';

// GET /api/reports/tally.xml?fy=2026&part=masters|vouchers[&company=Name] — the books of one year in
// Tally's XML import format. Owner at aal2 only. Two files, imported in this order:
//   part=masters   every ledger (chart accounts and parties) under Tally's default groups, opening balance 0
//   part=vouchers  an opening Journal of the balances carried in, then every posted entry of the year
// Order of events (nothing is sent unless everything is right):
//   1. gate + organisation + financial year      -> 403 / 400 / 500
//   2. `part`                                    -> 400
//   3. the whole model is built; every voucher checked to the paisa and every account checked against the
//      trial balance                              -> 422 naming the entry or account / 500
//   4. the audit row (`log_export`)              -> 500 and no file when it fails
//   5. the file, streamed as UTF-16LE with a byte-order mark

const INTERNAL = 'Something went wrong and nothing was sent. Please try again.';

export async function tallyResponse(fyParam: string | null, partParam: string | null, companyParam: string | null, fetchSite?: string | null): Promise<Response> {
  const opened = await openExport(fyParam, fetchSite);
  if (opened.response) return opened.response;
  const { ctx } = opened;

  if (!TALLY_PARTS.includes(partParam as TallyPart)) {
    return textResponse(400, 'Say which Tally file you want: part=masters (the ledgers, import first) or part=vouchers.');
  }
  const part = partParam as TallyPart;
  // Only an explicit company name goes into the file (research: the default imports into whichever company is open).
  const company = companyParam && singleLine(companyParam) !== '' ? singleLine(companyParam) : null;

  let model;
  try {
    model = await buildTallyModel(ctx, await loadTrialBalance(ctx.supabase, ctx.fy.to));
  } catch (e) {
    if (e instanceof TallyExportError) return textResponse(422, e.message);
    console.error('[export] tally: could not build the model:', e instanceof Error ? e.message : e);
    return textResponse(500, INTERNAL);
  }

  if (!(await recordExport(ctx.supabase, 'tally', ctx.fy.startYear))) return textResponse(500, INTERNAL);

  const text = part === 'masters' ? renderMasters(model.ledgers, company) : renderVouchers(model.vouchers, company);
  return new Response(Readable.toWeb(Readable.from(utf16Chunks(text))) as unknown as ReadableStream<Uint8Array>, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-16',
      'Content-Disposition': `attachment; filename="${exportFileName('tally', ctx.fy, 'xml', part)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
