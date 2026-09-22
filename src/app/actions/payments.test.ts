import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';
import { bounceCheque, depositCheque, markCleared, postPayment, saveDraftPayment } from './payments';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

const PAY = '11111111-1111-4111-8111-111111111111';
const PARTY = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const INV = '55555555-5555-4555-8555-555555555555';
const STAMP = '2026-09-22T10:00:00.123456+00:00';

const receipt = {
  direction: 'receipt' as const, partyId: PARTY, paymentDate: '2026-09-20', mode: 'cash' as const,
  instrumentNo: '', instrumentDate: '', chequeBank: '', amount: '5000.00', discount: '', accountId: ACCOUNT, note: '', allocations: [],
};

/** Answers each table like a healthy database; a test overrides what it wants to break. */
function healthy(over: (call: Call) => Answer | undefined = () => undefined) {
  state.respond = (call) => {
    const o = over(call);
    if (o) return o;
    switch (`${call.table}:${call.op}`) {
      case 'organization:select': return { data: [{ timezone: 'Asia/Kolkata' }] };
      case 'parties:select': return { data: [{ id: PARTY, type: 'customer', is_active: true }] };
      case 'accounts:select': return { data: [{ id: ACCOUNT, is_money: true }] };
      case 'payments:insert': return { data: [{ id: PAY, updated_at: STAMP }] };
      case 'payments:update': return { data: [{ id: PAY, updated_at: STAMP }] };
      case 'payments:select': return { data: [{ id: PAY, status: 'draft' }] };
      case 'payment_allocations:select': return { data: [] };
      case 'payment_allocations:delete': return { data: [{ id: PAY }] };
      case 'payment_allocations:insert': return { data: [], error: null };
      case 'payments:delete': return { data: [{ id: PAY }] };
      default: return { data: null, error: null };
    }
  };
}
const find = (table: string, op: Call['op']) => state.calls.find((c) => c.table === table && c.op === op);
const rpc = (fn: string) => state.calls.find((c) => c.rpc === fn);

describe('saveDraftPayment', () => {
  it('creates a draft receipt', async () => {
    reset(asCounter());
    healthy();
    expect(await saveDraftPayment(receipt)).toEqual({ ok: true, data: { id: PAY, updatedAt: STAMP } });
    const header = find('payments', 'insert')!.payload as Record<string, unknown>;
    expect(header).toMatchObject({ direction: 'receipt', party_id: PARTY, mode: 'cash', amount: '5000.00', account_id: ACCOUNT, status: 'draft', created_by: 'u-counter' });
    expect(state.revalidated).toEqual([]);
  });

  it('a receipt against a supplier-only party is refused; a payment against a customer-only party is refused', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'parties' ? { data: [{ id: PARTY, type: 'supplier', is_active: true }] } : undefined));
    expect(await saveDraftPayment(receipt)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_party' });

    reset(asAdmin());
    healthy((c) => (c.table === 'parties' ? { data: [{ id: PARTY, type: 'customer', is_active: true }] } : undefined));
    expect(await saveDraftPayment({ ...receipt, direction: 'payment' })).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_party' });
  });

  it('an account that is not a real money ledger is refused', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'accounts' ? { data: [{ id: ACCOUNT, is_money: false }] } : undefined));
    expect(await saveDraftPayment(receipt)).toEqual({ ok: false, code: 'validation', error: 'validation.invalid_account' });
  });

  it('a cheque with no cheque number is refused before the database (zod)', async () => {
    reset(asAdmin());
    expect(await saveDraftPayment({ ...receipt, mode: 'cheque' })).toEqual({ ok: false, code: 'validation', error: 'field.instrument_required' });
    expect(state.calls).toHaveLength(0);
  });

  it('editing sends the loaded updated_at and replaces the allocations', async () => {
    reset(asAdmin());
    healthy();
    const alloc = { invoiceType: 'sales_invoice' as const, invoiceId: INV, amount: '2000.00' };
    const r = await saveDraftPayment({ ...receipt, id: PAY, expectedUpdatedAt: STAMP, allocations: [alloc] });
    expect(r).toMatchObject({ ok: true });
    const upd = find('payments', 'update')!;
    expect(upd.filters).toEqual(expect.arrayContaining([['id', PAY], ['status', 'draft'], ['updated_at', STAMP]]));
    expect(find('payment_allocations', 'delete')).toBeDefined();
    expect(find('payment_allocations', 'insert')!.payload).toEqual([{ payment_id: PAY, invoice_type: 'sales_invoice', invoice_id: INV, amount: '2000.00' }]);
  });

  it('a stale version is a conflict and touches no allocations', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'payments' && c.op === 'update' ? { data: [] } : undefined));
    expect(await saveDraftPayment({ ...receipt, id: PAY, expectedUpdatedAt: 'old' })).toEqual({ ok: false, code: 'conflict', error: 'conflict' });
    expect(find('payment_allocations', 'delete')).toBeUndefined();
  });

  it('posted payments cannot be edited', async () => {
    reset(asAdmin());
    healthy((c) => (c.table === 'payments' && c.op === 'select' ? { data: [{ id: PAY, status: 'posted' }] } : undefined));
    expect(await saveDraftPayment({ ...receipt, id: PAY, expectedUpdatedAt: STAMP })).toMatchObject({ ok: false, code: 'not_draft' });
    expect(find('payments', 'update')).toBeUndefined();
  });

  it('a future date is refused', async () => {
    reset(asAdmin());
    healthy();
    expect(await saveDraftPayment({ ...receipt, paymentDate: '2999-01-01' })).toEqual({ ok: false, code: 'validation', error: 'validation.payment_date_future' });
  });

  it('bad input never reaches the database', async () => {
    reset(asAdmin());
    for (const [patch, key] of [
      [{ amount: '0' }, 'field.money_invalid'],
      [{ partyId: 'nope' }, 'field.payment_party_required'],
      [{ paymentDate: '19-09-2026' }, 'field.date_invalid'],
    ] as const) {
      expect(await saveDraftPayment({ ...receipt, ...patch })).toMatchObject({ ok: false, code: 'validation', error: key });
    }
    expect(state.calls).toHaveLength(0);
  });

  it('signed-out callers are refused before the database is touched', async () => {
    reset(null);
    expect(await saveDraftPayment(receipt)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(state.calls).toHaveLength(0);
  });
});

