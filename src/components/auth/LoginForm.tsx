'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { signIn } from '@/app/actions/auth';
import { signInSchema, type SignInInput } from '@/schemas/auth';

/** Email and password. An owner is then held on the authenticator step; the server decides where to go next. */
export function LoginForm() {
  const t = useTranslations('login');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInInput>({ resolver: zodResolver(signInSchema) });

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = await signIn(values);
      if (!res.ok) return setServerError(res.error);
      router.replace(res.data.next);
      router.refresh();
    }),
  );

  return (
    <form onSubmit={submit} noValidate>
      <p className="muted" style={{ margin: '0 0 14px' }}>
        {t('passwordHelp')}
      </p>
      {serverError && (
        <p role="alert" className="alert bad">
          {serverError}
        </p>
      )}
      <div className="field">
        <label htmlFor="email">{t('email')}</label>
        <input
          id="email" type="email" inputMode="email" autoComplete="username" autoFocus
          aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-err' : undefined}
          {...register('email')}
        />
        {errors.email && (
          <p id="email-err" className="fielderror">
            {te(`field.${errors.email.message}`)}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor="password">{t('password')}</label>
        <input
          id="password" type="password" autoComplete="current-password"
          aria-invalid={!!errors.password} aria-describedby={errors.password ? 'password-err' : undefined}
          {...register('password')}
        />
        {errors.password && (
          <p id="password-err" className="fielderror">
            {te(`field.${errors.password.message}`)}
          </p>
        )}
      </div>
      <button type="submit" className="btn primary block" disabled={pending}>
        {t('signIn')}
      </button>
    </form>
  );
}
