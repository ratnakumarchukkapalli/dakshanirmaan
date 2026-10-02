import { describe, expect, it, vi } from 'vitest';
import { asAdmin, asCounter, dbError, reset, state, type Answer, type Call } from '@/test/harness';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => (await import('@/test/harness')).intlMock);
vi.mock('next/cache', async () => (await import('@/test/harness')).cacheMock);
vi.mock('@/lib/auth/current', async () => (await import('@/test/harness')).currentMock);
vi.mock('@/lib/supabase/server', async () => (await import('@/test/harness')).supabaseMock);

import {
  autoMatchStatement, bookBankExpense, ignoreBankLine, importBankStatement, matchBankLine, matchLineToPayment, unmatchBankLine,
} from './bank';

const BANK = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const ENTRY = '33333333-3333-4333-8333-333333333333';
const PAY = '44444444-4444-4444-8444-444444444444';
const EXPENSE = '66666666-6666-4666-8666-666666666666';

const line = (over: Record<string, unknown> = {}) => ({
  lineNo: 1, txnDate: '2026-09-01', valueDate: '2026-09-01', narration: 'UPI-RAMESH-PAYMENT', reference: '123456789012',
  debit: '0.00', credit: '12500.50', balance: '112500.50', kind: 'other', ...over,
});
const importResult = {
  statement_id: 's-1', imported: 1, skipped_duplicates: 0, first_date: '2026-09-01', last_date: '2026-09-01',
  opening_balance: '100000.00', closing_balance: '112500.50', continuity_warning: false, previous_closing_balance: null,
};
const rpcCalls = () => state.calls.filter((c) => c.op === 'rpc');
const answerBankAccount = (c: Call): Answer | null =>
  c.table === 'accounts' && c.filters.some(([k, v]) => k === 'system_key' && v === 'bank') ? { data: [{ id: BANK, is_money: true }] } : null;

const everyAction = [
  () => importBankStatement({ fileName: 'a.txt', lines: [line()] }),
  () => autoMatchStatement({ statementId: LINE }),
  () => matchBankLine({ lineId: LINE, entryId: ENTRY }),
  () => unmatchBankLine({ lineId: LINE }),
  () => ignoreBankLine({ lineId: LINE, reason: 'own transfer' }),
  () => matchLineToPayment({ lineId: LINE, paymentId: PAY }),
  () => bookBankExpense({ lineId: LINE, note: '' }),
];

describe('bank actions are owner-only', () => {
  it('a counter user and an owner at aal1 are refused, and the database is never touched', async () => {
    for (const member of [asCounter(), asAdmin('aal1')]) {
      reset(member);
      for (const act of everyAction) expect(await act()).toMatchObject({ ok: false, code: 'forbidden' });
      expect(state.calls).toHaveLength(0);
    }
  });
});

describe('importBankStatement', () => {
  it('sends the previewed rows to import_bank_statement for the bank ledger, with money still as strings', async () => {
    reset(asAdmin());
    state.respond = (c) => answerBankAccount(c) ?? { data: importResult };
    const res = await importBankStatement({ fileName: 'Acct.txt', lines: [line(), line({ lineNo: 2, debit: '0.10', credit: '0.00', balance: '112500.40', reference: null, refHint: 'UTR998877' })] });
    expect(res).toEqual({
      ok: true,
      data: {
        statementId: 's-1', imported: 1, skippedDuplicates: 0, firstDate: '2026-09-01', lastDate: '2026-09-01',
        openingBalance: '100000.00', closingBalance: '112500.50', continuityWarning: false, previousClosingBalance: null,
      },
    });
    const [call] = rpcCalls();
    expect(call).toMatchObject({ rpc: 'import_bank_statement', payload: { p_account_id: BANK, p_source_file: 'Acct.txt' } });
    const lines = (call!.payload as { p_lines: Record<string, unknown>[] }).p_lines;
    expect(lines[0]).toEqual({
      txnDate: '2026-09-01', valueDate: '2026-09-01', narration: 'UPI-RAMESH-PAYMENT', reference: '123456789012',
      debit: '0.00', credit: '12500.50', balance: '112500.50',
    });
    // The ref column is empty, so the token found in the narration is sent as the reference.
    expect(lines[1]).toMatchObject({ reference: 'UTR998877', debit: '0.10' });
    for (const l of lines) for (const k of ['debit', 'credit', 'balance']) expect(typeof l[k]).toBe('string');
    expect(state.revalidated).toEqual(expect.arrayContaining(['/reports/reconcile', '/reports/cash-bank', '/reports/day-book']));
  });

  it('refuses a number where money text belongs, before the database', async () => {
    reset(asAdmin());
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line({ credit: 12500.5 })] })).toEqual({ ok: false, code: 'validation', error: 'field.money_invalid' });
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line({ credit: '12500.5' })] })).toMatchObject({ ok: false, code: 'validation' });
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line({ balance: null })] })).toEqual({ ok: false, code: 'validation', error: 'field.bank_balance_invalid' });
    expect(await importBankStatement({ fileName: 'a.txt', lines: [] })).toEqual({ ok: false, code: 'validation', error: 'field.bank_lines_required' });
    expect(state.calls).toHaveLength(0);
  });

  it('maps a database refusal that names a row to "Row N: …" and a plain sentence', async () => {
    reset(asAdmin());
    state.respond = (c) => answerBankAccount(c) ?? dbError('DN_VALIDATION:balance_chain_broken line=7');
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line()] })).toEqual({ ok: false, code: 'validation', error: 'validation.import_row' });
    state.respond = (c) => answerBankAccount(c) ?? dbError('DN_VALIDATION:too_many_lines');
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line()] })).toEqual({ ok: false, code: 'validation', error: 'validation.import_too_many_lines' });
    state.respond = (c) => answerBankAccount(c) ?? dbError('DN_FORBIDDEN');
    expect(await importBankStatement({ fileName: 'a.txt', lines: [line()] })).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

