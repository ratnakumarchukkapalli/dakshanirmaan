'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelInvoice } from '@/app/actions/sales';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';

/** "Cancel invoice" for owners: asks for a reason, then posts a reversal (the invoice keeps its number). */
export function CancelInvoice({ id, number }: { id: string; number: string }) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const close = () => {
    setOpen(false);
    setError(null);
    setReason('');
  };

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await cancelInvoice({ id, reason });
      if (!res.ok) return setError(res.error);
      close();
      router.replace(`/sales/${id}/view?done=cancelled`);
      router.refresh();
    });

  return (
    <>
      <button type="button" className="btn danger sm" onClick={() => setOpen(true)}>{t('cancelInvoice')}</button>
      <Modal open={open} onClose={close} title={t('cancelTitle', { number })} closeLabel={tc('close')}>
        <p>{t('cancelBody')}</p>
        {error && <p role="alert" className="alert bad">{error}</p>}
        <Field id="cancel-reason" label={t('cancelReason')} hint={t('cancelReasonHint')}>
          <input id="cancel-reason" value={reason} maxLength={200} autoComplete="off" autoFocus onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={close}>{t('keepInvoice')}</button>
          <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? tc('saving') : t('cancelConfirm')}
          </button>
        </div>
      </Modal>
    </>
  );
}
