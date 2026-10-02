import { fromScaled, toScaled, decimalString } from './decimal';
import { readPaged, type PagedSpec } from './paged';
import type { ExportContext } from './types';
import type { Lookups } from './lookups';

// Receivables ageing as at the last day of a financial year, for the archive's PDF. The ageing screen
// reads a view that is always "as of today"; a year-end report cannot, so this one is built from the
// ledger itself: every posted line on the receivables account that names a party, up to the year end.
// Each party's receipts and credit notes (credits) are matched against the oldest debits first (FIFO);
// what is left of the debits is aged from the entry date; credits left over are "on account". The
// total per party is therefore exactly the party's ledger balance, and the grand total is exactly the
// receivables line of the trial balance (a difference, if any, is lines with no party, and is shown).
// A document that was cancelled and its reversing entry (both on or before the year end) are taken out
// before matching, so a cancelled invoice never uses up a real invoice's balance. A credit note is
// matched to the invoice it was raised against when there is one, then FIFO for any rest.
// This is a ledger-based ageing: it does not follow which invoice a receipt was allocated to.

type Ctx = Pick<ExportContext, 'supabase' | 'asOf' | 'fy'>;

export interface AgeingLine { party: string; b0_30: string; b31_60: string; b61_90: string; b90_plus: string; onAccount: string; net: string }
export interface AgeingAsAt {
  rows: AgeingLine[];
  totals: Omit<AgeingLine, 'party'>;
  /** Receivables account balance in the books, debit positive, and the part of it no party owns. */
  control: string | null;
  withoutParty: string | null;
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export interface Event {
  date: string; entryNo: number; signed: bigint;
  /** `sales_invoice:<id>` of the document a debit came from. */
  key?: string;
  /** For a credit note: the `sales_invoice:<id>` it was raised against. */
  against?: string;
}

/** FIFO match of one party's events (oldest first). Returns buckets (paise) and the unmatched credit. */
export function ageParty(events: Event[], asAt: string): { buckets: [bigint, bigint, bigint, bigint]; onAccount: bigint } {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || a.entryNo - b.entryNo);
  const open: { date: string; rem: bigint; key: string | undefined }[] = [];
  let surplus = 0n;
  for (const e of sorted) {
    if (e.signed > 0n) {
      let amount = e.signed;
      const used = amount < surplus ? amount : surplus;
      surplus -= used;
      amount -= used;
      if (amount > 0n) open.push({ date: e.date, rem: amount, key: e.key });
    } else {
      let credit = -e.signed;
      const target = e.against ? open.find((o) => o.key === e.against) : undefined;
      if (target) {
        const used = credit < target.rem ? credit : target.rem;
        target.rem -= used;
        credit -= used;
        if (target.rem === 0n) open.splice(open.indexOf(target), 1);
      }
      while (credit > 0n && open.length > 0) {
        const head = open[0]!;
        const used = credit < head.rem ? credit : head.rem;
        head.rem -= used;
        credit -= used;
        if (head.rem === 0n) open.shift();
      }
      surplus += credit;
    }
  }
  const buckets: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
  for (const o of open) {
    const age = daysBetween(o.date, asAt);
    buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += o.rem;
  }
  return { buckets, onAccount: surplus };
}

