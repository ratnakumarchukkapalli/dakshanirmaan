import 'server-only';
import { cache } from 'react';
import { isSessionExpired } from '@/lib/auth/session-age';
import { createClient } from '@/lib/supabase/server';

export interface CurrentMember {
  userId: string;
  role: 'admin' | 'user';
  name: string;
  aal: 'aal1' | 'aal2';
}

/**
 * The signed-in, active member for this request, or null. Server components and actions only.
 * The database re-checks everything that matters; this is for routing and early refusal.
 */
export const getCurrentMember = cache(async (): Promise<CurrentMember | null> => {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const claims = claimsData?.claims;
  if (!claims?.sub) return null;
  // The 8-hour session limit is also enforced by the proxy; checking it here too means no caller
  // depends on the proxy having run. An age that cannot be established counts as expired.
  if (isSessionExpired(claims.amr, Date.now())) return null;
  const { data: row } = await supabase
    .from('app_users')
    .select('role, name, is_active')
    .eq('user_id', claims.sub)
    .maybeSingle();
  if (!row?.is_active) return null;
  return {
    userId: claims.sub,
    role: row.role === 'admin' ? 'admin' : 'user',
    name: row.name,
    aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
  };
});
