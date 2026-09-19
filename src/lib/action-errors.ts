import 'server-only';
import { getTranslations } from 'next-intl/server';
import { fail, parseDbError, type Failure } from '@/lib/action-result';

/** Turns a database error into a friendly, translated failure. Unknown errors are logged, not shown. */
export async function dbFailure(error: { message?: string } | null | undefined): Promise<Failure> {
  const t = await getTranslations('errors');
  const { code, detail } = parseDbError(error?.message);
  if (code === 'internal') console.error('[action] unexpected database error:', error?.message);
  if (code === 'validation') {
    return fail('validation', t.has(`validation.${detail}`) ? t(`validation.${detail}`) : t('validation.generic'));
  }
  return t.has(code) ? fail(code, t(code)) : fail('internal', t('internal'));
}
