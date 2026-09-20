'use client';

import { useTranslations } from 'next-intl';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Field } from '@/components/ui/Field';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import { compareDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import type { PreviewLineResult } from '@/lib/invoice-math';
import type { FormItem, InvoiceFormValues } from '@/lib/sales-types';
import { trimZeros } from '@/lib/units';

interface Props {
  index: number;
  item: FormItem | undefined;
  itemOptions: PickerOption[];
  itemId: string;
  qty: string;
  preview: PreviewLineResult | null;
  register: UseFormRegister<InvoiceFormValues>;
  errors: FieldErrors<InvoiceFormValues>;
  onPickItem: (id: string) => void;
  onQty: (value: string) => void;
  onAlt: (value: string) => void;
  onRemove: () => void;
}

/** One invoice line. A card on phones; on wide screens the fields sit in one row. */
export function LineRow({ index: i, item, itemOptions, itemId, qty, preview, register, errors, onPickItem, onQty, onAlt, onRemove }: Props) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const e = errors.lines?.[i];
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const hasAlt = !!item?.altUom && !!item.factor;
  const over = item?.isStock && qty !== '' && compareDecimal(qty, item.onHand, 3) === 1;

  return (
    <div className="lrow" role="group" aria-label={t('lineN', { n: i + 1 })}>
      <div className="lhead">
        <Field id={`l${i}-item`} label={t('item')} error={err(e?.itemId?.message)} className="litem">
          <Picker
            id={`l${i}-item`} options={itemOptions} value={itemId} onPick={onPickItem} placeholder={t('pickItem')}
            dialogTitle={t('pickItem')} searchLabel={t('searchItems')} emptyText={t('noMatches')} closeLabel={tc('close')}
          />
        </Field>
        <button type="button" className="iconbtn lremove" onClick={onRemove} aria-label={t('removeLine', { n: i + 1 })}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {item && (
        <p className="sub lineinfo">
          <span className="mono">HSN {item.hsn}</span> · GST {trimZeros(item.gstRate)}%
          {item.isStock && (
            <>
              {' · '}
              <span className={over ? 'warntext' : undefined}>{t('onHand', { qty: trimZeros(item.onHand), uom: item.baseUom })}</span>
            </>
          )}
          {over && <span className="warntext" role="status"> · {t('overStock')}</span>}
        </p>
      )}
      <div className="lnums">
        <Field id={`l${i}-qty`} label={t('qtyIn', { uom: item?.baseUom ?? t('qty') })} error={err(e?.qty?.message)}>
          <input id={`l${i}-qty`} inputMode="decimal" autoComplete="off" className="num r"
            {...register(`lines.${i}.qty`, { onChange: (ev) => onQty(ev.target.value) })} />
        </Field>
        {hasAlt && (
          <Field id={`l${i}-alt`} label={t('qtyIn', { uom: item.altUom! })} error={err(e?.altQty?.message)}>
            <input id={`l${i}-alt`} inputMode="decimal" autoComplete="off" className="num r"
              {...register(`lines.${i}.altQty`, { onChange: (ev) => onAlt(ev.target.value) })} />
          </Field>
        )}
        <Field id={`l${i}-rate`} label={t('rate')} error={err(e?.rate?.message)}>
          <input id={`l${i}-rate`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.rate`)} />
        </Field>
        <Field id={`l${i}-disc`} label={t('discount')} error={err(e?.discountPct?.message)}>
          <input id={`l${i}-disc`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.discountPct`)} />
        </Field>
        <div className="lamt" aria-live="polite">
          <span className="lbl">{t('lineTaxable')}</span>
          <b className="num">{preview ? inr2(preview.taxable) : '—'}</b>
        </div>
      </div>
    </div>
  );
}
