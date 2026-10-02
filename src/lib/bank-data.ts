import 'server-only';
import { decimalText } from '@/lib/decimal';
import { one, rows } from '@/lib/db';
import type {
  BankLine, BookItem, ExpenseAccountOption, LineStatus, ReconSummary, StatementSummary, Suggestion,
} from '@/lib/bank-types';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

// NUMERIC columns come back as JSON numbers; they are turned into exact text here and never calculated with.
const dec = (v: unknown, dp = 2) => decimalText(v as number | string | null, dp);
const decOrNull = (v: unknown) => (v === null || v === undefined ? null : dec(v));

function toSummary(r: Record<string, unknown>): StatementSummary {
  return {
    id: r.statement_id as string,
    periodFrom: r.period_from as string,
    periodTo: r.period_to as string,
    sourceFile: (r.source_file as string | null) ?? null,
    lineCount: Number(r.line_count ?? 0),
    unmatchedCount: Number(r.unmatched_count ?? 0),
    matchedCount: Number(r.matched_count ?? 0),
    ignoredCount: Number(r.ignored_count ?? 0),
    totalDebit: dec(r.total_debit),
    totalCredit: dec(r.total_credit),
    openingBalance: decOrNull(r.opening_balance),
    closingBalance: decOrNull(r.closing_balance),
  };
}

/** The bank ledger's reconciliation row (as at the latest imported statement), or null when no bank ledger is set up. */
export async function loadRecon(supabase: Supabase): Promise<ReconSummary | null> {
  const res = await supabase
    .from('v_bank_recon')
    .select('bank_balance, book_balance, difference, unmatched_lines, unexplained, explained, statement_id, statement_period_to, opening_difference, book_only_entries, bank_only_lines')
    .limit(1);
  const r = rows<Record<string, unknown>>(res, 'bank recon')[0];
  if (!r) return null;
  return {
    bankBalance: decOrNull(r.bank_balance),
    bookBalance: dec(r.book_balance),
    difference: decOrNull(r.difference),
    unmatchedLines: Number(r.unmatched_lines ?? 0),
    unexplained: decOrNull(r.unexplained),
    openingDifference: decOrNull(r.opening_difference),
    bookOnlyEntries: Number(r.book_only_entries ?? 0),
    bankOnlyLines: Number(r.bank_only_lines ?? 0),
    explained: typeof r.explained === 'boolean' ? r.explained : null,
    statementId: (r.statement_id as string | null) ?? null,
    asAt: (r.statement_period_to as string | null) ?? null,
  };
}

/** Every import, newest first. */
export async function loadStatements(supabase: Supabase): Promise<StatementSummary[]> {
  const res = await supabase
    .from('v_bank_statement_summary')
    .select('statement_id, period_from, period_to, source_file, line_count, unmatched_count, matched_count, ignored_count, total_debit, total_credit, opening_balance, closing_balance')
    .order('period_to', { ascending: false })
    .order('imported_at', { ascending: false })
    .limit(200);
  return rows<Record<string, unknown>>(res, 'bank statements').map(toSummary);
}

export async function loadStatement(supabase: Supabase, id: string): Promise<StatementSummary | null> {
  const res = await supabase
    .from('v_bank_statement_summary')
    .select('statement_id, period_from, period_to, source_file, line_count, unmatched_count, matched_count, ignored_count, total_debit, total_credit, opening_balance, closing_balance')
    .eq('statement_id', id)
    .maybeSingle();
  const r = one<Record<string, unknown>>(res, 'bank statement');
  return r ? toSummary(r) : null;
}

const PAYMENT_CHEQUE_OPEN = new Set(['deposited', 'issued']);

