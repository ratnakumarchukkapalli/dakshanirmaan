'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { addBillFreight } from '@/app/actions/purchases';
import { Card } from '@/components/ui/Card';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { formatDate, inr2 } from '@/lib/format';
import { addFreightSchema, type AddFreightInput } from '@/schemas/purchases';

export interface FreightVoucher {
  id: string;
  voucherNo: string;
  date: string;
  status: string;
  transporter: string;
  /** Freight before tax, as stored. */
  amount: string;
  /** The journal lines the database wrote: account name, debit, credit. */
  entry: { account: string; debit: string; credit: string }[];
}
export interface FreightChoice { id: string; name: string }
export interface FreightAccount { id: string; name: string; systemKey: string | null }

interface Props {
  billId: string;
  today: string;
  vouchers: FreightVoucher[];
  /** Active suppliers in our own state: the only transporters reverse charge can be posted for. */
  transporters: FreightChoice[];
  accounts: FreightAccount[];
  canAdd: boolean;
}

/** Freight on reverse charge for a posted bill: its own voucher, shown here with what it posted. */
export function FreightCard({ billId, today, vouchers, transporters, accounts, canAdd }: Props) {
  const t = useTranslations('purchases.freight');
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Card>
      <div className="cardtitle">
        <span>{t('title')}</span>
        {canAdd && <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>+ {t('add')}</button>}
      </div>
      {notice && <p role="status" className="alert good">{notice}</p>}
      {vouchers.length === 0 && <p className="hint">{t('none')}</p>}
      {vouchers.map((v) => (
        <div key={v.id} className="stack" style={{ marginBottom: 12 }}>
          <div>
            <strong className="mono">{v.voucherNo}</strong> <span className="sub">· {formatDate(v.date)} · {v.transporter} · {inr2(v.amount)}</span>
            {v.status === 'cancelled' && <span className="sub"> · {t('cancelled')}</span>}
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>{t('account')}</th><th className="r">{t('debit')}</th><th className="r">{t('credit')}</th></tr></thead>
              <tbody>
                {v.entry.map((l, i) => (
                  <tr key={i}>
                    <td>{l.account}</td>
                    <td className="r num">{Number(l.debit) ? inr2(l.debit) : ''}</td>
                    <td className="r num">{Number(l.credit) ? inr2(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {canAdd && <p className="hint">{t('hint')}</p>}
      <Modal open={open} onClose={() => setOpen(false)} title={t('modalTitle')} closeLabel={t('close')}>
        <FreightForm
          billId={billId} today={today} transporters={transporters} accounts={accounts}
          onDone={() => { setOpen(false); setNotice(t('done')); }} onCancel={() => setOpen(false)}
        />
      </Modal>
    </Card>
  );
}

type ErrMsg = { message?: string } | undefined;

function FreightForm({ billId, today, transporters, accounts, onDone, onCancel }: Pick<Props, 'billId' | 'today' | 'transporters' | 'accounts'> & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('purchases.freight');
  const ts = useTranslations('sales');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, setValue, control, formState: { errors } } = useForm<AddFreightInput>({
    resolver: zodResolver(addFreightSchema) as unknown as Resolver<AddFreightInput>,
    defaultValues: {
      id: requestId, billId, voucherDate: today, transporterId: '', amount: '', note: '',
      payAccountId: accounts.find((a) => a.systemKey === 'cash')?.id ?? accounts[0]?.id ?? '',
    },
  });
  const date = useWatch({ control, name: 'voucherDate' });
  const label = (a: FreightAccount) => (a.systemKey === 'cash' ? ts('accountCash') : a.systemKey === 'bank' ? ts('accountBank') : a.name);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  const submit = (values: AddFreightInput) => {
    setFailure(null);
    start(async () => {
      const res = await addBillFreight(values);
      if (!res.ok) return setFailure(res.error);
      router.refresh();
      onDone();
    });
  };

  return (
    <form onSubmit={handleSubmit(submit)} noValidate>
      {transporters.length === 0 && <p className="alert warn">{t('noTransporter')}</p>}
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <Field id="fr-transporter" label={t('transporter')} hint={t('transporterHint')} error={err((errors.transporterId as ErrMsg)?.message)}>
        <select id="fr-transporter" {...register('transporterId')}>
          <option value="" disabled>{t('chooseTransporter')}</option>
          {transporters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <div className="fieldrow">
        <Field id="fr-amount" label={t('amount')} hint={t('amountHint')} error={err((errors.amount as ErrMsg)?.message)}>
          <input id="fr-amount" inputMode="decimal" autoComplete="off" className="num" {...register('amount')} />
        </Field>
        <Field id="fr-date" label={t('date')} className="datefield" error={err((errors.voucherDate as ErrMsg)?.message)}>
          <DateField id="fr-date" value={date} onChange={(iso) => setValue('voucherDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
        </Field>
      </div>
      <Field id="fr-account" label={t('paidFrom')} error={err((errors.payAccountId as ErrMsg)?.message)}>
        <select id="fr-account" {...register('payAccountId')}>{accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}</select>
      </Field>
      <Field id="fr-note" label={t('note')} error={err((errors.note as ErrMsg)?.message)}>
        <input id="fr-note" autoComplete="off" maxLength={120} {...register('note')} />
      </Field>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending || transporters.length === 0}>{pending ? t('posting') : t('submit')}</button>
      </div>
    </form>
  );
}
