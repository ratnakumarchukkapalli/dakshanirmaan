'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { convertQuoteToInvoice, markQuote } from '@/app/actions/quotes';
import { Modal } from '@/components/ui/Modal';
import type { QuoteActions as Allowed } from '@/lib/quotes-view';

type Confirm = null | 'convert' | 'expire';

/**
 * The buttons on a quotation: Edit, Mark accepted / Reopen / Mark expired, Convert to invoice, Print.
 * `allowed` comes from the server (lib/quotes-view.ts); the database enforces the same rules again.
 * Convert only creates a DRAFT invoice and opens it; nothing is posted.
 */
export function QuoteActions({ id, allowed }: { id: string; allowed: Allowed }) {
  const t = useTranslations('quotes');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const mark = (status: 'open' | 'accepted' | 'expired', notice: 'accepted' | 'reopened' | 'expired') =>
    start(async () => {
      setFailure(null);
      const res = await markQuote({ id, status });
      setConfirm(null);
      if (!res.ok) return setFailure(res.error);
      router.push(`/sales/quotes/${id}?done=${notice}`);
      router.refresh();
    });

  const convert = () =>
    start(async () => {
      setFailure(null);
      const res = await convertQuoteToInvoice({ id });
      if (!res.ok) {
        setConfirm(null);
        return setFailure(res.error);
      }
      router.push(`/sales/${res.data.invoiceId}`);
    });

  return (
    <>
      {allowed.edit && <Link href={`/sales/quotes/new?id=${id}`} className="btn ghost sm">{t('edit')}</Link>}
      {allowed.accept && <button type="button" className="btn ghost sm" disabled={pending} onClick={() => mark('accepted', 'accepted')}>{t('markAccepted')}</button>}
      {allowed.reopen && <button type="button" className="btn ghost sm" disabled={pending} onClick={() => mark('open', 'reopened')}>{t('reopen')}</button>}
      {allowed.expire && <button type="button" className="btn ghost sm" disabled={pending} onClick={() => setConfirm('expire')}>{t('markExpired')}</button>}
      <button type="button" className="btn ghost sm" onClick={() => window.print()}>{t('print')}</button>
      {allowed.convert && <button type="button" className="btn primary sm" disabled={pending} onClick={() => setConfirm('convert')}>{t('convert')}</button>}

      {failure && <p role="alert" className="alert bad" style={{ flexBasis: '100%', margin: 0 }}>{failure}</p>}

      <Modal open={confirm === 'convert'} onClose={() => setConfirm((c) => (c === 'convert' ? null : c))} title={t('convertTitle')} closeLabel={tc('close')}>
        <p>{t('convertBody')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn primary" disabled={pending} onClick={convert}>{pending ? t('converting') : t('convertConfirm')}</button>
        </div>
      </Modal>

      <Modal open={confirm === 'expire'} onClose={() => setConfirm((c) => (c === 'expire' ? null : c))} title={t('expireTitle')} closeLabel={tc('close')}>
        <p>{t('expireBody')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending} onClick={() => mark('expired', 'expired')}>{t('expireConfirm')}</button>
        </div>
      </Modal>
    </>
  );
}
