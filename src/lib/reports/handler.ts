import 'server-only';
import { createTranslator } from 'next-intl';
import { NextResponse } from 'next/server';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { formatDate, todayIn } from '@/lib/format';
import { loadAgeing, loadCashBook, loadDayBookAll, loadStockReport, parseDayBookType } from '@/lib/reports-data';
import { parseRange } from '@/lib/reports-math';
import { cleanSearchText } from '@/lib/search';
import { createClient } from '@/lib/supabase/server';
import en from '@/messages/en.json';
import { buildAgeingWorkbook, buildCashBookWorkbook, buildDayBookWorkbook, buildStockWorkbook, reportFilename, type Translate } from './xlsx';

// GET /api/reports/[name]/xlsx — the Excel version of a report, with the same filters, the same
// loaders and the same role rules as its screen. Any active member (an owner only after the
// authenticator step); the cash & bank book is owner-only. Row-level security still decides what a
// session can read. Workbooks are always in English (like the statements).

export const REPORT_NAMES = ['aging', 'stock', 'day-book', 'cash-bank'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

const text = (status: number, body: string) =>
  new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function reportXlsxResponse(name: string, params: URLSearchParams): Promise<NextResponse> {
  if (!(REPORT_NAMES as readonly string[]).includes(name)) return text(404, 'Not found');
  const member = await getCurrentMember();
  if (!member || (member.role === 'admin' && member.aal !== 'aal2')) return text(401, 'Sign in to download reports.');
  const isAdmin = isVerifiedAdmin(member);
  if (name === 'cash-bank' && !isAdmin) return text(403, 'Only an owner can download the cash and bank book.');

  const supabase = await createClient();
  const orgRes = await supabase.from('organization').select('legal_name, timezone').maybeSingle();
  if (orgRes.error || !orgRes.data) return text(500, 'Could not prepare the report.');
  const org = orgRes.data.legal_name as string;
  const today = todayIn((orgRes.data.timezone as string | null) ?? 'Asia/Kolkata');
  const scoped = (ns: string) => createTranslator({ locale: 'en', messages: en, namespace: `reports.${ns}` } as never) as unknown as Translate;

  try {
    let buf: Buffer;
    let file: string;
    if (name === 'aging') {
      const q = cleanSearchText(params.get('q'));
      const t = scoped('aging');
      buf = await buildAgeingWorkbook(await loadAgeing(supabase, { isAdmin, q }), org, t, t('title'));
      file = reportFilename('Ageing', today);
    } else if (name === 'stock') {
      const t = scoped('stock');
      const report = await loadStockReport(supabase, { isAdmin, warehouse: params.get('wh') ?? undefined });
      buf = await buildStockWorkbook(report, isAdmin, org, t, t('title'));
      file = reportFilename('Stock', today);
    } else if (name === 'day-book') {
      const t = scoped('dayBook');
      const range = parseRange(params.get('from') ?? undefined, params.get('to') ?? undefined, today);
      const rows = await loadDayBookAll(supabase, { ...range, type: parseDayBookType(params.get('type') ?? undefined) });
      buf = await buildDayBookWorkbook(rows, range, org, t, t('title'));
      file = reportFilename('DayBook', `${range.from}_${range.to}`);
    } else {
      const t = scoped('cashBook');
      const range = parseRange(params.get('from') ?? undefined, params.get('to') ?? undefined, today);
      const book = await loadCashBook(supabase, { account: params.get('account') ?? undefined, ...range });
      buf = await buildCashBookWorkbook(book, range, org, t, t('title'));
      file = reportFilename(`CashBook-${book.account.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`, `${range.from}_${range.to}`);
    }
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'private, no-store' },
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'too_many') return text(422, `That range has too many rows for one workbook. Narrow the dates (from ${formatDate(today)} back).`);
    console.error('[reports] export failed:', name, e instanceof Error ? e.message : e);
    return text(500, 'Could not prepare the report.');
  }
}
