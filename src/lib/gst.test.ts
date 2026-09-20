import { describe, expect, it } from 'vitest';
import { GST_STATES, gstinCheckChar, gstinChecksumOk, isStateCode, stateOfGstin } from './gst';

describe('GSTIN check digit', () => {
  it('accepts a real, published sample GSTIN', () => {
    expect(gstinChecksumOk('27AAPFU0939F1ZV')).toBe(true);
  });
  it('rejects the same number with a wrong last character or a changed digit', () => {
    expect(gstinChecksumOk('27AAPFU0939F1ZW')).toBe(false);
    expect(gstinChecksumOk('27AAPFU0939F2ZV')).toBe(false);
  });
  it('can compute a valid check character for any first 14 (used by the tests below)', () => {
    const first14 = '37AAPFU0939F1Z';
    const gstin = first14 + gstinCheckChar(first14);
    expect(gstinChecksumOk(gstin)).toBe(true);
    expect(stateOfGstin(gstin)).toBe('37');
  });
  it('rejects the wrong shape before checking anything else', () => {
    expect(gstinChecksumOk('37aapfu0939f1zv')).toBe(false);
    expect(gstinChecksumOk('37AAPFU0939F1Z')).toBe(false);
    expect(gstinChecksumOk('')).toBe(false);
  });
});

describe('states', () => {
  it('knows Andhra Pradesh is 37 and that retired codes are not accepted', () => {
    expect(GST_STATES.find((s) => s.code === '37')?.name).toBe('Andhra Pradesh');
    expect(isStateCode('37')).toBe(true);
    for (const bad of ['00', '25', '28', '39', '40', '3', '']) expect(isStateCode(bad)).toBe(false);
  });
  it('has 38 entries with unique codes', () => {
    expect(GST_STATES).toHaveLength(38);
    expect(new Set(GST_STATES.map((s) => s.code)).size).toBe(38);
  });
  it('reads the state off a GSTIN prefix, or null if the prefix is not a state', () => {
    expect(stateOfGstin('36AAPFU0939F1ZV')).toBe('36');
    expect(stateOfGstin('00AAPFU0939F1ZV')).toBeNull();
  });
});
