// Client-side allocation math for the payment form's grid. Display-only: `post_payment`
// re-validates every allocation under the payment's row lock at post time and is the only
// authority on what an invoice can actually absorb. Exact decimal throughout — never `Number`
// arithmetic on money, the same rule the rest of this change follows.
import { addDecimal, compareDecimal } from '@/lib/decimal';
import type { OpenInvoiceForAlloc } from '@/lib/payments-types';

/**
 * A typed allocation amount, capped at that row's own open amount. `null` means `raw` isn't a
 * plain 0-2dp decimal and the keystroke should be ignored (the input keeps its previous value).
 */
export function capAllocationInput(raw: string, openAmount: string): string | null {
  if (raw === '') return '';
  if (!/^\d+(\.\d{0,2})?$/.test(raw)) return null;
  return compareDecimal(raw, openAmount, 2) === 1 ? openAmount : raw;
}

/** Fills open invoices oldest-first (highest `ageDays`) up to `amount`; the remainder is left on account. */
export function autoAllocateOldestFirst(invoices: OpenInvoiceForAlloc[], amount: string): Record<string, string> {
  let left = /^\d+(\.\d{1,2})?$/.test(amount) ? amount : '0.00';
  const next: Record<string, string> = {};
  for (const inv of [...invoices].sort((a, b) => b.ageDays - a.ageDays)) {
    if (compareDecimal(left, '0.00', 2) !== 1) break;
    const take = compareDecimal(left, inv.openAmount, 2) === 1 ? inv.openAmount : left;
    next[inv.invoiceId] = take;
    left = addDecimal(left, `-${take}`, 2) ?? '0.00';
  }
  return next;
}
