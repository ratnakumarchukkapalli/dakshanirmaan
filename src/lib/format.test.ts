import { describe, expect, it } from 'vitest';
import { formatDate, fyLabel, todayIn } from './format';

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
