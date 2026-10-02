import { toScaled, fromScaled } from '@/lib/export/decimal';
import { fakeDb, type FakeDb } from './export-fake';

export const owner = { userId: 'u-owner', role: 'admin' as const, name: 'Test Owner', aal: 'aal2' as const };
const OLD = '2020-01-01T00:00:00Z';

// ---------------------------------------------------------------------------------------------
// Fixture: last year's books (carried in), then the year's entries
// ---------------------------------------------------------------------------------------------

export const ACCOUNTS = [
  { id: 'a-cash', code: '1110', name: 'Cash', type: 'asset', parent_id: null, system_key: 'cash', is_group: false, is_control: false, is_money: true },
  { id: 'a-bank', code: '1120', name: 'Bank', type: 'asset', parent_id: null, system_key: 'bank', is_group: false, is_control: false, is_money: true },
  { id: 'a-ar', code: '1200', name: 'Accounts Receivable', type: 'asset', parent_id: null, system_key: 'ar', is_group: false, is_control: true, is_money: false },
  { id: 'a-adv', code: '1500', name: 'Employee Advances', type: 'asset', parent_id: null, system_key: 'employee_advance', is_group: false, is_control: true, is_money: false },
  { id: 'a-ap', code: '2100', name: 'Accounts Payable', type: 'liability', parent_id: null, system_key: 'ap', is_group: false, is_control: true, is_money: false },
  { id: 'a-ocgst', code: '2210', name: 'Output CGST', type: 'liability', parent_id: null, system_key: 'output_cgst', is_group: false, is_control: false, is_money: false },
  { id: 'a-osgst', code: '2220', name: 'Output SGST', type: 'liability', parent_id: null, system_key: 'output_sgst', is_group: false, is_control: false, is_money: false },
  { id: 'a-cap', code: '3100', name: 'Capital - Dad', type: 'equity', parent_id: null, system_key: null, is_group: false, is_control: false, is_money: false },
  { id: 'a-sales', code: '4100', name: 'Sales - Cement', type: 'income', parent_id: null, system_key: null, is_group: false, is_control: false, is_money: false },
  { id: 'a-rent', code: '5400', name: 'Godown Rent', type: 'expense', parent_id: null, system_key: null, is_group: false, is_control: false, is_money: false },
  { id: 'a-grp', code: '1000', name: 'Assets', type: 'asset', parent_id: null, system_key: null, is_group: true, is_control: false, is_money: false },
];
export const TOUGH_NAME = 'Shop \u{1F3D7}️ <Best> "Q" \'x\' & Co\u0001 ' + 'x'.repeat(100);
export const PARTIES = [
  { id: 'p1', name: 'Ram & Sons', type: 'customer', created_at: '2026-01-01T00:00:00Z' },
  { id: 'p2', name: 'Ram-Sons', type: 'customer', created_at: '2026-01-02T00:00:00Z' },
  { id: 'p3', name: 'Ram Sons', type: 'supplier', created_at: '2026-01-03T00:00:00Z' },
  { id: 'p4', name: 'శ్రీ వెంకటేశ్వర కన్‌స్ట్రక్షన్స్', type: 'customer', created_at: '2026-01-04T00:00:00Z' },
  { id: 'p5', name: TOUGH_NAME, type: 'customer', created_at: '2026-01-05T00:00:00Z' },
  { id: 'p6', name: 'cash', type: 'both', created_at: '2026-01-06T00:00:00Z' },
  { id: 'p7', name: 'Ravi Kumar', type: 'employee', created_at: '2026-01-07T00:00:00Z' },
].map((p) => ({ ...p, gstin: null, state_code: '37', phone: null, whatsapp_phone: null, credit_limit: '0.00', credit_days: 0, interest_rate_pm: '0.00', is_active: true, is_walk_in: false }));

