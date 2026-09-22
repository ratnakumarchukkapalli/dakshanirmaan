import { describe, expect, it } from 'vitest';
import { addDecimal } from './decimal';
import { autoAllocateOldestFirst, capAllocationInput } from './payments-alloc';
import type { OpenInvoiceForAlloc } from './payments-types';

const inv = (id: string, ageDays: number, openAmount: string): OpenInvoiceForAlloc => ({
  invoiceType: 'sales_invoice', invoiceId: id, partyId: 'p', docNo: id, docDate: '2026-09-01', ageDays, openAmount,
});

describe('capAllocationInput', () => {
  it('passes through a value at or under the open amount', () => {
    expect(capAllocationInput('100.00', '250.00')).toBe('100.00');
    expect(capAllocationInput('250.00', '250.00')).toBe('250.00');
  });

  it('caps a value over the open amount at the open amount exactly', () => {
    expect(capAllocationInput('999.99', '250.00')).toBe('250.00');
  });

  it('an empty box clears the allocation', () => {
    expect(capAllocationInput('', '250.00')).toBe('');
  });

  it('rejects anything that is not a plain 0-2dp decimal (the keystroke is ignored)', () => {
    expect(capAllocationInput('abc', '250.00')).toBeNull();
    expect(capAllocationInput('-5', '250.00')).toBeNull();
    expect(capAllocationInput('1.234', '250.00')).toBeNull();
  });
});

describe('autoAllocateOldestFirst', () => {
  it('fills the oldest invoice first, then the next, leaving the rest untouched', () => {
    const invoices = [inv('a', 10, '5000.00'), inv('b', 60, '3000.00'), inv('c', 30, '2000.00')];
    // b (60 days) is oldest, then c (30), then a (10).
    expect(autoAllocateOldestFirst(invoices, '4000.00')).toEqual({ b: '3000.00', c: '1000.00' });
  });

  it('fully allocates everything when the amount covers the total open', () => {
    const invoices = [inv('a', 10, '5000.00'), inv('b', 60, '3000.00')];
    expect(autoAllocateOldestFirst(invoices, '10000.00')).toEqual({ b: '3000.00', a: '5000.00' });
  });

  it('a zero or invalid amount allocates nothing', () => {
    const invoices = [inv('a', 10, '5000.00')];
    expect(autoAllocateOldestFirst(invoices, '0.00')).toEqual({});
    expect(autoAllocateOldestFirst(invoices, '')).toEqual({});
    expect(autoAllocateOldestFirst(invoices, 'nonsense')).toEqual({});
  });

  it('no open invoices allocates nothing, however large the amount', () => {
    expect(autoAllocateOldestFirst([], '99999.00')).toEqual({});
  });

  it('splits exactly at the paisa with no float drift across many rows', () => {
    // Amounts and a total chosen so naive float subtraction (0.1-style binary rounding) would
    // drift by the time it reaches the last row; exact-decimal arithmetic must not.
    const invoices = Array.from({ length: 7 }, (_, i) => inv(`r${i}`, 70 - i, '333.33'));
    const filled = autoAllocateOldestFirst(invoices, '1666.66');
    // 1666.66 / 333.33 = 5 rows fully allocated, one row partial, one row untouched.
    expect(Object.keys(filled)).toHaveLength(6);
    const total = Object.values(filled).reduce((s, v) => addDecimal(s, v, 2) ?? s, '0.00');
    expect(total).toBe('1666.66');
    expect(filled.r5).toBe('0.01');
    expect(filled.r6).toBeUndefined();
  });
});
