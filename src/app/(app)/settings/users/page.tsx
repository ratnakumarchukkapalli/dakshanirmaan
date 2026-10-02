import { UsersPanel } from '@/components/users/UsersPanel';
import { requireOwnerPage } from '@/lib/auth/require';
import { getShellContext } from '@/lib/shell-context';
import { createClient } from '@/lib/supabase/server';
import { loadUserRows } from '@/lib/users-data';

export default async function UsersPage() {
  const member = await requireOwnerPage();
  const [ctx, supabase] = await Promise.all([getShellContext(), createClient()]);
  return <UsersPanel users={await loadUserRows(supabase, ctx.timeZone)} currentUserId={member.userId} />;
}
