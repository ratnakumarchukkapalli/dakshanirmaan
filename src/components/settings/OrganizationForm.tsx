'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { updateOrganization } from '@/app/actions/organization';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { GST_STATES } from '@/lib/gst';
import { organizationSchema, type OrganizationFormInput, type OrganizationFormOutput } from '@/schemas/organization';

export function OrganizationForm({ initial }: { initial: OrganizationFormInput }) {
  const t = useTranslations('org');
  const ta = useTranslations('address');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const months = t.raw('months') as string[];

  const { register, handleSubmit, formState: { errors } } = useForm<OrganizationFormInput, unknown, OrganizationFormOutput>({
    resolver: zodResolver(organizationSchema),
    defaultValues: initial,
  });
  const err = (m: string | undefined) => (m ? te(`field.${m}`) : undefined);

  const submit = handleSubmit((values) =>
    start(async () => {
      setNotice(null);
      const res = await updateOrganization(values);
      if (!res.ok) return setNotice({ tone: 'bad', text: res.error });
      setNotice({ tone: 'good', text: t('saved') });
      router.refresh();
    }),
  );

  return (
    <Card>
      <form onSubmit={submit} noValidate>
        {notice && (
          <p role={notice.tone === 'bad' ? 'alert' : 'status'} className={`alert ${notice.tone}`}>{notice.text}</p>
        )}
        <div className="fieldrow">
          <Field id="o-legal" label={t('legalName')} error={err(errors.legalName?.message)} className="">
            <input id="o-legal" autoComplete="off" {...register('legalName')} />
          </Field>
          <Field id="o-trade" label={t('tradeName')} error={err(errors.tradeName?.message)}>
            <input id="o-trade" autoComplete="off" {...register('tradeName')} />
          </Field>
        </div>
        <div className="fieldrow">
          <Field id="o-gstin" label={t('gstin')} error={err(errors.gstin?.message)}>
            <input id="o-gstin" className="mono" style={{ textTransform: 'uppercase' }} maxLength={15} autoComplete="off" {...register('gstin')} />
          </Field>
          <Field id="o-state" label={t('state')} error={err(errors.stateCode?.message)}>
            <select id="o-state" {...register('stateCode')}>
              {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
            </select>
          </Field>
          <Field id="o-fy" label={t('fyStart')} error={err(errors.fyStartMonth?.message)}>
            <select id="o-fy" {...register('fyStartMonth')}>
              {months.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </select>
          </Field>
        </div>
        <p className="hint" style={{ margin: '-4px 0 12px' }}>{t('lockedNote')}</p>

        <div className="section-title">{t('address')}</div>
        <Field id="o-l1" label={ta('line1')} error={err(errors.address?.line1?.message)}>
          <input id="o-l1" autoComplete="off" {...register('address.line1')} />
        </Field>
        <Field id="o-l2" label={ta('line2')} error={err(errors.address?.line2?.message)}>
          <input id="o-l2" autoComplete="off" {...register('address.line2')} />
        </Field>
        <div className="fieldrow">
          <Field id="o-city" label={ta('city')} error={err(errors.address?.city?.message)}>
            <input id="o-city" autoComplete="off" {...register('address.city')} />
          </Field>
          <Field id="o-dist" label={ta('district')} error={err(errors.address?.district?.message)}>
            <input id="o-dist" autoComplete="off" {...register('address.district')} />
          </Field>
          <Field id="o-pin" label={ta('pincode')} error={err(errors.address?.pincode?.message)}>
            <input id="o-pin" inputMode="numeric" maxLength={6} autoComplete="off" {...register('address.pincode')} />
          </Field>
        </div>

        <div className="section-title">{t('footer')}</div>
        <Field id="o-bank" label={t('bankDetails')} hint={t('bankDetailsHint')} error={err(errors.invoiceBankDetails?.message)}>
          <input id="o-bank" autoComplete="off" {...register('invoiceBankDetails')} />
        </Field>
        <div className="fieldrow">
          <Field id="o-upi" label={t('upi')} hint={t('upiHint')} error={err(errors.upiVpa?.message)}>
            <input id="o-upi" autoComplete="off" {...register('upiVpa')} />
          </Field>
          <Field id="o-footer" label={t('footer')} hint={t('footerHint')} error={err(errors.invoiceFooter?.message)}>
            <input id="o-footer" autoComplete="off" {...register('invoiceFooter')} />
          </Field>
        </div>

        <div className="field check">
          <input id="o-einv" type="checkbox" {...register('einvoiceEnabled')} />
          <label htmlFor="o-einv">{t('einvoice')}</label>
        </div>
        <div className="field check">
          <input id="o-neg" type="checkbox" {...register('allowNegativeStock')} />
          <label htmlFor="o-neg">{t('negativeStock')}</label>
        </div>

        <button type="submit" className="btn primary" disabled={pending}>{pending ? tc('saving') : tc('save')}</button>
      </form>
    </Card>
  );
}
