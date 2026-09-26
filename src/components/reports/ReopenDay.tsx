'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { reopenDay } from '@/app/actions/day-close';
import { Modal } from '@/components/ui/Modal';

/** Owner-only: reopens a closed day so it can be counted again. The reversal is kept in the audit trail. */
export function ReopenDay({ id }: { id: string }) {
  const t = useTranslations('reports.dayClose');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function confirm() {
    setFailure(null);
    start(async () => {
      const res = await reopenDay({ id, reason });
      if (!res.ok) return setFailure(res.error);
      setOpen(false);
      setReason('');
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>{t('reopenBtn')}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('reopenTitle')} closeLabel={tc('close')}>
        <p>{t('reopenBody')}</p>
        <div className="field">
          <label htmlFor="reopen-reason" className="lbl">{t('reopenReason')}</label>
          <input id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {failure && <p role="alert" className="alert bad">{failure}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={confirm}>{t('reopenConfirm')}</button>
        </div>
      </Modal>
    </>
  );
}
