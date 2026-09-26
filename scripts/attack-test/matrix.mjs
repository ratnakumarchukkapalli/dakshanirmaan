// Table/view x identity x operation matrix, straight at PostgREST with each identity's JWT.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { http, loadIdentities, LEGACY_ANON, record, results, saveResults, errCode, errMsg, PUB, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const { C, sql, one, rows } = fx;

const ids = loadIdentities();
if (Date.now() - ids.createdAt > 45 * 60 * 1000) throw new Error('tokens too old; rerun setup.mjs');
const IDS = ids.ids;
const NON_OWNER = ['anon', 'admin_aal1', 'user', 'user_off'];
const ALL = ['admin_aal2', ...NON_OWNER];
const tok = (k) => IDS[k].token;

// ---- probe: one request, normalised outcome -----------------------------------------------------
async function probe(identity, method, path, body, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  if (method === 'GET') headers.Prefer = 'count=exact';
  else headers.Prefer = 'return=representation';
  if (method !== 'GET' && /^parties(\?|$)/.test(path)) path += (path.includes('?') ? '&' : '?') + 'select=' + colsOf.parties.filter((c) => !['monthly_salary', 'daily_wage'].includes(c)).join(',');
  const res = await http(method, `/rest/v1/${path}`, { token: tok(identity), body, headers });
  const arr = Array.isArray(res.json) ? res.json : null;
  let total = arr ? arr.length : 0;
  const cr = res.headers.get('content-range');
  if (method === 'GET' && cr && cr.includes('/')) { const t = cr.split('/')[1]; if (t !== '*') total = Number(t); }
  const effective = method === 'GET' ? (res.status < 300 && total > 0) : (res.status < 300 && arr && arr.length > 0);
  return { status: res.status, code: errCode(res), msg: errMsg(res).slice(0, 200), rows: total, effective, sample: arr && arr[0] ? arr[0] : null };
}

// ---- expectations -------------------------------------------------------------------------------
const ADMIN_ONLY_READ = new Set(['bank_statements', 'bank_statement_lines', 'opening_batches', 'opening_lines',
  'v_pnl', 'v_balance_sheet', 'v_trial_balance', 'v_money_balances', 'v_money_ledger', 'v_bank_recon', 'v_employees']);
// what a counter `user` may write, by table: 'draft' = rows whose header is still draft
const USER_WRITES = new Set(['sales_invoices', 'purchase_invoices', 'credit_notes', 'debit_notes', 'delivery_challans', 'expense_vouchers', 'payments',
  'stock_adjustments', 'stock_transfers', 'sales_invoice_lines', 'purchase_invoice_lines', 'credit_note_lines', 'debit_note_lines',
  'delivery_challan_lines', 'expense_voucher_lines', 'stock_adjustment_lines', 'stock_transfer_lines', 'payment_allocations', 'parties', 'party_addresses']);

const fails = [];
let ran = 0, passed = 0, inconclusive = 0;
function judge({ identity, object, op, variant = '', req, out, expected, note = '' }) {
  ran++;
  let verdict;
  const permissionish = out.status === 401 || out.status === 403 || out.code === '42501' || (out.code === 'P0001' && /DN_/.test(out.msg)) || out.status < 300 || (out.status === 500 && out.code === '55000');
  if (expected === 'refuse') verdict = out.effective ? 'FAIL' : permissionish ? 'PASS' : 'INCONCLUSIVE';
  else if (expected === 'own-row') verdict = out.effective && out.rows === 1 ? 'PASS' : out.effective ? 'FAIL' : 'PASS';
  else if (expected === 'allow') {
    if (op === 'SELECT') verdict = out.status < 300 ? 'PASS' : 'FAIL';
    else verdict = out.effective ? 'PASS' : (/^(42501|P0001|PGRST)/.test(out.code) ? 'FAIL' : 'INCONCLUSIVE');
  } else verdict = 'INFO';
  if (verdict === 'PASS') passed++;
  if (verdict === 'INCONCLUSIVE') inconclusive++;
  const rec = { identity, object, op, variant, req, status: out.status, code: out.code, msg: out.msg, rows: out.rows, expected, verdict, note, sample: expected === 'refuse' && out.effective ? out.sample : undefined };
  record(rec);
  if (verdict === 'FAIL' || verdict === 'INCONCLUSIVE') fails.push(rec);
  return rec;
}

// ---- catalogue ----------------------------------------------------------------------------------
const rels = rows(`select c.relname as name, c.relkind as kind, (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name=c.relname) as cols
  from pg_class c where relnamespace='public'::regnamespace and relkind in ('r','v') order by relkind, relname`);
const colsOf = Object.fromEntries(rels.map((r) => [r.name, r.cols.split(',')]));
const selectList = (t) => (t === 'parties' ? colsOf.parties.filter((c) => !['monthly_salary', 'daily_wage'].includes(c)).join(',') : '*');

