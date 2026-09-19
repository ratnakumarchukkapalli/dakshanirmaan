'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { requestCode, verifyCode } from '@/app/actions/auth';
import { requestCodeSchema, verifyCodeSchema, type RequestCodeInput } from '@/schemas/auth';

export function LoginForm() {
  const [email, setEmail] = useState<string | null>(null);
  return email === null ? <EmailStep onSent={setEmail} /> : <CodeStep email={email} onBack={() => setEmail(null)} />;
}

function EmailStep({ onSent }: { onSent: (email: string) => void }) {
  const t = useTranslations('login');
  const te = useTranslations('errors');
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RequestCodeInput>({ resolver: zodResolver(requestCodeSchema) });

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = await requestCode(values);
      if (res.ok) onSent(values.email);
      else setServerError(res.error);
    }),
  );

  return (
    <form onSubmit={submit} noValidate>
      <p className="muted" style={{ margin: '0 0 14px' }}>
        {t('emailHelp')}
      </p>
      {serverError && (
        <p role="alert" className="alert bad">
          {serverError}
        </p>
      )}
      <div className="field">
        <label htmlFor="email">{t('email')}</label>
        <input
          id="email" type="email" inputMode="email" autoComplete="email" autoFocus
          aria-invalid={!!errors.email} aria-describedby={errors.email ? 'email-err' : undefined}
          {...register('email')}
        />
        {errors.email && (
          <p id="email-err" className="fielderror">
            {te(`field.${errors.email.message}`)}
          </p>
        )}
      </div>
      <button type="submit" className="btn primary block" disabled={pending}>
        {t('sendCode')}
      </button>
    </form>
  );
}

function CodeStep({ email, onBack }: { email: string; onBack: () => void }) {
  const t = useTranslations('login');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ code: string }>({ resolver: zodResolver(verifyCodeSchema.pick({ code: true })) });

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = await verifyCode({ email, code: values.code });
      if (!res.ok) return setServerError(res.error);
      router.replace(res.data.next);
      router.refresh();
    }),
  );

  return (
    <form onSubmit={submit} noValidate>
      <p className="muted" style={{ margin: '0 0 14px' }}>
        {t('codeSent', { email })}
      </p>
      {serverError && (
        <p role="alert" className="alert bad">
          {serverError}
        </p>
      )}
      <div className="field">
        <label htmlFor="code">{t('code')}</label>
        <input
          id="code" className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
          aria-invalid={!!errors.code} aria-describedby={errors.code ? 'code-err' : undefined}
          {...register('code')}
        />
        {errors.code && (
          <p id="code-err" className="fielderror">
            {te(`field.${errors.code.message}`)}
          </p>
        )}
      </div>
      <button type="submit" className="btn primary block" disabled={pending}>
        {t('signIn')}
      </button>
      <p style={{ textAlign: 'center', marginBottom: 0 }}>
        <button type="button" className="linkbtn" onClick={onBack}>
          {t('useOtherEmail')}
        </button>
      </p>
    </form>
  );
}
