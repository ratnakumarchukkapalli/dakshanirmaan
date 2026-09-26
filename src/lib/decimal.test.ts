import { describe, expect, it } from 'vitest';
import { multiplyDays, negateDecimal, signOf, subtractDecimal } from './decimal';

describe('signed decimal helpers', () => {
  it('reads the sign of a decimal text', () => {
    expect(signOf('12.50')).toBe(1);
    expect(signOf('-0.01')).toBe(-1);
    expect(signOf('0.00')).toBe(0);
    expect(signOf('-0.00')).toBe(0);
    expect(signOf('')).toBe(0);
    expect(signOf('abc')).toBe(0);
  });
  it('negates and subtracts exactly', () => {
    expect(negateDecimal('12.50')).toBe('-12.50');
    expect(negateDecimal('-3.00')).toBe('3.00');
    expect(negateDecimal('0.00')).toBe('0.00');
    expect(subtractDecimal('18000.00', '3500.00', 2)).toBe('14500.00');
    expect(subtractDecimal('0.10', '0.30', 2)).toBe('-0.20');
    expect(subtractDecimal('x', '1', 2)).toBeNull();
  });
  it('multiplies days by a daily rate to the paisa', () => {
    expect(multiplyDays('6', '600')).toBe('3600.00');
    expect(multiplyDays('5.5', '600')).toBe('3300.00');
    expect(multiplyDays('0.5', '333.33')).toBe('166.67');
    expect(multiplyDays('1', '0.05')).toBe('0.05');
    expect(multiplyDays('1.25', '600')).toBeNull();
    expect(multiplyDays('two', '600')).toBeNull();
  });
});