type L = [account: string, debit: string, credit: string, party?: string];
export interface E { no: number; date: string; source: string; sourceId: string | null; doc: string | null; narration: string | null; lines: L[]; reversedBy?: string; status?: string }

export const LONG = 'long narration '.repeat(100);
export const MESSY = 'Cement \u0001\u0008 "50 kg" & <bags> \'x\' \u{1F3D7}️ శ్రీ\nsecond line\ttab';

/** The year before the one exported (opening balances come from here), then the exported year. */
export function entries(): E[] {
  return [
    { no: 1, date: '2026-03-15', source: 'opening', sourceId: null, doc: null, narration: 'Go-live', lines: [['a-ar', '5000.00', '0.00', 'p1'], ['a-cash', '300.00', '0.00'], ['a-cap', '0.00', '5300.00']] },
    { no: 2, date: '2025-12-01', source: 'sales_invoice', sourceId: 'old-inv', doc: 'DN/25-26/0001', narration: 'Old sale', lines: [['a-ar', '1000.00', '0.00', 'p1'], ['a-sales', '0.00', '1000.00']] },
    { no: 3, date: '2026-01-10', source: 'expense_voucher', sourceId: 'old-exp', doc: 'EXP/25-26/0001', narration: 'Old rent', lines: [['a-rent', '200.00', '0.00'], ['a-cash', '0.00', '200.00']] },
    // ----- 2026-27
    { no: 4, date: '2026-09-15', source: 'sales_invoice', sourceId: 'inv-1', doc: 'DN/26-27/0001', narration: 'Sale to Ram', lines: [['a-ar', '11800.00', '0.00', 'p1'], ['a-sales', '0.00', '10000.00'], ['a-ocgst', '0.00', '900.00'], ['a-osgst', '0.00', '900.00']] },
    { no: 5, date: '2026-09-20', source: 'payment', sourceId: 'pay-1', doc: 'RCPT/26-27/0001', narration: 'Receipt from Ram', lines: [['a-bank', '5000.00', '0.00'], ['a-ar', '0.00', '5000.00', 'p1']] },
    { no: 6, date: '2026-09-21', source: 'expense_voucher', sourceId: 'exp-1', doc: 'EXP/26-27/0001', narration: 'Rent for September', lines: [['a-rent', '500.00', '0.00'], ['a-cash', '0.00', '500.00']] },
    { no: 7, date: '2026-09-22', source: 'cash_deposit', sourceId: 'dep-1', doc: null, narration: 'Cash to bank', lines: [['a-bank', '300.00', '0.00'], ['a-cash', '0.00', '300.00']] },
    { no: 8, date: '2026-09-16', source: 'sales_invoice', sourceId: 'inv-2', doc: 'DN/26-27/0002', narration: 'Sale, later cancelled', reversedBy: 'e-9', lines: [['a-ar', '118.00', '0.00', 'p3'], ['a-sales', '0.00', '100.00'], ['a-ocgst', '0.00', '9.00'], ['a-osgst', '0.00', '9.00']] },
    { no: 9, date: '2026-09-17', source: 'sales_invoice', sourceId: 'inv-2', doc: 'DN/26-27/0002', narration: 'Reversal of DN/26-27/0002', lines: [['a-sales', '100.00', '0.00'], ['a-ocgst', '9.00', '0.00'], ['a-osgst', '9.00', '0.00'], ['a-ar', '0.00', '118.00', 'p3']] },
    { no: 10, date: '2026-10-01', source: 'manual', sourceId: null, doc: null, narration: MESSY, lines: [['a-rent', '10.00', '0.00'], ['a-cap', '0.00', '10.00']] },
    { no: 11, date: '2026-10-02', source: 'manual', sourceId: null, doc: null, narration: LONG, lines: [['a-ar', '77.77', '0.00', 'p5'], ['a-cap', '0.00', '77.77']] },
    { no: 12, date: '2026-10-03', source: 'sales_invoice', sourceId: 'inv-3', doc: 'DN/26-27/0003', narration: 'Cash sale', lines: [['a-cash', '1180.00', '0.00'], ['a-sales', '0.00', '1000.00'], ['a-ocgst', '0.00', '90.00'], ['a-osgst', '0.00', '90.00']] },
    { no: 13, date: '2026-10-04', source: 'sales_invoice', sourceId: 'inv-4', doc: 'DN/26-27/0004', narration: 'Sale to Telugu party', lines: [['a-ar', '236.00', '0.00', 'p4'], ['a-sales', '0.00', '200.00'], ['a-ocgst', '0.00', '18.00'], ['a-osgst', '0.00', '18.00']] },

    // ----- more of last year (entry numbers 14 and 15, so the year's numbering above is unchanged): a supplier bill on a party who also owes us, and an advance to an employee
    { no: 14, date: '2026-02-01', source: 'purchase_invoice', sourceId: 'old-pb', doc: 'PB/25-26/0001', narration: 'Old purchase', lines: [['a-rent', '300.00', '0.00'], ['a-ap', '0.00', '300.00', 'p1']] },
    { no: 15, date: '2026-02-10', source: 'payment', sourceId: 'old-adv', doc: 'PAY/25-26/0001', narration: 'Advance to Ravi', lines: [['a-adv', '400.00', '0.00', 'p7'], ['a-cash', '0.00', '400.00']] },
  ];
}