describe('matching', () => {
  it('matchBankLine matches by hand and says when a deposited cheque can be cleared', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: { line_id: LINE, entry_id: ENTRY, payment_id: PAY, match_status: 'manual', cheque_to_clear: true } });
    expect(await matchBankLine({ lineId: LINE, entryId: ENTRY })).toEqual({ ok: true, data: { chequeToClear: true, paymentId: PAY } });
    expect(rpcCalls()[0]).toMatchObject({ rpc: 'match_bank_line', payload: { p_line_id: LINE, p_entry_id: ENTRY, p_status: 'manual' } });
  });

  it('every match refusal has a friendly sentence', async () => {
    const details = ['amount_mismatch', 'wrong_direction', 'entry_already_matched', 'entry_cancelled', 'entry_not_on_account', 'entry_not_matchable', 'line_not_unmatched', 'line_not_found', 'entry_not_found'];
    for (const d of details) {
      reset(asAdmin());
      state.respond = () => dbError(`DN_VALIDATION:${d}`);
      expect(await matchBankLine({ lineId: LINE, entryId: ENTRY })).toEqual({ ok: false, code: 'validation', error: `validation.${d}` });
    }
  });

  it('auto-match, unmatch and ignore call their functions', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: 3 });
    expect(await autoMatchStatement({ statementId: LINE })).toEqual({ ok: true, data: { matched: 3 } });
    state.respond = () => ({ data: null });
    expect((await unmatchBankLine({ lineId: LINE })).ok).toBe(true);
    expect((await ignoreBankLine({ lineId: LINE, reason: '  own transfer ' })).ok).toBe(true);
    expect(rpcCalls().map((c) => c.rpc)).toEqual(['auto_match_bank_statement', 'unmatch_bank_line', 'ignore_bank_line']);
    expect(rpcCalls()[2]!.payload).toEqual({ p_line_id: LINE, p_reason: 'own transfer' });
    expect(await ignoreBankLine({ lineId: LINE, reason: '   ' })).toEqual({ ok: false, code: 'validation', error: 'field.reason_required' });
  });

  it('matchLineToPayment matches the line to the payment\'s own entry', async () => {
    reset(asAdmin());
    state.respond = (c) => (c.table === 'payments' ? { data: [{ id: PAY, status: 'posted', journal_entry_id: ENTRY }] } : { data: { cheque_to_clear: false } });
    expect(await matchLineToPayment({ lineId: LINE, paymentId: PAY })).toEqual({ ok: true, data: { chequeToClear: false } });
    expect(rpcCalls()[0]).toMatchObject({ rpc: 'match_bank_line', payload: { p_line_id: LINE, p_entry_id: ENTRY, p_status: 'manual' } });
    state.respond = (c) => (c.table === 'payments' ? { data: [{ id: PAY, status: 'draft', journal_entry_id: null }] } : { data: null });
    expect(await matchLineToPayment({ lineId: LINE, paymentId: PAY })).toMatchObject({ ok: false, code: 'not_posted' });
  });
});

describe('bookBankExpense', () => {
  it('is a thin wrapper over post_bank_expense: the line, the ledger and the note go, never a date or an amount', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: { voucher_id: EXPENSE, entry_id: ENTRY, line_id: LINE } });
    expect(await bookBankExpense({ lineId: LINE, accountId: '', note: ' IMPS fee ', amount: '1.00', date: '2020-01-01' })).toEqual({ ok: true, data: { id: EXPENSE, matched: true } });
    expect(state.calls).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({ rpc: 'post_bank_expense', payload: { p_line_id: LINE, p_account_id: null, p_note: 'IMPS fee' } });
    expect(Object.keys(rpcCalls()[0]!.payload as object).sort()).toEqual(['p_account_id', 'p_line_id', 'p_note']);
    expect(state.revalidated).toEqual(expect.arrayContaining(['/reports/reconcile', '/reports/cash-bank']));
  });

  it('passes a chosen ledger through', async () => {
    reset(asAdmin());
    state.respond = () => ({ data: { voucher_id: EXPENSE } });
    await bookBankExpense({ lineId: LINE, accountId: EXPENSE });
    expect(rpcCalls()[0]!.payload).toMatchObject({ p_account_id: EXPENSE, p_note: null });
  });

  it('maps the database refusals to plain sentences', async () => {
    const cases: [string, string, string][] = [
      ['DN_VALIDATION:line_not_unmatched', 'validation', 'validation.line_not_unmatched'],
      ['DN_VALIDATION:line_not_debit', 'validation', 'validation.line_not_debit'],
      ['DN_VALIDATION:invalid_account', 'validation', 'validation.bank_expense_account'],
      ['DN_PERIOD_LOCKED', 'period_locked', 'period_locked'],
    ];
    for (const [message, code, error] of cases) {
      reset(asAdmin());
      state.respond = () => dbError(message);
      expect(await bookBankExpense({ lineId: LINE })).toEqual({ ok: false, code, error });
    }
  });
});
