import type { PaymentFormValues } from '@/lib/payments-types';

// "Record this bank line" prefill for the payment form: pure, so it can be tested without a browser.
// Nothing here is posted; the owner still reviews and posts the payment.

export type BankLineForPayment = {
  txnDate: string;
  narration: string;
  reference: string | null;
  debit: string;
  credit: string;
};

type Mode = PaymentFormValues['mode'];

/** The payment mode a statement narration points at: UPI, NEFT, or a generic bank transfer (IMPS, RTGS and anything else). */
export function modeForNarration(narration: string): Mode {
  const n = narration.toUpperCase();
  if (/\bUPI\b/.test(n)) return 'upi';
  if (/\bNEFT\b/.test(n)) return 'neft';
  return 'bank';
}

const isZero = (v: string) => !/[1-9]/.test(v);

/** Which side of the books the line is: money in is a receipt, money out is a payment. */
export const directionOfLine = (line: Pick<BankLineForPayment, 'credit'>): 'receipt' | 'payment' => (isZero(line.credit) ? 'payment' : 'receipt');

/** Form values for a bank line. The party and the allocations are left for the owner to choose. */
export function prefillFromBankLine(line: BankLineForPayment, bankAccountId: string): PaymentFormValues {
  const direction = directionOfLine(line);
  return {
    direction,
    partyId: '',
    paymentDate: line.txnDate,
    mode: modeForNarration(line.narration),
    instrumentNo: (line.reference ?? '').slice(0, 40),
    instrumentDate: '',
    chequeBank: '',
    amount: direction === 'receipt' ? line.credit : line.debit,
    discount: '',
    accountId: bankAccountId,
    note: line.narration.trim().slice(0, 200),
    allocations: [],
  };
}

/**
 * What the form does once a payment recorded from a bank line has posted and the link to the line was tried.
 * A failed link must leave the form in a locked "posted" state: Post pressed again would make a second receipt
 * for the same money, and the draft id in the URL no longer opens anything.
 */
export function afterBankLinePost(linked: { ok: true } | { ok: false; error: string }, statementId: string):
  | { kind: 'redirect'; to: string }
  | { kind: 'posted_unlinked'; backHref: string; message: string } {
  const to = `/reports/reconcile/${statementId}`;
  return linked.ok ? { kind: 'redirect', to } : { kind: 'posted_unlinked', backHref: to, message: linked.error };
}

/** The values a bank-line payment must keep: the line's own side and amount, and the bank ledger. */
export function lockToBankLine(values: PaymentFormValues, line: { amount: string; direction: 'receipt' | 'payment' }, bankAccountId: string): PaymentFormValues {
  return { ...values, direction: line.direction, amount: line.amount, accountId: bankAccountId };
}
