import { describe, expect, it } from 'vitest';
import { amountInWords, formatDate, fyLabel, inr, inr2, inrRate, todayIn } from './format';

describe('fyLabel', () => {
  it('runs April to March', () => {
    expect(fyLabel('2026-09-19')).toBe('26-27');
    expect(fyLabel('2027-03-31')).toBe('26-27');
    expect(fyLabel('2027-04-01')).toBe('27-28');
    expect(fyLabel('2099-12-01')).toBe('99-00');
  });
  it('picks the year from the organisation-time date, not UTC', () => {
    // 19:00 UTC on 31 Mar is already 1 April in Kolkata; 17:00 UTC is still 31 March there.
    expect(fyLabel(todayIn('Asia/Kolkata', new Date('2027-03-31T19:00:00Z')))).toBe('27-28');
    expect(fyLabel(todayIn('Asia/Kolkata', new Date('2027-03-31T17:00:00Z')))).toBe('26-27');
  });
});

describe('formatDate', () => {
  it('shows DD-MM-YYYY without touching time zones', () => {
    expect(formatDate('2026-09-05')).toBe('05-09-2026');
  });
  it('refuses a timestamp: its calendar date depends on the time zone (23:59Z on 31 Dec is 1 Jan in India)', () => {
    expect(() => formatDate('2026-12-31T23:59:59Z')).toThrow();
    expect(formatDate(todayIn('Asia/Kolkata', new Date('2026-12-31T23:59:59Z')))).toBe('01-01-2027');
  });
  it('rejects non-ISO input instead of guessing', () => {
    expect(() => formatDate('05/09/2026')).toThrow();
  });
  it('rejects a month or day that cannot exist', () => {
    expect(() => formatDate('2026-13-45')).toThrow();
    expect(() => formatDate('2026-00-10')).toThrow();
    expect(() => formatDate('2026-04-00')).toThrow();
    expect(() => fyLabel('2026-13-01')).toThrow();
  });
  it('accepts a leap day', () => {
    expect(formatDate('2028-02-29')).toBe('29-02-2028');
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
    expect(inr2(-0.4)).toBe('-₹0.40');
    expect(inr2('100.40')).toBe('₹100.40');
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

describe('amountInWords', () => {
  const cases: [string, string][] = [
    ['0', 'Rupees Zero Only'],
    ['0.00', 'Rupees Zero Only'],
    ['1', 'Rupees One Only'],
    ['19', 'Rupees Nineteen Only'],
    ['20', 'Rupees Twenty Only'],
    ['21.00', 'Rupees Twenty One Only'],
    ['100', 'Rupees One Hundred Only'],
    ['101', 'Rupees One Hundred One Only'],
    ['999', 'Rupees Nine Hundred Ninety Nine Only'],
    ['1000', 'Rupees One Thousand Only'],
    ['12500.40', 'Rupees Twelve Thousand Five Hundred and Forty Paise Only'],
    ['0.05', 'Five Paise Only'],
    ['0.5', 'Fifty Paise Only'],
    ['99999', 'Rupees Ninety Nine Thousand Nine Hundred Ninety Nine Only'],
    ['100000', 'Rupees One Lakh Only'],
    ['123456', 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'],
    ['1000000', 'Rupees Ten Lakh Only'],
    ['10000000', 'Rupees One Crore Only'],
    ['10100000', 'Rupees One Crore One Lakh Only'],
    ['10000001', 'Rupees One Crore One Only'],
    ['1234567890', 'Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Only'],
    ['1280000000.00', 'Rupees One Hundred Twenty Eight Crore Only'],
    ['100000000000', 'Rupees Ten Thousand Crore Only'],
    ['5000.10', 'Rupees Five Thousand and Ten Paise Only'],
  ];
  it.each(cases)('%s', (input, words) => {
    expect(amountInWords(input)).toBe(words);
  });
  it('returns empty text for anything that is not a plain amount', () => {
    expect(amountInWords('')).toBe('');
    expect(amountInWords('-5')).toBe('');
    expect(amountInWords('1e3')).toBe('');
    expect(amountInWords('1.234')).toBe('');
    expect(amountInWords('₹5')).toBe('');
  });
});