// ---- fixture-config for writes ----------------------------------------------------------------------
const posted = (t, where = `status<>'draft'`, off = 0) => one(`select id from ${t} where ${where} order by created_at offset ${off} limit 1`) || null;
const mkNote = (t, lines) => {
  const id = one(`insert into ${t} (note_date, party_id, place_of_supply, status) values (current_date, '${C.kishore}', '37', 'draft') returning id`);
  sql(`insert into ${lines} (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values ('${id}', 1, '${C.ppc}', 'x', '2523', 'BAG', 1, 1, 1, 18)`);
  return id;
};
const item = { item_id: C.ppc, item_name: 'ATTACK', hsn_code: '2523', uom: 'BAG', qty: 1, rate: 1, gst_rate: 18 };
const lineOf = (lt, fk, hdrTable, mk, extraRaw = {}) => {
  const { __upd, ...extra } = extraRaw;
  return {
  kind: 'line', name: lt, hdr: hdrTable, fk,
  mkHdr: mk, mkDraft: async () => { const h = await mk(); return one(`select id from ${lt} where ${fk}='${h}' limit 1`); },
  posted: () => one(`select l.id from ${lt} l join ${hdrTable} h on h.id=l.${fk} where h.status<>'draft' limit 1`) || null,
  postedHdr: () => posted(hdrTable), ins: (h) => ({ [fk]: h, line_no: 99, ...extra }), updBody: __upd || { qty: 999 },
  };
};
const T = {
  sales_invoices: { kind: 'hdr', mkDraft: async () => fx.mkSales(), posted: () => posted('sales_invoices', `status='posted'`), updDraft: { vehicle_no: 'ATTACK' }, updPosted: { grand_total: 1 },
    ins: () => ({ invoice_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', warehouse_id: C.head, status: 'draft' }), insPosted: () => ({ invoice_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', warehouse_id: C.head, status: 'posted', grand_total: 1 }) },
  purchase_invoices: { kind: 'hdr', mkDraft: async () => fx.mkPurchase(), posted: () => posted('purchase_invoices', `status='posted'`), updDraft: { vehicle_no: 'ATTACK' }, updPosted: { grand_total: 1 },
    ins: () => ({ invoice_date: '2026-09-26', party_id: C.krishna, place_of_supply: '37', warehouse_id: C.head, status: 'draft' }), insPosted: () => ({ invoice_date: '2026-09-26', party_id: C.krishna, place_of_supply: '37', warehouse_id: C.head, status: 'posted' }) },
  credit_notes: { kind: 'hdr', mkDraft: async () => one(`insert into credit_notes (note_date, party_id, place_of_supply, status) values (current_date, '${C.kishore}', '37', 'draft') returning id`), posted: () => posted('credit_notes', `status='posted'`),
    updDraft: { reason: 'ATTACK' }, updPosted: { grand_total: 1 }, ins: () => ({ note_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', status: 'draft' }), insPosted: () => ({ note_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', status: 'posted' }) },
  debit_notes: { kind: 'hdr', mkDraft: async () => one(`insert into debit_notes (note_date, party_id, place_of_supply, status) values (current_date, '${C.krishna}', '37', 'draft') returning id`), posted: () => posted('debit_notes', `status='posted'`),
    updDraft: { reason: 'ATTACK' }, updPosted: { grand_total: 1 }, ins: () => ({ note_date: '2026-09-26', party_id: C.krishna, place_of_supply: '37', status: 'draft' }), insPosted: () => ({ note_date: '2026-09-26', party_id: C.krishna, place_of_supply: '37', status: 'posted' }) },
  delivery_challans: { kind: 'hdr', mkDraft: async () => fx.mkChallan(), posted: () => posted('delivery_challans', `status='posted'`), updDraft: { vehicle_no: 'ATTACK' }, updPosted: { vehicle_no: 'ATTACK' },
    ins: () => ({ challan_date: '2026-09-26', party_id: C.kishore, warehouse_id: C.head, status: 'draft' }), insPosted: () => ({ challan_date: '2026-09-26', party_id: C.kishore, warehouse_id: C.head, status: 'posted' }) },
  expense_vouchers: { kind: 'hdr', mkDraft: async () => fx.mkExpense(), posted: () => posted('expense_vouchers', `status='posted' and voucher_type='expense'`), updDraft: { advance_recovered: 0 }, updPosted: { advance_recovered: 999 },
    ins: () => ({ voucher_date: '2026-09-26', voucher_type: 'expense', pay_account_id: C.cash, status: 'draft' }), insPosted: () => ({ voucher_date: '2026-09-26', voucher_type: 'expense', pay_account_id: C.cash, status: 'posted' }) },
  payments: { kind: 'hdr', mkDraft: async () => fx.mkPayment(), posted: () => posted('payments', `status='posted'`), updDraft: { amount: 1 }, updPosted: { amount: 1 },
    ins: () => ({ direction: 'receipt', payment_date: '2026-09-26', party_id: C.kishore, mode: 'cash', amount: 1, account_id: C.cash, status: 'draft' }), insPosted: () => ({ direction: 'receipt', payment_date: '2026-09-26', party_id: C.kishore, mode: 'cash', amount: 1, account_id: C.cash, status: 'posted' }) },
  stock_adjustments: { kind: 'hdr', mkDraft: async () => fx.mkAdjustment(), posted: () => posted('stock_adjustments', `status='posted'`), updDraft: { reason: 'ATTACK' }, updPosted: { reason: 'ATTACK' },
    ins: () => ({ adj_date: '2026-09-26', warehouse_id: C.head, status: 'draft' }), insPosted: () => ({ adj_date: '2026-09-26', warehouse_id: C.head, status: 'posted' }) },
  stock_transfers: { kind: 'hdr', mkDraft: async () => fx.mkTransfer(), posted: () => posted('stock_transfers', `status<>'draft'`), updDraft: { vehicle_no: 'ATTACK' }, updPosted: { vehicle_no: 'ATTACK' },
    ins: () => ({ transfer_date: '2026-09-26', from_warehouse_id: C.head, to_warehouse_id: C.gann, status: 'draft' }), insPosted: () => ({ transfer_date: '2026-09-26', from_warehouse_id: C.head, to_warehouse_id: C.gann, status: 'in_transit' }) },
};
const L = {
  sales_invoice_lines: lineOf('sales_invoice_lines', 'invoice_id', 'sales_invoices', () => fx.mkSales(), { ...item }),
  purchase_invoice_lines: lineOf('purchase_invoice_lines', 'invoice_id', 'purchase_invoices', () => fx.mkPurchase(), { ...item, taxable_value: 0 }),
  credit_note_lines: lineOf('credit_note_lines', 'note_id', 'credit_notes', () => mkNote('credit_notes', 'credit_note_lines'), { ...item, taxable_value: 1 }),
  debit_note_lines: lineOf('debit_note_lines', 'note_id', 'debit_notes', () => mkNote('debit_notes', 'debit_note_lines'), { ...item, taxable_value: 1 }),
  delivery_challan_lines: lineOf('delivery_challan_lines', 'challan_id', 'delivery_challans', () => fx.mkChallan(), { ...item }),
  expense_voucher_lines: lineOf('expense_voucher_lines', 'voucher_id', 'expense_vouchers', () => fx.mkExpense(), { account_id: C.rentAcct, amount: 1, __upd: { amount: 1 } }),
  stock_adjustment_lines: lineOf('stock_adjustment_lines', 'adjustment_id', 'stock_adjustments', () => fx.mkAdjustment(), { item_id: C.ppc, item_name: 'ATTACK', qty: 1 }),
  stock_transfer_lines: lineOf('stock_transfer_lines', 'transfer_id', 'stock_transfers', () => fx.mkTransfer(), { item_id: C.ppc, item_name: 'ATTACK', uom: 'BAG', qty: 1 }),
};
// expense_voucher_lines posted rows must be for a NON-payroll voucher (payroll rows are hidden from `user` anyway)
L.expense_voucher_lines.posted = () => one(`select l.id from expense_voucher_lines l join expense_vouchers h on h.id=l.voucher_id where h.status='posted' and h.voucher_type='expense' limit 1`) || null;
L.expense_voucher_lines.postedHdr = () => posted('expense_vouchers', `status='posted' and voucher_type='expense'`);
L.stock_transfer_lines.postedHdr = () => posted('stock_transfers', `status<>'draft'`);
L.stock_transfer_lines.posted = () => one(`select l.id from stock_transfer_lines l join stock_transfers h on h.id=l.transfer_id where h.status<>'draft' limit 1`) || null;

