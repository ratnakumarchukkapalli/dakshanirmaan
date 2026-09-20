import { redirect } from 'next/navigation';
import { UsersPanel, type UserRow } from '@/components/users/UsersPanel';
import { getCurrentMember } from '@/lib/auth/current';
import { isVerifiedAdmin } from '@/lib/auth/require';
import { formatDate, todayIn } from '@/lib/format';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

export default async function UsersPage() {
  const member = await getCurrentMember();
  if (!member || !isVerifiedAdmin(member)) redirect('/');

  const [ctx, supabase] = await Promise.all([getShellContext(), createClient()]);
  const { data } = await supabase
    .from('app_users')
    .select('user_id, email, name, role, is_active, invited_at')
    .order('created_at');

  const users: UserRow[] = (data ?? []).map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role === 'admin' ? 'admin' : 'user',
    isActive: r.is_active,
    // The stored moment is a timestamp; show the business date in the organisation's time zone.
    invitedOn: r.invited_at ? formatDate(todayIn(ctx.timeZone, new Date(r.invited_at))) : null,
  }));

  return <UsersPanel users={users} currentUserId={member.userId} />;
}
