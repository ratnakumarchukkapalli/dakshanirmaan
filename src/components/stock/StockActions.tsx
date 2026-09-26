'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useFieldArray, useForm, useWatch, type FieldErrors, type Resolver } from 'react-hook-form';
import { receiveTransfer, recordAdjustment, recordTransfer } from '@/app/actions/stock';
import { DateField } from '@/components/ui/DateField';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import { baseToAlt, trimZeros } from '@/lib/units';
import { recordAdjustmentSchema, recordTransferSchema, type RecordAdjustmentInput, type RecordTransferInput } from '@/schemas/stock';

export interface ModalItem {
  id: string;
  name: string;
  brand: string | null;
  baseUom: string;
  altUom: string | null;
  factor: string | null;
  /** Godown id -> quantity on hand (text, quantities only). */
  onHand: Record<string, string>;
}
export interface ModalGodown { id: string; name: string; isDefault: boolean }

interface Props {
  items: ModalItem[];
  godowns: ModalGodown[];
  today: string;
  /** The godown the summary is showing (or the default one). */
  defaultGodown: string;
}

/**
 * Owner-only stock actions: adjustment, godown transfer. The bar is rendered only for a verified
 * owner (the posting functions refuse anyone else), and shows one confirmation line after a post.
 */
export function StockActions({ items, godowns, today, defaultGodown }: Props) {
  const t = useTranslations('stock');
  const [open, setOpen] = useState<null | 'adjust' | 'transfer'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (msg: string) => {
    setOpen(null);
    setNotice(msg);
  };
  return (
    <>
      <button type="button" className="btn ghost" onClick={() => setOpen('transfer')} disabled={godowns.length < 2}>{t('transferBtn')}</button>
      <button type="button" className="btn ghost" onClick={() => setOpen('adjust')}>{t('adjustBtn')}</button>
      <Modal open={open === 'adjust'} onClose={() => setOpen(null)} title={t('adjustTitle')} closeLabel={t('close')}>
        <AdjustmentForm items={items} godowns={godowns} today={today} defaultGodown={defaultGodown} onDone={() => done(t('adjustDone'))} onCancel={() => setOpen(null)} />
      </Modal>
      <Modal open={open === 'transfer'} onClose={() => setOpen(null)} title={t('transferTitle')} closeLabel={t('close')}>
        <TransferForm items={items} godowns={godowns} today={today} defaultGodown={defaultGodown} onDone={() => done(t('transferDone'))} onCancel={() => setOpen(null)} />
      </Modal>
      {notice && <p role="status" className="alert good" style={{ flexBasis: '100%', margin: 0 }}>{notice}</p>}
    </>
  );
}

function useItemOptions(items: ModalItem[], godownId: string, t: ReturnType<typeof useTranslations>): PickerOption[] {
  return useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        title: i.name,
        sub: t('onHandHere', { qty: trimZeros(i.onHand[godownId] ?? '0.000'), uom: i.baseUom }),
        search: `${i.name} ${i.brand ?? ''}`.toLowerCase(),
      })),
    [items, godownId, t],
  );
}

/** "≈ 120 pcs" under a quantity when the item has a second unit. */
function altHint(item: ModalItem | undefined, qty: string | undefined, t: ReturnType<typeof useTranslations>): string | undefined {
  if (!item?.altUom || !item.factor || !qty) return undefined;
  const alt = baseToAlt(item.factor, qty);
  return alt ? t('altHint', { qty: trimZeros(alt), uom: item.altUom }) : undefined;
}

type ErrMsg = { message?: string } | undefined;

