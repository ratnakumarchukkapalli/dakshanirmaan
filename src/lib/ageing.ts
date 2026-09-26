// Ageing buckets for a supplier's open bills (receivables come pre-bucketed from v_party_aging).
// Same cut-offs as that view: days since the invoice date, 0-30 / 31-60 / 61-90 / 90+.
// Display aggregation of stored open amounts, in exact decimals.
import { addDecimal, compareDecimal } from '@/lib/decimal';

export const BUCKETS = ['b0_30', 'b31_60', 'b61_90', 'b90_plus'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type BucketTotals = Record<Bucket, string>;

export function bucketOf(ageDays: number): Bucket {
  if (ageDays <= 30) return 'b0_30';
  if (ageDays <= 60) return 'b31_60';
  if (ageDays <= 90) return 'b61_90';
  return 'b90_plus';
}

export const emptyBuckets = (): BucketTotals => ({ b0_30: '0.00', b31_60: '0.00', b61_90: '0.00', b90_plus: '0.00' });

/** Sums each row's open amount (2-decimal text) into its bucket. */
export function bucketOpen(rows: { ageDays: number; openAmount: string }[]): BucketTotals {
  const out = emptyBuckets();
  for (const r of rows) {
    const b = bucketOf(r.ageDays);
    out[b] = addDecimal(out[b], r.openAmount, 2) ?? out[b];
  }
  return out;
}

/** The oldest bucket that holds anything, or null when everything is settled. */
export function oldestBucket(b: BucketTotals): Bucket | null {
  for (const k of [...BUCKETS].reverse()) if (compareDecimal(b[k], '0.00', 2) === 1) return k;
  return null;
}
