import { describe, expect, it } from 'vitest';
import { afterBankLinePost, directionOfLine, lockToBankLine, modeForNarration, prefillFromBankLine } from './bank-prefill';

describe('bank line → payment form', () => {
  it('picks the mode from the narration', () => {
    expect(modeForNarration('UPI-RAMESH TRADERS-RAMESH@OKHDFC')).toBe('upi');
    expect(modeForNarration('NEFT CR-SBIN0001-RAMESH')).toBe('neft');
    expect(modeForNarration('IMPS-4093-RAMESH')).toBe('bank');
    expect(modeForNarration('RTGS CR-HDFC')).toBe('bank');
    expect(modeForNarration('SOMETHING ELSE')).toBe('bank');
  });
  it('a credit line is a receipt for the credit amount, dated and referenced like the line', () => {
    const v = prefillFromBankLine({ txnDate: '2026-09-04', narration: '  UPI-RAMESH-PAY  ', reference: '123456789012', debit: '0.00', credit: '12500.50' }, 'bank-1');
    expect(v).toMatchObject({
      direction: 'receipt', paymentDate: '2026-09-04', amount: '12500.50', mode: 'upi', instrumentNo: '123456789012',
      accountId: 'bank-1', note: 'UPI-RAMESH-PAY', partyId: '', allocations: [],
    });
  });
  it('a debit line is a payment for the debit amount', () => {
    const line = { txnDate: '2026-09-04', narration: 'NEFT DR-ABC', reference: null, debit: '900.00', credit: '0.00' };
    expect(directionOfLine(line)).toBe('payment');
    expect(prefillFromBankLine(line, 'bank-1')).toMatchObject({ direction: 'payment', amount: '900.00', mode: 'neft', instrumentNo: '' });
  });
  it('keeps the reference and note inside what the form accepts', () => {
    const v = prefillFromBankLine({ txnDate: '2026-09-04', narration: 'x'.repeat(500), reference: 'R'.repeat(80), debit: '0.00', credit: '1.00' }, 'b');
    expect(v.instrumentNo).toHaveLength(40);
    expect(v.note).toHaveLength(200);
  });
});

describe('a payment recorded from a bank line', () => {
  it('goes back to the statement when the line was linked', () => {
    expect(afterBankLinePost({ ok: true }, 'st-1')).toEqual({ kind: 'redirect', to: '/reports/reconcile/st-1' });
  });
  it('locks into a posted state with the sentence and the way back when the link failed', () => {
    expect(afterBankLinePost({ ok: false, error: 'That entry is already matched.' }, 'st-1')).toEqual({
      kind: 'posted_unlinked', backHref: '/reports/reconcile/st-1', message: 'That entry is already matched.',
    });
  });
  it('keeps the line side, amount and bank ledger whatever the form holds', () => {
    const typed = prefillFromBankLine({ txnDate: '2026-09-04', narration: 'UPI-X', reference: null, debit: '0.00', credit: '500.00' }, 'bank-1');
    const tampered = { ...typed, direction: 'payment' as const, amount: '999.00', accountId: 'cash-1', partyId: 'p-1' };
    expect(lockToBankLine(tampered, { amount: '500.00', direction: 'receipt' }, 'bank-1')).toMatchObject({
      direction: 'receipt', amount: '500.00', accountId: 'bank-1', partyId: 'p-1',
    });
  });
});
