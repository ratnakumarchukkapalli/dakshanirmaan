'use client';

import { useTranslations } from 'next-intl';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import { Field } from '@/components/ui/Field';
import { Picker, type PickerOption } from '@/components/ui/Picker';
import { compareDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import type { ChallanFormValues, FormItem } from '@/lib/sales-types';
import { trimZeros } from '@/lib/units';

interface Props {
  index: number;
  item: FormItem | undefined;
  itemOptions: PickerOption[];
  itemId: string;
  qty: string;
  /** Line value for the e-way-bill threshold (qty x rate less discount) — no tax on a challan. */
  value: string | null;
  register: UseFormRegister<ChallanFormValues>;
  errors: FieldErrors<ChallanFormValues>;
  onPickItem: (id: string) => void;
  onQty: (value: string) => void;
  onAlt: (value: string) => void;
  onRemove: () => void;
}

/** One delivery-challan line. A card on phones; on wide screens the fields sit in one row. */
export function ChallanLineRow({ index: i, item, itemOptions, itemId, qty, value, register, errors, onPickItem, onQty, onAlt, onRemove }: Props) {
  const t = useTranslations('challans');
  const ts = useTranslations('sales');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const e = errors.lines?.[i];
  const err = (m?: string) => (m ? te(`field.${m}`) : undefined);
  const hasAlt = !!item?.altUom && !!item.factor;
  const over = item?.isStock && qty !== '' && compareDecimal(qty, item.onHand, 3) === 1;

  return (
    <div className="lrow" role="group" aria-label={ts('lineN', { n: i + 1 })}>
      <div className="lhead">
        <Field id={`dc${i}-item`} label={ts('item')} error={err(e?.itemId?.message)} className="litem">
          <Picker
            id={`dc${i}-item`} options={itemOptions} value={itemId} onPick={onPickItem} placeholder={ts('pickItem')}
            dialogTitle={ts('pickItem')} searchLabel={ts('searchItems')} emptyText={ts('noMatches')} closeLabel={tc('close')}
          />
        </Field>
        <button type="button" className="iconbtn lremove" onClick={onRemove} aria-label={ts('removeLine', { n: i + 1 })}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {item && (
        <p className="sub lineinfo">
          <span className="mono">HSN {item.hsn}</span>
          {item.isStock && (
            <>
              {' · '}
              <span className={over ? 'warntext' : undefined}>{ts('onHand', { qty: trimZeros(item.onHand), uom: item.baseUom })}</span>
            </>
          )}
          {over && <span className="warntext" role="status"> · {ts('overStock')}</span>}
        </p>
      )}
      <div className="lnums">
        <Field id={`dc${i}-qty`} label={ts('qtyIn', { uom: item?.baseUom ?? ts('qty') })} error={err(e?.qty?.message)}>
          <input id={`dc${i}-qty`} inputMode="decimal" autoComplete="off" className="num r"
            {...register(`lines.${i}.qty`, { onChange: (ev) => onQty(ev.target.value) })} />
        </Field>
        {hasAlt && (
          <Field id={`dc${i}-alt`} label={ts('qtyIn', { uom: item.altUom! })} error={err(e?.altQty?.message)}>
            <input id={`dc${i}-alt`} inputMode="decimal" autoComplete="off" className="num r"
              {...register(`lines.${i}.altQty`, { onChange: (ev) => onAlt(ev.target.value) })} />
          </Field>
        )}
        <Field id={`dc${i}-rate`} label={ts('rate')} error={err(e?.rate?.message)}>
          <input id={`dc${i}-rate`} inputMode="decimal" autoComplete="off" className="num r" {...register(`lines.${i}.rate`)} />
        </Field>
        <div className="lamt" aria-live="polite">
          <span className="lbl">{t('lineValue')}</span>
          <b className="num">{value ? inr2(value) : '—'}</b>
        </div>
      </div>
    </div>
  );
}
