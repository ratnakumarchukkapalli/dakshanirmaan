import { AccountPassword } from '@/components/auth/AccountPassword';

// Reached from the avatar menu; every signed-in member (an owner only after the authenticator step, like every screen).
export default function AccountPage() {
  return (
    <div className="screen">
      <AccountPassword />
    </div>
  );
}
