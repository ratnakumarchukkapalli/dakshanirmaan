import { describe, expect, it } from 'vitest';
import { exportFileName, fiscalYear, fyMonths, generatedAtText, listFiscalYears, resolveFiscalYear } from './period';
import { fakeDb, fakeSupabase } from '@/test/export-fake';
import type { Supabase } from './types';

describe('financial years', () => {
  it('runs April to March', () => {
    expect(fiscalYear(2026)).toEqual({ startYear: 2026, from: '2026-04-01', to: '2027-03-31', label: '2026-27' });
    expect(fiscalYear(2099).label).toBe('2099-00');
  });
  it('lists the years that have months set up, newest first', async () => {
    const db = fakeDb({ fiscal_periods: [{ year_label: '2025-26' }, { year_label: '2026-27' }, { year_label: '2026-27' }, { year_label: 'junk' }] });
    expect(await listFiscalYears(fakeSupabase(db) as unknown as Supabase)).toEqual([2026, 2025]);
  });
  it('defaults to the current FY, or the newest one set up', () => {
    const now = new Date('2026-10-02T06:00:00Z');
    expect(resolveFiscalYear(null, [2026, 2025], 'Asia/Kolkata', now)?.startYear).toBe(2026);
    expect(resolveFiscalYear('', [2026, 2025], 'Asia/Kolkata', now)?.startYear).toBe(2026);
    expect(resolveFiscalYear(undefined, [2025], 'Asia/Kolkata', now)?.startYear).toBe(2025);
    expect(resolveFiscalYear(null, [], 'Asia/Kolkata', now)).toBeNull();
    // 1 April in India is still 31 March in UTC for the first five and a half hours
    expect(resolveFiscalYear(null, [2026, 2025], 'Asia/Kolkata', new Date('2026-03-31T20:00:00Z'))?.startYear).toBe(2026);
    expect(resolveFiscalYear(null, [2026, 2025], 'UTC', new Date('2026-03-31T20:00:00Z'))?.startYear).toBe(2025);
  });
  it('takes only a year that is set up', () => {
    expect(resolveFiscalYear('2025', [2026, 2025], 'UTC')?.label).toBe('2025-26');
    expect(resolveFiscalYear('2030', [2026, 2025], 'UTC')).toBeNull();
    expect(resolveFiscalYear('26', [2026], 'UTC')).toBeNull();
    expect(resolveFiscalYear('2026-27', [2026], 'UTC')).toBeNull();
    expect(resolveFiscalYear('../x', [2026], 'UTC')).toBeNull();
  });
  it('lists the twelve months April first', () => {
    const m = fyMonths(fiscalYear(2026));
    expect(m).toHaveLength(12);
    expect(m[0]).toBe('2026-04');
    expect(m[8]).toBe('2026-12');
    expect(m[9]).toBe('2027-01');
    expect(m[11]).toBe('2027-03');
  });
});

describe('text helpers', () => {
  it('writes the generated-at time in the organisation zone', () => {
    const t = generatedAtText(new Date('2026-10-02T08:35:00Z'), 'Asia/Kolkata');
    expect(t).toMatch(/^02-10-2026 14:05 /);
    expect(generatedAtText(new Date('2026-10-02T18:40:00Z'), 'Asia/Kolkata')).toMatch(/^03-10-2026 00:10 /);
  });
  it('makes a safe file name', () => {
    expect(exportFileName('books', fiscalYear(2026), 'xlsx')).toBe('daksha-books-FY26-27.xlsx');
    expect(exportFileName('archive', fiscalYear(2099), 'zip')).toBe('daksha-archive-FY99-00.zip');
    expect(exportFileName('tally', fiscalYear(2026), '../xml"')).toBe('daksha-tally-FY26-27.xml');
  });
});
