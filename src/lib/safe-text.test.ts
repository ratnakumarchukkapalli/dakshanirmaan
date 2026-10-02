import { describe, expect, it } from 'vitest';
import { safeCells, safeText, stripXmlIllegal } from './safe-text';

describe('safeText / safeCells', () => {
  it('defuses formula starters and strips control characters', () => {
    expect(safeText('=HYPERLINK("http://x","y")')).toBe('\'=HYPERLINK("http://x","y")');
    expect(safeText('Ravi\u0001')).toBe('Ravi');
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(safeText(`${lead}1`)).toBe(`'${lead}1`);
    expect(safeText('Sri Venkateswara')).toBe('Sri Venkateswara');
    expect(safeText('రవి')).toBe('రవి');
  });
  it('strips only characters XML cannot hold, keeping tab, new line and return', () => {
    expect(stripXmlIllegal('a\u0000b\u000bc\u001fd\ue000e')).toBe('abcd\ue000e');
    expect(stripXmlIllegal('a\nb')).toBe('a\nb');
  });
  it('cleans text cells in a row and leaves numbers, dates and blanks alone', () => {
    const d = new Date(0);
    expect(safeCells(['=x', 5, null, d, ''])).toEqual(["'=x", 5, null, d, '']);
  });
});
