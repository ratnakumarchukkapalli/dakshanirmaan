'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { signOut, startTotpEnrollment, verifyTotp } from '@/app/actions/auth';
import { totpCodeSchema } from '@/schemas/auth';

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

/** mode 'enroll' = first time (scan a QR code); 'verify' = the app is already set up. */
export function MfaForm({ mode }: { mode: 'enroll' | 'verify' }) {
  const t = useTranslations('mfa');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ code: string }>({ resolver: zodResolver(totpCodeSchema) });

  const begin = () =>
    start(async () => {
      setServerError(null);
      const res = await startTotpEnrollment();
      if (res.ok) setEnrollment(res.data);
      else setServerError(res.error);
    });

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = await verifyTotp({ factorId: enrollment?.factorId, code: values.code });
      if (!res.ok) return setServerError(res.error);
      router.replace('/');
      router.refresh();
    }),
  );

  const showCodeField = mode === 'verify' || enrollment !== null;

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {mode === 'verify' ? t('verifyHelp') : t('enrollHelp')}
      </p>
      {serverError && (
        <p role="alert" className="alert bad">
          {serverError}
        </p>
      )}

      {mode === 'enroll' && !enrollment && (
        <button type="button" className="btn primary block" onClick={begin} disabled={pending}>
          {t('startSetup')}
        </button>
      )}

      {enrollment && (
        <div>
          <div className="qr">
            {/* Supabase returns the QR code as a self-contained SVG data URI. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrollment.qr} alt={t('qrAlt')} />
          </div>
          <p className="muted" style={{ margin: '0 0 4px' }}>
            {t('cannotScan')}
          </p>
          <p className="secret" style={{ margin: 0 }}>
            {enrollment.secret}
          </p>
        </div>
      )}

      {showCodeField && (
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="totp">{t('code')}</label>
            <input
              id="totp" className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              autoFocus={mode === 'verify'} aria-invalid={!!errors.code}
              aria-describedby={errors.code ? 'totp-err' : undefined}
              {...register('code')}
            />
            {errors.code && (
              <p id="totp-err" className="fielderror">
                {te(`field.${errors.code.message}`)}
              </p>
            )}
          </div>
          <button type="submit" className="btn primary block" disabled={pending}>
            {mode === 'enroll' ? t('confirmSetup') : t('verify')}
          </button>
        </form>
      )}

      <form action={signOut} style={{ textAlign: 'center' }}>
        <button type="submit" className="linkbtn">
          {t('signOut')}
        </button>
      </form>
    </div>
  );
}
