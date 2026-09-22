'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { bounceCheque, depositCheque, markCleared } from '@/app/actions/payments';
import { Modal } from '@/components/ui/Modal';

interface Props {
  id: string;
  chequeStatus: 'in_hand' | 'deposited' | 'cleared' | 'bounced' | 'issued' | 'presented' | null;
  direction: 'receipt' | 'payment';
  /** Only an admin session sees Bounce (the database is admin-only on it). */
  isAdmin: boolean;
}

/**
 * Inline cheque-lifecycle actions on a payments-list row. There is no dedicated view screen for a
 * posted payment (same reasoning as change 11's challans), so the row carries every action the
 * database currently allows for that cheque's status.
 */
export function PaymentRowActions({ id, chequeStatus, direction, isAdmin }: Props) {
  const t = useTranslations('payments');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [bounceOpen, setBounceOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setFailure(null);
    start(async () => {
      const res = await action();
      if (!res.ok) return setFailure(res.error ?? null);
      setBounceOpen(false);
      setReason('');
      router.refresh();
    });
  }

  if (chequeStatus === null || chequeStatus === 'bounced' || chequeStatus === 'cleared') return null;

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
    </>
  );
}
