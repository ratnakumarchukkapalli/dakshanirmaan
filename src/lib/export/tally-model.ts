import 'server-only';
import { loadTrialBalance, type TrialBalance } from '@/lib/books-data';
import { decimalString, fromScaled, toScaled } from './decimal';
import { Lookups, type AccountRow, type PartyRow } from './lookups';
import { journalEntriesSpec, type EntryRow } from './books-tables';
import { readPaged, type PagedSpec } from './paged';
import { dayBefore, NameRegistry, narrationText, tallyDate } from './tally-xml';
import type { ExportContext } from './types';

// Turns the books of one financial year into the content of the two Tally files (change 25, part B):
// the ledger masters, and the vouchers. Rules are those of docs/research/tally-xml-format.md. The model
// is built in memory (a year is a few thousand vouchers) and checked completely BEFORE the first byte of
// either file is sent, so a voucher that does not balance aborts the export instead of leaving half a file.

type Ctx = Pick<ExportContext, 'supabase' | 'asOf' | 'fy'>;

export type VoucherType = 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note' | 'Receipt' | 'Payment' | 'Contra' | 'Journal';

export interface TallyLedger {
  name: string;
  parent: string;
  /** Tally already owns this ledger (Cash); its name is used in vouchers but no master is written. */
  skipMaster: boolean;
}

export interface TallyLine {
  ledger: string;
  side: 'debit' | 'credit';
  /** Paise, positive. */
  amount: bigint;
}

export interface TallyVoucher {
  remoteId: string;
  type: VoucherType;
  number: string;
  /** YYYYMMDD */
  date: string;
  narration: string;
  /** Set for Sales / Purchase / Credit Note / Debit Note / Receipt / Payment when a customer or supplier is on the voucher. */
  partyLedger: string | null;
  lines: TallyLine[];
}

export interface TallyModel {
  ledgers: TallyLedger[];
  /** The opening voucher (when there is one) first, then the year's entries in entry order. */
  vouchers: TallyVoucher[];
  stats: { entries: number; lines: number; openingLines: number; hasOpeningVoucher: boolean };
}

/** The export cannot be produced as asked: an entry that does not balance, or data the mapping cannot place. Carries a plain message. */
export class TallyExportError extends Error {
  constructor(message: string, public readonly kind: 'unbalanced' | 'data') {
    super(message);
    this.name = 'TallyExportError';
  }
}

// ---------------------------------------------------------------------------------------------
// Ledgers and their parent groups (Tally's default group names, research section 4)
// ---------------------------------------------------------------------------------------------

const GROUP_BY_KEY: Record<string, string> = {
  cash: 'Cash-in-Hand', bank: 'Bank Accounts', cheques_in_hand: 'Current Assets', ar: 'Sundry Debtors', ap: 'Sundry Creditors',
  // Not Stock-in-Hand: when a Tally company has accounts integrated with inventory it may refuse ledgers of that
  // group in plain accounting vouchers, which would reject almost every Sales and Purchase voucher (research §8, open question).
  inventory: 'Current Assets', goods_in_transit: 'Current Assets',
  input_cgst: 'Duties & Taxes', input_sgst: 'Duties & Taxes', input_igst: 'Duties & Taxes',
  output_cgst: 'Duties & Taxes', output_sgst: 'Duties & Taxes', output_igst: 'Duties & Taxes', rcm_payable: 'Duties & Taxes',
  salary_payable: 'Current Liabilities', employee_advance: 'Loans & Advances (Asset)', rebate_receivable: 'Current Assets',
  opening_balance_equity: 'Capital Account',
  cogs: 'Direct Expenses', freight_inward: 'Direct Expenses', loading_unloading: 'Direct Expenses',
};
const GROUP_BY_CODE: Record<string, string> = {
  '2500': 'Duties & Taxes', '2600': 'Loans (Liability)',
  '4100': 'Sales Accounts', '4200': 'Sales Accounts', '4300': 'Sales Accounts',
};
const GROUP_BY_TYPE: Record<string, string> = {
  asset: 'Current Assets', liability: 'Current Liabilities', equity: 'Capital Account', income: 'Indirect Incomes', expense: 'Indirect Expenses',
};

export function accountGroup(a: Pick<AccountRow, 'code' | 'type' | 'system_key'>): string {
  return (a.system_key && GROUP_BY_KEY[a.system_key]) || GROUP_BY_CODE[a.code] || GROUP_BY_TYPE[a.type] || 'Suspense A/c';
}

