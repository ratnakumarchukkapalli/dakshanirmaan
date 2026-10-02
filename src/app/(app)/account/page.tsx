import { redirect } from 'next/navigation';
import { AccountPassword } from '@/components/auth/AccountPassword';
import { getCurrentMember } from '@/lib/auth/current';

// Reached from the avatar menu; every signed-in member (an owner only after the authenticator step, like every screen).
export default async function AccountPage() {
  const member = await getCurrentMember();
  if (!member) redirect('/login');
  return (
    <div className="screen">
      <AccountPassword role={member.role} />
    </div>
  );
}
