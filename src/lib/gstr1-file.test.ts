import { describe, expect, it } from 'vitest';
import { blockingWarnings, buildGstr1File, gstr1Filename, isPeriod, periodOrDefault, previousPeriod, type Gstr1Data } from './gstr1-file';

const empty: Gstr1Data = {
  period: '2026-09', fp: '092026', gstin: '37AAPFU0939F1ZU',
  b2b: [], b2cl: [], b2cs: [], cdnr: [], nil: { inv: [] }, hsn: { hsn_b2b: [], hsn_b2c: [] }, doc_issue: { doc_det: [] },
  totals: { invoices: 0, notes: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 },
  summary: {} as Gstr1Data['summary'], warnings: [],
};

describe('buildGstr1File', () => {
  it('wraps the envelope and leaves out every empty section', () => {
    expect(buildGstr1File(empty)).toEqual({ gstin: '37AAPFU0939F1ZU', fp: '092026', gt: 0, cur_gt: 0, version: 'GST3.2.2', hash: 'hash' });
  });

  it('keeps the sections that have rows, exactly as the database built them', () => {
    const b2b = [{ ctin: '37ABCDE1234F1ZZ', inv: [{ inum: 'DN/26-27/0001' }] }];
    const file = buildGstr1File({ ...empty, b2b, hsn: { hsn_b2b: [{ num: 1 }], hsn_b2c: [] }, doc_issue: { doc_det: [{ doc_num: 1 }] }, nil: { inv: [{ sply_ty: 'INTRAB2C' }] } });
    expect(file.b2b).toBe(b2b);
    expect(file.hsn).toEqual({ hsn_b2b: [{ num: 1 }] });
    expect(file.doc_issue).toEqual({ doc_det: [{ doc_num: 1 }] });
    expect(file.nil).toEqual({ inv: [{ sply_ty: 'INTRAB2C' }] });
    expect('b2cl' in file).toBe(false);
  });
});

describe('blockingWarnings', () => {
  it('withholds the file for the problems the portal would reject, not for advisory ones', () => {
    const d = { ...empty, warnings: [{ key: 'no_hsn', count: 1 }, { key: 'hsn_short', count: 3 }, { key: 'unmapped_uom', count: 1 }] };
    expect(blockingWarnings(d)).toEqual(['no_hsn', 'unmapped_uom']);
    expect(blockingWarnings({ ...empty, warnings: [{ key: 'hsn_short', count: 2 }] })).toEqual([]);
  });
});

describe('period and file names', () => {
  it('accepts YYYY-MM only', () => {
    expect(isPeriod('2026-09')).toBe(true);
    for (const bad of ['2026-13', '2026-9', '2026-09-01', '', null, undefined, 'abc']) expect(isPeriod(bad as string)).toBe(false);
  });
  it('names files GSTR1-YYYY-MM', () => {
    expect(gstr1Filename('2026-09')).toBe('GSTR1-2026-09.json');
    expect(gstr1Filename('2026-09', 'xlsx')).toBe('GSTR1-2026-09.xlsx');
  });
});

describe('previousPeriod', () => {
  it('is the month before, across a year end', () => {
    expect(previousPeriod('2026-09-26')).toBe('2026-08');
    expect(previousPeriod('2026-01-05')).toBe('2025-12');
  });
  it('periodOrDefault keeps a real period and replaces anything else', () => {
    expect(periodOrDefault('2026-05', '2026-09-26')).toBe('2026-05');
    expect(periodOrDefault('nope', '2026-09-26')).toBe('2026-08');
    expect(periodOrDefault(undefined, '2026-09-26')).toBe('2026-08');
  });
});