export function partyGroup(p: Pick<PartyRow, 'type'>): string {
  if (p.type === 'supplier') return 'Sundry Creditors';
  if (p.type === 'employee') return 'Current Liabilities';
  return 'Sundry Debtors'; // customer, and "both" (one ledger cannot sit in two groups)
}

/** Ledgers Tally creates in every company; a party or account of the same name is renamed, not duplicated. */
const TALLY_RESERVED = [
  'Profit & Loss A/c', 'Primary',
  // Tally's default group names (research §4): a ledger and a group of the same name clash in Tally.
  'Capital Account', 'Reserves & Surplus', 'Loans (Liability)', 'Secured Loans', 'Unsecured Loans', 'Bank OD A/c', 'Bank OCC A/c', 'Current Liabilities',
  'Duties & Taxes', 'Provisions', 'Sundry Creditors', 'Suspense A/c', 'Branch / Divisions', 'Fixed Assets', 'Investments', 'Current Assets', 'Bank Accounts',
  'Cash-in-Hand', 'Deposits (Asset)', 'Loans & Advances (Asset)', 'Stock-in-Hand', 'Sundry Debtors', 'Misc. Expenses (ASSET)', 'Sales Accounts',
  'Direct Incomes', 'Indirect Incomes', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses',
];
/** Prior years' profit, netted into one ledger so the opening voucher balances. */
export const BROUGHT_FORWARD_LEDGER = 'Profit and Loss brought forward';
const BROUGHT_FORWARD_GROUP = 'Reserves & Surplus';

interface Names {
  ledgers: TallyLedger[];
  account: Map<string, string>;
  party: Map<string, string>;
  broughtForward: string;
}

function nameLedgers(accounts: AccountRow[], parties: PartyRow[]): Names {
  const registry = new NameRegistry(TALLY_RESERVED);
  const ledgers: TallyLedger[] = [];
  const account = new Map<string, string>();
  const party = new Map<string, string>();
  // The synthetic ledger first: its name is fixed, everything else adapts around it.
  const broughtForward = registry.assign(BROUGHT_FORWARD_LEDGER);
  ledgers.push({ name: broughtForward, parent: BROUGHT_FORWARD_GROUP, skipMaster: false });
  // Accounts by code, then parties by when they were created: adding a party later never renames another.
  for (const a of [...accounts].filter((x) => !x.is_group).sort((x, y) => x.code.localeCompare(y.code) || x.id.localeCompare(y.id))) {
    const name = registry.assign(a.name, `Account ${a.code}`);
    account.set(a.id, name);
    ledgers.push({ name, parent: accountGroup(a), skipMaster: a.system_key === 'cash' });
  }
  for (const p of [...parties].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))) {
    const name = registry.assign(p.name, 'Party');
    party.set(p.id, name);
    ledgers.push({ name, parent: partyGroup(p), skipMaster: false });
  }
  return { ledgers, account, party, broughtForward };
}

// ---------------------------------------------------------------------------------------------
// Voucher types (research section 3)
// ---------------------------------------------------------------------------------------------

const BY_SOURCE: Record<string, VoucherType> = { sales_invoice: 'Sales', purchase_invoice: 'Purchase', credit_note: 'Credit Note', debit_note: 'Debit Note' };

/**
 * Sales / Purchase / Credit Note / Debit Note by the document the entry came from; otherwise Receipt,
 * Payment or Contra whenever a Cash or Bank ledger is on the entry (Tally's own Journal does not take
 * them); otherwise Journal. A reversal is never a Sales voucher with its signs turned round: it is
 * typed by its lines like any other entry. The go-live opening entry is always a Journal.
 */
export function voucherTypeFor(sourceType: string, isReversal: boolean, lines: { money: boolean; side: 'debit' | 'credit'; amount: bigint }[]): VoucherType {
  if (sourceType === 'opening') return 'Journal';
  const bySource = BY_SOURCE[sourceType];
  if (bySource && !isReversal) return bySource;
  const money = lines.filter((l) => l.money);
  if (money.length === 0) return 'Journal';
  if (money.length === lines.length) return 'Contra';
  const net = money.reduce((n, l) => n + (l.side === 'debit' ? l.amount : -l.amount), 0n);
  if (net > 0n) return 'Receipt';
  if (net < 0n) return 'Payment';
  return 'Journal';
}

// ---------------------------------------------------------------------------------------------
// Building the model
// ---------------------------------------------------------------------------------------------

const PARTY_VOUCHERS: ReadonlySet<VoucherType> = new Set(['Sales', 'Purchase', 'Credit Note', 'Debit Note', 'Receipt', 'Payment']);

const money2 = (v: unknown) => decimalString(v as string | number | null | undefined, 2) ?? '0.00';

