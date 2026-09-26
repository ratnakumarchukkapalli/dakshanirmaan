import { StatTile } from '@/components/ui/StatTile';
import type { BucketTotals } from '@/lib/ageing';
import { compareDecimal } from '@/lib/decimal';
import { inr } from '@/lib/format';

interface Props {
  buckets: BucketTotals;
  labels: { b0_30: string; b31_60: string; b61_90: string; b90_plus: string };
  /** Shown when there is nothing in a bucket. */
  empty: string;
  /** Extra tiles after the four buckets (on account, interest). */
  extra?: { label: string; value: string; sub?: string }[];
}

/** The four ageing buckets as tiles (numbers, not just colour): older buckets that hold money warn. */
export function AgeingTiles({ buckets, labels, empty, extra = [] }: Props) {
  const has = (v: string) => compareDecimal(v, '0.00', 2) === 1;
  const tone = { b0_30: undefined, b31_60: 'warn', b61_90: 'bad', b90_plus: 'bad' } as const;
  return (
    <div className="tiles">
      {(['b0_30', 'b31_60', 'b61_90', 'b90_plus'] as const).map((k) => (
        <StatTile key={k} label={labels[k]} value={has(buckets[k]) ? inr(buckets[k]) : empty} tone={has(buckets[k]) ? tone[k] : undefined} small />
      ))}
      {extra.map((e) => (
        <StatTile key={e.label} label={e.label} value={e.value} sub={e.sub} small />
      ))}
    </div>
  );
}
