'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/lib/auth/require';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { inviteUserSchema, resetPasswordSchema, userIdSchema } from '@/schemas/users';

// A ban this long is "for good"; enabling lifts it. Keeps a disabled person from getting new sessions.
const BAN_FOREVER = '876000h';

/**
 * Add a person. Creates their sign-in account with the owner-chosen starting password (no email is sent), then records their role in
 * the business as THE ADMIN, so the database checks the admin too. They sign in with the email and starting password the owner hands over.
 */
export async function inviteUser(input: unknown): Promise<ActionResult<{ userId: string }>> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = inviteUserSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { email, name, role, password } = parsed.data;

  const service = createAdminClient();
  let userId: string | undefined;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data.user) {
    userId = created.data.user.id;
  } else if (created.error?.code === 'email_exists') {
    // A half-finished earlier attempt left the account without a business role: reuse it.
    // One page of 200 is plenty: the business has at most 10 people (the database caps active users).
    const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
    userId = data.users.find((u) => u.email?.toLowerCase() === email)?.id;
  }
  if (!userId) {
    console.error('[admin] could not create sign-in account:', created.error?.code ?? created.error?.message);
    return fail('internal', t('internal'));
  }

  const supabase = await createClient();
  const { data: existing } = await supabase.from('app_users').select('user_id').eq('user_id', userId).maybeSingle();
  if (existing) return fail('validation', t('validation.already_member'));

  const { error } = await supabase.rpc('admin_set_user', {
    p_user_id: userId, p_email: email, p_name: name, p_role: role, p_is_active: true,
  });
  if (error) return dbFailure(error);

  revalidatePath('/settings/users');
  return ok({ userId });
}

async function setActive(input: unknown, active: boolean): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = userIdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', t('validation.no_such_user'));
  const { userId } = parsed.data;

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('app_users').select('email, name, role').eq('user_id', userId).maybeSingle();
  if (!row) return fail('validation', t('validation.no_such_user'));

  // Business record first: it takes effect on the person's very next request.
  const { error } = await supabase.rpc('admin_set_user', {
    p_user_id: userId, p_email: row.email, p_name: row.name, p_role: row.role, p_is_active: active,
  });
  if (error) return dbFailure(error);

  const { error: authError } = await createAdminClient().auth.admin.updateUserById(userId, {
    ban_duration: active ? 'none' : BAN_FOREVER,
  });
  if (authError) {
    console.error('[admin] sign-in account ban/unban failed:', authError.code ?? authError.message);
    return fail('partial', t(active ? 'partial_enable' : 'partial_disable'));
  }

  revalidatePath('/settings/users');
  return ok();
}

export async function disableUser(input: unknown): Promise<ActionResult> {
  return setActive(input, false);
}

export async function enableUser(input: unknown): Promise<ActionResult> {
  return setActive(input, true);
}

/**
 * Owner sets a new password for someone (the app sends no email, so this is the "forgot password" path).
 * The person is told in person. Only people already in the business can be reset.
 */
export async function resetUserPassword(input: unknown): Promise<ActionResult> {
  const t = await getTranslations('errors');
  const denied = await requireAdmin();
  if (denied) return denied;
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const { userId, password } = parsed.data;

  const supabase = await createClient();
  const { data: row } = await supabase.from('app_users').select('user_id').eq('user_id', userId).maybeSingle();
  if (!row) return fail('validation', t('validation.no_such_user'));

  const { error } = await createAdminClient().auth.admin.updateUserById(userId, { password });
  if (error) {
    console.error('[admin] password reset failed:', error.code ?? error.message);
    return fail('internal', t('internal'));
  }
  return ok();
}
