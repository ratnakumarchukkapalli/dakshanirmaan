import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { cancelCashDeposit, postCashDeposit } from './cash-deposit';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const DEP = '22222222-2222-4222-8222-222222222222';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table ?? call.rpc}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'post_cash_deposit:rpc': return { data: DEP };
      default: return { data: null, error: null };
    }
  };
}

describe('postCashDeposit', () => {
  const input = { date: TODAY, amount: '2000.00', reference: ' SLIP-1 ', note: '' };

  it('any signed-in member deposits: the database gets the trimmed fields and returns the id', async () => {
    reset(asCounter());
    healthy();
    expect(await postCashDeposit(input)).toEqual({ ok: true, data: { id: DEP } });
    expect(rpc('post_cash_deposit')?.payload).toEqual({ p_date: TODAY, p_amount: '2000.00', p_reference: 'SLIP-1', p_note: null });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/payments', '/reports/day-close', '/']));
  });

  it('an owner who has not passed the authenticator step is refused before the database is touched', async () => {
    reset(asAdmin('aal1'));
    healthy();
    expect(await postCashDeposit(input)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('post_cash_deposit')).toBeUndefined();
  });

  it('refuses money that is zero, negative, a float artefact or too precise, without calling the database', async () => {
    for (const amount of ['0', '0.00', '-5', '10.001', 'abc', '', '1e3']) {
      reset(asCounter());
      healthy();
      expect(await postCashDeposit({ ...input, amount })).toMatchObject({ ok: false, code: 'validation' });
      expect(rpc('post_cash_deposit')).toBeUndefined();
    }
  });

  it('refuses a future date and an over-long reference', async () => {
    reset(asCounter());
    healthy();
    expect(await postCashDeposit({ ...input, date: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.doc_date_future' });
    expect(await postCashDeposit({ ...input, reference: 'x'.repeat(61) })).toMatchObject({ ok: false, code: 'validation' });
    expect(rpc('post_cash_deposit')).toBeUndefined();
  });

  it('maps the database refusals to friendly sentences that exist in the message catalogue', async () => {
    const cases: [string, string, string][] = [
      ['DN_PERIOD_LOCKED', 'period_locked', 'period_locked'],
      ['DN_VALIDATION:day_closed', 'validation', 'validation.day_closed'],
      ['DN_VALIDATION:invalid_amount', 'validation', 'validation.invalid_amount'],
      ['DN_FORBIDDEN', 'forbidden', 'forbidden'],
    ];
    for (const [db, code, error] of cases) {
      reset(asCounter());
      healthy((c) => (c.rpc === 'post_cash_deposit' ? dbError(db) : undefined));
      expect(await postCashDeposit(input)).toEqual({ ok: false, code, error });
    }
  });

  it('a raw database failure is never shown', async () => {
    reset(asCounter());
    healthy((c) => (c.rpc === 'post_cash_deposit' ? dbError('relation "x" does not exist') : undefined));
    expect(await postCashDeposit(input)).toEqual({ ok: false, code: 'internal', error: 'internal' });
  });
});

describe('cancelCashDeposit', () => {
  const reason = 'typed the wrong amount';

  it('is owner-only: a counter is refused before the database is touched', async () => {
    reset(asCounter());
    expect(await cancelCashDeposit({ id: DEP, reason })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('cancel_document')).toBeUndefined();
  });

  it('needs a real reason', async () => {
    reset(asAdmin());
    expect(await cancelCashDeposit({ id: DEP, reason: 'no' })).toEqual({ ok: false, code: 'validation', error: 'field.reason_required' });
  });

  it('an owner cancels through cancel_document and the screens refresh', async () => {
    reset(asAdmin());
    expect(await cancelCashDeposit({ id: DEP, reason })).toEqual({ ok: true, data: { id: DEP } });
    expect(rpc('cancel_document')?.payload).toEqual({ p_source_type: 'cash_deposit', p_source_id: DEP, p_reason: reason });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/payments', '/reports/day-close']));
  });

  it('a closed day is refused with a friendly sentence', async () => {
    reset(asAdmin());
    state.respond = (c) => (c.rpc === 'cancel_document' ? dbError('DN_VALIDATION:day_closed') : { data: null });
    expect(await cancelCashDeposit({ id: DEP, reason })).toEqual({ ok: false, code: 'validation', error: 'validation.day_closed' });
  });
});
