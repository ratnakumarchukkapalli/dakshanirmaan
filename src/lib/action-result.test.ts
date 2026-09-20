import { describe, expect, it } from 'vitest';
import { fail, ok, parseDbError } from './action-result';

describe('parseDbError', () => {
  it('maps Postgres DN_* messages to error codes', () => {
    expect(parseDbError('DN_FORBIDDEN')).toEqual({ code: 'forbidden' });
    expect(parseDbError('DN_PERIOD_LOCKED')).toEqual({ code: 'period_locked' });
    expect(parseDbError('DN_NEGATIVE_STOCK')).toEqual({ code: 'negative_stock' });
    expect(parseDbError('DN_NO_PERIOD')).toEqual({ code: 'no_period' });
  });
  it('carries the detail of a validation error', () => {
    expect(parseDbError('DN_VALIDATION:max_active_users')).toEqual({ code: 'validation', detail: 'max_active_users' });
    expect(parseDbError('DN_VALIDATION:last_admin')).toEqual({ code: 'validation', detail: 'last_admin' });
  });
  it('carries the details the database added for party and user rules', () => {
    for (const d of ['party_type_has_balance', 'address_party_locked', 'email_taken', 'admin_only_field'])
      expect(parseDbError(`DN_VALIDATION:${d}`)).toEqual({ code: 'validation', detail: d });
  });
  it('finds the code inside a longer message', () => {
    expect(parseDbError('error: DN_VALIDATION:email (context)').detail).toBe('email');
  });
  it('treats anything else as internal, never echoing it', () => {
    expect(parseDbError('duplicate key value violates unique constraint "x"')).toEqual({ code: 'internal' });
    expect(parseDbError(undefined)).toEqual({ code: 'internal' });
    expect(parseDbError('DN_SOMETHING_NEW')).toEqual({ code: 'internal' });
  });
});

describe('parseDbError: constraint failures (SQLSTATE)', () => {
  it('duplicate GSTIN gets its own detail, other duplicates a generic one', () => {
    expect(parseDbError('duplicate key value violates unique constraint "parties_gstin_key"', '23505')).toEqual({ code: 'validation', detail: 'gstin_taken' });
    expect(parseDbError('duplicate key value violates unique constraint "x"', '23505')).toEqual({ code: 'validation', detail: 'duplicate' });
  });
  it('check and foreign-key failures are validation; permission failures are forbidden', () => {
    expect(parseDbError('violates check constraint "items_hsn_check"', '23514')).toEqual({ code: 'validation' });
    expect(parseDbError('violates foreign key constraint', '23503')).toEqual({ code: 'validation' });
    expect(parseDbError('new row violates row-level security policy', '42501')).toEqual({ code: 'forbidden' });
  });
  it('a zero-value invoice (journal amount check) gets its own detail', () => {
    expect(parseDbError('new row for relation "journal_lines" violates check constraint "journal_lines_check"', '23514'))
      .toEqual({ code: 'validation', detail: 'zero_total' });
  });
  it('a number too big for its column is a validation problem, not an internal one', () => {
    expect(parseDbError('numeric field overflow', '22003')).toEqual({ code: 'validation', detail: 'number_too_large' });
  });
  it('an unknown SQLSTATE stays internal', () => {
    expect(parseDbError('boom', '58000')).toEqual({ code: 'internal' });
  });
});

describe('envelope helpers', () => {
  it('builds success and failure shapes', () => {
    expect(ok({ id: 1 })).toEqual({ ok: true, data: { id: 1 } });
    expect(ok()).toEqual({ ok: true, data: null });
    expect(fail('forbidden', 'No.')).toEqual({ ok: false, code: 'forbidden', error: 'No.' });
  });
});
