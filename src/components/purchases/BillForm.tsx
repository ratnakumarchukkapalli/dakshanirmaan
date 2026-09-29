'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form';
import { deleteDraftBill, postBill, saveDraftBill } from '@/app/actions/purchases';
import { TotalsRows } from '@/components/sales/TotalsPanel';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { Modal } from '@/components/ui/Modal';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import type { ErrorCode } from '@/lib/action-result';
import { inr, inr2 } from '@/lib/format';
import { stateName } from '@/lib/gst';
import { previewTotals } from '@/lib/invoice-math';
import type { BillFormContext, BillFormInitial, BillFormValues } from '@/lib/purchases-types';
import { altToBase, baseToAlt, trimZeros } from '@/lib/units';
import { saveDraftBillSchema } from '@/schemas/purchases';
import { BillLineRow } from './BillLineRow';

type Confirm = null | 'post' | 'delete';

const emptyLine = () => ({ itemId: '', qty: '', altQty: '', rate: '', discountPct: '' });

interface Props {
  ctx: BillFormContext;
  /** Present when editing an existing draft. */
  initial?: BillFormInitial;
}

export function BillForm({ ctx, initial }: Props) {
  const t = useTranslations('purchases');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initial?.updatedAt ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; code?: ErrorCode } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const suppliersById = useMemo(() => new Map(ctx.suppliers.map((p) => [p.id, p])), [ctx.suppliers]);
  const itemsById = useMemo(() => new Map(ctx.items.map((i) => [i.id, i])), [ctx.items]);

  const { register, handleSubmit, control, setValue, getValues, trigger, formState: { errors } } = useForm<BillFormValues>({
    // The shared schema is the one source of truth; its input type is looser than the form's, hence the cast.
    resolver: zodResolver(saveDraftBillSchema) as unknown as Resolver<BillFormValues>,
    defaultValues: initial?.values ?? {
      partyId: '', invoiceDate: ctx.today, supplierBillNo: '', supplierBillDate: ctx.today, itcEligible: true, lines: [emptyLine()],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const watched = useWatch({ control });
  const partyId = watched.partyId ?? '';
  const itcEligible = watched.itcEligible ?? true;
  const lines = useMemo(() => watched.lines ?? [], [watched.lines]);
  const supplier = suppliersById.get(partyId);
  // The tax split follows the supplier's own state (post_purchase_invoice decides again from the database).
  const intra = supplier ? supplier.stateCode === ctx.orgState : true;

  const totals = useMemo(
    () =>
      previewTotals(
        lines.map((l) => ({ qty: l?.qty ?? '', rate: l?.rate ?? '', discountPct: l?.discountPct ?? '', gstRate: itemsById.get(l?.itemId ?? '')?.gstRate ?? '' })),
        intra,
      ),
    [lines, itemsById, intra],
  );
  const zeroTotal = totals.grandTotal === '0.00' || totals.lines.every((l) => l === null);

  useEffect(() => {
    if (failure || notice) alertRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [failure, notice]);

  const supplierOptions: PickerOption[] = useMemo(
    () =>
      ctx.suppliers.map((p) => ({
        id: p.id, title: p.name, disabled: false,
        sub: [p.gstin ?? t('noGstin'), stateName(p.stateCode), p.isActive ? null : t('disabledTag')].filter(Boolean).join(' · '),
        search: `${p.name} ${p.gstin ?? ''} ${stateName(p.stateCode)}`.toLowerCase(),
      })),
    [ctx.suppliers, t],
  );
  const itemOptions: PickerOption[] = useMemo(
    () =>
      ctx.items.map((i) => ({
        id: i.id, title: i.brand ? `${i.name} · ${i.brand}` : i.name,
        sub: [`HSN ${i.hsn}`, `GST ${trimZeros(i.gstRate)}%`, i.isActive ? null : t('disabledTag')].filter(Boolean).join(' · '),
        search: `${i.name} ${i.brand ?? ''} ${i.hsn}`.toLowerCase(),
      })),
    [ctx.items, t],
  );

  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  function pickItem(index: number, id: string) {
    if (!itemsById.has(id)) return;
    setValue(`lines.${index}.itemId`, id, { shouldValidate: true });
    const item = itemsById.get(id)!;
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

  /** Checks the form, then asks the person to confirm before anything is posted. */
  async function askToPost() {
    setFailure(null);
    setNotice(null);
    if (!(await trigger())) return;
    if (getValues('invoiceDate') > ctx.today) return setFailure({ message: te('validation.bill_date_future') });
    if (zeroTotal) return setFailure({ message: te('validation.bill_zero_total') });
    setConfirm('post');
  }

  /** Saves the draft, and for `post` also posts it. The database does the numbering, the tax and the sums. */
  const execute = (kind: 'save' | 'post') =>
    handleSubmit((values) =>
      start(async () => {
        setFailure(null);
        setNotice(null);
        if (values.invoiceDate > ctx.today) return setFailure({ message: te('validation.bill_date_future') });
        const saved = await saveDraftBill({ ...values, id: draftId ?? undefined, expectedUpdatedAt: updatedAt ?? undefined });
        if (!saved.ok) {
          setConfirm(null);
          return setFailure({ message: saved.error, code: saved.code });
        }
        setDraftId(saved.data.id);
        setUpdatedAt(saved.data.updatedAt);
        if (!draftId) window.history.replaceState(null, '', `/purchases/${saved.data.id}`);
        if (kind === 'save') {
          setConfirm(null);
          return setNotice(t('savedNotice'));
        }

        const res = await postBill({ id: saved.data.id });
        if (!res.ok) {
          setConfirm(null);
          return setFailure({ message: res.error, code: res.code });
        }
        router.push(`/purchases/${res.data.id}/view?done=posted`);
      }),
    )();

  const removeDraft = () =>
    start(async () => {
      if (!draftId) return router.push('/purchases');
      const res = await deleteDraftBill({ id: draftId });
      if (!res.ok) {
        setConfirm(null);
        return setFailure({ message: res.error, code: res.code });
      }
      router.push('/purchases');
    });

  const supplierErr = err(errors.partyId?.message);
  const linesErr = err(errors.lines?.root?.message ?? errors.lines?.message);

  return (
    <div className="screen stack">
      <div className="screenhead" style={{ marginBottom: 0 }}>
        <Link href="/purchases" className="btn ghost sm">{t('back')}</Link>
        <h1>{draftId ? t('titleEdit') : t('titleNew')}</h1>
        <Chip tone="muted">{t('statusDraft')}</Chip>
        <span className="sub mono">{t('numberOnPost')}</span>
        {draftId && (
          <span className="headbtns">
            <button type="button" className="btn danger sm" onClick={() => setConfirm('delete')}>{t('deleteDraft')}</button>
          </span>
        )}
      </div>

      <form onSubmit={(e) => e.preventDefault()} noValidate className="bill">
        <div className="billmain stack">
          <div ref={alertRef} aria-live="polite">
            {failure && (
              <div role="alert" className="alert bad">
                {failure.message}
                {failure.code === 'conflict' && (
                  <>
                    {' '}
                    <button type="button" className="linkbtn" onClick={() => window.location.reload()}>{t('reload')}</button>
                  </>
                )}
              </div>
            )}
            {notice && <div role="status" className="alert good">{notice}</div>}
          </div>

          <Card>
            <div className="fieldrow">
              <Field id="bill-party" label={t('supplier')} error={supplierErr} className="grow2">
                <Picker
                  id="bill-party" options={supplierOptions} value={partyId}
                  onPick={(id) => setValue('partyId', id, { shouldValidate: true })} placeholder={t('pickSupplier')}
                  dialogTitle={t('pickSupplier')} searchLabel={t('searchSuppliers')} emptyText={t('noMatches')} closeLabel={tc('close')}
                />
              </Field>
              <Field id="bill-date" label={t('receivedOn')} hint={t('dateHint')} error={err(errors.invoiceDate?.message)} className="datefield">
                <DateField
                  id="bill-date" value={watched.invoiceDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('invoiceDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
            </div>
            <div className="fieldrow">
              <Field id="bill-no" label={t('supplierBillNo')} hint={t('supplierBillNoHint')} error={err(errors.supplierBillNo?.message)}>
                <input id="bill-no" className="mono" autoComplete="off" maxLength={40} {...register('supplierBillNo')} />
              </Field>
              <Field id="bill-bdate" label={t('supplierBillDate')} hint={t('dateHint')} error={err(errors.supplierBillDate?.message)} className="datefield">
                <DateField
                  id="bill-bdate" value={watched.supplierBillDate ?? ''} placeholder="DD-MM-YYYY"
                  onChange={(iso) => setValue('supplierBillDate', iso, { shouldValidate: true, shouldDirty: true })}
                />
              </Field>
            </div>
            <label className="radio" style={{ marginTop: 6 }}>
              <input type="checkbox" {...register('itcEligible')} />
              <span>{t('itcEligible')}</span>
            </label>
            <p className="hint">{itcEligible ? t('itcYes') : t('itcNo')}</p>
            <p className="hint">{t('rcmNote')}</p>
          </Card>

          <Card>
            <div className="cardtitle"><span>{t('items')}</span></div>
            {linesErr && <p className="fielderror" role="alert">{linesErr}</p>}
            <div className="lines">
              {fields.map((f, i) => {
                const l = lines[i];
                return (
                  <BillLineRow
                    key={f.id} index={i} item={itemsById.get(l?.itemId ?? '')} itemOptions={itemOptions} itemId={l?.itemId ?? ''}
                    preview={totals.lines[i] ?? null} register={register} errors={errors}
                    onPickItem={(id) => pickItem(i, id)} onQty={(v) => onQty(i, v)} onAlt={(v) => onAlt(i, v)}
                    onRemove={() => (fields.length > 1 ? remove(i) : setValue(`lines.${i}`, emptyLine()))}
                  />
                );
              })}
            </div>
            <button type="button" className="btn ghost addline" onClick={() => append(emptyLine())}>+ {t('addItem')}</button>
            <p className="hint">{t('altHint')}</p>
            <p className="hint">{t('stockOnlyHint')}</p>
          </Card>
        </div>

        <aside className="floatpanel" aria-label={t('summary')}>
          <GlassPanel strong className="card panelcard">
            {supplier ? (
              <div className="partycard">
                <div className="n">{supplier.name}</div>
                <div className="g mono">
                  {[supplier.gstin ? `GSTIN ${supplier.gstin}` : t('noGstin'), `${stateName(supplier.stateCode)} (${supplier.stateCode})`].join(' · ')}
                </div>
                <div className="g">{intra ? t('intraNote') : t('interNote')}</div>
                <div className="g" style={{ marginTop: 6 }}>
                  {t('owed')}: <b className="num">{inr(supplier.owed)}</b>
                </div>
              </div>
            ) : (
              <p className="hint" style={{ margin: '0 0 10px' }}>{t('pickSupplierHint')}</p>
            )}
            <div className="previewtag">{t('preview')}</div>
            <TotalsRows
              totals={totals} intra={intra}
              labels={{ taxable: t('taxableValue'), cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: t('roundOff'), total: t('total') }}
            />
            {!itcEligible && <p className="postnote warntext" role="note">{t('itcNoPreview')}</p>}
            <p className="postnote">{t('previewNote')}</p>
          </GlassPanel>

          <GlassPanel className="actionbar">
            <div className="actiontotal">
              <div>
                <span className="lbl">{t('total')}</span>
                <b className="num">{inr2(totals.grandTotal)}</b>
              </div>
              <button type="button" className="btn ghost big" disabled={pending} onClick={() => execute('save')}>
                {pending && !confirm ? tc('saving') : t('saveDraft')}
              </button>
            </div>
            <div className="actionbtns">
              <button type="button" className="btn primary big" disabled={pending} onClick={askToPost}>{t('post')}</button>
            </div>
          </GlassPanel>
        </aside>
      </form>

      <Modal open={confirm === 'post'} onClose={() => setConfirm((c) => (c === 'post' ? null : c))} title={t('confirmPostTitle')} closeLabel={tc('close')}>
        <p>{t('confirmPostBody', { party: supplier?.name ?? '', amount: inr2(totals.grandTotal) })}</p>
        <p className="hint">{itcEligible ? t('confirmItcYes') : t('confirmItcNo')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn primary" disabled={pending} onClick={() => execute('post')}>
            {pending ? t('posting') : t('confirmPost')}
          </button>
        </div>
      </Modal>

      <Modal open={confirm === 'delete'} onClose={() => setConfirm((c) => (c === 'delete' ? null : c))} title={t('deleteTitle')} closeLabel={tc('close')}>
        <p>{t('deleteBody')}</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending} onClick={removeDraft}>{t('deleteConfirm')}</button>
        </div>
      </Modal>
    </div>
  );
}
