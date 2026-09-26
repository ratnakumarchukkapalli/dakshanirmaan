import { describe, expect, it, vi } from 'vitest';
import { addDecimal } from './decimal';
import { netPaid, summariseVouchers, type EmployeeLedgerRow } from './staff-data';

vi.mock('server-only', () => ({}));

const row = (over: Partial<EmployeeLedgerRow>): EmployeeLedgerRow => ({
  key: 'k', entryId: 'e1', entryNo: 1, sourceId: 'v1', date: '2026-09-15', docNo: 'EXP/26-27/0004', voucherType: 'salary', periodMonth: '2026-09-01',
  accountKey: 'salary_payable', narration: null, debit: '0.00', credit: '0.00', advanceBalance: '0.00', payableBalance: '0.00', ...over,
});

describe('summariseVouchers', () => {
  it('folds a salary entry (payable raised, settled, advance recovered) into one line', () => {
    const rows = [
      row({ key: 'a', credit: '18000.00', advanceBalance: '3500.00', payableBalance: '18000.00' }),
      row({ key: 'b', debit: '18000.00', advanceBalance: '3500.00', payableBalance: '0.00' }),
      row({ key: 'c', accountKey: 'employee_advance', credit: '3500.00', advanceBalance: '0.00', payableBalance: '0.00' }),
    ];
    expect(summariseVouchers(rows)).toEqual([
      expect.objectContaining({ gross: '18000.00', paid: '14500.00', advanceGiven: '0.00', advanceRecovered: '3500.00', advanceBalance: '0.00', payableBalance: '0.00' }),
    ]);
  });

  it('a plain advance is one line with nothing earned', () => {
    const rows = [row({ entryId: 'e2', voucherType: 'advance', periodMonth: null, accountKey: 'employee_advance', debit: '2000.00', advanceBalance: '2000.00' })];
    expect(summariseVouchers(rows)).toEqual([expect.objectContaining({ gross: null, paid: null, advanceGiven: '2000.00', advanceBalance: '2000.00' })]);
  });

  it('a salary with no advance to recover still shows, paid in full', () => {
    const rows = [row({ credit: '15000.00', payableBalance: '15000.00' }), row({ key: 'b', debit: '15000.00' })];
    expect(summariseVouchers(rows)).toEqual([expect.objectContaining({ gross: '15000.00', paid: '15000.00', advanceRecovered: '0.00' })]);
  });

  it('keeps entries apart and in order', () => {
    const rows = [
      row({ entryId: 'e1', accountKey: 'employee_advance', voucherType: 'advance', debit: '100.00', advanceBalance: '100.00' }),
      row({ entryId: 'e2', accountKey: 'employee_advance', voucherType: 'advance', debit: '50.00', advanceBalance: '150.00' }),
    ];
    expect(summariseVouchers(rows).map((v) => [v.advanceGiven, v.advanceBalance])).toEqual([['100.00', '100.00'], ['50.00', '150.00']]);
  });

  it('a cancelled salary nets to zero instead of showing a second salary and "advance given"', () => {
    const original = [
      row({ key: 'a', credit: '18000.00', advanceBalance: '3500.00', payableBalance: '18000.00' }),
      row({ key: 'b', debit: '18000.00', advanceBalance: '3500.00', payableBalance: '0.00' }),
      row({ key: 'c', accountKey: 'employee_advance', credit: '3500.00', advanceBalance: '0.00', payableBalance: '0.00' }),
    ];
    // The cancel posts the mirror entry against the same voucher, dated later, with debit and credit swapped.
    const mirror = { entryId: 'e9', entryNo: 9, date: '2026-09-20', narration: 'Reversal of EXP/26-27/0004' };
    const reversal = [
      row({ ...mirror, key: 'd', debit: '18000.00', advanceBalance: '0.00', payableBalance: '-18000.00' }),
      row({ ...mirror, key: 'e', credit: '18000.00', advanceBalance: '0.00', payableBalance: '0.00' }),
      row({ ...mirror, key: 'f', accountKey: 'employee_advance', debit: '3500.00', advanceBalance: '3500.00', payableBalance: '0.00' }),
    ];
    const lines = summariseVouchers([...original, ...reversal]);
    expect(lines.map((v) => v.reversal)).toEqual([false, true]);
    expect(lines[1]).toEqual(expect.objectContaining({ gross: '-18000.00', paid: '-14500.00', advanceGiven: '0.00', advanceRecovered: '-3500.00', advanceBalance: '3500.00' }));
    const sum = (pick: (v: (typeof lines)[number]) => string | null) => lines.reduce((s, v) => addDecimal(s, pick(v) ?? '0.00', 2) ?? s, '0.00');
    expect(sum((v) => v.gross)).toBe('0.00');
    expect(sum((v) => v.paid)).toBe('0.00');
    expect(sum((v) => v.advanceGiven)).toBe('0.00');
    expect(sum((v) => v.advanceRecovered)).toBe('0.00');
  });

  it('a cancelled advance nets out too, and a reversal is recognised by its narration when the original is not loaded', () => {
    const rows = [row({ entryId: 'e9', entryNo: 9, sourceId: 'v1', voucherType: 'advance', periodMonth: null, accountKey: 'employee_advance', credit: '2000.00', narration: 'Reversal of ADV/1' })];
    expect(summariseVouchers(rows)).toEqual([expect.objectContaining({ reversal: true, advanceGiven: '-2000.00', advanceRecovered: '0.00' })]);
  });
});

describe('netPaid (the "Paid in {month}" tile)', () => {
  const salary = (entryId: string, sourceId: string, gross: string, recovered: string) => [
    row({ key: `${entryId}a`, entryId, sourceId, credit: gross }),
    row({ key: `${entryId}b`, entryId, sourceId, debit: gross }),
    ...(recovered === '0.00' ? [] : [row({ key: `${entryId}c`, entryId, sourceId, accountKey: 'employee_advance' as const, credit: recovered })]),
  ];

  it('is gross less the recovered advance, not the gross', () => {
    expect(netPaid(salary('e1', 'v1', '18000.00', '3500.00'))).toBe('14500.00');
  });

  it('adds up several vouchers and ignores plain advances', () => {
    const advance = row({ entryId: 'e3', sourceId: 'v3', voucherType: 'advance', periodMonth: null, accountKey: 'employee_advance', debit: '2000.00' });
    const wages = salary('e2', 'v2', '6000.00', '0.00').map((r) => ({ ...r, voucherType: 'wages' as const }));
    expect(netPaid([...salary('e1', 'v1', '18000.00', '3500.00'), ...wages, advance])).toBe('20500.00');
  });

  it('a cancelled voucher nets to zero', () => {
    const mirror = { entryId: 'e9', entryNo: 9, narration: 'Reversal of EXP/26-27/0004' };
    const reversal = [
      row({ ...mirror, key: 'd', debit: '18000.00' }),
      row({ ...mirror, key: 'e', credit: '18000.00' }),
      row({ ...mirror, key: 'f', accountKey: 'employee_advance', debit: '3500.00' }),
    ];
    expect(netPaid([...salary('e1', 'v1', '18000.00', '3500.00'), ...reversal])).toBe('0.00');
  });

  it('is 0.00 with nothing paid', () => {
    expect(netPaid([])).toBe('0.00');
  });
});
