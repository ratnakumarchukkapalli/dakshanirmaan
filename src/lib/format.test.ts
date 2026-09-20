import { describe, expect, it } from 'vitest';
import { formatDate, fyLabel, inr, inr2, inrRate, todayIn } from './format';

describe('fyLabel', () => {
  it('runs April to March', () => {
    expect(fyLabel('2026-09-19')).toBe('26-27');
    expect(fyLabel('2027-03-31')).toBe('26-27');
    expect(fyLabel('2027-04-01')).toBe('27-28');
    expect(fyLabel('2099-12-01')).toBe('99-00');
  });
});

describe('formatDate', () => {
  it('shows DD-MM-YYYY without touching time zones', () => {
    expect(formatDate('2026-09-05')).toBe('05-09-2026');
    expect(formatDate('2026-12-31T23:59:59Z')).toBe('31-12-2026');
  });
  it('rejects non-ISO input instead of guessing', () => {
    expect(() => formatDate('05/09/2026')).toThrow();
  });
});

describe('todayIn', () => {
  it('uses the organisation time zone, not UTC', () => {
    const lateUtc = new Date('2026-09-18T20:00:00Z'); // already 19 Sep in Kolkata
    expect(todayIn('Asia/Kolkata', lateUtc)).toBe('2026-09-19');
    expect(todayIn('UTC', lateUtc)).toBe('2026-09-18');
  });
});

describe('inr / inr2', () => {
  it('groups in lakhs and crores', () => {
    expect(inr(123456)).toBe('₹1,23,456');
    expect(inr(12345678)).toBe('₹1,23,45,678');
    expect(inr('22600')).toBe('₹22,600');
  });
  it('inr2 always shows paise', () => {
    expect(inr2(1234.5)).toBe('₹1,234.50');
    expect(inr2('0')).toBe('₹0.00');
  });
  it('handles negatives and empty values', () => {
    expect(inr(-1500)).toBe('-₹1,500');
    expect(inr(null)).toBe('₹0');
    expect(inr2(undefined)).toBe('₹0.00');
  });
});

describe('inrRate', () => {
  it('shows at least 2 and at most 4 decimals, never rounding to whole rupees', () => {
    expect(inrRate('62.5')).toBe('₹62.50');
    expect(inrRate('62.5375')).toBe('₹62.5375');
    expect(inrRate(62.5)).toBe('₹62.50');
    expect(inrRate('380')).toBe('₹380.00');
    expect(inrRate('62.1200')).toBe('₹62.12');
  });
  it('groups in lakhs and handles empty values', () => {
    expect(inrRate('123456.7')).toBe('₹1,23,456.70');
    expect(inrRate(null)).toBe('₹0.00');
    expect(inrRate(-1.5)).toBe('-₹1.50');
  });
});
