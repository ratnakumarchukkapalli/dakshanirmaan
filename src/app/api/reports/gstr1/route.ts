import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { loadGstr1 } from '@/lib/books-data';
import { todayIn } from '@/lib/format';
import { blockingWarnings, buildGstr1File, gstr1Filename, periodOrDefault } from '@/lib/gstr1-file';
import { createClient } from '@/lib/supabase/server';
import { buildGstr1Workbook } from '@/lib/reports/xlsx-books';

// GET /api/reports/gstr1?period=YYYY-MM[&format=xlsx] — GSTR-1 for the portal (JSON) or as a workbook.
// Owner past the authenticator step only. The figures are `gstr1_data`'s; a file with a problem the
// portal would reject (no HSN, an unmapped unit, an export, no organisation GSTIN) is withheld with the
// reason rather than handed out.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const text = (status: number, body: string) =>
  new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  const member = await getCurrentMember();
  if (!member || (member.role === 'admin' && member.aal !== 'aal2')) return text(401, 'Sign in to download returns.');
  if (!isVerifiedAdmin(member)) return text(403, 'Only an owner can download GST returns.');

  const supabase = await createClient();
  const orgRes = await supabase.from('organization').select('legal_name, timezone').maybeSingle();
  if (orgRes.error || !orgRes.data) return text(500, 'Could not prepare the return.');
  const today = todayIn((orgRes.data.timezone as string | null) ?? 'Asia/Kolkata');
  const period = periodOrDefault(request.nextUrl.searchParams.get('period'), today);
  const xlsx = request.nextUrl.searchParams.get('format') === 'xlsx';

  try {
    const data = await loadGstr1(supabase, period);
    const blocked = blockingWarnings(data);
    if (blocked.length > 0) return text(422, `This month cannot be exported yet: ${blocked.join(', ')}. Fix them on the GST screen first.`);

    if (xlsx) {
      const buf = await buildGstr1Workbook(data, orgRes.data.legal_name as string);
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${gstr1Filename(period, 'xlsx')}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }
    return new NextResponse(JSON.stringify(buildGstr1File(data), null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${gstr1Filename(period)}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error('[gstr1] export failed:', e instanceof Error ? e.message : e);
    return text(500, 'Could not prepare the return.');
  }
}
