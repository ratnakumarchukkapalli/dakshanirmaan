import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/AuthCard';
import { MfaForm } from '@/components/auth/MfaForm';
import { createClient } from '@/lib/supabase/server';

// Admins only (proxy.ts sends them here until the authenticator step is done). First visit
// shows set-up; later visits just ask for the 6-digit code.
export default async function MfaPage() {
  const t = await getTranslations('mfa');
  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const mode = factors?.totp.length ? 'verify' : 'enroll';
  return (
    <AuthCard title={mode === 'verify' ? t('titleVerify') : t('titleEnroll')}>
      <MfaForm mode={mode} />
    </AuthCard>
  );
}
