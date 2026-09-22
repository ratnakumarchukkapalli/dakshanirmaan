// The one shape every server action returns (api spec: "Result envelope and errors").
// Actions never throw to the UI; raw database text never reaches it.

export type ErrorCode =
  | 'validation' | 'forbidden' | 'period_locked' | 'negative_stock' | 'credit_limit' | 'not_draft'
  | 'not_posted' | 'has_allocations' | 'unbalanced' | 'conflict' | 'partial' | 'no_period'
  | 'rate_limited' | 'cheque_state' | 'internal';

export type Failure = { ok: false; error: string; code: ErrorCode };
export type ActionResult<T = null> = { ok: true; data: T } | Failure;

export const ok = <T = null>(data: T = null as T): ActionResult<T> => ({ ok: true, data });
export const fail = (code: ErrorCode, error: string): Failure => ({ ok: false, error, code });

const DB_CODES: Record<string, ErrorCode> = {
  DN_FORBIDDEN: 'forbidden',
  DN_PERIOD_LOCKED: 'period_locked',
  DN_NEGATIVE_STOCK: 'negative_stock',
  DN_CREDIT_LIMIT: 'credit_limit',
  DN_NOT_DRAFT: 'not_draft',
  DN_NOT_POSTED: 'not_posted',
  DN_HAS_ALLOCATIONS: 'has_allocations',
  DN_UNBALANCED: 'unbalanced',
  DN_NO_PERIOD: 'no_period',
  // Raised by deposit_cheque / mark_cheque_cleared / bounce_cheque for any transition the
  // cheque's current status doesn't allow (already deposited, not a cheque, wrong direction…).
  DN_CHEQUE_STATE: 'cheque_state',
  // Raised by post_sales_invoice when the draft's challan was already converted to a different,
  // posted invoice (a stray duplicate draft from a double-click on "Invoice ->"). No detail
  // string travels with it, so this reads as the generic validation sentence.
  DN_CONVERTED: 'validation',
};

/**
 * Reads a Postgres `DN_*` RAISE (optionally `DN_VALIDATION:<detail>`) out of an error message.
 * Constraint failures carry a SQLSTATE instead: unique (23505), check (23514), foreign key
 * (23503), numeric out of range (22003) and "not allowed" (42501) map to friendly validation / forbidden results.
 */
export function parseDbError(message: string | undefined, sqlState?: string): { code: ErrorCode; detail?: string } {
  const match = /DN_[A-Z_]+(?::[a-z_]+)?/.exec(message ?? '');
  if (!match) {
    if (sqlState === '23505') return { code: 'validation', detail: /parties_gstin_key/.test(message ?? '') ? 'gstin_taken' : 'duplicate' };
    if (sqlState === '22003') return { code: 'validation', detail: 'number_too_large' };
    // A zero-value invoice fails the journal's "amount > 0" check when it posts: say so plainly.
    if (sqlState === '23514' && /journal_lines_check/.test(message ?? '')) return { code: 'validation', detail: 'zero_total' };
    if (sqlState === '23514' || sqlState === '23503') return { code: 'validation' };
    if (sqlState === '42501') return { code: 'forbidden' };
    return { code: 'internal' };
  }
  const [name, detail] = match[0].split(':');
  if (name === 'DN_VALIDATION') return { code: 'validation', detail };
  return { code: DB_CODES[name!] ?? 'internal' };
}
