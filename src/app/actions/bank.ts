'use server';

import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { dbFailure, zodFailure } from '@/lib/action-errors';
import { fail, ok, parseDbError, type ActionResult, type Failure } from '@/lib/action-result';
import { requireAdminMember } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import {
  bankLineIdSchema, bookBankExpenseSchema, ignoreBankLineSchema, importBankStatementSchema, matchBankLineSchema,
  matchLineToPaymentSchema, statementIdSchema,
} from '@/schemas/bank';

// Bank statement import and matching. Owner only (aal2): every function behind these actions refuses anyone
// else on its own. Nothing here posts from a statement line on its own and nothing works out money: an
// imported line is just recorded, a match only links a line to an entry that already exists, and the one
// place a new entry is made (`bookBankExpense`) goes through `post_expense_voucher`.

type Supabase = Awaited<ReturnType<typeof createClient>>;

const bad = async (detail: string): Promise<Failure> => fail('validation', (await getTranslations('errors'))(`validation.${detail}`));

function revalidateBank() {
  revalidatePath('/reports/reconcile');
  revalidatePath('/reports/cash-bank');
  revalidatePath('/reports/day-book');
}

/**
 * A failure from `import_bank_statement`. Its details get import-specific sentences (`validation.import_<detail>`,
 * because words like "future_date" mean something else elsewhere), and an error that names a row ("line=N")
 * says "Row N: …" in front.
 */
async function importFailure(error: { message?: string; code?: string }): Promise<Failure> {
  const t = await getTranslations('errors');
  const { code, detail } = parseDbError(error.message, error.code);
  const key = `validation.import_${detail}`;
  if (code !== 'validation' || !detail || !t.has(key)) return dbFailure(error);
  const row = /line=(\d+)/.exec(error.message ?? '');
  return fail('validation', row ? t('validation.import_row', { n: Number(row[1]), message: t(key) }) : t(key));
}

async function bankAccountId(supabase: Supabase): Promise<{ id: string } | { error: Failure }> {
  const { data, error } = await supabase.from('accounts').select('id, is_money').eq('system_key', 'bank').maybeSingle();
  if (error) return { error: await dbFailure(error) };
  if (!data?.id) return { error: await bad('missing_account') };
  return { id: data.id as string };
}

export type ImportResult = {
  statementId: string | null;
  imported: number;
  skippedDuplicates: number;
  firstDate: string;
  lastDate: string;
  openingBalance: string;
  closingBalance: string;
  continuityWarning: boolean;
  previousClosingBalance: string | null;
};

/**
 * Imports the lines the owner previewed in the browser (the file itself is never sent or stored). Money stays
 * text from the parser to the database; the database checks every row, the running balance and what was
 * imported before, and skips rows it already holds.
 */
export async function importBankStatement(input: unknown): Promise<ActionResult<ImportResult>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = importBankStatementSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const account = await bankAccountId(supabase);
  if ('error' in account) return account.error;

  const { data, error } = await supabase.rpc('import_bank_statement', {
    p_account_id: account.id,
    p_source_file: v.fileName,
    p_lines: v.lines.map((l) => ({
      txnDate: l.txnDate, valueDate: l.valueDate, narration: l.narration, reference: l.reference ?? l.refHint ?? null,
      debit: l.debit, credit: l.credit, balance: l.balance,
    })),
  });
  if (error) return importFailure(error);

  const r = (data ?? {}) as Record<string, unknown>;
  revalidateBank();
  return ok({
    statementId: (r.statement_id as string | null) ?? null,
    imported: Number(r.imported ?? 0),
    skippedDuplicates: Number(r.skipped_duplicates ?? 0),
    firstDate: String(r.first_date ?? ''),
    lastDate: String(r.last_date ?? ''),
    openingBalance: String(r.opening_balance ?? ''),
    closingBalance: String(r.closing_balance ?? ''),
    continuityWarning: r.continuity_warning === true,
    previousClosingBalance: r.previous_closing_balance == null ? null : String(r.previous_closing_balance),
  });
}

