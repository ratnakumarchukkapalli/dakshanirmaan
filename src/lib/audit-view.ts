// How an audit_log row reads on the audit-trail screen: the changed columns of a master edit as
// "field: before → after", or the few identifying facts of a posting. Pure, so it is unit-tested.

export interface AuditDetail { key: string; before?: string; after?: string }

const IDENTIFYING = ['doc_no', 'invoice_no', 'note_no', 'voucher_no', 'adj_no', 'transfer_no', 'challan_no', 'name', 'month', 'reason', 'as_of', 'year_label', 'fy'];
const MAX = 60;

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s;
};

type Bag = Record<string, unknown> | null | undefined;

/** Detail lines for one row, at most `limit`; the rest are dropped (the row still says what changed). */
export function auditDetails(action: string, before: Bag, after: Bag, limit = 6): AuditDetail[] {
  // A delete keeps the row in `before` and has no `after`: show what was deleted.
  const a = (action === 'delete' ? before : after) ?? {};
  const b = before ?? {};
  if (action === 'update' && Object.keys(a).length > 0) {
    return Object.keys(a).slice(0, limit).map((key) => ({ key, before: show(b[key]), after: show(a[key]) }));
  }
  const keys = IDENTIFYING.filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
  return keys.slice(0, limit).map((key) => ({ key, after: show(a[key]) }));
}
