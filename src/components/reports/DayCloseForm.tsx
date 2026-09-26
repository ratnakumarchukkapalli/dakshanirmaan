'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { closeDay } from '@/app/actions/day-close';
import { Field } from '@/components/ui/Field';
import { signOf, subtractDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import { closeDaySchema } from '@/schemas/day-close';

interface Props {
  date: string;
  /** What the books say should be in the drawer (from `day_close_preview`). */
  expected: string;
}

/**
 * The counted-cash form. The "difference" line is only a preview so the counter sees a short or an
 * over drawer before confirming; the stored difference is whatever `post_day_close` computes from
 * the ledger, and that is what the screen shows after the close.
 */
export function DayCloseForm({ date, expected }: Props) {
  const t = useTranslations('reports.dayClose');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const valid = closeDaySchema.shape.counted.safeParse(counted).success;
  const gap = valid ? subtractDecimal(counted, expected, 2) : null;
  const sign = gap === null ? 0 : signOf(gap);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    const parsed = closeDaySchema.safeParse({ date, counted, note, expectedSeen: expected });
    if (!parsed.success) {
      const key = `field.${parsed.error.issues[0]?.message}`;
      setFieldError(te.has(key) ? te(key) : te('validation.generic'));
      return;
    }
    setFieldError(null);
    start(async () => {
      const res = await closeDay({ date, counted, note, expectedSeen: expected });
      if (!res.ok) return setFailure(res.error);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Field id="counted" label={t('countedLabel')} hint={t('countedHint')} error={fieldError ?? undefined}>
        <input id="counted" className="num" inputMode="decimal" autoComplete="off" value={counted} onChange={(e) => setCounted(e.target.value.trim())} />
      </Field>
      {valid && gap !== null && (
        <p className={sign === 0 ? 'alert good' : 'alert warn'} role="status">
          {sign === 0 ? t('previewMatch') : sign === -1 ? t('previewShort', { amount: inr2(gap.replace('-', '')) }) : t('previewOver', { amount: inr2(gap) })}
        </p>
      )}
      <Field id="close-note" label={t('noteLabel')}>
        <input id="close-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <button type="submit" className="btn primary" disabled={pending}>{pending ? t('closing') : t('closeBtn')}</button>
    </form>
  );
}
