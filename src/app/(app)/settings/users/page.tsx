import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { UsersPanel, type UserRow } from '@/components/users/UsersPanel';
import { getCurrentMember } from '@/lib/auth/current';
import { formatDate, todayIn } from '@/lib/format';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';

export default async function UsersPage() {
  const member = await getCurrentMember();
  if (member?.role !== 'admin') redirect('/');

  const [t, ctx, supabase] = await Promise.all([getTranslations('users'), getShellContext(), createClient()]);
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

  return (
    <div className="screen">
      <div className="screenhead">
        <h1>{t('title')}</h1>
      </div>
      <UsersPanel users={users} currentUserId={member.userId} />
    </div>
  );
}
