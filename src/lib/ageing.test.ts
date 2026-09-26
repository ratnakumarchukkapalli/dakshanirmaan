import { describe, expect, it } from 'vitest';
import { bucketOf, bucketOpen, oldestBucket } from './ageing';

describe('ageing buckets', () => {
  it('cuts at 30 / 60 / 90 days like v_party_aging', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(bucketOf)).toEqual([
      'b0_30', 'b0_30', 'b31_60', 'b31_60', 'b61_90', 'b61_90', 'b90_plus', 'b90_plus',
    ]);
  });
  it('sums exactly, without float drift', () => {
    const rows = Array.from({ length: 7 }, () => ({ ageDays: 10, openAmount: '333.33' }));
    rows.push({ ageDays: 45, openAmount: '0.10' }, { ageDays: 46, openAmount: '0.20' });
    expect(bucketOpen(rows)).toEqual({ b0_30: '2333.31', b31_60: '0.30', b61_90: '0.00', b90_plus: '0.00' });
  });
  it('finds the oldest non-empty bucket', () => {
    expect(oldestBucket(bucketOpen([]))).toBeNull();
    expect(oldestBucket(bucketOpen([{ ageDays: 5, openAmount: '1.00' }, { ageDays: 70, openAmount: '2.00' }]))).toBe('b61_90');
  });
});