/** All lines of one statement with their status, the best suggestion for each unmatched one, and the cheque state of matched receipts. */
export async function loadStatementLines(supabase: Supabase, statementId: string): Promise<BankLine[]> {
  const [linesRes, suggestRes] = await Promise.all([
    supabase
      .from('bank_statement_lines')
      .select('id, line_no, txn_date, value_date, narration, reference, debit, credit, balance, match_status, ignore_reason, matched_entry_id, matched_payment_id')
      .eq('statement_id', statementId)
      .order('txn_date', { ascending: true })
      .order('line_no', { ascending: true })
      .limit(5000),
    supabase.rpc('suggest_bank_matches', { p_statement_id: statementId }),
  ]);
  const lines = rows<Record<string, unknown>>(linesRes, 'bank lines');
  const suggestions = rows<Record<string, unknown>>(suggestRes, 'bank suggestions');

  // Best first per line already; keep the first.
  const best = new Map<string, Suggestion>();
  for (const s of suggestions) {
    const lineId = s.line_id as string;
    if (best.has(lineId)) continue;
    best.set(lineId, {
      entryId: s.entry_id as string,
      paymentId: (s.payment_id as string | null) ?? null,
      kind: String(s.candidate_kind ?? ''),
      entryNo: s.entry_no === null || s.entry_no === undefined ? null : String(s.entry_no),
      entryDate: s.entry_date as string,
      narration: (s.narration as string | null) ?? null,
      amount: dec(s.amount),
      reason: String(s.reason ?? ''),
    });
  }

  const paymentIds = [...new Set(lines.map((l) => l.matched_payment_id as string | null).filter((x): x is string => !!x))];
  const open = new Set<string>();
  if (paymentIds.length) {
    const payRes = await supabase.from('payments').select('id, cheque_status').in('id', paymentIds);
    for (const p of rows<Record<string, unknown>>(payRes, 'matched payments')) {
      if (PAYMENT_CHEQUE_OPEN.has(String(p.cheque_status))) open.add(p.id as string);
    }
  }

  return lines.map((l) => {
    const raw = String(l.match_status);
    const suggestion = raw === 'unmatched' ? best.get(l.id as string) ?? null : null;
    const status: LineStatus = raw === 'auto' || raw === 'manual' ? 'matched' : raw === 'ignored' ? 'ignored' : suggestion ? 'suggested' : 'unmatched';
    const paymentId = (l.matched_payment_id as string | null) ?? null;
    return {
      id: l.id as string,
      lineNo: l.line_no === null || l.line_no === undefined ? null : Number(l.line_no),
      txnDate: l.txn_date as string,
      valueDate: (l.value_date as string | null) ?? null,
      narration: (l.narration as string | null) ?? '',
      reference: (l.reference as string | null) ?? null,
      debit: dec(l.debit),
      credit: dec(l.credit),
      balance: decOrNull(l.balance),
      status,
      ignoreReason: (l.ignore_reason as string | null) ?? null,
      matchedEntryId: (l.matched_entry_id as string | null) ?? null,
      matchedPaymentId: paymentId,
      chequeToClear: status === 'matched' && !!paymentId && open.has(paymentId),
      suggestion,
    };
  });
}

/** Bank-side entries a line can still be matched to by hand. */
export async function loadFreeBookItems(supabase: Supabase): Promise<BookItem[]> {
  const res = await supabase
    .from('v_bank_book_items')
    .select('entry_id, entry_no, entry_date, narration, source_type, direction, amount, instrument_no')
    .eq('matchable', true)
    .is('matched_line_id', null)
    .order('entry_date', { ascending: false })
    .limit(500);
  return rows<Record<string, unknown>>(res, 'bank book items').map((r) => ({
    entryId: r.entry_id as string,
    entryNo: r.entry_no === null || r.entry_no === undefined ? null : String(r.entry_no),
    entryDate: r.entry_date as string,
    narration: (r.narration as string | null) ?? null,
    sourceType: String(r.source_type ?? ''),
    direction: r.direction === 'in' ? 'in' : 'out',
    amount: dec(r.amount),
    instrumentNo: (r.instrument_no as string | null) ?? null,
  }));
}

/** Expense ledgers an unmatched debit can be booked to, with Bank Charges marked as the default. */
export async function loadExpenseAccounts(supabase: Supabase): Promise<ExpenseAccountOption[]> {
  const res = await supabase
    .from('accounts')
    .select('id, code, name, system_key')
    .eq('type', 'expense')
    .eq('is_group', false)
    .eq('is_control', false)
    .order('code');
  // Ledgers the posting engine owns are refused by post_bank_expense; do not offer them. Filtered here, not in SQL,
  // because `not in` would also drop the ledgers with no system key.
  const engineOwned = new Set(['cogs', 'round_off', 'stock_loss', 'cash_over_short', 'discount_allowed', 'salaries']);
  return rows<Record<string, unknown>>(res, 'expense accounts')
    .filter((a) => !engineOwned.has(String(a.system_key ?? '')))
    .map((a) => ({ id: a.id as string, name: a.name as string, isBankCharges: a.system_key === 'bank_charges' }));
}

/** The line a "record from this bank line" link points at: only an owner's unmatched line is returned. */
export async function loadOpenLine(supabase: Supabase, lineId: string) {
  const res = await supabase
    .from('bank_statement_lines')
    .select('id, statement_id, txn_date, narration, reference, debit, credit, match_status')
    .eq('id', lineId)
    .maybeSingle();
  const l = one<Record<string, unknown>>(res, 'bank line');
  if (!l || l.match_status !== 'unmatched') return null;
  return {
    id: l.id as string,
    statementId: l.statement_id as string,
    txnDate: l.txn_date as string,
    narration: ((l.narration as string | null) ?? '').trim(),
    reference: (l.reference as string | null) ?? null,
    debit: dec(l.debit),
    credit: dec(l.credit),
  };
}
