import { describe, expect, it } from 'vitest';
import {
  addDaysIso, attentionHref, barShare, buildSalesWeek, hasSales, lastDays, maxTotal, sortAttention, sumMoney,
  type AttentionRow,
} from './dashboard-math';

describe('sumMoney', () => {
  it('adds exactly where floats drift', () => {
    expect(sumMoney([0.1, 0.2])).toBe('0.30');
    expect(sumMoney(['1234567890123.45', '0.55'])).toBe('1234567890124.00');
  });
  it('handles negatives (a customer in credit) and nulls', () => {
    expect(sumMoney([100, -30.5, null, undefined])).toBe('69.50');
    expect(sumMoney([])).toBe('0.00');
  });
  it('refuses something that is not money', () => {
    expect(() => sumMoney(['abc'])).toThrow();
  });
});

describe('dates', () => {
  it('addDaysIso crosses month, year and leap boundaries', () => {
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDaysIso('2026-01-02', -6)).toBe('2025-12-27');
    expect(addDaysIso('2026-09-25', 0)).toBe('2026-09-25');
  });
  it('lastDays is seven days ending today, oldest first', () => {
    expect(lastDays('2026-09-25', 7)).toEqual([
      '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25',
    ]);
  });
});

describe('buildSalesWeek', () => {
  const days = lastDays('2026-09-25', 3);
  const daily = [{ sale_date: '2026-09-25', invoice_count: 2, billed_total: 12329, round_off: 0.36 }];
  const cats = [
    { sale_date: '2026-09-25', category: 'cement', amount: 5248.64 },
    { sale_date: '2026-09-25', category: 'steel', amount: 7080 },
  ];
  it('zero-fills days with no sales and reads amounts as exact texts', () => {
    const week = buildSalesWeek(days, daily, cats);
    expect(week.map((d) => d.total)).toEqual(['0.00', '0.00', '12329.00']);
    expect(week[2]).toEqual({ date: '2026-09-25', cement: '5248.64', steel: '7080.00', other: '0.00', total: '12329.00', roundOff: '0.36', invoices: 2 });
    expect(week[0]).toMatchObject({ cement: '0.00', invoices: 0 });
  });
  it('hasSales / maxTotal', () => {
    expect(hasSales(buildSalesWeek(days, [], []))).toBe(false);
    const week = buildSalesWeek(days, daily, cats);
    expect(hasSales(week)).toBe(true);
    expect(maxTotal(week)).toBe('12329.00');
  });
  it('barShare is a 0..1 share of the tallest day, 0 for an empty scale', () => {
    expect(barShare('6164.50', '12329.00')).toBe(0.5);
    expect(barShare('0.00', '12329.00')).toBe(0);
    expect(barShare('5.00', '0.00')).toBe(0);
  });
});

const row = (over: Partial<AttentionRow>): AttentionRow => ({
  kind: 'low_stock', severity: 'warning', subject_type: 'item', subject_id: null, title: 't', detail: 'd', due_date: null, amount: null, interest: null, ...over,
});

describe('attention', () => {
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  it('every known kind lands on a screen that exists', () => {
    expect(attentionHref('overdue_party', id)).toBe(`/parties/${id}`);
    expect(attentionHref('low_stock', id)).toBe(`/stock/${id}`);
    expect(attentionHref('cheque_due', id)).toBe('/payments');
    expect(attentionHref('stale_challan', id)).toBe('/sales?status=challan');
    expect(attentionHref('challan_possible_duplicate', id)).toBe('/sales?status=challan');
    expect(attentionHref('transfer_in_transit', id)).toBe('/stock');
    expect(attentionHref('day_close_difference', id)).toBe('/reports');
    expect(attentionHref('gst_due', null)).toBe('/reports');
    expect(attentionHref('create_fy_periods', null)).toBe('/settings');
  });
  it('a malformed subject id never reaches a URL; an unknown kind has no link', () => {
    expect(attentionHref('overdue_party', '../../x')).toBe('/parties');
    expect(attentionHref('low_stock', "1'; drop")).toBe('/stock');
    expect(attentionHref('something_new', id)).toBeNull();
  });
  it('sorts critical before warning before info, then oldest due first, undated last', () => {
    const sorted = sortAttention([
      row({ title: 'info', severity: 'info', due_date: '2026-01-01' }),
      row({ title: 'warn late', severity: 'warning', due_date: '2026-09-10' }),
      row({ title: 'warn undated', severity: 'warning', due_date: null }),
      row({ title: 'crit', severity: 'critical', due_date: '2026-09-20' }),
      row({ title: 'warn early', severity: 'warning', due_date: '2026-09-01' }),
    ]);
    expect(sorted.map((r) => r.title)).toEqual(['crit', 'warn early', 'warn late', 'warn undated', 'info']);
  });
});
