import 'server-only';
import { decimalText } from '@/lib/decimal';
import { fyRange } from '@/lib/fy';
import type { createClient } from '@/lib/supabase/server';

type Supabase = Awaited<ReturnType<typeof createClient>>;

const d2 = (v: unknown) => decimalText(v as number | string | null, 2);

export type AccountKey = 'ar' | 'ap';

export interface LedgerParty {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'both';
  gstin: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  isActive: boolean;
  stateCode: string;
}

export interface LedgerRow {
  key: string;
  date: string;
  docNo: string | null;
  sourceType: string;
  sourceId: string | null;
  narration: string | null;
  isReversal: boolean;
  accountKey: AccountKey;
  debit: string;
  credit: string;
  /** Running balance of this row's own account, "owed" sense: AR positive = they owe us, AP positive = we owe them. */
  balance: string;
}

export interface PartyLedger {
  party: LedgerParty;
  /** null = all time. */
  period: { from: string; to: string } | null;
  /** Balance carried in from before the period, per account, when the period has one. */
  broughtForward: Partial<Record<AccountKey, string>>;
  rows: LedgerRow[];
  /** Balance at the end of the period, per account that has any activity. */
  closing: Partial<Record<AccountKey, string>>;
  /** True when more than MAX_ROWS lines exist and the rest were left out. */
  truncated: boolean;
}

const PAGE = 1000;
const MAX_PAGES = 20;

/** Ledger documents that have a screen of their own to open. */
export function documentHref(sourceType: string, sourceId: string | null): string | null {
  if (!sourceId) return null;
  if (sourceType === 'sales_invoice') return `/sales/${sourceId}/view`;
  return null;
}

/**
 * One party's ledger from `v_party_ledger`, for a financial year (`period`) or all time (null).
 * Returns null when the party does not exist (or is an employee, whose ledger is the staff screen's).
 * Every query's `error` is checked: a failure throws rather than rendering an empty ledger.
 */
export async function loadPartyLedger(supabase: Supabase, partyId: string, fy: number | 'all'): Promise<PartyLedger | null> {
  const { data: p, error: pErr } = await supabase
    .from('parties')
    .select('id, name, type, gstin, phone, whatsapp_phone, is_active, state_code')
    .eq('id', partyId)
    .maybeSingle();
  if (pErr) throw new Error(`party lookup failed: ${pErr.message}`);
  if (!p || p.type === 'employee') return null;

  const period = fy === 'all' ? null : fyRange(fy);
  const rows: LedgerRow[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase
      .from('v_party_ledger')
      .select('line_id, entry_date, source_type, source_id, doc_no, narration, is_reversal, account_key, debit, credit, running_balance')
      .eq('party_id', partyId)
      .order('entry_date', { ascending: true })
      .order('entry_no', { ascending: true })
      .order('line_no', { ascending: true })
      .order('line_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (period) q = q.gte('entry_date', period.from).lte('entry_date', period.to);
    const { data, error } = await q;
    if (error) throw new Error(`party ledger failed: ${error.message}`);
    for (const r of data ?? []) {
      rows.push({
        key: r.line_id as string, date: r.entry_date as string, docNo: (r.doc_no as string | null) ?? null,
        sourceType: r.source_type as string, sourceId: (r.source_id as string | null) ?? null,
        narration: (r.narration as string | null) ?? null, isReversal: !!r.is_reversal, accountKey: r.account_key as AccountKey,
        debit: d2(r.debit), credit: d2(r.credit), balance: d2(r.running_balance),
      });
    }
    if ((data?.length ?? 0) < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  // What was owed going into the period: the running balance of the last line before it, per account.
  const broughtForward: Partial<Record<AccountKey, string>> = {};
  if (period) {
    for (const key of ['ar', 'ap'] as const) {
      const { data, error } = await supabase
        .from('v_party_ledger')
        .select('running_balance')
        .eq('party_id', partyId)
        .eq('account_key', key)
        .lt('entry_date', period.from)
        .order('entry_date', { ascending: false })
        .order('entry_no', { ascending: false })
        .order('line_no', { ascending: false })
        .order('line_id', { ascending: false })
        .limit(1);
      if (error) throw new Error(`brought-forward balance failed: ${error.message}`);
      if (data?.[0]) broughtForward[key] = d2(data[0].running_balance);
    }
  }

  const closing: Partial<Record<AccountKey, string>> = { ...broughtForward };
  for (const r of rows) closing[r.accountKey] = r.balance;

  return {
    party: {
      id: p.id as string, name: p.name as string, type: p.type as LedgerParty['type'], gstin: (p.gstin as string | null) ?? null,
      phone: (p.phone as string | null) ?? null, whatsappPhone: (p.whatsapp_phone as string | null) ?? null,
      isActive: !!p.is_active, stateCode: p.state_code as string,
    },
    period, broughtForward, rows, closing, truncated,
  };
}