/** Ids of entries that reverse another entry, from any year (a reversal in this year of an entry from last year is still a reversal). */
async function readReversalIds(ctx: Ctx): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const r of readPaged<{ reversed_by: string }>(ctx, {
    from: 'journal_entries', select: 'id, reversed_by', order: ['id'], filter: (q) => q.not('reversed_by', 'is', null),
  })) out.add(r.reversed_by);
  return out;
}

/** Signed paise (debit positive) per control account and party, for entries up to `to`. */
async function partyBalances(ctx: Ctx, to: string): Promise<Map<string, Map<string, bigint>>> {
  const spec: PagedSpec = {
    from: 'journal_lines',
    select: 'id, account_id, party_id, debit::text, credit::text, journal_entries!inner(entry_date, status)',
    order: ['id'], dateColumn: 'journal_entries.entry_date', range: { to },
    filter: (q) => q.not('party_id', 'is', null).eq('journal_entries.status', 'posted'),
  };
  const out = new Map<string, Map<string, bigint>>();
  for await (const l of readPaged<{ account_id: string; party_id: string; debit: string; credit: string }>(ctx, spec)) {
    const byParty = out.get(l.account_id) ?? new Map<string, bigint>();
    byParty.set(l.party_id, (byParty.get(l.party_id) ?? 0n) + toScaled(money2(l.debit), 2) - toScaled(money2(l.credit), 2));
    out.set(l.account_id, byParty);
  }
  return out;
}

const lineOf = (ledger: string, signed: bigint): TallyLine => ({ ledger, side: signed > 0n ? 'debit' : 'credit', amount: signed > 0n ? signed : -signed });

/** What the lines were built from, kept so the finished vouchers can be checked against the trial balance (debit positive, paise). */
interface Tracking {
  /** Per account code: the year's entries. */
  year: Map<string, bigint>;
  /** Per account code: the balance carried into the opening voucher. */
  opening: Map<string, bigint>;
  /** Per ledger name: everything that went into it, before lines were merged. */
  ledger: Map<string, bigint>;
}
const bump = (m: Map<string, bigint>, key: string, by: bigint) => m.set(key, (m.get(key) ?? 0n) + by);

type TrialRows = Awaited<ReturnType<typeof loadTrialBalance>>['rows'];

/**
 * The opening voucher: the balance-sheet balances carried into the year, as one Journal dated on the
 * first day. Control accounts (receivables, payables, employee advances ...) are split by party so
 * each party's ledger opens with its own balance; a party with balances on two control accounts
 * appears once, netted. Prior years' profit and loss is netted into one reserves ledger, which is what
 * makes the voucher balance. null when nothing was carried in (the very first year: the go-live
 * opening entry is then an ordinary voucher of the year).
 */
async function openingVoucher(ctx: Ctx, before: TrialRows, accounts: AccountRow[], names: Names, track: Tracking): Promise<TallyVoucher | null> {
  if (before.length === 0) return null;
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const balances = await partyBalances(ctx, dayBefore(ctx.fy.from));

  const lines: TallyLine[] = [];
  let carried = 0n; // balance sheet closings, debit positive
  let profitAndLoss = 0n; // income and expense closings, debit positive
  for (const row of before) {
    const account = byCode.get(row.code);
    if (!account) throw new TallyExportError(`The trial balance names an account (${row.code}) that is not in the chart of accounts.`, 'data');
    const closing = toScaled(row.debit, 2) - toScaled(row.credit, 2);
    if (closing === 0n) continue;
    if (account.type === 'income' || account.type === 'expense') {
      profitAndLoss += closing;
      continue;
    }
    carried += closing;
    bump(track.opening, row.code, closing);
    const accountLedger = names.account.get(account.id);
    if (!accountLedger) throw new TallyExportError(`Account ${row.code} has no ledger.`, 'data');
    let rest = closing;
    if (account.is_control) {
      const parties = [...(balances.get(account.id) ?? new Map<string, bigint>())].sort((a, b) => (names.party.get(a[0]) ?? '').localeCompare(names.party.get(b[0]) ?? ''));
      for (const [partyId, amount] of parties) {
        if (amount === 0n) continue;
        const ledger = names.party.get(partyId);
        if (!ledger) throw new TallyExportError(`A party on account ${row.code} is not in the party list.`, 'data');
        lines.push(lineOf(ledger, amount));
        bump(track.ledger, ledger, amount);
        rest -= amount;
      }
    }
    if (rest !== 0n) {
      lines.push(lineOf(accountLedger, rest));
      bump(track.ledger, accountLedger, rest);
    }
  }
  if (carried + profitAndLoss !== 0n) {
    throw new TallyExportError(`The trial balance before ${ctx.fy.from} does not balance (debits and credits differ by ${fromScaled(carried + profitAndLoss, 2)}), so the opening balances cannot be exported.`, 'unbalanced');
  }
  if (carried !== 0n) {
    lines.push(lineOf(names.broughtForward, -carried));
    bump(track.ledger, names.broughtForward, -carried);
  }
  if (lines.length === 0) return null;
  return {
    remoteId: `dn-opening-${ctx.fy.startYear}`,
    type: 'Journal', number: 'OPENING', date: tallyDate(ctx.fy.from), narration: narrationText('Opening balances brought forward'), partyLedger: null, lines: netByLedger(lines),
  };
}

