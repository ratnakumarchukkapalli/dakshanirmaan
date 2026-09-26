import { describe, expect, it } from 'vitest';
import { fyName, fyRange, fyStartYear, parseFyParam } from './fy';

describe('financial year (April to March)', () => {
  it('finds the start year on both sides of April', () => {
    expect(fyStartYear('2026-09-19')).toBe(2026);
    expect(fyStartYear('2026-04-01')).toBe(2026);
    expect(fyStartYear('2027-03-31')).toBe(2026);
    expect(fyStartYear('2027-04-01')).toBe(2027);
  });
  it('names and bounds a year', () => {
    expect(fyName(2026)).toBe('2026-27');
    expect(fyName(2099)).toBe('2099-00');
    expect(fyRange(2026)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
  it('accepts only a year we offer', () => {
    expect(parseFyParam(undefined, 2026)).toBe(2026);
    expect(parseFyParam('all', 2026)).toBe('all');
    expect(parseFyParam('2025', 2026)).toBe(2025);
    expect(parseFyParam('2030', 2026)).toBe(2026);
    expect(parseFyParam('x', 2026)).toBe(2026);
  });
  it('rejects a malformed date', () => {
    expect(() => fyStartYear('19-09-2026')).toThrow();
  });
});