// ------------------------------------------------------------------------------------------------
// 1. SELECT on every table and view, every identity (+ the legacy anon JWT as a second anon shape)
// ------------------------------------------------------------------------------------------------
const selectMatrix = {};
for (const r of rels) {
  selectMatrix[r.name] = {};
  for (const identity of ALL) {
    const path = `${r.name}?select=${selectList(r.name)}&limit=3`;
    const out = await probe(identity, 'GET', path);
    selectMatrix[r.name][identity] = { status: out.status, code: out.code, rows: out.rows };
    if (identity === 'admin_aal2') continue; // control
    let expected = 'refuse';
    if (r.name === 'app_users' && identity !== 'anon') expected = 'own-row';
    else if (identity === 'user' && !ADMIN_ONLY_READ.has(r.name)) expected = 'allow';
    judge({ identity, object: r.name, op: 'SELECT', req: `GET /rest/v1/${path}`, out, expected });
  }
  // legacy anon JWT as bearer
  const legacy = await http('GET', `/rest/v1/${r.name}?select=${selectList(r.name)}&limit=3`, { token: LEGACY_ANON, apikey: LEGACY_ANON });
  const arr = Array.isArray(legacy.json) ? legacy.json : [];
  judge({ identity: 'anon(legacy-jwt)', object: r.name, op: 'SELECT', req: `GET /rest/v1/${r.name} (Authorization: Bearer <legacy anon JWT>)`,
    out: { status: legacy.status, code: errCode(legacy), msg: errMsg(legacy).slice(0, 200), rows: arr.length, effective: legacy.status < 300 && arr.length > 0, sample: arr[0] }, expected: 'refuse' });
}
fs.writeFileSync(OUT + '/select-matrix.json', JSON.stringify(selectMatrix, null, 1));
console.log(`SELECT phase done: ${ran} checks, ${fails.length} non-pass so far`);

