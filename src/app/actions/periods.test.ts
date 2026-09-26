import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { createFiscalYear, setPeriodLock } from './periods';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);
const answer = (a: Answer | ((c: Call) => Answer)) => { state.respond = typeof a === 'function' ? a : () => a; };

describe('setPeriodLock', () => {
  it('locks a month through the database function', async () => {
    reset(asAdmin());
    answer({ data: true });
    expect(await setPeriodLock({ month: '2026-09-01', locked: true })).toEqual({ ok: true, data: { changed: true } });
    expect(rpc('set_period_lock')?.payload).toEqual({ p_month: '2026-09-01', p_locked: true, p_reason: null });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/settings/period-locks', '/settings/audit-trail']));
  });

  it('unlocking carries the reason, and is refused here without one before the database is called', async () => {
    reset(asAdmin());
    answer({ data: true });
    expect(await setPeriodLock({ month: '2026-09-01', locked: false, reason: 'Filed the wrong month' })).toMatchObject({ ok: true });
    expect(rpc('set_period_lock')?.payload).toMatchObject({ p_locked: false, p_reason: 'Filed the wrong month' });
    state.calls.length = 0;
    expect(await setPeriodLock({ month: '2026-09-01', locked: false })).toMatchObject({ ok: false, code: 'validation', error: 'validation.reason_required' });
    expect(rpc('set_period_lock')).toBeUndefined();
  });

  it('is owner-only, and only a first-of-month is accepted', async () => {
    reset(asCounter());
    expect(await setPeriodLock({ month: '2026-09-01', locked: true })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin('aal1'));
    expect(await setPeriodLock({ month: '2026-09-01', locked: true })).toMatchObject({ ok: false, code: 'forbidden' });
    reset(asAdmin());
    expect(await setPeriodLock({ month: '2026-09-15', locked: true })).toMatchObject({ ok: false, code: 'validation' });
    expect(state.calls).toHaveLength(0);
  });

  it('maps a month with no period row', async () => {
    reset(asAdmin());
    answer(dbError('DN_NO_PERIOD'));
    expect(await setPeriodLock({ month: '2035-01-01', locked: true })).toMatchObject({ ok: false, code: 'no_period' });
  });
});

describe('createFiscalYear', () => {
  it('returns how many months were added', async () => {
    reset(asAdmin());
    answer({ data: 12 });
    expect(await createFiscalYear({ label: '2027-28' })).toEqual({ ok: true, data: { added: 12 } });
    expect(rpc('ensure_fiscal_year')?.payload).toEqual({ p_label: '2027-28' });
  });

  it('maps a bad label from the database and refuses a non-owner', async () => {
    reset(asAdmin());
    answer(dbError('DN_VALIDATION:bad_year_label'));
    expect(await createFiscalYear({ label: '2027-29' })).toMatchObject({ ok: false, code: 'validation', error: 'validation.bad_year_label' });
    reset(asCounter());
    expect(await createFiscalYear({ label: '2027-28' })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
