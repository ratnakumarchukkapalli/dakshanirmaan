'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { createParty, updateParty } from '@/app/actions/parties';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { GST_STATES, isStateCode, stateName } from '@/lib/gst';
import { createPartySchema, partyBasicsSchema, type CreatePartyInput, type CreatePartyOutput } from '@/schemas/parties';

export interface PartyValues {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'both';
  gstin: string | null;
  stateCode: string;
  phone: string | null;
  whatsappPhone: string | null;
  creditLimit: string | null;
  creditDays: string | null;
  interestRatePm: string | null;
}

interface Props {
  /** Owners also see (and may set) the credit terms. */
  isAdmin: boolean;
  defaultStateCode: string;
  /** Present = edit this party; absent = create a new one. */
  party?: PartyValues;
  triggerClassName?: string;
}

export function PartyModal({ isAdmin, defaultStateCode, party, triggerClassName = 'btn primary' }: Props) {
  const t = useTranslations('parties');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {party ? t('edit') : `+ ${t('newParty')}`}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={party ? t('editTitle') : t('createTitle')} closeLabel={tc('close')}>
        <PartyForm isAdmin={isAdmin} defaultStateCode={defaultStateCode} party={party} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function PartyForm({ isAdmin, defaultStateCode, party, onDone }: Props & { onDone: () => void }) {
  const t = useTranslations('parties');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  // On an existing party a counter user sees type, GSTIN and state but cannot change them.
  const identityLocked = !!party && !isAdmin;

  const {
    register, handleSubmit, control, setValue, setError, formState: { errors },
  } = useForm<CreatePartyInput, unknown, CreatePartyOutput>({
    // A counter user editing a party cannot see or change identity or credit fields, so those are
    // not validated: a legacy GSTIN or state that today's rules reject must not block the save.
    resolver: (identityLocked ? zodResolver(partyBasicsSchema) : zodResolver(createPartySchema)) as Resolver<CreatePartyInput, unknown, CreatePartyOutput>,
    defaultValues: {
      name: party?.name ?? '', type: party?.type ?? 'customer', gstin: party?.gstin ?? '',
      stateCode: party?.stateCode ?? defaultStateCode, phone: party?.phone ?? '', whatsappPhone: party?.whatsappPhone ?? '',
      creditLimit: party?.creditLimit ?? '', creditUnlimited: party ? party.creditLimit === null : false, creditDays: party?.creditDays ?? '', interestRatePm: party?.interestRatePm ?? '',
    },
  });

  // A GSTIN's first two digits are its state: pick the state for the person as they type.
  const gstin = String(useWatch({ control, name: 'gstin' }) ?? '').toUpperCase();
  useEffect(() => {
    if (!identityLocked && gstin.length >= 2 && isStateCode(gstin.slice(0, 2))) setValue('stateCode', gstin.slice(0, 2));
  }, [gstin, identityLocked, setValue]);
  const unlimited = !!useWatch({ control, name: 'creditUnlimited' });

  const err = (name: keyof CreatePartyInput) => {
    const m = errors[name]?.message;
    return m ? te(`field.${m}`) : undefined;
  };

  // Fields that have a box on screen. A problem with any other field would otherwise block
  // Save with nothing to point at, so it is shown as a notice above the form.
  const shown = new Set<string>(['name', 'phone', 'whatsappPhone']);
  if (!identityLocked) ['type', 'gstin', 'stateCode'].forEach((f) => shown.add(f));
  if (isAdmin) ['creditLimit', 'creditDays', 'interestRatePm'].forEach((f) => shown.add(f));
  const hiddenProblem = Object.entries(errors).find(([name, e]) => !shown.has(name) && e?.message)?.[1]?.message;

  const submit = handleSubmit((values) => {
    // On an existing party, unticking "No credit limit" needs a limit (0 = no credit); otherwise
    // nothing would be sent and the party would quietly stay unlimited.
    if (party && isAdmin && !values.creditUnlimited && values.creditLimit === undefined) {
      setError('creditLimit', { message: 'credit_limit_required' });
      return;
    }
    start(async () => {
      setServerError(null);
      // Counter users never send credit terms (the server drops them and the database refuses them).
      const payload = { ...values };
      if (!isAdmin) {
        delete payload.creditLimit;
        delete payload.creditUnlimited;
        delete payload.creditDays;
        delete payload.interestRatePm;
      }
      if (party) {
        const res = await updateParty({ id: party.id, ...payload });
        if (!res.ok) return setServerError(res.error);
        onDone();
        router.refresh();
      } else {
        const res = await createParty(payload);
        if (!res.ok) return setServerError(res.error);
        onDone();
        router.push(`/parties/${res.data.id}`);
      }
    });
  });

  return (
    <form onSubmit={submit} noValidate>
      {(serverError || hiddenProblem) && (
        <p role="alert" className="alert bad">
          {serverError ?? te(`field.${hiddenProblem}`)}
        </p>
      )}
      <div className="fieldrow">
        <Field id="p-name" label={t('name')} error={err('name')}>
          <input id="p-name" placeholder={t('namePlaceholder')} autoComplete="off" autoFocus {...register('name')} />
        </Field>
        {identityLocked ? (
          <ReadOnly label={t('type')} value={{ customer: t('typeCustomer'), supplier: t('typeSupplier'), both: t('typeBoth') }[party.type]} />
        ) : (
          <Field id="p-type" label={t('type')} error={err('type')}>
            <select id="p-type" {...register('type')}>
              <option value="customer">{t('typeCustomer')}</option>
              <option value="supplier">{t('typeSupplier')}</option>
              <option value="both">{t('typeBoth')}</option>
            </select>
          </Field>
        )}
      </div>
      <div className="fieldrow">
        {identityLocked ? (
          <>
            <ReadOnly label={t('gstin')} value={party.gstin ?? tc('none')} mono />
            <ReadOnly label={t('state')} value={`${stateName(party.stateCode)} (${party.stateCode})`} />
          </>
        ) : (
          <>
            <Field id="p-gstin" label={t('gstin')} hint={t('gstinHint')} error={err('gstin')}>
              <input id="p-gstin" className="mono" style={{ textTransform: 'uppercase' }} maxLength={15} autoComplete="off" {...register('gstin')} />
            </Field>
            <Field id="p-state" label={t('state')} error={err('stateCode')}>
              <select id="p-state" {...register('stateCode')}>
                {GST_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
      {identityLocked && (
        <p className="hint" style={{ margin: '-4px 0 12px' }}>
          {t('identityOwnerOnly')}
        </p>
      )}
      <div className="fieldrow">
        <Field id="p-phone" label={t('phone')} error={err('phone')}>
          <input id="p-phone" type="tel" inputMode="tel" autoComplete="off" {...register('phone')} />
        </Field>
        <Field id="p-wa" label={t('whatsapp')} error={err('whatsappPhone')}>
          <input id="p-wa" type="tel" inputMode="tel" autoComplete="off" {...register('whatsappPhone')} />
        </Field>
      </div>

      <div className="section-title">{t('termsTitle')}</div>
      {isAdmin ? (
        <div className="fieldrow">
          <div className="field">
            <Field id="p-cl" label={t('creditLimitField')} hint={party ? t('creditLimitBlankKeeps') : t('creditLimitBlankZero')} error={err('creditLimit')}>
              <input id="p-cl" inputMode="decimal" autoComplete="off" {...register('creditLimit', { disabled: unlimited })} />
            </Field>
            <div className="field check" style={{ marginBottom: 0 }}>
              <input id="p-cl-none" type="checkbox" {...register('creditUnlimited')} />
              <label htmlFor="p-cl-none">{t('creditUnlimited')}</label>
            </div>
          </div>
          <Field id="p-cd" label={t('creditDays')} error={err('creditDays')}>
            <input id="p-cd" inputMode="numeric" autoComplete="off" {...register('creditDays')} />
          </Field>
          <Field id="p-ir" label={t('interestRate')} error={err('interestRatePm')}>
            <input id="p-ir" inputMode="decimal" autoComplete="off" {...register('interestRatePm')} />
          </Field>
        </div>
      ) : (
        <p className="hint" style={{ margin: '0 0 12px' }}>
          {t('termsOwnerOnly')}
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDone}>
          {tc('cancel')}
        </button>
        <button type="submit" className="btn primary" disabled={pending}>
          {pending ? tc('saving') : tc('save')}
        </button>
      </div>
    </form>
  );
}

function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      <p className={`static${mono ? ' mono' : ''}`}>{value}</p>
    </div>
  );
}
