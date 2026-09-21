'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import { whatsappInvoiceLink, type ShareLink } from '@/app/actions/share';
import { Modal } from '@/components/ui/Modal';

interface Props {
  id: string;
  /** Cancelled invoices keep only the PDF; drafts show none of this. */
  cancelled: boolean;
  /** False when the server has no link secret / origin: the WhatsApp button is then not shown at all. */
  canShare: boolean;
}

/**
 * PDF, Print and WhatsApp for a posted invoice. The PDF is the one layout truth: Print opens it in
 * a new tab for the browser's own print dialog. WhatsApp asks the server for a signed 24-hour link.
 */
export function InvoiceActions({ id, cancelled, canShare }: Props) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const pdf = `/api/invoices/${id}/pdf`;

  const openShare = () => {
    setOpen(true);
    setShare(null);
    setError(null);
    setCopied(false);
    start(async () => {
      const res = await whatsappInvoiceLink({ id });
      if (!res.ok) return setError(res.error);
      setShare(res.data);
    });
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.link);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setError(t('copyFailed'));
    }
  };

  return (
    <>
      <a className="btn ghost sm" href={pdf} download>{t('pdf')}</a>
      {!cancelled && (
        <>
          <a className="btn ghost sm" href={pdf} target="_blank" rel="noopener">{t('print')}</a>
          {canShare && <button type="button" className="btn primary sm" onClick={openShare}>{t('whatsapp')}</button>}
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('shareTitle')} closeLabel={tc('close')}>
        {pending && <p role="status">{t('shareWorking')}</p>}
        {error && <p role="alert" className="alert bad">{error}</p>}
        {share && (
          <>
            <p>{share.whatsappUrl ? t('shareBody') : t('shareNoPhone')}</p>
            <p className="hint" style={{ marginTop: 0 }}>{t('shareExpiry')}</p>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={copy}>{copied ? t('copied') : t('copyLink')}</button>
              {share.whatsappUrl && (
                <a className="btn primary" href={share.whatsappUrl} target="_blank" rel="noopener" onClick={() => setOpen(false)}>
                  {t('openWhatsapp')}
                </a>
              )}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