/** One line per ledger, netted: a party with a receivable on one account and a payable on another opens with a single balance. */
function netByLedger(lines: TallyLine[]): TallyLine[] {
  const net = new Map<string, bigint>();
  for (const l of lines) bump(net, l.ledger, l.side === 'debit' ? l.amount : -l.amount);
  return [...net].filter(([, v]) => v !== 0n).map(([ledger, v]) => lineOf(ledger, v));
}

/** Merges lines on the same ledger and side (a ledger appearing twice on one side is one line in Tally). */
function mergeLines(lines: TallyLine[]): TallyLine[] {
  const merged = new Map<string, TallyLine>();
  for (const l of lines) {
    const key = `${l.side}|${l.ledger}`;
    const have = merged.get(key);
    if (have) have.amount += l.amount;
    else merged.set(key, { ...l });
  }
  return [...merged.values()];
}

/**
 * The self-check of the finished vouchers, against the app's own trial balance (`trial_balance_asat`, a
 * different code path from the journal lines the vouchers were made from). Two things must hold:
 *  1. every ledger's total in the emitted vouchers equals what went into it (nothing lost or doubled by the
 *     merging and netting of lines);
 *  2. for every account, the year's entries equal the trial balance at the year end minus the day before
 *     (so, with the opening voucher, balance-sheet accounts end where the trial balance says and
 *     profit-and-loss accounts show exactly the year's movement).
 * A mismatch refuses the export, naming the account.
 */
function verifyAgainstTrialBalance(ctx: Ctx, vouchers: TallyVoucher[], track: Tracking, before: TrialRows, end: TrialRows, accounts: AccountRow[]): void {
  const emitted = new Map<string, bigint>();
  for (const v of vouchers) for (const l of v.lines) bump(emitted, l.ledger, l.side === 'debit' ? l.amount : -l.amount);
  for (const key of new Set([...emitted.keys(), ...track.ledger.keys()])) {
    if ((emitted.get(key) ?? 0n) !== (track.ledger.get(key) ?? 0n)) {
      throw new TallyExportError(`The ledger "${key}" does not add up in the Tally vouchers (${fromScaled(emitted.get(key) ?? 0n, 2)} against ${fromScaled(track.ledger.get(key) ?? 0n, 2)} in the books). Nothing was exported.`, 'unbalanced');
    }
  }
  const closing = (rows: TrialRows) => new Map(rows.map((r) => [r.code, toScaled(r.debit, 2) - toScaled(r.credit, 2)] as const));
  const b = closing(before);
  const e = closing(end);
  const names = new Map(accounts.map((a) => [a.code, a.name]));
  const retry = 'If entries were being posted while the export ran, try again; otherwise tell the person who keeps the books.';
  for (const code of new Set([...track.year.keys(), ...e.keys(), ...b.keys()])) {
    const want = (e.get(code) ?? 0n) - (b.get(code) ?? 0n);
    const got = track.year.get(code) ?? 0n;
    if (got !== want) {
      throw new TallyExportError(`Account ${code} ${names.get(code) ?? ''}: the year's entries come to ${fromScaled(got, 2)} (debit positive) but the trial balance moved by ${fromScaled(want, 2)} between ${ctx.fy.from} and ${ctx.fy.to}. Nothing was exported. ${retry}`.replace('  ', ' '), 'unbalanced');
    }
  }
}

