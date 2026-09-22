'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { addDecimal, compareDecimal } from '@/lib/decimal';
import { inr2 } from '@/lib/format';
import { capAllocationInput } from '@/lib/payments-alloc';
import type { OpenInvoiceForAlloc } from '@/lib/payments-types';

interface Props {
  /** This party's open invoices for the chosen direction, oldest last (age_days ascending is computed here). */
  invoices: OpenInvoiceForAlloc[];
  /** invoiceId -> the amount typed against it, '' when none. */
  values: Record<string, string>;
  /** The payment's own amount — what the progress bar and "unallocated" summary are against. */
  amount: string;
  onChange: (invoiceId: string, value: string) => void;
  onAutoAllocate: () => void;
  onClear: () => void;
}

/**
 * The allocation grid from the prototype's `#allocgrid`: one row per open invoice, an
 * amount input capped at that row's own open amount (display only — `post_payment` re-validates
 * every cap under the row lock at post time and is the actual authority), a progress bar and an
 * "auto-allocate oldest first" shortcut. Below 600px the Due column collapses into the row's
 * sub-line (`.mdue`, styled in globals.css).
 */
export function AllocationGrid({ invoices, values, amount, onChange, onAutoAllocate, onClear }: Props) {
  const t = useTranslations('payments');

  const sorted = useMemo(() => [...invoices].sort((a, b) => b.ageDays - a.ageDays), [invoices]);

  const allocated = useMemo(
    () => Object.values(values).reduce((s, v) => (v ? addDecimal(s, v, 2) ?? s : s), '0.00'),
    [values],
  );
  const remainder = useMemo(() => {
    const r = addDecimal(amount || '0.00', `-${allocated}`, 2) ?? '0.00';
    return r.startsWith('-') ? '0.00' : r;
  }, [amount, allocated]);
  const fullyAllocated = compareDecimal(remainder, '0.00', 2) === 0 && compareDecimal(amount || '0.00', '0.00', 2) === 1;
  const progressPct = Number(amount) > 0 ? Math.min((Number(allocated) / Number(amount)) * 100, 100) : 0;

  function onInput(inv: OpenInvoiceForAlloc, raw: string) {
    const capped = capAllocationInput(raw, inv.openAmount);
    if (capped !== null) onChange(inv.invoiceId, capped);
  }

  if (sorted.length === 0) {
    return <p className="hint">{t('noOpenInvoices')}</p>;
  }

  return (
    <div>
      <div className="cardtitle" style={{ marginTop: 8 }}>
        <span>{t('allocateTo')}</span>
        <span className="muted" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
          {fullyAllocated ? t('fullyAllocated') : t('unallocatedAmount', { amount: inr2(remainder) })}
        </span>
      </div>
      <div className="progress"><i style={{ width: `${progressPct}%` }} /></div>
      <div className="alloc">
        <div className="h">{t('invoiceCol')}</div>
        <div className="h due" style={{ textAlign: 'right' }}>{t('dueCol')}</div>
        <div className="h" style={{ textAlign: 'right' }}>{t('allocateCol')}</div>
        {sorted.map((inv) => (
          <div key={inv.invoiceId} style={{ display: 'contents' }}>
            <div>
              <span className="mono">{inv.docNo}</span>{' '}
              <span className="psub num">
                {t('ageDays', { n: inv.ageDays })}
                <span className="mdue"> · {t('dueCol')} {inr2(inv.openAmount)}</span>
              </span>
            </div>
            <div className="due num r" style={{ textAlign: 'right' }}>{inr2(inv.openAmount)}</div>
            <div style={{ textAlign: 'right' }}>
              <input
                className="qty num" inputMode="decimal" placeholder="0" aria-label={t('allocateFor', { doc: inv.docNo })}
                value={values[inv.invoiceId] ?? ''} onChange={(e) => onInput(inv, e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="btn ghost sm" onClick={onAutoAllocate}>{t('autoAllocate')}</button>
        <button type="button" className="btn ghost sm" onClick={onClear}>{t('clearAllocations')}</button>
      </div>
    </div>
  );
}
