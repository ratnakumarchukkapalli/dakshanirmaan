import { describe, expect, it } from 'vitest';
import { previewTotals, type PreviewLine } from './invoice-math';
import { altToBase, baseToAlt, trimZeros } from './units';

const L = (qty: string, rate: string, discountPct: string, gstRate: string): PreviewLine => ({ qty, rate, discountPct, gstRate });

// Expected figures were worked out independently (Python Decimal, ROUND_HALF_UP = Postgres numeric
// round) and are re-proved against the real posting function by the SQL parity check described in
// openspec/changes/10-sales-billing-ui/implementation-notes.md.
interface Case {
  name: string; intra: boolean; lines: PreviewLine[];
  taxable: string; cgst: string; sgst: string; igst: string; roundOff: string; grandTotal: string;
  lineTaxable?: string[];
}
const CASES: Case[] = [
  { name: 'cement bags, intra-state', intra: true, lines: [L('100', '385.0000', '0', '28')],
    taxable: '38500.00', cgst: '5390.00', sgst: '5390.00', igst: '0.00', roundOff: '0.00', grandTotal: '49280.00' },
  { name: 'same bill, inter-state', intra: false, lines: [L('100', '385.0000', '0', '28')],
    taxable: '38500.00', cgst: '0.00', sgst: '0.00', igst: '10780.00', roundOff: '0.00', grandTotal: '49280.00' },
  { name: 'TMT: 1200 kg (pieces-converted), 18%', intra: true, lines: [L('1200.000', '58.0000', '0', '18')],
    taxable: '69600.00', cgst: '6264.00', sgst: '6264.00', igst: '0.00', roundOff: '0.00', grandTotal: '82128.00' },
  { name: 'fractional discount and rate, rounds up', intra: true, lines: [L('37.500', '412.3350', '2.50', '18')],
    taxable: '15076.00', cgst: '1356.84', sgst: '1356.84', igst: '0.00', roundOff: '0.32', grandTotal: '17790.00' },
  { name: 'three lines, three rates, intra', intra: true,
    lines: [L('10.000', '1234.5678', '0', '18'), L('3.333', '99.9999', '5', '28'), L('0.500', '7.7777', '12.5', '5')],
    taxable: '12665.71', cgst: '1155.53', sgst: '1155.53', igst: '0.00', roundOff: '0.23', grandTotal: '14977.00',
    lineTaxable: ['12345.68', '316.63', '3.40'] },
  { name: 'same three lines, inter (tax is rounded per line, then summed)', intra: false,
    lines: [L('10.000', '1234.5678', '0', '18'), L('3.333', '99.9999', '5', '28'), L('0.500', '7.7777', '12.5', '5')],
    taxable: '12665.71', cgst: '0.00', sgst: '0.00', igst: '2311.05', roundOff: '0.24', grandTotal: '14977.00' },
  { name: 'exact half-paise tax rounds away from zero (0.025 -> 0.03)', intra: true, lines: [L('1', '1.0000', '0', '5')],
    taxable: '1.00', cgst: '0.03', sgst: '0.03', igst: '0.00', roundOff: '-0.06', grandTotal: '1.00' },
  { name: 'exact half-rupee total rounds up (0.50 -> 1)', intra: true, lines: [L('1', '0.5000', '0', '0')],
    taxable: '0.50', cgst: '0.00', sgst: '0.00', igst: '0.00', roundOff: '0.50', grandTotal: '1.00' },
  { name: 'tax below a paisa', intra: true, lines: [L('1.000', '10.1000', '0', '5')],
    taxable: '10.10', cgst: '0.25', sgst: '0.25', igst: '0.00', roundOff: '0.40', grandTotal: '11.00' },
  { name: '0% GST', intra: true, lines: [L('5.000', '50.0000', '0', '0')],
    taxable: '250.00', cgst: '0.00', sgst: '0.00', igst: '0.00', roundOff: '0.00', grandTotal: '250.00' },
  { name: '100% discount', intra: true, lines: [L('5.000', '50.0000', '100', '18')],
    taxable: '0.00', cgst: '0.00', sgst: '0.00', igst: '0.00', roundOff: '0.00', grandTotal: '0.00' },
  { name: 'GST rate with paise (12.50%) and discount 3.25%', intra: true, lines: [L('7.000', '111.1100', '3.25', '12.50')],
    taxable: '752.49', cgst: '47.03', sgst: '47.03', igst: '0.00', roundOff: '0.45', grandTotal: '847.00' },
  { name: 'large bill stays exact', intra: true, lines: [L('99999.999', '9999.9999', '0', '28')],
    taxable: '999999980.00', cgst: '139999997.20', sgst: '139999997.20', igst: '0.00', roundOff: '-0.40', grandTotal: '1279999974.00' },
];

describe('previewTotals — parity table with the database rounding rules', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = previewTotals(c.lines, c.intra);
      expect({ taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, roundOff: r.roundOff, grandTotal: r.grandTotal }).toEqual({
        taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst, roundOff: c.roundOff, grandTotal: c.grandTotal,
      });
      if (c.lineTaxable) expect(r.lines.map((l) => l?.taxable)).toEqual(c.lineTaxable);
    });
  }

  it('an unfinished line contributes nothing and is reported as null', () => {
    const r = previewTotals([L('10', '100', '0', '18'), L('', '100', '0', '18'), L('5', 'abc', '0', '18')], true);
    expect(r.lines[1]).toBeNull();
    expect(r.lines[2]).toBeNull();
    expect(r.taxable).toBe('1000.00');
  });
  it('a blank discount means 0; a discount over 100 is not previewed', () => {
    expect(previewTotals([L('1', '100', '', '0')], true).taxable).toBe('100.00');
    expect(previewTotals([L('1', '100', '100.01', '0')], true).lines[0]).toBeNull();
  });
  it('rejects more decimals than the columns hold instead of silently rounding them', () => {
    expect(previewTotals([L('1.0001', '100', '0', '0')], true).lines[0]).toBeNull();
    expect(previewTotals([L('1', '100.00001', '0', '0')], true).lines[0]).toBeNull();
  });
});

describe('pieces <-> kg', () => {
  // 12 mm bar: 1 piece = 10.6 kg (illustrative factor).
  it('pieces to kg', () => {
    expect(altToBase('10.6000', '113')).toBe('1197.800');
    expect(altToBase('10.6000', '0.5')).toBe('5.300');
  });
  it('kg to pieces, 3 decimals, rounds half up', () => {
    expect(baseToAlt('10.6000', '1197.800')).toBe('113.000');
    expect(baseToAlt('10.6000', '1200')).toBe('113.208');
    expect(baseToAlt('3.0000', '10')).toBe('3.333');
    expect(baseToAlt('3.0000', '20')).toBe('6.667');
  });
  it('round trip on whole pieces is exact', () => {
    for (const pcs of ['1', '7', '113', '250']) expect(baseToAlt('10.6000', altToBase('10.6000', pcs)!)).toBe(`${pcs}.000`);
  });
  it('refuses junk and a zero factor', () => {
    expect(altToBase('0.0000', '5')).toBeNull();
    expect(baseToAlt('10.6', 'x')).toBeNull();
    expect(altToBase('10.6', '')).toBeNull();
  });
  it('trims trailing zeros for display', () => {
    expect(trimZeros('12.500')).toBe('12.5');
    expect(trimZeros('3.000')).toBe('3');
    expect(trimZeros('100')).toBe('100');
  });
});
