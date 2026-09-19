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
  it('finds the code inside a longer message', () => {
    expect(parseDbError('error: DN_VALIDATION:email (context)').detail).toBe('email');
  });
  it('treats anything else as internal, never echoing it', () => {
    expect(parseDbError('duplicate key value violates unique constraint "x"')).toEqual({ code: 'internal' });
    expect(parseDbError(undefined)).toEqual({ code: 'internal' });
    expect(parseDbError('DN_SOMETHING_NEW')).toEqual({ code: 'internal' });
  });
});

describe('envelope helpers', () => {
  it('builds success and failure shapes', () => {
    expect(ok({ id: 1 })).toEqual({ ok: true, data: { id: 1 } });
    expect(ok()).toEqual({ ok: true, data: null });
    expect(fail('forbidden', 'No.')).toEqual({ ok: false, code: 'forbidden', error: 'No.' });
  });
});
