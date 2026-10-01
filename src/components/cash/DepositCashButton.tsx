'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { postCashDeposit } from '@/app/actions/cash-deposit';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { compareDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import { cashDepositSchema } from '@/schemas/cash-deposit';

interface Props {
  /** The organisation's today (ISO): the default date. */
  today: string;
  /** What the books say is in the drawer now (exact text), for the "more than the books hold" warning; null when unknown. */
  cashOnHand: string | null;
  /** Initial date, when opened from a screen showing another day (ISO). */
  defaultDate?: string;
}

/**
 * "Deposit cash to bank": one modal, one action. The warning about an amount above the books' cash is
 * only a hint; the database accepts it (the drawer may hold cash the books do not know about yet).
 */
export function DepositCashButton({ today, cashOnHand, defaultDate }: Props) {
  const t = useTranslations('cashDeposit');
  const te = useTranslations('errors');
  const tc = useTranslations('common');
  const tr = useTranslations('reports');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate ?? today);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const amountOk = cashDepositSchema.shape.amount.safeParse(amount).success;
  // The books' figure is for the date this screen is showing; for any other date in the box it would mislead.
  const onHand = date === (defaultDate ?? today) ? cashOnHand : null;
  const over = amountOk && onHand !== null && compareDecimal(amount, onHand, 2) === 1;

  function close() {
    setOpen(false);
    setAmount('');
    setReference('');
    setNote('');
    setFieldError(null);
    setFailure(null);
    setDate(defaultDate ?? today);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailure(null);
    const parsed = cashDepositSchema.safeParse({ date, amount, reference, note });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = `field.${issue?.message}`;
      setFieldError({ field: String(issue?.path[0] ?? ''), message: te.has(key) ? te(key) : te('validation.generic') });
      return;
    }
    setFieldError(null);
    start(async () => {
      const res = await postCashDeposit({ date, amount, reference, note });
      if (!res.ok) return setFailure(res.error);
      close();
      router.refresh();
    });
  }

  const err = (name: string) => (fieldError?.field === name ? fieldError.message : undefined);

  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen(true)}>{t('button')}</button>
      <Modal open={open} onClose={close} title={t('title')} closeLabel={tc('close')}>
        <form onSubmit={submit} noValidate>
          <p className="hint">{t('intro')}</p>
          <Field id="dep-date" label={t('dateLabel')} error={err('date')}>
            <DateField id="dep-date" value={date} onChange={setDate} placeholder={tr('datePlaceholder')} />
          </Field>
          <Field id="dep-amount" label={t('amountLabel')} hint={onHand !== null ? t('onHand', { amount: inr2(onHand) }) : undefined} error={err('amount')}>
            <input id="dep-amount" className="num" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
          </Field>
          {over && <p className="alert warn" role="status">{t('overWarn', { amount: inr2(onHand!) })}</p>}
          <Field id="dep-ref" label={t('refLabel')} hint={t('refHint')} error={err('reference')}>
            <input id="dep-ref" value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field id="dep-note" label={t('noteLabel')} error={err('note')}>
            <input id="dep-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {failure && <p role="alert" className="alert bad">{failure}</p>}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={close}>{tc('cancel')}</button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? t('saving') : t('submit')}</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
