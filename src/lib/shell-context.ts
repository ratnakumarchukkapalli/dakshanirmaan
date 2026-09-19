import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getCurrentMember } from '@/lib/auth/current';
import { createClient } from '@/lib/supabase/server';

export interface ShellContext {
  role: 'admin' | 'user';
  name: string;
  gstin: string | null;
  timeZone: string;
}

/**
 * Facts the topbar needs, read as the signed-in user (RLS applies). proxy.ts has already turned
 * away everyone else; the redirect here is a second lock, not the first.
 */
export const getShellContext = cache(async (): Promise<ShellContext> => {
  const member = await getCurrentMember();
  if (!member) redirect('/login');
  const supabase = await createClient();
  const { data: org } = await supabase.from('organization').select('gstin, timezone').maybeSingle();
  return {
    role: member.role,
    name: member.name,
    gstin: org?.gstin ?? null,
    timeZone: org?.timezone ?? 'Asia/Kolkata',
  };
});