// ------------------------------------------------------------------------------------------------
// 2. Header / line tables: INSERT, UPDATE and DELETE on a draft row and on a posted row
// ------------------------------------------------------------------------------------------------
async function writeOps(table, cfg) {
  const isLine = cfg.kind === 'line';
  for (const identity of ALL) {
    const userOk = identity === 'user' || identity === 'admin_aal2';
    const exp = (phase) => (userOk && phase === 'draft' ? 'allow' : 'refuse');
    // INSERT into a draft parent / draft status
    {
      let body;
      if (isLine) body = cfg.ins(await cfg.mkHdr());
      else body = cfg.ins();
      const out = await probe(identity, 'POST', table, body);
      judge({ identity, object: table, op: 'INSERT', variant: 'draft', req: `POST /rest/v1/${table} ${JSON.stringify(body)}`, out, expected: exp('draft') });
    }
    // INSERT tamper: straight into a POSTED parent / status 'posted'
    {
      let body, skip = false;
      if (isLine) { const ph = cfg.postedHdr(); if (!ph) skip = true; else body = cfg.ins(ph); }
      else body = cfg.insPosted();
      if (!skip) {
        const out = await probe(identity, 'POST', table, body);
        judge({ identity, object: table, op: 'INSERT', variant: isLine ? 'into posted parent' : "status='posted'", req: `POST /rest/v1/${table} ${JSON.stringify(body)}`, out, expected: 'refuse' });
      }
    }
    // UPDATE / DELETE a draft row (fresh fixture each time)
    for (const op of ['UPDATE', 'DELETE']) {
      const rid = await cfg.mkDraft();
      const path = `${table}?id=eq.${rid}`;
      const body = op === 'UPDATE' ? (isLine ? cfg.updBody : cfg.updDraft) : undefined;
      const out = await probe(identity, op === 'UPDATE' ? 'PATCH' : 'DELETE', path, body);
      judge({ identity, object: table, op, variant: 'draft row', req: `${op === 'UPDATE' ? 'PATCH' : 'DELETE'} /rest/v1/${path}${body ? ' ' + JSON.stringify(body) : ''}`, out, expected: exp('draft') });
    }
    // UPDATE / DELETE a POSTED row
    for (const op of ['UPDATE', 'DELETE']) {
      const rid = cfg.posted();
      if (!rid) { record({ identity, object: table, op, variant: 'posted row', verdict: 'N/A', note: 'no posted fixture exists' }); continue; }
      const path = `${table}?id=eq.${rid}`;
      const body = op === 'UPDATE' ? (isLine ? cfg.updBody : cfg.updPosted) : undefined;
      const out = await probe(identity, op === 'UPDATE' ? 'PATCH' : 'DELETE', path, body);
      judge({ identity, object: table, op, variant: 'posted row', req: `${op === 'UPDATE' ? 'PATCH' : 'DELETE'} /rest/v1/${path}${body ? ' ' + JSON.stringify(body) : ''}`, out, expected: 'refuse' });
    }
  }
}
// posted fixtures for credit/debit notes do not exist in demo data: build one as the database owner (setup)
for (const [t, lt, lines] of [['credit_notes', 'credit_note_lines', 'note'], ['debit_notes', 'debit_note_lines', 'note']]) {
  try {
    const p = t === 'credit_notes' ? C.kishore : C.krishna;
    const id = one(`insert into ${t} (note_date, party_id, place_of_supply, status, taxable_total, grand_total) values (current_date, '${p}', '37', 'posted', 100, 118) returning id`);
    sql(`insert into ${lt} (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values ('${id}', 1, '${C.ppc}', 'x', '2523', 'BAG', 1, 100, 100, 18)`);
  } catch (e) { console.log('no posted', t, String(e.message).slice(0, 160)); }
}
for (const [t, cfg] of Object.entries(T)) await writeOps(t, cfg);
for (const [t, cfg] of Object.entries(L)) await writeOps(t, cfg);
console.log(`hdr/line phase done: ${ran} checks, ${fails.length} non-pass so far`);


// ------------------------------------------------------------------------------------------------
// 3. Everything else: masters, admin-only tables, ledger, day_closes, app_users, allocations
// ------------------------------------------------------------------------------------------------
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
const ownerDeviations = [];
// expectFor(identity) -> 'allow' | 'refuse'. Owner outcomes are controls (validate the request is well-formed).
async function runCase({ table, op, variant = '', body, mkRow, expectFor, pathFn }) {
  for (const identity of ALL) {
    const expected = expectFor(identity);
    let method = op === 'INSERT' ? 'POST' : op === 'UPDATE' ? 'PATCH' : 'DELETE';
    let path = table, b = body;
    if (op !== 'INSERT') { const rid = mkRow ? await mkRow() : null; if (mkRow && !rid && !pathFn) { record({ identity, object: table, op, variant, verdict: 'N/A', note: 'no fixture row' }); continue; } path = pathFn ? pathFn(rid, identity) : `${table}?id=eq.${rid}`; }
    if (typeof b === 'function') b = await b(identity);
    const out = await probe(identity, method, path, b);
    const rec = judge({ identity, object: table, op, variant, req: `${method} /rest/v1/${path}${b ? ' ' + JSON.stringify(b) : ''}`, out, expected });
    if (identity === 'admin_aal2' && (rec.verdict === 'FAIL' || rec.verdict === 'INCONCLUSIVE')) { rec.control = true; ownerDeviations.push(rec); fails.pop(); }
    if (identity === 'admin_aal2' && rec.verdict === 'PASS') { ran--; passed--; } // controls do not count toward the non-owner tally
    else if (identity === 'admin_aal2') { ran--; }
    return_ = out;
  }
}
let return_;
const only = (...who) => (id) => (who.includes(id) ? 'allow' : 'refuse');
const nobody = () => 'refuse';

