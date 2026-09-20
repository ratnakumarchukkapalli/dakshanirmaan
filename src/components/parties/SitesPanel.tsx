'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { addPartyAddress, setDefaultSite } from '@/app/actions/parties';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { GST_STATES, stateName } from '@/lib/gst';
import { partyAddressSchema } from '@/schemas/parties';
import type { z } from 'zod';

export interface Site {
  id: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  district: string | null;
  pincode: string;
  stateCode: string;
  isBilling: boolean;
}

const siteFormSchema = partyAddressSchema.omit({ partyId: true });
type SiteInput = z.input<typeof siteFormSchema>;
type SiteOutput = z.output<typeof siteFormSchema>;

export function SitesPanel({ partyId, sites, defaultSiteId, defaultStateCode }: {
  partyId: string; sites: Site[]; defaultSiteId: string | null; defaultStateCode: string;
}) {
  const t = useTranslations('parties');
  const tc = useTranslations('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const makeDefault = (addressId: string) =>
    start(async () => {
      setError(null);
      const res = await setDefaultSite({ partyId, addressId });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });

  return (
    <Card>
      <div className="cardtitle" style={{ justifyContent: 'space-between' }}>
        <span>{t('sites')}</span>
        <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
          + {t('addSite')}
        </button>
      </div>
      {error && <p role="alert" className="alert bad">{error}</p>}
      {sites.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t('noSites')}</p>
      ) : (
        <div className="stack">
          {sites.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="pname">
                  {s.label}{' '}
                  {s.isBilling && <Chip tone="accent">{t('billingAddress')}</Chip>}{' '}
                  {s.id === defaultSiteId && <Chip tone="good">{t('defaultSite')}</Chip>}
                </div>
                <div className="sub">
                  {[s.line1, s.line2, s.city, s.district, s.pincode].filter(Boolean).join(', ')} · {stateName(s.stateCode)}
                </div>
              </div>
              {s.id !== defaultSiteId && (
                <button type="button" className="btn ghost sm" disabled={pending} onClick={() => makeDefault(s.id)}>
                  {t('makeDefaultSite')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('addSite')} closeLabel={tc('close')}>
        <SiteForm partyId={partyId} defaultStateCode={defaultStateCode} onDone={() => setOpen(false)} />
      </Modal>
    </Card>
  );
}

function SiteForm({ partyId, defaultStateCode, onDone }: {
  partyId: string; defaultStateCode: string; onDone: () => void;
}) {
  const t = useTranslations('parties');
  const ta = useTranslations('address');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<SiteInput, unknown, SiteOutput>({
    resolver: zodResolver(siteFormSchema),
    defaultValues: { label: '', stateCode: defaultStateCode, line1: '', line2: '', city: '', district: '', pincode: '' },
  });
  const err = (n: keyof SiteInput) => (errors[n]?.message ? te(`field.${errors[n]!.message}`) : undefined);

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = await addPartyAddress({ partyId, ...values });
      if (!res.ok) return setServerError(res.error);
      onDone();
      router.refresh();
    }),
  );

  return (
    <form onSubmit={submit} noValidate>
      {serverError && <p role="alert" className="alert bad">{serverError}</p>}
      <Field id="s-label" label={t('siteLabel')} error={err('label')}>
        <input id="s-label" autoFocus autoComplete="off" {...register('label')} />
      </Field>
      <Field id="s-l1" label={ta('line1')} error={err('line1')}>
        <input id="s-l1" autoComplete="off" {...register('line1')} />
      </Field>
      <Field id="s-l2" label={ta('line2')} error={err('line2')}>
        <input id="s-l2" autoComplete="off" {...register('line2')} />
      </Field>
      <div className="fieldrow">
        <Field id="s-city" label={ta('city')} error={err('city')}>
          <input id="s-city" autoComplete="off" {...register('city')} />
        </Field>
        <Field id="s-dist" label={ta('district')} error={err('district')}>
          <input id="s-dist" autoComplete="off" {...register('district')} />
        </Field>
      </div>
      <div className="fieldrow">
        <Field id="s-pin" label={ta('pincode')} error={err('pincode')}>
          <input id="s-pin" inputMode="numeric" maxLength={6} autoComplete="off" {...register('pincode')} />
        </Field>
        <Field id="s-state" label={ta('state')} error={err('stateCode')}>
          <select id="s-state" {...register('stateCode')}>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
          </select>
        </Field>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDone}>{tc('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? tc('saving') : t('createSite')}</button>
      </div>
    </form>
  );
}
