'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { recordInvoiceEwb } from '@/app/actions/sales';
import { Card } from '@/components/ui/Card';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { KeyValue } from '@/components/ui/KeyValue';
import { Modal } from '@/components/ui/Modal';
import type { EwbValues } from '@/lib/ewb';
import { formatDate } from '@/lib/format';
import { recordEwbSchema, TRANSPORT_MODES } from '@/schemas/sales';

interface Props {
  id: string;
  values: EwbValues;
  /** Posted invoices can be edited; a cancelled one only shows what was recorded. */
  editable: boolean;
  /** The total is above the e-way-bill threshold and no e-way bill number is recorded yet. */
  needsEwb: boolean;
  thresholdLabel: string;
}

/** Transport and e-way-bill details on the posted view, with a small form to record the number from the portal. */
export function EwbPanel({ id, values, editable, needsEwb, thresholdLabel }: Props) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const { register, handleSubmit, setValue, control, formState: { errors } } = useForm<EwbValues & { id: string }>({
    resolver: zodResolver(recordEwbSchema) as unknown as Resolver<EwbValues & { id: string }>,
    defaultValues: { id, ...values },
  });
  const ewbDate = useWatch({ control, name: 'ewbDate' });
  const ewbValidUntil = useWatch({ control, name: 'ewbValidUntil' });
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const modeLabel = (m: string) => (m ? t(`mode_${m}`) : '');

  const submit = handleSubmit((v) =>
    start(async () => {
      setFailure(null);
      const res = await recordInvoiceEwb(v);
      if (!res.ok) return setFailure(res.error);
      setOpen(false);
      router.refresh();
    }),
  );

  const has = Object.values(values).some(Boolean);
  const rows = [
    ...(values.ewbNo ? [{ label: t('ewbNo'), value: <span className="mono">{values.ewbNo}</span> }] : []),
    ...(values.ewbDate ? [{ label: t('ewbDate'), value: <span className="num">{formatDate(values.ewbDate)}</span> }] : []),
    ...(values.ewbValidUntil ? [{ label: t('ewbValidUntil'), value: <span className="num">{formatDate(values.ewbValidUntil)}</span> }] : []),
    ...(values.vehicleNo ? [{ label: t('vehicleNo'), value: <span className="mono">{values.vehicleNo}</span> }] : []),
    ...(values.transporterName ? [{ label: t('transporter'), value: values.transporterName }] : []),
    ...(values.transporterGstin ? [{ label: t('transporterGstin'), value: <span className="mono">{values.transporterGstin}</span> }] : []),
    ...(values.transportMode ? [{ label: t('transportMode'), value: modeLabel(values.transportMode) }] : []),
    ...(values.distanceKm ? [{ label: t('distanceKm'), value: <span className="num">{values.distanceKm} km</span> }] : []),
  ];

  return (
    <Card>
      <div className="cardtitle">
        <span>{t('ewbTitle')}</span>
        {editable && (
          <button type="button" className="btn ghost sm no-print" onClick={() => { setFailure(null); setOpen(true); }}>
            {has ? t('ewbEdit') : t('ewbRecord')}
          </button>
        )}
      </div>
      {needsEwb && editable && <p className="alert warn" role="note">{t('ewbHint', { amount: thresholdLabel })}</p>}
      {has ? <KeyValue rows={rows} /> : <p className="hint" style={{ margin: 0 }}>{t('ewbNone')}</p>}

      <Modal open={open} onClose={() => setOpen(false)} title={t('ewbTitle')} closeLabel={tc('close')}>
        <form onSubmit={submit} noValidate>
          <p className="hint" style={{ marginTop: 0 }}>{t('ewbPortalNote')}</p>
          {failure && <p role="alert" className="alert bad">{failure}</p>}
          <div className="fieldrow">
            <Field id="ewb-no" label={t('ewbNo')} hint={t('ewbNoHint')} error={err(errors.ewbNo?.message)}>
              <input id="ewb-no" className="mono" inputMode="numeric" autoComplete="off" {...register('ewbNo')} />
            </Field>
          </div>
          <div className="fieldrow">
            <Field id="ewb-date" label={t('ewbDate')} hint={t('dateHint')} error={err(errors.ewbDate?.message)}>
              <DateField id="ewb-date" value={ewbDate ?? ''} placeholder="DD-MM-YYYY" onChange={(iso) => setValue('ewbDate', iso, { shouldValidate: true })} />
            </Field>
            <Field id="ewb-until" label={t('ewbValidUntil')} hint={t('dateHint')} error={err(errors.ewbValidUntil?.message)}>
              <DateField id="ewb-until" value={ewbValidUntil ?? ''} placeholder="DD-MM-YYYY" onChange={(iso) => setValue('ewbValidUntil', iso, { shouldValidate: true })} />
            </Field>
          </div>
          <div className="fieldrow">
            <Field id="ewb-veh" label={t('vehicleNo')} error={err(errors.vehicleNo?.message)}>
              <input id="ewb-veh" className="mono" autoComplete="off" style={{ textTransform: 'uppercase' }} {...register('vehicleNo')} />
            </Field>
            <Field id="ewb-trn" label={t('transporter')} error={err(errors.transporterName?.message)}>
              <input id="ewb-trn" autoComplete="off" {...register('transporterName')} />
            </Field>
          </div>
          <div className="fieldrow">
            <Field id="ewb-mode" label={t('transportMode')} error={err(errors.transportMode?.message)}>
              <select id="ewb-mode" {...register('transportMode')}>
                <option value="">—</option>
                {TRANSPORT_MODES.map((m) => <option key={m} value={m}>{t(`mode_${m}`)}</option>)}
              </select>
            </Field>
            <Field id="ewb-dist" label={t('distanceKm')} error={err(errors.distanceKm?.message)}>
              <input id="ewb-dist" className="num" inputMode="numeric" autoComplete="off" {...register('distanceKm')} />
            </Field>
            <Field id="ewb-tgst" label={t('transporterGstin')} error={err(errors.transporterGstin?.message)}>
              <input id="ewb-tgst" className="mono" autoComplete="off" style={{ textTransform: 'uppercase' }} {...register('transporterGstin')} />
            </Field>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>{tc('cancel')}</button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? tc('saving') : tc('save')}</button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
