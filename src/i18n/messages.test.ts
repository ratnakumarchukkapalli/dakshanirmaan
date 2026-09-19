import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const load = (l: string) => JSON.parse(readFileSync(path.join(__dirname, `../messages/${l}.json`), 'utf8'));

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('messages', () => {
  const en = flatten(load('en')).sort();
  const te = flatten(load('te')).sort();
  it('Telugu has every key English has (a missing key breaks the screen)', () => {
    expect(en.filter((k) => !te.includes(k))).toEqual([]);
  });
  it('English has every key Telugu has (no stray keys)', () => {
    expect(te.filter((k) => !en.includes(k))).toEqual([]);
  });
  it('no message is empty', () => {
    const all = (o: Record<string, unknown>): string[] =>
      Object.values(o).flatMap((v) => (v && typeof v === 'object' ? all(v as Record<string, unknown>) : [String(v)]));
    for (const l of ['en', 'te']) expect(all(load(l)).filter((s) => s.trim() === '')).toEqual([]);
  });
});
