import { describe, expect, it } from 'vitest';
import { backupTime, planRetention } from './retention.ts';

const name = (iso: string) => `dn-backup-${iso.replace(/[-:]/g, '').replace(/\.\d+/, '')}.tar.age`;
/** One backup per day at 02:00 UTC for `days` days ending on `end`. */
const daily = (end: string, days: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(`${end}T02:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    return name(d.toISOString());
  });

describe('backupTime', () => {
  it('reads the UTC time from the file name', () => {
    expect(backupTime('dn-backup-20260926T043149Z.tar.age')?.toISOString()).toBe('2026-09-26T04:31:49.000Z');
  });
  it('rejects anything else', () => {
    for (const n of ['notes.txt', 'dn-backup-2026.tar.age', 'dn-backup-20261340T000000Z.tar.age', 'dn-backup-20260926T043149Z.tar']) expect(backupTime(n), n).toBeNull();
  });
});

describe('planRetention', () => {
  it('keeps everything while there is less than two weeks of it', () => {
    const files = daily('2026-09-26', 10);
    expect(planRetention(files).remove).toEqual([]);
  });
  it('keeps the 14 newest days, then one per week and month further back, and removes the rest', () => {
    const files = daily('2026-09-26', 400);
    const { keep, remove } = planRetention(files);
    expect(keep.length + remove.length).toBe(400);
    for (const n of daily('2026-09-26', 14)) expect(keep).toContain(n);
    // 14 days + at most 12 weeks + 12 months, with overlaps: well under 40.
    expect(keep.length).toBeGreaterThanOrEqual(14 + 10);
    expect(keep.length).toBeLessThanOrEqual(38);
    // Something over twelve months old is gone; something 60 days old survives only as a weekly one.
    expect(remove).toContain(name('2025-09-01T02:00:00Z'));
    const sixty = daily('2026-09-26', 61).at(-1)!;
    expect(keep.includes(sixty) || remove.includes(sixty)).toBe(true);
  });
  it('several backups on one day keep only the newest of that day', () => {
    const a = name('2026-09-26T02:00:00Z');
    const b = name('2026-09-26T14:00:00Z');
    const { keep, remove } = planRetention([a, b]);
    expect(keep).toEqual([b]);
    expect(remove).toEqual([a]);
  });
  it('never lists a file that is not a backup, and never keeps fewer than the newest one', () => {
    const { keep, remove } = planRetention(['README.txt', name('2026-09-26T02:00:00Z')]);
    expect(keep).toEqual([name('2026-09-26T02:00:00Z')]);
    expect(remove).toEqual([]);
  });
  it('the newest backup of each of the last 12 months survives even when older than 14 days', () => {
    const files = daily('2026-09-26', 400);
    const { keep } = planRetention(files);
    for (const month of ['2026-08', '2026-05', '2025-11']) {
      const newest = files.filter((f) => backupTime(f)!.toISOString().startsWith(month)).sort().at(-1)!;
      expect(keep, month).toContain(newest);
    }
  });
});