// -- payment_allocations
{
  // A fresh POSTED receipt (+ optionally one allocation) every time, built the way the app does it.
  const freshPosted = async (withAlloc) => {
    const inv = await fx.postedSales({ party: C.kishore, qty: 1, rate: 350 });
    const p = fx.mkPayment({ party: C.kishore, amount: 100, alloc: withAlloc ? { type: 'sales_invoice', id: inv, amount: 100 } : null });
    const r = await fx.ownerRpc('post_payment', { p_payment_id: p });
    if (r.status >= 300) throw new Error('fixture post_payment ' + r.text);
    return { inv, p, alloc: withAlloc ? one(`select id from payment_allocations where payment_id='${p}'`) : null };
  };
  const kInv = () => one(`select id from sales_invoices where party_id='${C.kishore}' and status='posted' order by created_at desc limit 1`);
  const mkPay = () => fx.mkPayment({ party: C.kishore });
  const mkAlloc = () => one(`insert into payment_allocations (payment_id, invoice_type, invoice_id, amount) values ('${mkPay()}', 'sales_invoice', '${kInv()}', 1) returning id`);
  await runCase({ table: 'payment_allocations', op: 'INSERT', variant: 'draft payment', body: () => ({ payment_id: mkPay(), invoice_type: 'sales_invoice', invoice_id: kInv(), amount: 1 }), expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'payment_allocations', op: 'INSERT', variant: 'POSTED payment (re-allocate a posted receipt)', body: async () => { const f = await freshPosted(false); return { payment_id: f.p, invoice_type: 'sales_invoice', invoice_id: f.inv, amount: 100 }; }, expectFor: nobody });
  await runCase({ table: 'payment_allocations', op: 'UPDATE', variant: 'draft', body: { amount: 2 }, mkRow: mkAlloc, expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'payment_allocations', op: 'DELETE', variant: 'draft', mkRow: mkAlloc, expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'payment_allocations', op: 'UPDATE', variant: 'POSTED payment allocation', body: { amount: 1 }, mkRow: async () => (await freshPosted(true)).alloc, expectFor: nobody });
  await runCase({ table: 'payment_allocations', op: 'DELETE', variant: 'POSTED payment allocation', mkRow: async () => (await freshPosted(true)).alloc, expectFor: nobody });
}