export function buildDb(list: E[] = entries()): FakeDb {
  const journal_entries = list.map((e) => ({
    id: `e-${e.no}`, entry_no: e.no, entry_date: e.date, narration: e.narration, source_type: e.source, source_id: e.sourceId, status: e.status ?? 'posted',
    reversed_by: e.reversedBy ?? null, posted_by: owner.userId, posted_at: OLD, created_at: OLD,
    journal_lines: e.lines.map((l, i) => ({ id: `l-${e.no}-${i + 1}`, line_no: i + 1, account_id: l[0], party_id: l[3] ?? null, debit: l[1], credit: l[2] })),
  }));
  const journal_lines = list.flatMap((e) => e.lines.map((l, i) => ({
    id: `l-${e.no}-${i + 1}`, line_no: i + 1, account_id: l[0], party_id: l[3] ?? null, debit: l[1], credit: l[2], created_at: OLD, journal_entries: { entry_date: e.date, status: e.status ?? 'posted' },
  })));
  const d = fakeDb({
    organization: [{ legal_name: 'Daksha Nirmaan Traders', timezone: 'Asia/Kolkata' }],
    fiscal_periods: [{ year_label: '2026-27' }, { year_label: '2025-26' }],
    accounts: ACCOUNTS, parties: PARTIES,
    v_document_refs: list.filter((e) => e.doc && e.sourceId).map((e) => ({ source_type: e.source, source_id: e.sourceId, doc_no: e.doc, doc_date: e.date })),
    journal_entries, journal_lines,
  });
  // The app's own trial balance: closing per account over posted entries up to the date.
  d.rpcs.trial_balance_asat = (args) => {
    const upTo = String(args?.p_date);
    const sums = new Map<string, bigint>();
    for (const l of journal_lines) {
      if (l.journal_entries.entry_date > upTo || l.journal_entries.status !== 'posted') continue;
      sums.set(l.account_id, (sums.get(l.account_id) ?? 0n) + toScaled(l.debit, 2) - toScaled(l.credit, 2));
    }
    return ACCOUNTS.filter((a) => (sums.get(a.id) ?? 0n) !== 0n).sort((a, b) => a.code.localeCompare(b.code)).map((a) => ({
      account_id: a.id, code: a.code, name: a.name, account_type: a.type, total_debit: 0, total_credit: 0, closing: Number(fromScaled(sums.get(a.id)!, 2)),
    }));
  };
  d.rpcs.log_export = () => [];
  return d;
}

