import { describe, expect, it } from 'vitest';
import { baseToAlt, qtyDisplay } from './units';

describe('qtyDisplay', () => {
  it('groups en-IN and drops trailing zeros', () => {
    expect(qtyDisplay('1120.500')).toBe('1,120.5');
    expect(qtyDisplay('4699.000')).toBe('4,699');
    expect(qtyDisplay('1234567.000')).toBe('12,34,567');
    expect(qtyDisplay('-3.000')).toBe('-3');
    expect(qtyDisplay('0.000')).toBe('0');
  });
  it('leaves something that is not a number alone', () => {
    expect(qtyDisplay('abc')).toBe('abc');
  });
});

describe('baseToAlt', () => {
  it('converts kg to pieces', () => {
    expect(baseToAlt('10.6600', '106.600')).toBe('10.000');
  });
});
