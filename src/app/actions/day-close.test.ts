import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { closeDay, reopenDay } from './day-close';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const CLOSE = '11111111-1111-4111-8111-111111111111';
// A counter may close today or yesterday only, so the fixtures close today (the organisation's date).
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table ?? call.rpc}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'post_day_close:rpc': return { data: null };
      case 'day_closes:select': return { data: [{ id: CLOSE, difference: -200 }] };
      default: return { data: null, error: null };
    }
  };
}

describe('closeDay', () => {
  const input = { date: TODAY, counted: '1600.00', note: '', expectedSeen: '1800.00' };

  it('any signed-in member closes: the database is called with the counted cash and returns its own difference', async () => {
    reset(asCounter());
    healthy();
    expect(await closeDay(input)).toEqual({ ok: true, data: { id: CLOSE, difference: '-200.00' } });
    expect(rpc('post_day_close')?.payload).toEqual({ p_date: TODAY, p_counted: '1600.00', p_note: null, p_expected_seen: '1800.00' });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/reports/day-close', '/']));
  });

  it('an owner who has not passed the authenticator step is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    healthy();
    expect(await closeDay(input)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('post_day_close')).toBeUndefined();
  });

  it('keeps the note when there is one, and rejects money that is not text with 2 decimals', async () => {
    reset(asCounter());
    healthy();
    await closeDay({ ...input, note: '  short by the tea money ' });
    expect(rpc('post_day_close')?.payload).toMatchObject({ p_note: 'short by the tea money' });

    for (const counted of ['-1', '12.345', 'abc', '', '1e3']) {
      reset(asCounter());
      healthy();
      expect(await closeDay({ ...input, counted })).toMatchObject({ ok: false, code: 'validation' });
      expect(rpc('post_day_close')).toBeUndefined();
    }
  });

  it('sends the expected figure the screen showed, which may be negative, and refuses a missing or malformed one', async () => {
    reset(asCounter());
    healthy();
    expect(await closeDay({ ...input, expectedSeen: '-8000.00' })).toMatchObject({ ok: true });
    expect(rpc('post_day_close')?.payload).toMatchObject({ p_expected_seen: '-8000.00' });
    for (const expectedSeen of [undefined, '', 'x', '1.234']) {
      reset(asCounter());
      healthy();
      expect(await closeDay({ ...input, expectedSeen })).toMatchObject({ ok: false, code: 'validation' });
      expect(rpc('post_day_close')).toBeUndefined();
    }
  });

  it('days are closed in order: a later live close blocks an earlier day, for a counter and for an owner', async () => {
    for (const who of [asCounter(), asAdmin()]) {
      reset(who);
      healthy((c) => (c.table === 'day_closes' && c.op === 'select' ? { data: [{ close_date: '9999-12-31', id: CLOSE, difference: 0 }] } : undefined));
      expect(await closeDay(input)).toEqual({ ok: false, code: 'validation', error: 'validation.later_close_exists' });
      expect(rpc('post_day_close')).toBeUndefined();
    }
  });

  it('a counter cannot close a day older than yesterday; an owner can (nothing later is closed)', async () => {
    const old = { ...input, date: '2026-01-05' };
    reset(asCounter());
    healthy();
    expect(await closeDay(old)).toEqual({ ok: false, code: 'validation', error: 'validation.close_date_old' });
    expect(rpc('post_day_close')).toBeUndefined();
    reset(asAdmin());
    healthy();
    expect(await closeDay(old)).toMatchObject({ ok: true });
    reset(asCounter());
    healthy();
    expect(await closeDay({ ...input, date: TODAY })).toMatchObject({ ok: true });
  });

  it('zero counted cash is a real count (an empty drawer)', async () => {
    reset(asCounter());
    healthy();
    expect(await closeDay({ ...input, counted: '0' })).toMatchObject({ ok: true });
  });

  it('refuses a future date without calling the database', async () => {
    reset(asCounter());
    healthy();
    expect(await closeDay({ ...input, date: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.future_date' });
    expect(rpc('post_day_close')).toBeUndefined();
  });

  it('maps the database refusals to friendly sentences that exist in the message catalogue', async () => {
    const cases: [string, string, string][] = [
      ['DN_PERIOD_LOCKED', 'period_locked', 'period_locked'],
      ['DN_VALIDATION:already_closed', 'validation', 'validation.already_closed'],
      ['DN_VALIDATION:expected_changed', 'validation', 'validation.expected_changed'],
      ['DN_VALIDATION:later_close_exists', 'validation', 'validation.later_close_exists'],
      ['DN_FORBIDDEN', 'forbidden', 'forbidden'],
    ];
    for (const [db, code, error] of cases) {
      reset(asCounter());
      healthy((c) => (c.rpc === 'post_day_close' ? dbError(db) : undefined));
      expect(await closeDay(input)).toEqual({ ok: false, code, error });
    }
  });

  it('a raw database failure is never shown', async () => {
    reset(asCounter());
    healthy((c) => (c.rpc === 'post_day_close' ? dbError('relation "x" does not exist') : undefined));
    expect(await closeDay(input)).toEqual({ ok: false, code: 'internal', error: 'internal' });
  });
});

describe('reopenDay', () => {
  const reason = 'counted the wrong drawer';

  it('is owner-only: a counter is refused before the database is touched', async () => {
    reset(asCounter());
    expect(await reopenDay({ id: CLOSE, reason })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('cancel_document')).toBeUndefined();
  });

  it('needs a real reason', async () => {
    reset(asAdmin());
    expect(await reopenDay({ id: CLOSE, reason: 'no' })).toEqual({ ok: false, code: 'validation', error: 'field.reason_required' });
  });

  it('an owner reopens through cancel_document and the screens refresh', async () => {
    reset(asAdmin());
    expect(await reopenDay({ id: CLOSE, reason })).toEqual({ ok: true, data: { id: CLOSE } });
    expect(rpc('cancel_document')?.payload).toEqual({ p_source_type: 'day_close', p_source_id: CLOSE, p_reason: reason });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/reports/day-close', '/']));
  });

  it('refuses to reopen a day while a later day stays closed', async () => {
    reset(asAdmin());
    state.respond = (c) => (c.table === 'day_closes'
      ? { data: [{ close_date: c.filters.some(([k]) => k === 'id') ? '2026-09-20' : '2026-09-25' }] }
      : { data: null });
    expect(await reopenDay({ id: CLOSE, reason })).toEqual({ ok: false, code: 'validation', error: 'validation.reopen_later_first' });
    expect(rpc('cancel_document')).toBeUndefined();
  });

  it('maps the database refusals', async () => {
    for (const [db, code] of [['DN_NOT_POSTED', 'not_posted'], ['DN_PERIOD_LOCKED', 'period_locked']] as const) {
      reset(asAdmin());
      state.respond = () => dbError(db);
      expect(await reopenDay({ id: CLOSE, reason })).toEqual({ ok: false, code, error: code });
    }
  });
});