/** Matches every line that has exactly one clear candidate. Returns how many it matched; creates nothing. */
export async function autoMatchStatement(input: unknown): Promise<ActionResult<{ matched: number }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = statementIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('auto_match_bank_statement', { p_statement_id: parsed.data.statementId });
  if (error) return dbFailure(error);

  revalidateBank();
  return ok({ matched: Number(data ?? 0) });
}

/** Links a line to a book entry by hand. `chequeToClear` says the entry is a deposited cheque the owner may now mark cleared. */
export async function matchBankLine(input: unknown): Promise<ActionResult<{ chequeToClear: boolean; paymentId: string | null }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = matchBankLineSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('match_bank_line', {
    p_line_id: parsed.data.lineId, p_entry_id: parsed.data.entryId, p_status: 'manual',
  });
  if (error) return dbFailure(error);

  const r = (data ?? {}) as Record<string, unknown>;
  revalidateBank();
  return ok({ chequeToClear: r.cheque_to_clear === true, paymentId: (r.payment_id as string | null) ?? null });
}

/** Undoes a match, or an "ignored" mark. */
export async function unmatchBankLine(input: unknown): Promise<ActionResult<{ lineId: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = bankLineIdSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('unmatch_bank_line', { p_line_id: parsed.data.lineId });
  if (error) return dbFailure(error);

  revalidateBank();
  return ok({ lineId: parsed.data.lineId });
}

/** Sets a line aside with a reason (own-account transfers, a bounced cheque's pair). The reason is kept. */
export async function ignoreBankLine(input: unknown): Promise<ActionResult<{ lineId: string }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = ignoreBankLineSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { error } = await supabase.rpc('ignore_bank_line', { p_line_id: parsed.data.lineId, p_reason: parsed.data.reason });
  if (error) return dbFailure(error);

  revalidateBank();
  return ok({ lineId: parsed.data.lineId });
}

/** After a receipt or payment was posted from a line: links the line to that payment's book entry. */
export async function matchLineToPayment(input: unknown): Promise<ActionResult<{ chequeToClear: boolean }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = matchLineToPaymentSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);

  const supabase = await createClient();
  const { data: payment, error: payError } = await supabase.from('payments').select('id, status, journal_entry_id').eq('id', parsed.data.paymentId).maybeSingle();
  if (payError) return dbFailure(payError);
  if (!payment) return bad('no_such_payment');
  if (payment.status !== 'posted' || !payment.journal_entry_id) return fail('not_posted', (await getTranslations('errors'))('not_posted'));

  const { data, error } = await supabase.rpc('match_bank_line', {
    p_line_id: parsed.data.lineId, p_entry_id: payment.journal_entry_id, p_status: 'manual',
  });
  if (error) return dbFailure(error);

  revalidateBank();
  return ok({ chequeToClear: ((data ?? {}) as Record<string, unknown>).cheque_to_clear === true });
}

/**
 * Books an unmatched bank DEBIT nobody recorded (a bank charge, a fee) as an expense paid from the bank and links
 * the line to it, in one database call: `post_bank_expense` makes the voucher, posts it and matches the line in a
 * single transaction (all or nothing), takes the date and amount from the stored line, defaults to Bank Charges
 * with no GST split, and refuses a second call on the same line. Nothing about the money is sent from here.
 */
export async function bookBankExpense(input: unknown): Promise<ActionResult<{ id: string; matched: boolean }>> {
  const gate = await requireAdminMember();
  if (gate.denied) return gate.denied;
  const parsed = bookBankExpenseSchema.safeParse(input);
  if (!parsed.success) return zodFailure(parsed.error);
  const v = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('post_bank_expense', {
    p_line_id: v.lineId, p_account_id: v.accountId ?? null, p_note: v.note ?? null,
  });
  // "invalid_account" elsewhere means the cash/bank account; here it is the expense ledger that was chosen.
  if (error) return parseDbError(error.message, error.code).detail === 'invalid_account' ? bad('bank_expense_account') : dbFailure(error);

  revalidateBank();
  revalidatePath('/');
  return ok({ id: String(((data ?? {}) as Record<string, unknown>).voucher_id ?? ''), matched: true });
}
