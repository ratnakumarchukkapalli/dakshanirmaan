'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { changePassword } from '@/app/actions/auth';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { changePasswordSchema, type ChangePasswordInput } from '@/schemas/auth';

/** Any signed-in member changes their own password. */
export function AccountPassword() {
  const t = useTranslations('account');
  const te = useTranslations('errors');
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  const submit = handleSubmit((values) =>
    start(async () => {
      setNotice(null);
      const res = await changePassword(values);
      if (!res.ok) return setNotice({ tone: 'bad', text: res.error });
      setNotice({ tone: 'good', text: t('done') });
      reset({ password: '' });
    }),
  );

  return (
    <Card>
      <div className="cardtitle">{t('title')}</div>
      <p className="muted" style={{ marginTop: 0 }}>{t('hint')}</p>
      {notice && <p role={notice.tone === 'bad' ? 'alert' : 'status'} className={`alert ${notice.tone}`}>{notice.text}</p>}
      <form onSubmit={submit} noValidate>
        <Field id="new-password" label={t('newPassword')} error={errors.password ? te(`field.${errors.password.message}`) : undefined}>
          <input id="new-password" type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <button type="submit" className="btn primary" disabled={pending}>{t('save')}</button>
      </form>
    </Card>
  );
}
