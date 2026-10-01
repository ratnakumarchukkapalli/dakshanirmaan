'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelCashDeposit } from '@/app/actions/cash-deposit';
import { Modal } from '@/components/ui/Modal';

/** Owner-only: cancels a cash deposit. The reversal is kept in the audit trail. */
export function CancelCashDeposit({ id }: { id: string }) {
  const t = useTranslations('cashDeposit');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function confirm() {
    setFailure(null);
    start(async () => {
      const res = await cancelCashDeposit({ id, reason });
      if (!res.ok) return setFailure(res.error);
      setOpen(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>{t('cancelBtn')}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('cancelTitle')} closeLabel={tc('close')}>
        <p>{t('cancelBody')}</p>
        <div className="field">
          <label htmlFor={`cancel-dep-${id}`} className="lbl">{t('cancelReason')}</label>
          <input id={`cancel-dep-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {failure && <p role="alert" className="alert bad">{failure}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={confirm}>{t('cancelConfirm')}</button>
        </div>
      </Modal>
    </>
  );
}