describe('postPayment', () => {
  it('a counter-staff session posts an ordinary receipt', async () => {
    reset(asCounter());
    // Both `payments:select` calls (the pre-post gate read, and reading voucher_no back after) share this answer.
    state.respond = (call) =>
      call.table === 'payments' && call.op === 'select' ? { data: [{ direction: 'receipt', discount: 0, voucher_no: 'RCPT/0001' }] } : { data: null, error: null };
    expect(await postPayment({ id: PAY })).toEqual({ ok: true, data: { id: PAY, voucherNo: 'RCPT/0001' } });
    expect(rpc('post_payment')?.payload).toEqual({ p_payment_id: PAY });
    expect(state.revalidated).toEqual(expect.arrayContaining(['/payments', '/payments/new']));
  });

  it('a counter-staff session cannot post an outgoing payment or a discounted one', async () => {
    reset(asCounter());
    state.respond = (call) =>
      call.table === 'payments' && call.op === 'select' ? { data: [{ direction: 'payment', discount: 0 }] } : { data: null, error: null };
    expect(await postPayment({ id: PAY })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('post_payment')).toBeUndefined();

    reset(asCounter());
    state.respond = (call) =>
      call.table === 'payments' && call.op === 'select' ? { data: [{ direction: 'receipt', discount: 50 }] } : { data: null, error: null };
    expect(await postPayment({ id: PAY })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('post_payment')).toBeUndefined();
  });

  it('an admin session may post either', async () => {
    reset(asAdmin());
    state.respond = (call) =>
      call.table === 'payments' && call.op === 'select' ? { data: [{ direction: 'payment', discount: 50, voucher_no: 'PAY/0001' }] } : { data: null, error: null };
    expect(await postPayment({ id: PAY })).toEqual({ ok: true, data: { id: PAY, voucherNo: 'PAY/0001' } });
  });

  it('maps the database refusals to codes with a friendly sentence', async () => {
    for (const [db, code] of [['DN_PERIOD_LOCKED', 'period_locked'], ['DN_NOT_DRAFT', 'not_draft'], ['DN_VALIDATION:allocation_exceeds_invoice', 'validation']] as const) {
      reset(asAdmin());
      state.respond = (call) =>
        call.table === 'payments' && call.op === 'select' ? { data: [{ direction: 'receipt', discount: 0 }] } : dbError(db);
      expect(await postPayment({ id: PAY })).toMatchObject({ ok: false, code });
    }
  });

  it('an unknown payment is a friendly validation message', async () => {
    reset(asCounter());
    state.respond = () => ({ data: [] });
    expect(await postPayment({ id: PAY })).toEqual({ ok: false, code: 'validation', error: 'validation.no_such_payment' });
  });
});

describe('cheque lifecycle', () => {
  it('deposit and mark-cleared are member actions', async () => {
    reset(asCounter());
    expect(await depositCheque({ id: PAY })).toEqual({ ok: true, data: { id: PAY } });
    expect(rpc('deposit_cheque')?.payload).toEqual({ p_payment_id: PAY });

    reset(asCounter());
    expect(await markCleared({ id: PAY })).toEqual({ ok: true, data: { id: PAY } });
    expect(rpc('mark_cheque_cleared')?.payload).toEqual({ p_payment_id: PAY });
  });

  it('a bad cheque-state transition maps to the cheque_state code', async () => {
    reset(asCounter());
    state.respond = () => dbError('DN_CHEQUE_STATE');
    expect(await depositCheque({ id: PAY })).toEqual({ ok: false, code: 'cheque_state', error: 'cheque_state' });
  });

  it('bounce is admin-only and needs a real reason', async () => {
    reset(asCounter());
    expect(await bounceCheque({ id: PAY, reason: 'customer said insufficient funds' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(rpc('bounce_cheque')).toBeUndefined();

    reset(asAdmin());
    expect(await bounceCheque({ id: PAY, reason: 'no' })).toEqual({ ok: false, code: 'validation', error: 'field.reason_required' });

    reset(asAdmin());
    expect(await bounceCheque({ id: PAY, reason: 'customer said insufficient funds' })).toEqual({ ok: true, data: { id: PAY } });
    expect(rpc('bounce_cheque')?.payload).toEqual({ p_payment_id: PAY, p_reason: 'customer said insufficient funds' });
  });
});
