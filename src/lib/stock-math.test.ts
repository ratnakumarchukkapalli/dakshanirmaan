import { describe, expect, it } from 'vitest';
import { averageRate, kgToTonnes, sumStock } from './stock-math';

describe('stock display math', () => {
  it('adds quantities and values across godowns exactly', () => {
    expect(sumStock([{ qty: '100.000', value: '31800.00' }, { qty: '0.100', value: '0.10' }, { qty: '0.200', value: '0.20' }]))
      .toEqual({ qty: '100.300', value: '31800.30' });
  });
  it('has no value when any row hides cost', () => {
    expect(sumStock([{ qty: '5.000', value: '10.00' }, { qty: '1.000' }])).toEqual({ qty: '6.000', value: null });
    expect(sumStock([])).toEqual({ qty: '0.000', value: null });
  });
  it('handles negative stock', () => {
    expect(sumStock([{ qty: '-2.500', value: '-50.00' }, { qty: '1.000', value: '20.00' }])).toEqual({ qty: '-1.500', value: '-30.00' });
  });
  it('derives the weighted average like the view: round(value / qty, 4)', () => {
    expect(averageRate('31800.00', '100.000')).toBe('318.0000');
    expect(averageRate('47600.00', '1000.000')).toBe('47.6000');
    expect(averageRate('10.00', '3.000')).toBe('3.3333');
    expect(averageRate('20.00', '3.000')).toBe('6.6667');
    expect(averageRate('0.00', '0.000')).toBe('0.0000');
    expect(averageRate('x', '1.000')).toBeNull();
  });
  it('converts kilograms to tonnes', () => {
    expect(kgToTonnes('11460.000')).toBe('11.46');
    expect(kgToTonnes('500.000')).toBe('0.50');
    expect(kgToTonnes('-1500.000')).toBe('-1.50');
  });
});
