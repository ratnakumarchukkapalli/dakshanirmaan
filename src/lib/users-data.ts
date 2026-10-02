import 'server-only';
import type { UserRow } from '@/components/users/UsersPanel';
import { formatDate, todayIn } from '@/lib/format';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Who has set up an authenticator app, by user id, from the database function `owner_totp_status()` (an
 * owner at aal2 only). Returns null when the answer cannot be had (the function is missing, errored, or
 * answered something unexpected): the screen then shows nothing rather than a wrong "no".
 */
export async function loadTotpStatus(supabase: Supabase): Promise<Map<string, boolean> | null> {
  const { data, error } = await supabase.rpc('owner_totp_status');
  if (error || !Array.isArray(data)) return null;
  const out = new Map<string, boolean>();
  for (const r of data as { user_id?: unknown; has_totp?: unknown }[]) {
    if (typeof r?.user_id === 'string' && typeof r.has_totp === 'boolean') out.set(r.user_id, r.has_totp);
  }
  return out;
}

/** The people on the Users screen. `hasTotp` is only filled in for active owners, and null when unknown. */
export async function loadUserRows(supabase: Supabase, timeZone: string): Promise<UserRow[]> {
  const [{ data }, totp] = await Promise.all([
    supabase.from('app_users').select('user_id, email, name, role, is_active, invited_at').order('created_at'),
    loadTotpStatus(supabase),
  ]);
  return (data ?? []).map((r) => {
    const isOwner = r.role === 'admin';
    return {
      userId: r.user_id,
      email: r.email,
      name: r.name,
      role: isOwner ? 'admin' : 'user',
      isActive: r.is_active,
      // The stored moment is a timestamp; show the business date in the organisation's time zone.
      invitedOn: r.invited_at ? formatDate(todayIn(timeZone, new Date(r.invited_at))) : null,
      hasTotp: isOwner && r.is_active ? (totp?.get(r.user_id) ?? null) : null,
    };
  });
}
