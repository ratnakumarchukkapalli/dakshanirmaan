import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { ZodError } from 'zod';
import { fail, parseDbError, type Failure } from '@/lib/action-result';

/** Turns a database error into a friendly, translated failure. Unknown errors are logged, not shown. */
export async function dbFailure(error: { message?: string; code?: string } | null | undefined): Promise<Failure> {
  const t = await getTranslations('errors');
  const { code, detail } = parseDbError(error?.message, error?.code);
  if (code === 'internal') console.error('[action] unexpected database error:', error?.message);
  if (code === 'validation') {
    return fail('validation', t.has(`validation.${detail}`) ? t(`validation.${detail}`) : t('validation.generic'));
  }
  return t.has(code) ? fail(code, t(code)) : fail('internal', t('internal'));
}

/** The first thing wrong with the input, as a translated sentence (schema messages are `errors.field.*` keys). */
export async function zodFailure(error: ZodError): Promise<Failure> {
  const t = await getTranslations('errors');
  const key = `field.${error.issues[0]?.message}`;
  return fail('validation', t.has(key) ? t(key) : t('validation.generic'));
}
