'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { zodFailure } from '@/lib/action-errors';
import { allowCodeCheck, allowTotpCheck } from '@/lib/auth/rate-limit';
import { requireMember } from '@/lib/auth/require';
import { getCurrentMember } from '@/lib/auth/current';
import { clientIp } from '@/lib/http';
import { isLocale } from '@/i18n/config';
import { writeLocaleCookie } from '@/i18n/cookie';
import { createClient } from '@/lib/supabase/server';
import { changePasswordSchema, signInSchema, verifyTotpSchema } from '@/schemas/auth';

/**
 * Sign in with email and password. Unknown email, wrong password, disabled person and a sign-in account with no
 * place in the business all give the same answer, so this cannot be used to find out who works here. An owner
 * is sent on to the authenticator step; until it is passed the database treats them as no one (aal2).
 */
export async function signIn(input: unknown): Promise<ActionResult<{ next: '/' | '/login/mfa' }>> {
  const t = await getTranslations('errors');
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return fail('validation', t('sign_in_failed'));
  const { email, password } = parsed.data;

  if (!allowCodeCheck(email, await clientIp())) return fail('rate_limited', t('rate_limited'));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (error && (error.status === 429 || error.code === 'over_request_rate_limit')) return fail('rate_limited', t('rate_limited'));
    if (error && (!error.status || error.status >= 500)) {
      console.error('[auth] sign-in failed:', error.code ?? error.message);
      return fail('internal', t('internal'));
    }
    return fail('validation', t('sign_in_failed'));
  }

  const { data: row } = await supabase
    .from('app_users')
    .select('role, is_active, locale')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!row?.is_active) {
    // A real sign-in account with no active place in the business is a nobody.
    await supabase.auth.signOut({ scope: 'local' });
    return fail('validation', t('sign_in_failed'));
  }

  if (isLocale(row.locale)) await writeLocaleCookie(row.locale);
  return ok({ next: row.role === 'admin' ? '/login/mfa' : '/' });
}

/** Any signed-in member changes their own password. An owner must have passed the authenticator step first. */
export async function changePassword(input: unknown): Promise<ActionResult> {
  const gate = await requireMember();
  if (gate.denied) return gate.denied;
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === 'same_password') return fail('validation', (await getTranslations('errors'))('validation.same_password'));
    if (error.code === 'weak_password') return fail('validation', (await getTranslations('errors'))('field.password_short'));
    console.error('[auth] password change failed:', error.code ?? error.message);
    return fail('internal', (await getTranslations('errors'))('internal'));
  }
  return ok();
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
