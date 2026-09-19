'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { defaultLocale, isLocale, LOCALE_COOKIE } from '@/i18n/config';
import { writeLocaleCookie } from '@/i18n/cookie';
import { getCurrentMember } from '@/lib/auth/current';
import { createClient } from '@/lib/supabase/server';

/** Flips English ↔ Telugu: always on this device (cookie), and on the person's row when signed in. */
export async function toggleLocale() {
  const current = (await cookies()).get(LOCALE_COOKIE)?.value;
  const next = (isLocale(current) ? current : defaultLocale) === 'en' ? 'te' : 'en';
  await writeLocaleCookie(next);
  if (await getCurrentMember()) {
    const supabase = await createClient();
    const { error } = await supabase.rpc('set_my_locale', { p_locale: next });
    if (error) console.error('[locale] could not save language on the person row:', error.message);
  }
  revalidatePath('/', 'layout');
}
