import { describe, expect, it } from 'vitest';
import { auditDetails } from './audit-view';

describe('auditDetails', () => {
  it('lists each changed column with its old and new value', () => {
    expect(auditDetails('update', { sale_rate: 400 }, { sale_rate: 410 })).toEqual([{ key: 'sale_rate', before: '400', after: '410' }]);
  });
  it('shows a missing old value as a dash, and long values cut short', () => {
    const long = 'x'.repeat(100);
    const [d] = auditDetails('update', {}, { address: long });
    expect(d?.before).toBe('—');
    expect(d?.after?.length).toBe(60);
    expect(d?.after?.endsWith('…')).toBe(true);
  });
  it('for a posting or an insert shows only the identifying facts', () => {
    expect(auditDetails('post', null, { doc_no: 'DN/26-27/0001', entry_id: 'e1', grand_total: 5120 })).toEqual([{ key: 'doc_no', after: 'DN/26-27/0001' }]);
    expect(auditDetails('insert', null, { name: 'P1', gstin: 'x' })).toEqual([{ key: 'name', after: 'P1' }]);
    expect(auditDetails('lock', { is_locked: false }, { month: '2026-09-01', is_locked: true, reason: null })).toEqual([{ key: 'month', after: '2026-09-01' }]);
  });
  it('an unlock shows its reason', () => {
    expect(auditDetails('unlock', null, { month: '2026-09-01', reason: 'Filed the wrong month' })).toEqual([
      { key: 'month', after: '2026-09-01' }, { key: 'reason', after: 'Filed the wrong month' },
    ]);
  });
  it('honours the limit', () => {
    expect(auditDetails('update', {}, { a: 1, b: 2, c: 3 }, 2)).toHaveLength(2);
  });
});
