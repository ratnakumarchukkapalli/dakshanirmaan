'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { allowCodeCheck, allowCodeRequest, allowTotpCheck } from '@/lib/auth/rate-limit';
import { getCurrentMember } from '@/lib/auth/current';
import { clientIp } from '@/lib/http';
import { isLocale } from '@/i18n/config';
import { writeLocaleCookie } from '@/i18n/cookie';
import { createClient } from '@/lib/supabase/server';
import { requestCodeSchema, verifyCodeSchema, verifyTotpSchema } from '@/schemas/auth';

/**
 * Step 1 of sign-in: email a one-time code. The reply is identical whether or not the email is
 * registered, so this cannot be used to find out who works here.
 */
export async function requestCode(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const parsed = requestCodeSchema.safeParse(input);
  if (!parsed.success) return fail('validation', t('field.email_invalid'));
  const { email } = parsed.data;

  if (!allowCodeRequest(email, await clientIp())) return fail('rate_limited', t('rate_limited'));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) {
    // Unknown / disabled emails land here too and must look like success. Real faults must not.
    if (error.code === 'over_email_send_rate_limit' || error.status === 429) return fail('rate_limited', t('rate_limited'));
    if (!error.status || error.status >= 500) {
      console.error('[auth] sign-in code could not be sent:', error.code ?? error.message);
      return fail('internal', t('internal'));
    }
  }
  return ok();
}

/** Step 2: check the code. Wrong, expired, unknown and disabled all give the same answer. */
export async function verifyCode(input: unknown): Promise<ActionResult<{ next: '/' | '/login/mfa' }>> {
  const t = await getTranslations('errors');
  const parsed = verifyCodeSchema.safeParse(input);
  if (!parsed.success) return fail('validation', t('code_wrong'));
  const { email, code } = parsed.data;

  if (!allowCodeCheck(email, await clientIp())) return fail('rate_limited', t('rate_limited'));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
  if (error || !data.user) return fail('validation', t('code_wrong'));

  const { data: row } = await supabase
    .from('app_users')
    .select('role, is_active, locale')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!row?.is_active) {
    // A real Auth account with no active place in the business is a nobody.
    await supabase.auth.signOut({ scope: 'local' });
    return fail('validation', t('code_wrong'));
  }

  if (isLocale(row.locale)) await writeLocaleCookie(row.locale);
  return ok({ next: row.role === 'admin' ? '/login/mfa' : '/' });
}

/** Admin only: start authenticator-app set-up. Returns the QR code and the typed-in secret. */
export async function startTotpEnrollment(): Promise<ActionResult<{ factorId: string; qr: string; secret: string }>> {
  const t = await getTranslations('errors');
  const member = await getCurrentMember();
  if (!member || member.role !== 'admin') return fail('forbidden', t('forbidden'));

  const supabase = await createClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  if (factors?.totp.length) return fail('validation', t('mfa_already'));
  // A half-finished earlier attempt would block a new one: clear it.
  for (const f of factors?.all ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator app',
    issuer: 'Daksha Nirmaan Traders',
  });
  if (error || !data) {
    console.error('[auth] TOTP enrol failed:', error?.code ?? error?.message);
    return fail('internal', t('internal'));
  }
  return ok({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
}

/** Admin only: confirm the 6-digit authenticator code (set-up or a normal sign-in). Lifts the session to aal2. */
export async function verifyTotp(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const parsed = verifyTotpSchema.safeParse(input);
  if (!parsed.success) return fail('validation', t('code_wrong'));
  const member = await getCurrentMember();
  if (!member || member.role !== 'admin') return fail('forbidden', t('forbidden'));
  if (!allowTotpCheck(member.userId)) return fail('rate_limited', t('rate_limited'));

  const supabase = await createClient();
  let factorId = parsed.data.factorId;
  if (!factorId) {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    factorId = factors?.totp[0]?.id;
  }
  if (!factorId) return fail('validation', t('code_wrong'));

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: parsed.data.code });
  if (error) return fail('validation', t('code_wrong'));
  return ok();
}

/** Ends this device's session only. */
export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: 'local' });
  redirect('/login');
}
