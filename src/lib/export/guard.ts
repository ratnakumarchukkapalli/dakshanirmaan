import 'server-only';
import { getCurrentMember, type CurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import type { ExportKind } from './kinds';
import type { Supabase } from './types';

// The gate every export route shares (full books, Tally file, year archive): an owner who has passed the
// authenticator step, and nobody else. A counter user, an owner at aal1 and a signed-out visitor all get
// the same 403, decided before the database is touched for anything.

export const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/** The signed-in verified owner, or the 403 to send back. */
export async function requireExportOwner(): Promise<{ member: CurrentMember; denied?: undefined } | { member?: undefined; denied: Response }> {
  const member = await getCurrentMember();
  if (!member || !isVerifiedAdmin(member)) return { denied: textResponse(403, 'Only an owner can export the books.') };
  return { member };
}

/**
 * Writes the audit row for an export (the `log_export` function). Call it before the first byte of the
 * file is sent and send nothing when it returns false: no audit row, no file.
 */
export async function recordExport(supabase: Supabase, kind: ExportKind, fy: number): Promise<boolean> {
  const { error } = await supabase.rpc('log_export', { p_kind: kind, p_fy: fy });
  if (error) {
    console.error('[export] audit row could not be written:', kind, fy, error.message);
    return false;
  }
  return true;
}