export async function buildTallyModel(ctx: Ctx, trialEnd: TrialBalance): Promise<TallyModel> {
  const track: Tracking = { year: new Map(), opening: new Map(), ledger: new Map() };
  const lk = new Lookups(ctx);
  const [accountRows, partyRows, accountById, docs] = await Promise.all([lk.accountRows(), lk.partyRows(), lk.accounts(), lk.docNumbers()]);
  const names = nameLedgers(accountRows, partyRows);
  const reversalIds = await readReversalIds(ctx);

  const vouchers: TallyVoucher[] = [];
  const trialBefore = await loadTrialBalance(ctx.supabase, dayBefore(ctx.fy.from));
  const opening = await openingVoucher(ctx, trialBefore.rows, accountRows, names, track);
  if (opening) vouchers.push(opening);
  const openingLines = opening?.lines.length ?? 0;

  // Voucher numbers are unique within a voucher type: a cancelled document and its reversal, or a
  // cheque's posting and its clearing, share one document number but must not share a Tally number.
  const usedNumbers = new Set<string>();
  const unique = (type: string, number: string): string => {
    let candidate = number;
    for (let n = 2; usedNumbers.has(`${type}|${candidate}`); n += 1) candidate = `${number}/${n}`;
    usedNumbers.add(`${type}|${candidate}`);
    return candidate;
  };
  if (opening) usedNumbers.add(`Journal|${opening.number}`);

  const spec: PagedSpec = { ...journalEntriesSpec(ctx), filter: (q) => q.eq('status', 'posted') };
  let entries = 0;
  let lineCount = 0;
  for await (const e of readPaged<EntryRow>(ctx, spec)) {
    entries += 1;
    const docNo = (e.source_id && docs.get(`${e.source_type}:${e.source_id}`)) || null;
    const label = docNo ? `${docNo} (entry ${e.entry_no})` : `entry ${e.entry_no}`;
    const isReversal = reversalIds.has(e.id);
    const raw = [...e.journal_lines].sort((a, b) => a.line_no - b.line_no);
    if (raw.length < 2) throw new TallyExportError(`Journal ${label} dated ${e.entry_date} has fewer than two lines, so it cannot be a voucher.`, 'unbalanced');

    let dr = 0n;
    let cr = 0n;
    const typed: { money: boolean; side: 'debit' | 'credit'; amount: bigint }[] = [];
    const lines: TallyLine[] = [];
    const partyLedgers: string[] = [];
    for (const l of raw) {
      const account = accountById.get(l.account_id);
      if (!account) throw new TallyExportError(`Journal ${label} uses an account that is not in the chart of accounts.`, 'data');
      const debit = toScaled(money2(l.debit), 2);
      const credit = toScaled(money2(l.credit), 2);
      if ((debit > 0n) === (credit > 0n)) throw new TallyExportError(`Journal ${label} has a line with both or neither of debit and credit.`, 'data');
      const side = debit > 0n ? 'debit' : 'credit';
      const amount = debit > 0n ? debit : credit;
      if (side === 'debit') dr += amount; else cr += amount;
      const onParty = l.party_id !== null && account.is_control;
      const ledger = onParty ? names.party.get(l.party_id as string) : names.account.get(account.id);
      if (!ledger) throw new TallyExportError(`Journal ${label} uses a ${onParty ? 'party' : 'account'} that has no ledger.`, 'data');
      if (onParty && !partyLedgers.includes(ledger)) partyLedgers.push(ledger);
      lines.push({ ledger, side, amount });
      bump(track.year, account.code, side === 'debit' ? amount : -amount);
      bump(track.ledger, ledger, side === 'debit' ? amount : -amount);
      typed.push({ money: account.is_money, side, amount });
    }
    if (dr !== cr) {
      throw new TallyExportError(`Journal ${label} dated ${e.entry_date} does not balance: debits ${fromScaled(dr, 2)}, credits ${fromScaled(cr, 2)}. Nothing was exported; fix or reverse the entry first.`, 'unbalanced');
    }

    const type = voucherTypeFor(e.source_type, isReversal, typed);
    const base = docNo ?? `JE-${e.entry_no}`;
    const flag = isReversal ? '[Reversal entry]' : e.reversed_by !== null ? '[Reversed later]' : '';
    const merged = mergeLines(lines);
    lineCount += merged.length;
    vouchers.push({
      remoteId: `dn-je-${e.id}`,
      type,
      number: unique(type, isReversal ? `${base}/REV` : base),
      date: tallyDate(e.entry_date),
      // The document number leads (Tally discards VOUCHERNUMBER under automatic numbering) and the flag follows it, so a long narration is what gets cut.
      narration: narrationText([[docNo, flag].filter(Boolean).join(' '), e.narration].filter(Boolean).join(' - ')),
      partyLedger: PARTY_VOUCHERS.has(type) ? (partyLedgers[0] ?? null) : null,
      lines: merged,
    });
  }

  verifyAgainstTrialBalance(ctx, vouchers, track, trialBefore.rows, trialEnd.rows, accountRows);
  return { ledgers: names.ledgers, vouchers, stats: { entries, lines: lineCount, openingLines, hasOpeningVoucher: opening !== null } };
}
