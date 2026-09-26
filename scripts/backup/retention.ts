// Which backups to keep: the last 14 days, 12 weeks and 12 months (spec: security-deployment,
// "Backups off-platform"). Pure, so it is tested; the CLI below only lists or deletes files.
//   node scripts/backup/retention.ts <dir>            list what would be deleted (dry run)
//   node scripts/backup/retention.ts <dir> --apply    delete it
import { readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = { daily: 14, weekly: 12, monthly: 12 } as const;

const NAME = /^dn-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/;

/** The UTC moment a backup file name says it was made, or null when it is not a backup file. */
export function backupTime(name: string): Date | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC rolls month 13 into next year; a name that does not round-trip is not a real timestamp.
  const real = t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
  return real ? t : null;
}

const day = (t: Date) => t.toISOString().slice(0, 10);
const month = (t: Date) => t.toISOString().slice(0, 7);
/** The Monday of the (UTC) week the moment falls in, as a date string. */
const week = (t: Date) => {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** Keeps the newest file of each of the latest N days / weeks / months. Files that are not backups are never listed for deletion. */
export function planRetention(names: string[], keep: { daily: number; weekly: number; monthly: number } = KEEP): { keep: string[]; remove: string[] } {
  const backups = names
    .map((name) => ({ name, t: backupTime(name) }))
    .filter((b): b is { name: string; t: Date } => b.t !== null)
    .sort((a, b) => b.t.getTime() - a.t.getTime());

  const kept = new Set<string>();
  const newestPer = (bucket: (t: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const b of backups) {
      const k = bucket(b.t);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      kept.add(b.name);
    }
  };
  newestPer(day, keep.daily);
  newestPer(week, keep.weekly);
  newestPer(month, keep.monthly);

  return { keep: backups.filter((b) => kept.has(b.name)).map((b) => b.name), remove: backups.filter((b) => !kept.has(b.name)).map((b) => b.name) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: retention.ts <dir> [--apply]');
    process.exit(2);
  }
  const plan = planRetention(readdirSync(dir));
  for (const n of plan.remove) {
    console.log(`${process.argv.includes('--apply') ? 'delete' : 'would delete'}  ${n}`);
    if (process.argv.includes('--apply')) unlinkSync(path.join(dir, n));
  }
  console.log(`retention: keeping ${plan.keep.length}, ${plan.remove.length} ${process.argv.includes('--apply') ? 'deleted' : 'to delete'}`);
}
