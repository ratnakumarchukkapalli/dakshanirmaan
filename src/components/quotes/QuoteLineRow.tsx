'use client';

import { useTranslations } from 'next-intl';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Field } from '@/components/ui/Field';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import { inr2 } from '@/lib/format';
import type { PreviewLineResult } from '@/lib/invoice-math';
import type { FormItem } from '@/lib/sales-types';
import type { QuoteFormValues } from '@/lib/quotes-types';
import { trimZeros } from '@/lib/units';

interface Props {
  index: number;
  item: FormItem | undefined;
  itemOptions: PickerOption[];
  itemId: string;
  preview: PreviewLineResult | null;
  register: UseFormRegister<QuoteFormValues>;
  errors: FieldErrors<QuoteFormValues>;
  onPickItem: (id: string) => void;
  onQty: (value: string) => void;
  onAlt: (value: string) => void;
  onRemove: () => void;
}

/** One quotation line: the invoice line without the stock hint (a quote reserves nothing). A card on phones. */
export function QuoteLineRow({ index: i, item, itemOptions, itemId, preview, register, errors, onPickItem, onQty, onAlt, onRemove }: Props) {
  const t = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const e = errors.lines?.[i];
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const hasAlt = !!item?.altUom && !!item.factor;

  return (
    <div className="lrow" role="group" aria-label={t('lineN', { n: i + 1 })}>
      <div className="lhead">
        <Field id={`ql${i}-item`} label={t('item')} error={err(e?.itemId?.message)} className="litem">
          <Picker
            id={`ql${i}-item`} options={itemOptions} value={itemId} onPick={onPickItem} placeholder={t('pickItem')}
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
          {!item.isActive && <span className="warntext"> · {t('disabledTag')}</span>}
        </p>
      )}
      <div className="lnums">
        <Field id={`ql${i}-qty`} label={t('qtyIn', { uom: item?.baseUom ?? t('qty') })} error={err(e?.qty?.message)}>
          <input id={`ql${i}-qty`} inputMode="decimal" autoComplete="off" className="num r"
            {...register(`lines.${i}.qty`, { onChange: (ev) => onQty(ev.target.value) })} />
        </Field>
        {hasAlt && (
          <Field id={`ql${i}-alt`} label={t('qtyIn', { uom: item.altUom! })} error={err(e?.altQty?.message)}>
            <input id={`ql${i}-alt`} inputMode="decimal" autoComplete="off" className="num r"
              {...register(`lines.${i}.altQty`, { onChange: (ev) => onAlt(ev.target.value) })} />
          </Field>
        )}
        <Field id={`ql${i}-rate`} label={t('rate')} error={err(e?.rate?.message)}>
          <input id={`ql${i}-rate`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.rate`)} />
        </Field>
        <Field id={`ql${i}-disc`} label={t('discount')} error={err(e?.discountPct?.message)}>
          <input id={`ql${i}-disc`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.discountPct`)} />
        </Field>
        <div className="lamt" aria-live="polite">
          <span className="lbl">{t('lineTaxable')}</span>
          <b className="num">{preview ? inr2(preview.taxable) : '—'}</b>
        </div>
      </div>
    </div>
  );
}