export async function loadAgeingAsAt(ctx: Ctx, lk: Lookups, trialBalanceClosing: (accountCode: string) => bigint): Promise<AgeingAsAt> {
  const accounts = await lk.accountRows();
  const ar = accounts.find((a) => a.system_key === 'ar');
  const parties = await lk.parties();
  const events = new Map<string, Event[]>();
  if (ar) {
    const spec: PagedSpec = {
      from: 'journal_lines',
      select: 'id, party_id, debit::text, credit::text, journal_entries!inner(id, entry_date, entry_no, status, source_type, source_id, reversed_by)',
      order: ['id'], dateColumn: 'journal_entries.entry_date', range: { to: ctx.fy.to },
      filter: (q) => q.eq('account_id', ar.id).not('party_id', 'is', null).eq('journal_entries.status', 'posted'),
    };
    // Credit notes that name the invoice they correct.
    const against = new Map<string, string>();
    for await (const c of readPaged<{ id: string; against_invoice_id: string | null }>(ctx, {
      from: 'credit_notes', select: 'id, against_invoice_id', order: ['id'], filter: (q) => q.not('against_invoice_id', 'is', null),
    })) if (c.against_invoice_id) against.set(c.id, `sales_invoice:${c.against_invoice_id}`);

    type Line = { party_id: string; debit: string; credit: string; journal_entries: { id: string; entry_date: string; entry_no: number; source_type: string; source_id: string | null; reversed_by: string | null } };
    const all: Line[] = [];
    for await (const l of readPaged<Line>(ctx, spec)) all.push(l);
    // A cancelled document and its reversal cancel each other out: drop both, so the reversal's credit is not
    // set against the oldest real debit. (A reversal dated after the year end is not read, and its original stays.)
    const seen = new Set(all.map((l) => l.journal_entries.id));
    const dropped = new Set<string>();
    for (const l of all) {
      const rev = l.journal_entries.reversed_by;
      if (rev && seen.has(rev)) { dropped.add(l.journal_entries.id); dropped.add(rev); }
    }
    for (const l of all) {
      const e = l.journal_entries;
      if (dropped.has(e.id)) continue;
      const signed = toScaled(decimalString(l.debit, 2) ?? '0.00', 2) - toScaled(decimalString(l.credit, 2) ?? '0.00', 2);
      const list = events.get(l.party_id) ?? [];
      const ev: Event = { date: e.entry_date, entryNo: e.entry_no, signed };
      if (e.source_id) {
        if (signed > 0n) ev.key = `${e.source_type}:${e.source_id}`;
        else if (e.source_type === 'credit_note') { const a = against.get(e.source_id); if (a) ev.against = a; }
      }
      list.push(ev);
      events.set(l.party_id, list);
    }
  }

  const rows: (AgeingLine & { sort: bigint })[] = [];
  const sum = { b: [0n, 0n, 0n, 0n] as bigint[], on: 0n, net: 0n };
  for (const [partyId, list] of events) {
    const { buckets, onAccount } = ageParty(list, ctx.fy.to);
    const net = buckets.reduce((a, b) => a + b, 0n) - onAccount;
    if (net === 0n && onAccount === 0n) continue;
    buckets.forEach((b, i) => { sum.b[i] = (sum.b[i] ?? 0n) + b; });
    sum.on += onAccount;
    sum.net += net;
    rows.push({
      party: parties.get(partyId)?.name ?? partyId,
      b0_30: fromScaled(buckets[0], 2), b31_60: fromScaled(buckets[1], 2), b61_90: fromScaled(buckets[2], 2), b90_plus: fromScaled(buckets[3], 2),
      onAccount: fromScaled(onAccount, 2), net: fromScaled(net, 2), sort: net,
    });
  }
  rows.sort((a, b) => (a.sort === b.sort ? a.party.localeCompare(b.party) : a.sort > b.sort ? -1 : 1));
  const control = ar ? trialBalanceClosing(ar.code) : null;
  return {
    rows: rows.map((r) => ({ party: r.party, b0_30: r.b0_30, b31_60: r.b31_60, b61_90: r.b61_90, b90_plus: r.b90_plus, onAccount: r.onAccount, net: r.net })),
    totals: { b0_30: fromScaled(sum.b[0]!, 2), b31_60: fromScaled(sum.b[1]!, 2), b61_90: fromScaled(sum.b[2]!, 2), b90_plus: fromScaled(sum.b[3]!, 2), onAccount: fromScaled(sum.on, 2), net: fromScaled(sum.net, 2) },
    control: control === null ? null : fromScaled(control, 2),
    withoutParty: control === null ? null : fromScaled(control - sum.net, 2),
  };
}
