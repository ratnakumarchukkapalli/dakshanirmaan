import { NextResponse, type NextRequest } from 'next/server';
import { ATTACHMENT_BUCKET } from '@/lib/attachments-data';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Opens one bill photo: a verified owner is sent to a 60-second signed address for the file. There is
// no public URL; the row is read through RLS first, so anyone else (and a bad id) gets the same 404.
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isVerifiedAdmin(await getCurrentMember())) return new NextResponse(null, { status: 403, headers: NO_STORE });
  if (!isUuid(id)) return new NextResponse(null, { status: 404, headers: NO_STORE });

  const supabase = await createClient();
  const { data: row, error } = await supabase.from('attachments').select('storage_path').eq('id', id).maybeSingle();
  if (error) {
    console.error('[attachments] read failed:', error.message);
    return new NextResponse(null, { status: 500, headers: NO_STORE });
  }
  if (!row) return new NextResponse(null, { status: 404, headers: NO_STORE });

  const { data, error: signError } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(row.storage_path as string, 60);
  if (signError || !data) return new NextResponse(null, { status: 404, headers: NO_STORE });
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: NO_STORE });
}
