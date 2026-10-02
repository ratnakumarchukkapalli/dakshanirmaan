'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { saveQuote } from '@/app/actions/quotes';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import type { ErrorCode } from '@/lib/action-result';
import { inr2, inrRate } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { previewTotals } from '@/lib/invoice-math';
import { derivePlaceOfSupply } from '@/lib/place-of-supply';
import type { QuoteFormInitial, QuoteFormValues } from '@/lib/quotes-types';
import type { FormParty, InvoiceFormContext } from '@/lib/sales-types';
import { altToBase, baseToAlt, rateText, trimZeros } from '@/lib/units';
import { QUOTE_NOTE_MAX, saveQuoteSchema } from '@/schemas/quotes';
import { QuoteLineRow } from './QuoteLineRow';

const emptyLine = () => ({ itemId: '', qty: '', altQty: '', rate: '', discountPct: '' });

interface Props {
  ctx: InvoiceFormContext;
  /** Present when editing an open quotation. */
  initial?: QuoteFormInitial;
}

/**
 * Create / edit a quotation. No stock check, no credit limit, no payment: a quote posts nothing.
 * The numbers shown beside the form are an ESTIMATE (the invoice form's preview math); the real
 * totals come from the database and are shown on the quotation after saving.
 */
export function QuoteForm({ ctx, initial }: Props) {
  const t = useTranslations('quotes');
  const ts = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const partiesById = useMemo(() => new Map(ctx.parties.map((p) => [p.id, p])), [ctx.parties]);
  const itemsById = useMemo(() => new Map(ctx.items.map((i) => [i.id, i])), [ctx.items]);

  const { register, handleSubmit, control, setValue, getValues, formState: { errors } } = useForm<QuoteFormValues>({
    // The shared schema is the one source of truth; its input type is looser than the form's, hence the cast.
    resolver: zodResolver(saveQuoteSchema) as unknown as Resolver<QuoteFormValues>,
    defaultValues: initial?.values ?? { partyId: '', quoteDate: ctx.today, validUntil: '', note: '', lines: [emptyLine()] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control });
  const partyId = watched.partyId ?? '';
  const lines = useMemo(() => watched.lines ?? [], [watched.lines]);
  const noteLength = (watched.note ?? '').length;
  const party: FormParty | undefined = partiesById.get(partyId);
  // Same rule as the invoice form and the database: the customer's default delivery site (when it is not the billing address), else their default address, else their state.
  const defaultSite = party?.sites.find((s) => s.id === party.defaultSiteId && !s.isBilling);
  const place = derivePlaceOfSupply(party?.sites ?? [], defaultSite?.id ?? '', party?.stateCode) ?? ctx.orgState;
  const intra = place === ctx.orgState;

  const totals = useMemo(
    () =>
      previewTotals(
        lines.map((l) => ({ qty: l?.qty ?? '', rate: l?.rate ?? '', discountPct: l?.discountPct ?? '', gstRate: itemsById.get(l?.itemId ?? '')?.gstRate ?? '' })),
        intra,
      ),
    [lines, itemsById, intra],
  );

  useEffect(() => {
    if (failure) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure]);

  const partyOptions: PickerOption[] = useMemo(
    () =>
      [...ctx.parties]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id, title: p.name, disabled: false,
          sub: [p.gstin, stateName(p.stateCode), p.isActive ? null : ts('disabledTag')].filter(Boolean).join(' · '),
          search: `${p.name} ${p.gstin ?? ''} ${stateName(p.stateCode)}`.toLowerCase(),
        })),
    [ctx.parties, ts],
  );
  const itemOptions: PickerOption[] = useMemo(
    () =>
      ctx.items.map((i) => ({
        id: i.id, title: i.brand ? `${i.name} · ${i.brand}` : i.name,
        sub: [`HSN ${i.hsn}`, `${inrRate(i.saleRate)}/${i.baseUom}`, i.isActive ? null : ts('disabledTag')].filter(Boolean).join(' · '),
        search: `${i.name} ${i.brand ?? ''} ${i.hsn}`.toLowerCase(),
      })),
    [ctx.items, ts],
  );

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  function pickItem(index: number, id: string) {
    const item = itemsById.get(id);
    if (!item) return;
    setValue(`lines.${index}.itemId`, id, { shouldValidate: true });
    setValue(`lines.${index}.rate`, rateText(item.saleRate), { shouldValidate: true });
    const qty = getValues(`lines.${index}.qty`);
    setValue(`lines.${index}.altQty`, item.altUom && item.factor && qty ? trimZeros(baseToAlt(item.factor, qty) ?? '') : '');
  }
  // Typing one unit fills the other from the item's per-piece weight; the base unit is what is saved.
  function onQty(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.altQty`, trimZeros(baseToAlt(item.factor, value) ?? ''));
  }
  function onAlt(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.qty`, trimZeros(altToBase(item.factor, value) ?? ''), { shouldValidate: value !== '' });
  }

  const zeroTotal = totals.grandTotal === '0.00' || totals.lines.every((l) => l === null);

  const submit = handleSubmit((values) =>
    start(async () => {
      setFailure(null);
      if (values.quoteDate > ctx.today) return setFailure({ message: te('quote.future_date') });
      if (zeroTotal) return setFailure({ message: te('quote.zero_total') });
      const res = await saveQuote({ ...values, id: initial?.id, expectedUpdatedAt: initial?.updatedAt });
      if (!res.ok) return setFailure({ message: res.error, code: res.code });
      // The saved quotation shows the database's own totals.
      router.push(`/sales/quotes/${res.data.id}?saved=1`);
    }),
  );

  const linesErr = err(errors.lines?.root?.message ?? errors.lines?.message);

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href={initial ? `/sales/quotes/${initial.id}` : '/sales/quotes'} className="btn ghost sm">{t('back')}</Link>
        <h1>{initial ? t('titleEdit') : t('titleNew')}</h1>
        {initial ? <span className="sub mono">{initial.quoteNo}</span> : <span className="sub mono">{t('numberOnSave')}</span>}
        <Chip tone="muted">{t('statusOpen')}</Chip>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate className="bill">
        <div className="billmain stack">
          <div ref={alertRef} aria-live="polite">
            {failure && (
              <div role="alert" className="alert bad">
                {failure.message}
                {failure.code === 'conflict' && (
                  <>
                    {' '}
                    <button type="button" className="linkbtn" onClick={() => window.location.reload()}>{ts('reload')}</button>
                  </>
                )}
              </div>
            )}
          </div>

          <Card>
            <div className="fieldrow">
              <Field id="q-party" label={ts('customer')} error={err(errors.partyId?.message)} className="grow2">
                <Picker
                  id="q-party" options={partyOptions} value={partyId}
                  onPick={(id) => setValue('partyId', id, { shouldValidate: true })} placeholder={ts('pickCustomer')}
                  dialogTitle={ts('pickCustomer')} searchLabel={ts('searchCustomers')} emptyText={ts('noMatches')} closeLabel={tc('close')}
                />
              </Field>
              <Field id="q-date" label={t('quoteDate')} hint={ts('dateHint')} error={err(errors.quoteDate?.message)} className="datefield">
                <DateField
                  id="q-date" value={watched.quoteDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('quoteDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
              <Field id="q-valid" label={t('validUntil')} hint={t('validUntilHint')} error={err(errors.validUntil?.message)} className="datefield">
                <DateField
                  id="q-valid" value={watched.validUntil ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('validUntil', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <div className="cardtitle"><span>{ts('items')}</span></div>
            {linesErr && <p className="fielderror" role="alert">{linesErr}</p>}
            <div className="lines">
              {fields.map((f, i) => {
                const l = lines[i];
                return (
                  <QuoteLineRow
                    key={f.id} index={i} item={itemsById.get(l?.itemId ?? '')} itemOptions={itemOptions} itemId={l?.itemId ?? ''}
                    preview={totals.lines[i] ?? null} register={register} errors={errors}
                    onPickItem={(id) => pickItem(i, id)} onQty={(v) => onQty(i, v)} onAlt={(v) => onAlt(i, v)}
                    onRemove={() => (fields.length > 1 ? remove(i) : setValue(`lines.${i}`, emptyLine()))}
                  />
                );
              })}
            </div>
            <button type="button" className="btn ghost addline" onClick={() => append(emptyLine())}>+ {ts('addItem')}</button>
            <p className="hint">{ts('altHint')}</p>
          </Card>

          <Card>
            <Field id="q-note" label={t('note')} hint={t('noteHint')} error={err(errors.note?.message)}>
              <textarea id="q-note" rows={3} maxLength={QUOTE_NOTE_MAX} autoComplete="off" {...register('note')} />
            </Field>
            <p className="hint num" style={{ margin: 0 }}>{noteLength}/{QUOTE_NOTE_MAX}</p>
          </Card>
        </div>

        <aside className="floatpanel" aria-label={t('summary')}>
          <GlassPanel strong className="card panelcard">
            {party ? (
              <div className="partycard">
                <div className="n">{party.name}</div>
                <div className="g mono">
                  {[party.gstin ? `GSTIN ${party.gstin}` : ts('noGstin'), `${stateName(party.stateCode)} (${party.stateCode})`].join(' · ')}
                </div>
                <div className="g">{intra ? ts('intraNote') : ts('interNote')}</div>
              </div>
            ) : (
              <p className="hint" style={{ margin: '0 0 10px' }}>{ts('pickCustomerHint')}</p>
            )}
            <div className="previewtag">{t('estimate')}</div>
            <TotalsRows
              totals={totals} intra={intra}
              labels={{ taxable: ts('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: ts('roundOff'), total: ts('total') }}
            />
            <p className="postnote">{t('estimateNote')}</p>
            <p className="postnote">{t('noChecks')}</p>
          </GlassPanel>

          <GlassPanel className="actionbar">
            <div className="actiontotal">
              <div>
                <span className="lbl">{ts('total')}</span>
                <b className="num">{inr2(totals.grandTotal)}</b>
              </div>
            </div>
            <div className="actionbtns">
              <button type="submit" className="btn primary big" disabled={pending}>{pending ? tc('saving') : t('save')}</button>
            </div>
          </GlassPanel>
        </aside>
      </form>
    </div>
  );
}