function AdjustmentForm({ items, godowns, today, defaultGodown, onDone, onCancel }: Props & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('stock');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request, not a second one.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, control, handleSubmit, setValue, formState: { errors } } = useForm<RecordAdjustmentInput>({
    resolver: zodResolver(recordAdjustmentSchema) as unknown as Resolver<RecordAdjustmentInput>,
    defaultValues: { id: requestId, adjDate: today, warehouseId: defaultGodown, reason: '', lines: [{ itemId: '', direction: 'loss', qty: '', rate: '' }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const godownId = useWatch({ control, name: 'warehouseId' });
  const adjDate = useWatch({ control, name: 'adjDate' });
  const lines = useWatch({ control, name: 'lines' });
  const options = useItemOptions(items, godownId, t);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  const submit = handleSubmit((values) => {
    setFailure(null);
    start(async () => {
      const res = await recordAdjustment(values);
      if (!res.ok) return setFailure(res.error);
      router.refresh();
      onDone();
    });
  });

  return (
    <form onSubmit={submit} noValidate>
      <p className="minfo">{t('adjustInfo')}</p>
      <div className="fieldrow">
        <Field id="adj-date" label={t('date')} className="datefield" error={err((errors.adjDate as ErrMsg)?.message)}>
          <DateField id="adj-date" value={adjDate} onChange={(iso) => setValue('adjDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
        </Field>
        <Field id="adj-godown" label={t('godown')} error={err((errors.warehouseId as ErrMsg)?.message)}>
          <select id="adj-godown" {...register('warehouseId')}>
            {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="lines">
        {fields.map((f, i) => {
          const item = items.find((x) => x.id === lines?.[i]?.itemId);
          const found = lines?.[i]?.direction === 'found';
          const lineErr = (errors.lines?.[i] ?? {}) as FieldErrors<RecordAdjustmentInput['lines'][number]>;
          return (
            <div key={f.id} className="lrow">
              <div className="lhead">
                <Field id={`adj-item-${i}`} label={t('item')} className="litem" error={err((lineErr.itemId as ErrMsg)?.message)}>
                  <Picker
                    id={`adj-item-${i}`} options={options} value={lines?.[i]?.itemId ?? ''} placeholder={t('chooseItem')} dialogTitle={t('chooseItem')}
                    searchLabel={t('searchItem')} emptyText={t('noItems')} closeLabel={t('close')}
                    onPick={(id) => setValue(`lines.${i}.itemId`, id, { shouldValidate: true })}
                  />
                </Field>
                {fields.length > 1 && (
                  <button type="button" className="btn ghost lremove" aria-label={t('removeLine')} onClick={() => remove(i)}>✕</button>
                )}
              </div>
              <div className="lnums">
                <Field id={`adj-dir-${i}`} label={t('direction')}>
                  <select id={`adj-dir-${i}`} {...register(`lines.${i}.direction`)}>
                    <option value="loss">{t('dirLoss')}</option>
                    <option value="found">{t('dirFound')}</option>
                  </select>
                </Field>
                <Field id={`adj-qty-${i}`} label={item ? t('qtyIn', { uom: item.baseUom }) : t('qty')} hint={altHint(item, lines?.[i]?.qty, t)} error={err((lineErr.qty as ErrMsg)?.message)}>
                  <input id={`adj-qty-${i}`} inputMode="decimal" autoComplete="off" className="r" {...register(`lines.${i}.qty`)} />
                </Field>
                {found && (
                  <Field id={`adj-rate-${i}`} label={t('foundRate', { uom: item?.baseUom ?? '' })} hint={t('foundRateHint')} error={err((lineErr.rate as ErrMsg)?.message)}>
                    <input id={`adj-rate-${i}`} inputMode="decimal" autoComplete="off" className="r" {...register(`lines.${i}.rate`)} />
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {(errors.lines as ErrMsg)?.message && <p className="fielderror">{err((errors.lines as ErrMsg)?.message)}</p>}
      <button type="button" className="btn ghost addline" onClick={() => append({ itemId: '', direction: 'loss', qty: '', rate: '' })}>+ {t('addLine')}</button>
      <Field id="adj-reason" label={t('reason')} className="reasonfield" error={err((errors.reason as ErrMsg)?.message)}>
        <input id="adj-reason" autoComplete="off" placeholder={t('reasonPlaceholder')} {...register('reason')} />
      </Field>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{t('post')}</button>
      </div>
    </form>
  );
}

function TransferForm({ items, godowns, today, defaultGodown, onDone, onCancel }: Props & { onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('stock');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const to = godowns.find((g) => g.id !== defaultGodown)?.id ?? '';

  // One id per open of the modal (its content unmounts on close): a retry after a lost response is the same request, not a second one.
  const [requestId] = useState(() => crypto.randomUUID());
  const { register, control, handleSubmit, setValue, formState: { errors } } = useForm<RecordTransferInput>({
    resolver: zodResolver(recordTransferSchema) as unknown as Resolver<RecordTransferInput>,
    defaultValues: { id: requestId, transferDate: today, fromWarehouseId: defaultGodown, toWarehouseId: to, vehicleNo: '', lines: [{ itemId: '', qty: '' }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const from = useWatch({ control, name: 'fromWarehouseId' });
  const date = useWatch({ control, name: 'transferDate' });
  const lines = useWatch({ control, name: 'lines' });
  const options = useItemOptions(items, from, t);
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);

  const submit = handleSubmit((values) => {
    setFailure(null);
    start(async () => {
      const res = await recordTransfer(values);
      if (!res.ok) return setFailure(res.error);
      router.refresh();
      onDone();
    });
  });

  return (
    <form onSubmit={submit} noValidate>
      <p className="minfo">{t('transferInfo')}</p>
      <div className="fieldrow">
        <Field id="tr-date" label={t('date')} className="datefield" error={err((errors.transferDate as ErrMsg)?.message)}>
          <DateField id="tr-date" value={date} onChange={(iso) => setValue('transferDate', iso, { shouldValidate: true })} placeholder="DD-MM-YYYY" />
        </Field>
        <Field id="tr-vehicle" label={t('vehicle')} error={err((errors.vehicleNo as ErrMsg)?.message)}>
          <input id="tr-vehicle" className="mono" autoComplete="off" placeholder="AP 16 TC 4455" {...register('vehicleNo')} />
        </Field>
      </div>
      <div className="fieldrow">
        <Field id="tr-from" label={t('from')} error={err((errors.fromWarehouseId as ErrMsg)?.message)}>
          <select id="tr-from" {...register('fromWarehouseId')}>
            {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field id="tr-to" label={t('to')} error={err((errors.toWarehouseId as ErrMsg)?.message)}>
          <select id="tr-to" {...register('toWarehouseId')}>
            {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="lines">
        {fields.map((f, i) => {
          const item = items.find((x) => x.id === lines?.[i]?.itemId);
          const lineErr = (errors.lines?.[i] ?? {}) as FieldErrors<RecordTransferInput['lines'][number]>;
          return (
            <div key={f.id} className="lrow">
              <div className="lhead">
                <Field id={`tr-item-${i}`} label={t('item')} className="litem" error={err((lineErr.itemId as ErrMsg)?.message)}>
                  <Picker
                    id={`tr-item-${i}`} options={options} value={lines?.[i]?.itemId ?? ''} placeholder={t('chooseItem')} dialogTitle={t('chooseItem')}
                    searchLabel={t('searchItem')} emptyText={t('noItems')} closeLabel={t('close')}
                    onPick={(id) => setValue(`lines.${i}.itemId`, id, { shouldValidate: true })}
                  />
                </Field>
                {fields.length > 1 && (
                  <button type="button" className="btn ghost lremove" aria-label={t('removeLine')} onClick={() => remove(i)}>✕</button>
                )}
              </div>
              <div className="lnums">
                <Field id={`tr-qty-${i}`} label={item ? t('qtyIn', { uom: item.baseUom }) : t('qty')} hint={altHint(item, lines?.[i]?.qty, t)} error={err((lineErr.qty as ErrMsg)?.message)}>
                  <input id={`tr-qty-${i}`} inputMode="decimal" autoComplete="off" className="r" {...register(`lines.${i}.qty`)} />
                </Field>
              </div>
            </div>
          );
        })}
      </div>
      {(errors.lines as ErrMsg)?.message && <p className="fielderror">{err((errors.lines as ErrMsg)?.message)}</p>}
      <button type="button" className="btn ghost addline" onClick={() => append({ itemId: '', qty: '' })}>+ {t('addLine')}</button>
      {failure && <p role="alert" className="alert bad">{failure}</p>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{t('post')}</button>
      </div>
    </form>
  );
}

/** Owner-only: the destination godown confirms the goods arrived. */
export function ReceiveButton({ id }: { id: string }) {
  const t = useTranslations('stock');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button" className="btn primary sm" disabled={pending}
        onClick={() => start(async () => {
          setFailure(null);
          const res = await receiveTransfer({ id });
          if (!res.ok) return setFailure(res.error);
          router.refresh();
        })}
      >
        {t('receiveBtn')}
      </button>
      {failure && <p role="alert" className="fielderror">{failure}</p>}
    </div>
  );
}
