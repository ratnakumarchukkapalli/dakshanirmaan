'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { postChallan, saveDraftChallan } from '@/app/actions/challans';
import { Card } from '@/components/ui/Card';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import type { ErrorCode } from '@/lib/action-result';
import { compareDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import { EWAY_BILL_THRESHOLD } from '@/lib/gst';
import { previewTotals } from '@/lib/invoice-math';
import type { ChallanFormInitial, ChallanFormValues, InvoiceFormContext } from '@/lib/sales-types';
import { altToBase, baseToAlt, rateText, trimZeros } from '@/lib/units';
import { saveDraftChallanSchema } from '@/schemas/challans';
import { ChallanLineRow } from './ChallanLineRow';

const emptyLine = () => ({ itemId: '', qty: '', altQty: '', rate: '', discountPct: '' });

interface Props {
  ctx: InvoiceFormContext;
  /** Present when editing an existing draft. */
  initial?: ChallanFormInitial;
}

/**
 * A single plain card, same as the prototype's `#challan` screen — a challan has no tax and no
 * credit check to justify the invoice form's separate floating summary panel. It sits in the left
 * half of the sales/challans/new page's grid2, next to the Open challans panel.
 */
export function ChallanForm({ ctx, initial }: Props) {
  const t = useTranslations('challans');
  const ts = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const [confirm, setConfirm] = useState<null | 'post'>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const partiesById = useMemo(() => new Map(ctx.parties.map((p) => [p.id, p])), [ctx.parties]);
  // A challan is a goods-out note: only items tracked as stock can go on one.
  const stockItems = useMemo(() => ctx.items.filter((i) => i.isStock), [ctx.items]);
  const itemsById = useMemo(() => new Map(stockItems.map((i) => [i.id, i])), [stockItems]);

  const { register, handleSubmit, control, setValue, getValues, trigger, reset, formState: { errors } } = useForm<ChallanFormValues>({
    // The shared schema is the one source of truth; its input type is looser than the form's, hence the cast.
    resolver: zodResolver(saveDraftChallanSchema) as unknown as Resolver<ChallanFormValues>,
    defaultValues: initial?.values ?? { partyId: '', challanDate: ctx.today, siteId: '', vehicleNo: '', lines: [emptyLine()] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control });
  const partyId = watched.partyId ?? '';
  const siteId = watched.siteId ?? '';
  const lines = useMemo(() => watched.lines ?? [], [watched.lines]);
  const party = partiesById.get(partyId);

  // No tax on a challan; `previewTotals`'s `taxable` is exactly the value formula the database
  // writes to each line's `value` column (qty x rate less discount), which is what matters here.
  const totals = useMemo(
    () => previewTotals(lines.map((l) => ({ qty: l?.qty ?? '', rate: l?.rate ?? '', discountPct: l?.discountPct ?? '', gstRate: '0' })), true),
    [lines],
  );

  useEffect(() => {
    if (failure || notice) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure, notice]);

  const partyOptions: PickerOption[] = useMemo(
    () =>
      [...ctx.parties]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id, title: p.name, disabled: false,
          sub: [p.gstin, p.isActive ? null : ts('disabledTag')].filter(Boolean).join(' · '),
          search: `${p.name} ${p.gstin ?? ''}`.toLowerCase(),
        })),
    [ctx.parties, ts],
  );
  const itemOptions: PickerOption[] = useMemo(
    () =>
      stockItems.map((i) => ({
        id: i.id, title: i.brand ? `${i.name} · ${i.brand}` : i.name,
        sub: [`HSN ${i.hsn}`, ts('onHand', { qty: trimZeros(i.onHand), uom: i.baseUom }), i.isActive ? null : ts('disabledTag')].filter(Boolean).join(' · '),
        search: `${i.name} ${i.brand ?? ''} ${i.hsn}`.toLowerCase(),
      })),
    [stockItems, ts],
  );

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  function pickParty(id: string) {
    const p = partiesById.get(id);
    if (!p) return;
    setValue('partyId', id, { shouldValidate: true });
    const site = p.sites.find((s) => s.id === p.defaultSiteId && !s.isBilling);
    setValue('siteId', site ? site.id : '');
  }

  function pickItem(index: number, id: string) {
    const item = itemsById.get(id);
    if (!item) return;
    setValue(`lines.${index}.itemId`, id, { shouldValidate: true });
    setValue(`lines.${index}.rate`, rateText(item.saleRate), { shouldValidate: true });
    const qty = getValues(`lines.${index}.qty`);
    setValue(`lines.${index}.altQty`, item.altUom && item.factor && qty ? trimZeros(baseToAlt(item.factor, qty) ?? '') : '');
  }

  function onQty(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.altQty`, trimZeros(baseToAlt(item.factor, value) ?? ''));
  }
  function onAlt(index: number, value: string) {
    const item = itemsById.get(getValues(`lines.${index}.itemId`));
    if (item?.altUom && item.factor) setValue(`lines.${index}.qty`, trimZeros(altToBase(item.factor, value) ?? ''), { shouldValidate: value !== '' });
  }

  const needsEwb = compareDecimal(totals.taxable, EWAY_BILL_THRESHOLD, 2) === 1;
  const zeroTotal = totals.taxable === '0.00' || totals.lines.every((l) => l === null);

  async function askToPost() {
    setFailure(null);
    setNotice(null);
    if (!(await trigger())) return;
    if (getValues('challanDate') > ctx.today) return setFailure({ message: te('validation.date_future') });
    if (zeroTotal) return setFailure({ message: te('validation.zero_total') });
    setConfirm('post');
  }

  /** Saves the draft, and for `post` also posts it. The database numbers it and moves the stock. */
  const execute = (kind: 'save' | 'post') =>
    handleSubmit((values) =>
      start(async () => {
        setFailure(null);
        setNotice(null);
        if (values.challanDate > ctx.today) return setFailure({ message: te('validation.date_future') });
        const saved = await saveDraftChallan({ ...values, id: draftId ?? undefined, expectedUpdatedAt: updatedAt ?? undefined });
        if (!saved.ok) {
          setConfirm(null);
          return setFailure({ message: saved.error, code: saved.code });
        }
        setDraftId(saved.data.id);
        setUpdatedAt(saved.data.updatedAt);
        if (!draftId) window.history.replaceState(null, '', `/sales/challans/new?id=${saved.data.id}`);
        if (kind === 'save') {
          setConfirm(null);
          return setNotice(t('savedNotice'));
        }

        const res = await postChallan({ id: saved.data.id });
        if (!res.ok) {
          setConfirm(null);
          return setFailure({ message: res.error, code: res.code });
        }
        // No dedicated "view" screen for a posted challan: land back on a blank form, ready for
        // the next one, with the Open challans panel now showing this one.
        setDraftId(null);
        setUpdatedAt(null);
        setConfirm(null);
        setNotice(t('postedNotice'));
        reset({ partyId: '', challanDate: ctx.today, siteId: '', vehicleNo: '', lines: [emptyLine()] });
        window.history.replaceState(null, '', '/sales/challans/new');
        router.refresh();
      }),
    )();

  return (
    <Card>
      <form onSubmit={(e) => e.preventDefault()} noValidate>
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
          {notice && <div role="status" className="alert good">{notice}</div>}
        </div>

        <div className="fieldrow">
          <Field id="dc-party" label={ts('customer')} error={err(errors.partyId?.message)} className="grow2">
            <Picker
              id="dc-party" options={partyOptions} value={partyId} onPick={pickParty} placeholder={ts('pickCustomer')}
              dialogTitle={ts('pickCustomer')} searchLabel={ts('searchCustomers')} emptyText={ts('noMatches')} closeLabel={tc('close')}
            />
          </Field>
          <Field id="dc-date" label={t('challanDate')} hint={ts('dateHint')} error={err(errors.challanDate?.message)} className="datefield">
            <DateField
              id="dc-date" value={watched.challanDate ?? ''} placeholder="DD-MM-YYYY"
              onChange={(iso) => setValue('challanDate', iso, { shouldValidate: true, shouldDirty: true })}
            />
          </Field>
          <Field id="dc-veh" label={ts('vehicleNo')} error={err(errors.vehicleNo?.message)}>
            <input id="dc-veh" className="mono" autoComplete="off" style={{ textTransform: 'uppercase' }} {...register('vehicleNo')} />
          </Field>
        </div>

        {party && (
          <div className="sitechips" role="group" aria-labelledby="dc-sites-label">
            <span className="lbl" id="dc-sites-label">{ts('deliverTo')}</span>
            <SiteChip active={siteId === ''} onPick={() => setValue('siteId', '')} label={ts('billingAddress')} />
            {party.sites.filter((s) => !s.isBilling).map((s) => (
              <SiteChip key={s.id} active={siteId === s.id} onPick={() => setValue('siteId', s.id)} label={s.label} />
            ))}
            {party.sites.length === 0 && <span className="hint" style={{ margin: 0 }}>{ts('noSites')}</span>}
          </div>
        )}

        <div className="cardtitle" style={{ marginTop: 14 }}><span>{ts('items')}</span></div>
        {(errors.lines?.root?.message ?? errors.lines?.message) && (
          <p className="fielderror" role="alert">{err(errors.lines?.root?.message ?? errors.lines?.message)}</p>
        )}
        <div className="lines">
          {fields.map((f, i) => {
            const l = lines[i];
            return (
              <ChallanLineRow
                key={f.id} index={i} item={itemsById.get(l?.itemId ?? '')} itemOptions={itemOptions} itemId={l?.itemId ?? ''}
                qty={l?.qty ?? ''} value={totals.lines[i]?.taxable ?? null} register={register} errors={errors}
                onPickItem={(id) => pickItem(i, id)} onQty={(v) => onQty(i, v)} onAlt={(v) => onAlt(i, v)}
                onRemove={() => (fields.length > 1 ? remove(i) : setValue(`lines.${i}`, emptyLine()))}
              />
            );
          })}
        </div>
        <button type="button" className="btn ghost addline" onClick={() => append(emptyLine())}>+ {ts('addItem')}</button>
        <p className="hint">{ts('altHint')}</p>
        {needsEwb && <p className="hint warntext" role="note">{ts('ewbHint', { amount: inr2(EWAY_BILL_THRESHOLD) })}</p>}
        <p className="hint">{t('postNote')}</p>

        <div className="totals" style={{ marginTop: 12 }}>
          <div className="row grand"><span>{t('totalValue')}</span><span className="num">{inr2(totals.taxable)}</span></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={pending} onClick={askToPost}>{t('post')}</button>
          <button type="button" className="btn ghost" disabled={pending} onClick={() => execute('save')}>
            {pending && !confirm ? tc('saving') : t('saveDraft')}
          </button>
        </div>
      </form>

      <Modal open={confirm === 'post'} onClose={() => setConfirm((c) => (c === 'post' ? null : c))} title={t('confirmPostTitle')} closeLabel={tc('close')}>
        <p>{t('confirmPostBody', { party: party?.name ?? '', amount: inr2(totals.taxable) })}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn primary" disabled={pending} onClick={() => execute('post')}>
            {pending ? t('posting') : t('confirmPost')}
          </button>
        </div>
      </Modal>
    </Card>
  );
}

function SiteChip({ active, onPick, label }: { active: boolean; onPick: () => void; label: string }) {
  return (
    <button type="button" className={`chipbtn${active ? ' on' : ''}`} aria-pressed={active} onClick={onPick}>
      {label}
    </button>
  );
}
