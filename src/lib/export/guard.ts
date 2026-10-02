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

/**
 * A browser tells the server where a request came from in `Sec-Fetch-Site`: `same-origin` when the app's own page
 * (its Download button) triggered it, `none` for a typed or bookmarked address. `cross-site` and `same-site` mean
 * another page (an image tag, a link on a sibling site) fired the owner's download, which would spam the audit log
 * and burn CPU, so those get a 403. No header (curl, an old browser) is allowed: the owner-only gate still applies.
 */
export function crossSiteRefusal(fetchSite: string | null | undefined): Response | null {
  if (fetchSite == null) return null;
  const site = fetchSite.trim().toLowerCase();
  if (site === 'same-origin' || site === 'none') return null;
  return textResponse(403, 'Exports can only be started from the app itself.');
}

/** The signed-in verified owner, or the 403 to send back. Refuses a cross-site request before looking at anything else. */
export async function requireExportOwner(fetchSite?: string | null): Promise<{ member: CurrentMember; denied?: undefined } | { member?: undefined; denied: Response }> {
  const crossSite = crossSiteRefusal(fetchSite);
  if (crossSite) return { denied: crossSite };
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
