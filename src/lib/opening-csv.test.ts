import { describe, expect, it } from 'vitest';
import { parseOpeningCsv } from './opening-csv';

describe('parseOpeningCsv', () => {
  it('reads a header row and data rows, keeping numbers as text', () => {
    const r = parseOpeningCsv('item,godown,qty,rate\nUltraTech PPC 50kg,Head Godown,120,315.50\nTMT 12mm,Head Godown,2500.5,68.2500\n');
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, item: 'UltraTech PPC 50kg', godown: 'Head Godown', qty: '120', rate: '315.50' },
      { line: 3, item: 'TMT 12mm', godown: 'Head Godown', qty: '2500.5', rate: '68.2500' },
    ]);
  });

  it('accepts other header names in any order, CRLF line ends, a BOM, and quoted commas', () => {
    const r = parseOpeningCsv('﻿Rate,Quantity,Warehouse,Item Name\r\n300,10,"Head, Main","Cement ""Gold"", 50kg"\r\n');
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([{ line: 2, item: 'Cement "Gold", 50kg', godown: 'Head, Main', qty: '10', rate: '300' }]);
  });

  it('skips blank lines but keeps real line numbers', () => {
    const r = parseOpeningCsv('item,godown,qty,rate\n\nA,G,1,2\n');
    expect(r.rows.map((x) => x.line)).toEqual([3]);
  });

  it('flags an empty file, a missing header, and a header with no rows', () => {
    expect(parseOpeningCsv('  \n').problems).toEqual([{ line: 1, key: 'empty' }]);
    expect(parseOpeningCsv('A,G,1,2\n').problems).toEqual([{ line: 1, key: 'header' }]);
    expect(parseOpeningCsv('item,godown,qty,rate\n').problems).toEqual([{ line: 1, key: 'empty' }]);
  });

  it('flags every bad row with its line number and reason', () => {
    const r = parseOpeningCsv(['item,godown,qty,rate', 'A,G,1', 'A,G,-1,2', 'A,G,1,0', ',G,1,2', 'A,G,1,2.34567', 'B,G,1,2', 'b,g,3,4'].join('\n'));
    expect(r.problems).toEqual([
      { line: 2, key: 'columns' },
      { line: 3, key: 'qty' },
      { line: 4, key: 'rate' },
      { line: 5, key: 'blank' },
      { line: 6, key: 'rate' },
      { line: 8, key: 'repeated' },
    ]);
  });

  it('refuses thousands separators (they would silently change the number) and more than 500 rows', () => {
    expect(parseOpeningCsv('item,godown,qty,rate\nA,G,"1,200",5\n').problems).toEqual([{ line: 2, key: 'qty' }]);
    const many = ['item,godown,qty,rate', ...Array.from({ length: 501 }, (_, i) => `I${i},G,1,1`)].join('\n');
    expect(parseOpeningCsv(many).problems).toEqual([{ line: 502, key: 'too_many' }]);
  });
});
