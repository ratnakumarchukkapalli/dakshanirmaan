import { describe, expect, it } from 'vitest';
import { decimalString, divideDecimal, exactCellNumber, fromScaled, sumDecimal, toScaled } from './decimal';

describe('decimalString', () => {
  it('keeps the database digits and pads to the places asked', () => {
    expect(decimalString('1234567.89', 2)).toBe('1234567.89');
    expect(decimalString('100.5', 2)).toBe('100.50');
    expect(decimalString('7', 2)).toBe('7.00');
    expect(decimalString('62.5375', 4)).toBe('62.5375');
    expect(decimalString('0.070', 2)).toBe('0.07'); // extra zeros are not a rounding
    expect(decimalString('-12.5', 2)).toBe('-12.50');
    expect(decimalString('-0.00', 2)).toBe('0.00');
  });
  it('accepts a JSON number only when it is exact at that many places', () => {
    expect(decimalString(1234567.89, 2)).toBe('1234567.89');
    expect(decimalString(0.07, 2)).toBe('0.07');
    expect(decimalString(18, 2)).toBe('18.00');
    expect(() => decimalString(0.001, 2)).toThrow(/does not fit/);
  });
  it('never rounds: more places than the column has is an error', () => {
    expect(() => decimalString('1.005', 2)).toThrow(/does not fit/);
  });
  it('passes empty values through as null and refuses text that is not a number', () => {
    expect(decimalString(null, 2)).toBeNull();
    expect(decimalString(undefined, 2)).toBeNull();
    expect(decimalString('', 2)).toBeNull();
    expect(() => decimalString('12abc', 2)).toThrow(/not a plain decimal/);
    expect(() => decimalString('NaN', 2)).toThrow();
    expect(() => decimalString(Number.POSITIVE_INFINITY, 2)).toThrow();
  });
});

describe('exact sums', () => {
  it('adds without float drift (0.1 + 0.2 style)', () => {
    expect(sumDecimal(['0.10', '0.20'], 2)).toBe('0.30');
    expect(sumDecimal(['1234567.89', '0.07', '-0.01'], 2)).toBe('1234567.95');
    expect(0.1 + 0.2).not.toBe(0.3); // the trap this avoids
  });
  it('round-trips scaled integers, negatives included', () => {
    expect(toScaled('-12.50', 2)).toBe(-1250n);
    expect(fromScaled(-1250n, 2)).toBe('-12.50');
    expect(fromScaled(0n, 3)).toBe('0.000');
    expect(() => toScaled('1.234', 2)).toThrow();
  });
  it('averages half away from zero like Postgres round()', () => {
    // 116397.70 / 387.000 = 300.769...; 6015.39 / 20.000 = 300.7695
    expect(divideDecimal(toScaled('116397.70', 2), toScaled('387.000', 3), 2, 3, 4)).toBe('300.7693');
    expect(divideDecimal(toScaled('6015.39', 2), toScaled('20.000', 3), 2, 3, 4)).toBe('300.7695');
    expect(divideDecimal(toScaled('10.00', 2), 0n, 2, 3, 4)).toBeNull();
    expect(divideDecimal(-100n, 3000n, 2, 3, 4)).toBe('-0.3333');
  });
});

describe('exactCellNumber', () => {
  it('turns 2, 3 and 4 place decimals into the number whose digits are the same', () => {
    for (const t of ['1234567.89', '0.07', '0.10', '100.50', '62.5375', '0.000', '-12.5', '99999999999.99', '0.01']) {
      const n = exactCellNumber(t);
      expect(n).not.toBeNull();
      expect(Number(t)).toBe(n);
      // the file stores String(n); it must read back as the same digits
      expect(String(n)).toBe(String(Number(t)));
    }
    expect(exactCellNumber('1234567.89')).toBe(1234567.89);
    expect(String(exactCellNumber('0.07'))).toBe('0.07');
    expect(exactCellNumber('0.00')).toBe(0);
  });
  it('declines a value a number would change (the writer then keeps the text)', () => {
    expect(exactCellNumber('12345678901234567890.12')).toBeNull();
    expect(exactCellNumber('0.1234567890123456789')).toBeNull();
    expect(exactCellNumber('abc')).toBeNull();
    expect(exactCellNumber('1e5')).toBeNull();
  });
});
