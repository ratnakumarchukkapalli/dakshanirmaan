'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { bounceCheque, cancelPayment, depositCheque, markCleared } from '@/app/actions/payments';
import { Modal } from '@/components/ui/Modal';

interface Props {
  id: string;
  chequeStatus: 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'issued' | 'presented' | null;
  direction: 'receipt' | 'payment';
  /** Only an admin session sees Bounce and Cancel (the database is admin-only on both). */
  isAdmin: boolean;
}

/**
 * Inline actions on a POSTED payments-list row: the cheque lifecycle (cheques only) and, for an
 * admin, Cancel — a reversal of the whole payment, offered unless the cheque has reached the bank
 * (deposited / cleared / presented: the database refuses those with DN_CHEQUE_STATE; a received
 * cheque goes through Bounce instead). There is no dedicated view screen for a
 * posted payment (same reasoning as change 11's challans), so the row carries every action the
 * database currently allows for that cheque's status.
 */
export function PaymentRowActions({ id, chequeStatus, direction, isAdmin }: Props) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [bounceOpen, setBounceOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setFailure(null);
    start(async () => {
      const res = await action();
      if (!res.ok) return setFailure(res.error ?? null);
      setBounceOpen(false);
      setCancelOpen(false);
      setReason('');
      router.refresh();
    });
  }

  const chequeActionable = chequeStatus !== null && chequeStatus !== 'bounced' && chequeStatus !== 'cleared';
  const canCancel = isAdmin && (chequeStatus === null || chequeStatus === 'in_hand' || chequeStatus === 'issued');
  if (!chequeActionable && !canCancel) return null;

  return (
    <>
      {failure && <p role="alert" className="fielderror">{failure}</p>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chequeStatus === 'in_hand' && direction === 'receipt' && (
          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(() => depositCheque({ id }))}>{t('depositBtn')}</button>
        )}
        {(chequeStatus === 'deposited' || chequeStatus === 'issued') && (
          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => run(() => markCleared({ id }))}>{t('markClearedBtn')}</button>
        )}
        {isAdmin && (chequeStatus === 'in_hand' || chequeStatus === 'deposited') && direction === 'receipt' && (
          <button type="button" className="btn danger sm" disabled={pending} onClick={() => setBounceOpen(true)}>{t('bounceBtn')}</button>
        )}
        {canCancel && (
          <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setCancelOpen(true)}>{t('cancelBtn')}</button>
        )}
      </div>

      <Modal open={bounceOpen} onClose={() => setBounceOpen(false)} title={t('bounceTitle')} closeLabel={tc('close')}>
        <p>{t('bounceBody')}</p>
        <div className="field">
          <label htmlFor="bounce-reason" className="lbl">{t('bounceReasonLabel')}</label>
          <input id="bounce-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setBounceOpen(false)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={() => run(() => bounceCheque({ id, reason }))}>
            {t('bounceConfirm')}
          </button>
        </div>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('cancelTitle')} closeLabel={tc('close')}>
        <p>{t('cancelBody')}</p>
        <div className="field">
          <label htmlFor="cancel-reason" className="lbl">{t('cancelReasonLabel')}</label>
          <input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setCancelOpen(false)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending || reason.trim().length < 3} onClick={() => run(() => cancelPayment({ id, reason }))}>
            {t('cancelConfirm')}
          </button>
        </div>
      </Modal>
    </>
  );
}