// -- parties
{
  // a party with REAL values on every guarded column, so a PATCH that "succeeds" is a real change, not a no-op
  const mkParty = () => one(`insert into parties (name, type, state_code, credit_limit, credit_days, interest_rate_pm, is_active) values ('ATTACK-FX-${uniq()}', 'customer', '37', 5000, 30, 1.5, true) returning id`);
  const mkEmp = () => one(`insert into parties (name, type, state_code, monthly_salary, daily_wage) values ('ATTACK-EMP-FX-${uniq()}', 'employee', '37', 18000, 600) returning id`);
  const userOnly = only('admin_aal2', 'user');
  await runCase({ table: 'parties', op: 'INSERT', variant: 'customer', body: () => ({ name: 'ATTACK-INS-' + uniq(), type: 'customer', state_code: '37' }), expectFor: userOnly });
  await runCase({ table: 'parties', op: 'INSERT', variant: 'customer with credit_limit/days/interest/is_active in body', body: () => ({ name: 'ATTACK-INS-' + uniq(), type: 'customer', state_code: '37', credit_limit: 99999999, credit_days: 999, interest_rate_pm: 9, is_active: false }), expectFor: userOnly });
  await runCase({ table: 'parties', op: 'INSERT', variant: 'employee with monthly_salary', body: () => ({ name: 'ATTACK-EMP-' + uniq(), type: 'employee', state_code: '37', monthly_salary: 1 }), expectFor: only('admin_aal2') });
  await runCase({ table: 'parties', op: 'INSERT', variant: 'is_walk_in=true (second walk-in, unlimited credit)', body: () => ({ name: 'ATTACK-WALKIN-' + uniq(), type: 'customer', state_code: '37', is_walk_in: true }), expectFor: nobody });
  const upd = (variant, body, exp) => runCase({ table: 'parties', op: 'UPDATE', variant, body, mkRow: () => mkParty(), expectFor: exp });
  await upd('name', { name: 'ATTACK-RENAMED' }, userOnly);
  await upd('phone', { phone: '9999999999' }, userOnly);
  for (const [v, b] of [['credit_limit (raise own customer limit)', { credit_limit: 99999999 }], ['credit_limit to NULL (unlimited)', { credit_limit: null }], ['credit_days', { credit_days: 365 }],
    ['interest_rate_pm 1.5 -> 0', { interest_rate_pm: 0 }], ['is_active=false', { is_active: false }], ['type customer->supplier', { type: 'supplier' }], ['gstin (valid checksum)', { gstin: '37AAACK1234A1Z9' }],
    ['state_code (flips CGST/SGST vs IGST)', { state_code: '36' }], ['monthly_salary', { monthly_salary: 1 }], ['daily_wage', { daily_wage: 1 }]])
    await upd(v, b, only('admin_aal2'));
  await runCase({ table: 'parties', op: 'UPDATE', variant: 'walk-in credit_limit -> NULL', body: { credit_limit: null }, mkRow: () => C.walkin, expectFor: nobody });
  await runCase({ table: 'parties', op: 'UPDATE', variant: 'employee monthly_salary', body: { monthly_salary: 1 }, mkRow: mkEmp, expectFor: only('admin_aal2') });
  await runCase({ table: 'parties', op: 'UPDATE', variant: 'employee daily_wage', body: { daily_wage: 1 }, mkRow: mkEmp, expectFor: only('admin_aal2') });
  await runCase({ table: 'parties', op: 'UPDATE', variant: 'employee name (a counter user may rename)', body: { name: 'ATTACK-EMP-RENAMED' }, mkRow: mkEmp, expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'parties', op: 'DELETE', mkRow: () => mkParty(), expectFor: nobody });
}
// -- party_addresses
{
  const mkAddr = () => { const p = one(`insert into parties (name, type, state_code) values ('ATTACK-FX-${uniq()}', 'customer', '37') returning id`); return one(`insert into party_addresses (party_id, label, address, state_code) values ('${p}', 'x', '{"line1":"a"}', '37') returning id`); };
  await runCase({ table: 'party_addresses', op: 'INSERT', body: () => ({ party_id: C.kishore, label: 'ATTACK-' + uniq(), address: { line1: 'x' }, state_code: '37' }), expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'party_addresses', op: 'UPDATE', variant: 'label', body: { label: 'ATTACK' }, mkRow: mkAddr, expectFor: only('admin_aal2', 'user') });
  await runCase({ table: 'party_addresses', op: 'UPDATE', variant: 'move to another party', body: { party_id: C.ramesh }, mkRow: mkAddr, expectFor: nobody });
  await runCase({ table: 'party_addresses', op: 'DELETE', mkRow: mkAddr, expectFor: nobody });
}
// -- items / accounts / warehouses / organization / fiscal_periods / doc_sequences
{
  const mkItem = () => one(`insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('ATTACK-ITEM-${uniq()}', 'cement', '2523', 18, 'BAG', 100) returning id`);
  await runCase({ table: 'items', op: 'INSERT', body: () => ({ name: 'ATTACK-ITEM-' + uniq(), category: 'cement', hsn_code: '2523', gst_rate: 18, base_uom: 'BAG', sale_rate: 100 }), expectFor: only('admin_aal2') });
  for (const [v, b] of [['sale_rate', { sale_rate: 1 }], ['gst_rate to 0', { gst_rate: 0 }], ['is_active=false', { is_active: false }], ['hsn_code', { hsn_code: '0000' }]])
    await runCase({ table: 'items', op: 'UPDATE', variant: v, body: b, mkRow: mkItem, expectFor: only('admin_aal2') });
  await runCase({ table: 'items', op: 'DELETE', mkRow: mkItem, expectFor: nobody });

  const mkAcct = () => one(`insert into accounts (code, name, type) values ('9${uniq().slice(-6)}', 'ATTACK-ACCT-${uniq()}', 'expense') returning id`);
  await runCase({ table: 'accounts', op: 'INSERT', body: () => ({ code: '8' + uniq().slice(-6), name: 'ATTACK-' + uniq(), type: 'expense' }), expectFor: only('admin_aal2') });
  for (const [v, b] of [['name', { name: 'ATTACK' }], ['is_money=true (turn any account into a money account)', { is_money: true }], ['type', { type: 'income' }], ['system_key', { system_key: 'cash' }]])
    await runCase({ table: 'accounts', op: 'UPDATE', variant: v, body: b, mkRow: mkAcct, expectFor: only('admin_aal2') });
  await runCase({ table: 'accounts', op: 'DELETE', mkRow: mkAcct, expectFor: nobody });

  const mkWh = () => one(`insert into warehouses (name) values ('ATTACK-WH-${uniq()}') returning id`);
  await runCase({ table: 'warehouses', op: 'INSERT', body: () => ({ name: 'ATTACK-WH-' + uniq() }), expectFor: only('admin_aal2') });
  await runCase({ table: 'warehouses', op: 'UPDATE', variant: 'name', body: { name: 'ATTACK' }, mkRow: mkWh, expectFor: only('admin_aal2') });
  await runCase({ table: 'warehouses', op: 'UPDATE', variant: 'is_transit=true', body: { is_transit: true }, mkRow: mkWh, expectFor: nobody });
  await runCase({ table: 'warehouses', op: 'DELETE', mkRow: mkWh, expectFor: nobody });

  const org = one(`select id from organization limit 1`);
  await runCase({ table: 'organization', op: 'UPDATE', variant: 'legal_name', body: { legal_name: 'Daksha Nirmaan Traders' }, mkRow: () => org, expectFor: only('admin_aal2') });
  await runCase({ table: 'organization', op: 'UPDATE', variant: 'allow_negative_stock=true', body: { allow_negative_stock: true }, mkRow: () => org, expectFor: only('admin_aal2') });
  await runCase({ table: 'organization', op: 'UPDATE', variant: 'upi_vpa (payee on every invoice)', body: { upi_vpa: 'attacker@upi' }, mkRow: () => org, expectFor: only('admin_aal2') });
  await runCase({ table: 'organization', op: 'INSERT', body: { legal_name: 'X', state_code: '37', singleton: false }, expectFor: nobody });
  await runCase({ table: 'organization', op: 'DELETE', mkRow: () => org, expectFor: nobody });

  const mkPeriod = () => one(`insert into fiscal_periods (year_label, month) select '2098-99', (coalesce(max(month), '2050-01-01'::date) + interval '1 month')::date from fiscal_periods where year_label='2098-99' returning id`);
  await runCase({ table: 'fiscal_periods', op: 'UPDATE', variant: 'is_locked=true (lock a period directly, bypassing set_period_lock)', body: { is_locked: true }, mkRow: mkPeriod, expectFor: nobody });
  await runCase({ table: 'fiscal_periods', op: 'UPDATE', variant: 'is_locked=false on a real period', body: { is_locked: false }, mkRow: () => one(`select id from fiscal_periods where month='2026-09-01'`), expectFor: nobody });
  await runCase({ table: 'fiscal_periods', op: 'INSERT', body: () => ({ year_label: '2097-98', month: '2097-04-01' }), expectFor: nobody });
  await runCase({ table: 'fiscal_periods', op: 'DELETE', mkRow: mkPeriod, expectFor: nobody });
  const seqId = () => one(`select id from doc_sequences where series='DN' limit 1`);
  await runCase({ table: 'doc_sequences', op: 'UPDATE', variant: 'next_no=1 (reset invoice numbering)', body: { next_no: 1 }, mkRow: seqId, expectFor: nobody });
  await runCase({ table: 'doc_sequences', op: 'INSERT', body: () => ({ series: 'Z' + uniq().slice(-3), doc_type: 'quotation', fy_label: '2026-27', prefix: 'ZZ' }), expectFor: nobody });
  await runCase({ table: 'doc_sequences', op: 'DELETE', mkRow: seqId, expectFor: nobody });
}
// -- owner-only staging tables
{
  const mkStmt = () => one(`insert into bank_statements (account_id, period_from, period_to) values ('${C.bank}', '2026-08-01', '2026-08-31') returning id`);
  await runCase({ table: 'bank_statements', op: 'INSERT', body: { account_id: C.bank, period_from: '2026-08-01', period_to: '2026-08-31' }, expectFor: only('admin_aal2') });
  await runCase({ table: 'bank_statements', op: 'UPDATE', body: { source_file: 'ATTACK' }, mkRow: mkStmt, expectFor: only('admin_aal2') });
  await runCase({ table: 'bank_statements', op: 'DELETE', mkRow: mkStmt, expectFor: only('admin_aal2') });
  const mkStl = () => one(`insert into bank_statement_lines (statement_id, txn_date, narration, debit) values ('${mkStmt()}', '2026-08-02', 'x', 1) returning id`);
  await runCase({ table: 'bank_statement_lines', op: 'INSERT', body: () => ({ statement_id: mkStmt(), txn_date: '2026-08-02', narration: 'x', credit: 1 }), expectFor: only('admin_aal2') });
  await runCase({ table: 'bank_statement_lines', op: 'UPDATE', body: { narration: 'ATTACK' }, mkRow: mkStl, expectFor: only('admin_aal2') });
  await runCase({ table: 'bank_statement_lines', op: 'DELETE', mkRow: mkStl, expectFor: only('admin_aal2') });
  const mkBatch = () => { sql(`delete from opening_lines where batch_id in (select id from opening_batches where status='draft')`); sql(`delete from opening_batches where status='draft'`); return one(`insert into opening_batches (status) values ('draft') returning id`); };
  await runCase({ table: 'opening_batches', op: 'INSERT', variant: 'draft', body: () => { sql(`delete from opening_lines where batch_id in (select id from opening_batches where status='draft')`); sql(`delete from opening_batches where status='draft'`); return { status: 'draft' }; }, expectFor: only('admin_aal2') });
  await runCase({ table: 'opening_batches', op: 'UPDATE', variant: "status='posted'", body: { status: 'posted' }, mkRow: mkBatch, expectFor: nobody });
  await runCase({ table: 'opening_batches', op: 'DELETE', mkRow: mkBatch, expectFor: nobody });
  const mkOl = () => { const b = mkBatch(); return one(`insert into opening_lines (batch_id, kind, party_id, side, amount) values ('${b}', 'party', '${C.kishore}', 'receivable', 1) returning id`); };
  await runCase({ table: 'opening_lines', op: 'INSERT', body: () => ({ batch_id: mkBatch(), kind: 'party', party_id: C.kishore, side: 'receivable', amount: 1 }), expectFor: only('admin_aal2') });
  await runCase({ table: 'opening_lines', op: 'UPDATE', body: { amount: 2 }, mkRow: mkOl, expectFor: only('admin_aal2') });
  await runCase({ table: 'opening_lines', op: 'DELETE', mkRow: mkOl, expectFor: only('admin_aal2') });
  sql(`delete from opening_lines where batch_id in (select id from opening_batches where status='draft')`); sql(`delete from opening_batches where status='draft'`);
}
// -- ledger + audit + day_closes: writable by NOBODY (owner included)
{
  const je = () => one(`select id from journal_entries where source_type='sales_invoice' order by created_at limit 1`);
  await runCase({ table: 'journal_entries', op: 'INSERT', body: { entry_date: '2026-09-26', source_type: 'manual', narration: 'ATTACK' }, expectFor: nobody });
  await runCase({ table: 'journal_entries', op: 'UPDATE', variant: 'narration', body: { narration: 'ATTACK' }, mkRow: je, expectFor: nobody });
  await runCase({ table: 'journal_entries', op: 'UPDATE', variant: "status='cancelled'", body: { status: 'cancelled' }, mkRow: je, expectFor: nobody });
  await runCase({ table: 'journal_entries', op: 'DELETE', mkRow: je, expectFor: nobody });
  const jl = () => one(`select id from journal_lines order by created_at limit 1`);
  await runCase({ table: 'journal_lines', op: 'INSERT', body: () => ({ entry_id: je(), line_no: 99, account_id: C.cash, debit: 1, credit: 0 }), expectFor: nobody });
  await runCase({ table: 'journal_lines', op: 'UPDATE', variant: 'debit=1', body: { debit: 1 }, mkRow: jl, expectFor: nobody });
  await runCase({ table: 'journal_lines', op: 'UPDATE', variant: 'account_id -> cash', body: { account_id: C.cash }, mkRow: jl, expectFor: nobody });
  await runCase({ table: 'journal_lines', op: 'DELETE', mkRow: jl, expectFor: nobody });
  const sm = () => one(`select id from stock_movements order by created_at limit 1`);
  await runCase({ table: 'stock_movements', op: 'INSERT', body: { item_id: C.ppc, warehouse_id: C.head, movement_date: '2026-09-26', qty: 100000, rate: 1, value: 100000, source_type: 'manual' }, expectFor: nobody });
  await runCase({ table: 'stock_movements', op: 'UPDATE', variant: 'qty', body: { qty: 100000 }, mkRow: sm, expectFor: nobody });
  await runCase({ table: 'stock_movements', op: 'UPDATE', variant: 'rate/value (cost)', body: { rate: 0, value: 0 }, mkRow: sm, expectFor: nobody });
  await runCase({ table: 'stock_movements', op: 'DELETE', mkRow: sm, expectFor: nobody });
  const al = () => one(`select id from audit_log order by created_at limit 1`);
  await runCase({ table: 'audit_log', op: 'INSERT', body: { action: 'ATTACK', entity: 'forged' }, expectFor: nobody });
  await runCase({ table: 'audit_log', op: 'UPDATE', body: { action: 'ATTACK' }, mkRow: al, expectFor: nobody });
  await runCase({ table: 'audit_log', op: 'DELETE', mkRow: al, expectFor: nobody });
  const dcl = () => one(`select id from day_closes where close_date='2026-04-01'`) || one(`insert into day_closes (close_date, counted, status) values ('2026-04-01', 1, 'posted') returning id`);
  await runCase({ table: 'day_closes', op: 'INSERT', body: { close_date: '2026-04-02', counted: 1 }, expectFor: nobody });
  await runCase({ table: 'day_closes', op: 'UPDATE', variant: 'counted / status', body: { counted: 0, status: 'cancelled' }, mkRow: dcl, expectFor: nobody });
  await runCase({ table: 'day_closes', op: 'DELETE', mkRow: dcl, expectFor: nobody });
}
// -- app_users: privilege escalation and self-reactivation
{
  const me = (identity) => IDS[identity].userId;
  await runCase({ table: 'app_users', op: 'UPDATE', variant: "own role -> 'admin'", body: { role: 'admin' }, mkRow: () => null, pathFn: (_r, identity) => `app_users?user_id=eq.${me(identity) || '00000000-0000-0000-0000-000000000000'}`, expectFor: nobody });
  await runCase({ table: 'app_users', op: 'UPDATE', variant: 'own is_active -> true', body: { is_active: true }, mkRow: () => null, pathFn: (_r, identity) => `app_users?user_id=eq.${me(identity) || '00000000-0000-0000-0000-000000000000'}`, expectFor: nobody });
  await runCase({ table: 'app_users', op: 'UPDATE', variant: "another user's role -> 'user' (demote the owner)", body: { role: 'user' }, mkRow: () => null, pathFn: () => `app_users?user_id=eq.${IDS.admin_aal2.userId}`, expectFor: nobody });
  await runCase({ table: 'app_users', op: 'UPDATE', variant: 'own name (self-service)', body: { name: 'ATTACK' }, mkRow: () => null, pathFn: (_r, identity) => `app_users?user_id=eq.${me(identity) || '00000000-0000-0000-0000-000000000000'}`, expectFor: nobody });
  await runCase({ table: 'app_users', op: 'INSERT', variant: 'new admin row for own uid', body: (identity) => ({ user_id: me(identity) || crypto.randomUUID(), role: 'admin', name: 'ATTACK', is_active: true }), expectFor: nobody });
  await runCase({ table: 'app_users', op: 'DELETE', mkRow: () => null, pathFn: () => `app_users?user_id=eq.${IDS.admin_aal2.userId}`, expectFor: nobody });
}
// -- views: no write path at all
for (const r of rels.filter((x) => x.kind === 'v')) {
  const col = r.cols.split(',')[0];
  for (const identity of ALL) {
    for (const [op, method, path, body] of [['INSERT', 'POST', r.name, {}], ['UPDATE', 'PATCH', `${r.name}?${col}=not.is.null`, { [col]: null }], ['DELETE', 'DELETE', `${r.name}?${col}=not.is.null`, undefined]]) {
      const out = await probe(identity, method, path, body);
      if (identity === 'admin_aal2') continue;
      const ok = out.status >= 400 && !out.effective;
      ran++; if (ok) passed++;
      const rec = { identity, object: r.name, op, variant: 'view write', req: `${method} /rest/v1/${path}`, status: out.status, code: out.code, msg: out.msg, rows: out.rows, expected: 'refuse', verdict: ok ? 'PASS' : 'FAIL' };
      record(rec); if (!ok) fails.push(rec);
    }
  }
}
// -- parties pay columns: nobody may read them through the table (owner uses employee_pay_rates())
for (const identity of ALL) {
  for (const path of ['parties?select=monthly_salary,daily_wage&limit=2', 'parties?select=*&limit=1', 'parties?monthly_salary=gt.0&select=id&limit=2', 'parties?select=id&order=monthly_salary.desc&limit=2']) {
    const out = await probe(identity, 'GET', path);
    const rec = judge({ identity, object: 'parties (pay columns)', op: 'SELECT', variant: path.slice(8, 60), req: `GET /rest/v1/${path}`, out, expected: 'refuse' });
    if (identity === 'admin_aal2') { ran--; if (rec.verdict === 'PASS') passed--; else { ownerDeviations.push(rec); fails.pop(); } }
  }
}

fs.writeFileSync(OUT + '/fails-1.json', JSON.stringify(fails, null, 1));
fs.writeFileSync(OUT + '/owner-deviations.json', JSON.stringify(ownerDeviations, null, 1));
saveResults('results-1');
console.log(JSON.stringify({ ran, passed, inconclusive, fail: fails.filter((f) => f.verdict === 'FAIL').length, ownerDeviations: ownerDeviations.length }));
