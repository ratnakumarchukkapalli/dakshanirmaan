'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { createItem, deactivateItem, deleteItem, reactivateItem, updateItem } from '@/app/actions/items';
import { Field } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { createItemSchema, type ItemFormInput, type ItemFormOutput } from '@/schemas/items';

export interface ItemValues {
  id: string;
  name: string;
  brand: string | null;
  category: 'cement' | 'steel' | 'other';
  hsnCode: string;
  gstRate: string;
  baseUom: string;
  altUom: string | null;
  conversionFactor: string | null;
  reorderLevel: string;
  saleRate: string;
  isStock: boolean;
  isActive: boolean;
}

export function ItemModal({ item, triggerClassName = 'btn primary' }: { item?: ItemValues; triggerClassName?: string }) {
  const t = useTranslations('items');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>
        {item ? t('edit') : `+ ${t('newItem')}`}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={item ? t('editTitle') : t('createTitle')} closeLabel={tc('close')}>
        <ItemForm item={item} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function ItemForm({ item, onDone }: { item?: ItemValues; onDone: () => void }) {
  const t = useTranslations('items');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<ItemFormInput, unknown, ItemFormOutput>({
    resolver: zodResolver(createItemSchema),
    defaultValues: {
      name: item?.name ?? '', brand: item?.brand ?? '', category: item?.category ?? 'cement', hsnCode: item?.hsnCode ?? '',
      gstRate: item?.gstRate ?? '18', baseUom: item?.baseUom ?? '', altUom: item?.altUom ?? '',
      conversionFactor: item?.conversionFactor ?? '', reorderLevel: item?.reorderLevel ?? '0', saleRate: item?.saleRate ?? '',
      isStock: item?.isStock ?? true,
    },
  });
  const err = (n: keyof ItemFormInput) => (errors[n]?.message ? te(`field.${errors[n]!.message}`) : undefined);

  const submit = handleSubmit((values) =>
    start(async () => {
      setServerError(null);
      const res = item ? await updateItem({ id: item.id, ...values }) : await createItem(values);
      if (!res.ok) return setServerError(res.error);
      onDone();
      router.refresh();
    }),
  );

  return (
    <form onSubmit={submit} noValidate>
      {serverError && <p role="alert" className="alert bad">{serverError}</p>}
      <Field id="i-name" label={t('name')} error={err('name')}>
        <input id="i-name" autoFocus autoComplete="off" {...register('name')} />
      </Field>
      <div className="fieldrow">
        <Field id="i-brand" label={t('brand')} error={err('brand')}>
          <input id="i-brand" autoComplete="off" {...register('brand')} />
        </Field>
        <Field id="i-cat" label={t('category')} error={err('category')}>
          <select id="i-cat" {...register('category')}>
            <option value="cement">{t('cement')}</option>
            <option value="steel">{t('steel')}</option>
            <option value="other">{t('other')}</option>
          </select>
        </Field>
      </div>
      <div className="fieldrow">
        <Field id="i-hsn" label={t('hsn')} error={err('hsnCode')}>
          <input id="i-hsn" className="mono" inputMode="numeric" maxLength={8} autoComplete="off" {...register('hsnCode')} />
        </Field>
        <Field id="i-gst" label={t('gstRate')} error={err('gstRate')}>
          <input id="i-gst" inputMode="decimal" autoComplete="off" {...register('gstRate')} />
        </Field>
        <Field id="i-rate" label={t('saleRate')} error={err('saleRate')}>
          <input id="i-rate" inputMode="decimal" autoComplete="off" {...register('saleRate')} />
        </Field>
      </div>
      <div className="fieldrow">
        <Field id="i-base" label={t('baseUom')} hint={t('baseUomHint')} error={err('baseUom')}>
          <input id="i-base" autoComplete="off" {...register('baseUom')} />
        </Field>
        <Field id="i-alt" label={t('altUom')} hint={t('altUomHint')} error={err('altUom')}>
          <input id="i-alt" autoComplete="off" {...register('altUom')} />
        </Field>
        <Field id="i-factor" label={t('conversionFactor')} error={err('conversionFactor')}>
          <input id="i-factor" inputMode="decimal" autoComplete="off" {...register('conversionFactor')} />
        </Field>
      </div>
      <Field id="i-reorder" label={t('reorderLevel')} error={err('reorderLevel')}>
        <input id="i-reorder" inputMode="decimal" autoComplete="off" {...register('reorderLevel')} />
      </Field>
      <div className="field check">
        <input id="i-stock" type="checkbox" {...register('isStock')} />
        <label htmlFor="i-stock">{t('isStock')}</label>
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>{t('isStockHelp')} {item && t('unitsLocked')}</p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onDone}>{tc('cancel')}</button>
        <button type="submit" className="btn primary" disabled={pending}>{pending ? tc('saving') : tc('save')}</button>
      </div>
    </form>
  );
}

export function ItemStatusButton({ itemId, isActive }: { itemId: string; isActive: boolean }) {
  const t = useTranslations('items');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = () =>
    start(async () => {
      setError(null);
      const res = await (isActive ? deactivateItem : reactivateItem)({ itemId });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  return (
    <div>
      {error && <p role="alert" className="alert bad">{error}</p>}
      <button type="button" className={`btn sm ${isActive ? 'danger' : 'ghost'}`} disabled={pending} onClick={toggle}>
        {isActive ? t('disable') : t('enable')}
      </button>
    </div>
  );
}

/** Owner-only. Asks first; the database refuses an item that has ever been used. */
export function DeleteItemButton({ itemId, name }: { itemId: string; name: string }) {
  const t = useTranslations('items');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () =>
    start(async () => {
      setError(null);
      const res = await deleteItem({ itemId });
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => { setError(null); setOpen(true); }}>{t('delete')}</button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('deleteTitle', { name })} closeLabel={tc('close')}>
        <p>{t('deleteBody')}</p>
        {error && <p role="alert" className="alert bad">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>{tc('cancel')}</button>
          <button type="button" className="btn danger" disabled={pending} onClick={confirm}>{t('deleteConfirm')}</button>
        </div>
      </Modal>
    </>
  );
}
