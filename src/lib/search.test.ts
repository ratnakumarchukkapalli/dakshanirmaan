import { describe, expect, it } from 'vitest';
import { cleanSearchText, containsPattern, orContainsFilter, quoteFilterValue } from './search';

/** Reads a filter back the way PostgREST does: commas split conditions only outside double quotes, `\\` and `\"` are escapes. */
function parseConditions(filter: string): { column: string; op: string; value: string }[] {
  const out: { column: string; op: string; value: string }[] = [];
  let i = 0;
  while (i < filter.length) {
    const m = /^([a-z_]+)\.([a-z]+)\./.exec(filter.slice(i));
    if (!m) throw new Error(`bad condition at ${i}: ${filter.slice(i)}`);
    i += m[0].length;
    if (filter[i] !== '"') throw new Error('value must be quoted');
    i++;
    let value = '';
    while (filter[i] !== '"') {
      if (i >= filter.length) throw new Error('unterminated quote');
      if (filter[i] === '\\') i++; // escape: take the next character literally
      value += filter[i++];
    }
    i++;
    out.push({ column: m[1]!, op: m[2]!, value });
    if (i < filter.length) {
      if (filter[i] !== ',') throw new Error('expected a comma between conditions');
      i++;
    }
  }
  return out;
}

const hostile = [
  'Sri Rama & Co. (Guntur)',
  'a,b',
  'x"y',
  'x\\"y',
  'foo),id.gt.(0',
  '",id.gt.0,name.ilike."',
  '50%',
  'a_b',
  'a*b',
  'back\\slash',
  '%_*\\"',
  'line\nbreak',
];

describe('orContainsFilter', () => {
  it('always yields exactly one condition per column, whatever the text contains', () => {
    for (const text of hostile) {
      const conds = parseConditions(orContainsFilter(['name', 'gstin'], text)!);
      expect(conds.map((c) => [c.column, c.op])).toEqual([['name', 'ilike'], ['gstin', 'ilike']]);
      expect(conds[0]!.value).toBe(conds[1]!.value);
    }
  });
  it('a name with punctuation is searched as plain text', () => {
    const conds = parseConditions(orContainsFilter(['name'], 'Sri Rama & Co. (Guntur)')!);
    expect(conds[0]!.value).toBe('*Sri Rama & Co. (Guntur)*');
  });
  it('commas, parens and quotes stay inside the value', () => {
    expect(parseConditions(orContainsFilter(['name'], 'a,b')!)[0]!.value).toBe('*a,b*');
    expect(parseConditions(orContainsFilter(['name'], 'foo),id.gt.(0')!)[0]!.value).toBe('*foo),id.gt.(0*');
    expect(parseConditions(orContainsFilter(['name'], 'x"y')!)[0]!.value).toBe('*x"y*');
  });
  it('% _ and backslash are made literal for LIKE; * (unescapable in PostgREST) becomes a one-character wildcard', () => {
    expect(containsPattern('50%')).toBe('*50\\%*');
    expect(containsPattern('a_b')).toBe('*a\\_b*');
    expect(containsPattern('a\\b')).toBe('*a\\\\b*');
    expect(containsPattern('a*b')).toBe('*a_b*');
  });
  it('only the leading and trailing * are left as wildcards', () => {
    for (const text of hostile) {
      const value = parseConditions(orContainsFilter(['name'], text)!)[0]!.value;
      const inner = value.slice(1, -1);
      expect(value.startsWith('*') && value.endsWith('*')).toBe(true);
      expect(inner).not.toContain('*');
      // every % and _ in the pattern is preceded by an escaping backslash (or is an escaped backslash pair)
      if (!text.includes('*')) expect(inner.replace(/\\[\\%_]/g, '')).not.toMatch(/[%_]/);
    }
  });
  it('returns null for nothing to search', () => {
    expect(orContainsFilter(['name'], '')).toBeNull();
    expect(orContainsFilter(['name'], '   ')).toBeNull();
    expect(orContainsFilter(['name'], undefined)).toBeNull();
  });
});

describe('cleanSearchText / quoteFilterValue', () => {
  it('trims, caps at 60 characters and drops control characters', () => {
    expect(cleanSearchText('  Ramesh  ')).toBe('Ramesh');
    expect(cleanSearchText('x'.repeat(200))).toHaveLength(60);
    expect(cleanSearchText('a\nb\tc')).toBe('a b c');
  });
  it('escapes only backslash and double quote', () => {
    expect(quoteFilterValue('a"b\\c,d')).toBe('"a\\"b\\\\c,d"');
  });
});
