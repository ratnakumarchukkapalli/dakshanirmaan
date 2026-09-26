// Every public function, every identity, through PostgREST /rpc with each identity's JWT.
import fs from 'node:fs';
import { http, loadIdentities, record, saveResults, errCode, errMsg, LEGACY_ANON, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const { C, sql, one, rows } = fx;

const ids = loadIdentities();
if (Date.now() - ids.createdAt > 50 * 60 * 1000) throw new Error('tokens too old; rerun setup.mjs');
const IDS = ids.ids;
const NON_OWNER = ['anon', 'admin_aal1', 'user_off', 'user'];
const ORDER = [...NON_OWNER, 'admin_aal2']; // owner LAST: a state change made by the control must not hide a bypass
const tok = (k) => IDS[k].token;

const fails = [];
let ran = 0, passed = 0, inconclusive = 0;
const GATE = /DN_FORBIDDEN|permission denied for function|permission denied/;
const isGateRefusal = (o) => o.status === 401 || o.status === 403 || GATE.test(o.msg) || o.code === '42501';

async function rpc(identity, fn, args) {
  const r = await http('POST', `/rest/v1/rpc/${fn}`, { token: tok(identity), body: args });
  const data = r.json;
  const nrows = Array.isArray(data) ? data.length : data === null ? 0 : 1;
  return { status: r.status, code: errCode(r), msg: errMsg(r), data, nrows, ok: r.status < 300 };
}

// expected: 'closed'  -> the gate must refuse (success = FAIL; some other error = INCONCLUSIVE unless in okAlt)
//           'open'    -> the gate must let the call through (gate refusal = FAIL); success or a business error both prove that
//           'empty'   -> the call succeeds but must return no data
//           'null'    -> the call succeeds and returns null/false
async function check({ identity, fn, variant = '', args, expected, okAlt = null, note = '', ownerControl = false }) {
  const out = await rpc(identity, fn, args);
  let verdict;
  if (expected === 'closed') {
    if (out.ok) verdict = 'FAIL';
    else if (isGateRefusal(out) || (okAlt && okAlt.test(out.msg))) verdict = 'PASS';
    else verdict = 'INCONCLUSIVE';
  } else if (expected === 'open') {
    verdict = isGateRefusal(out) ? 'FAIL' : 'PASS';
  } else if (expected === 'empty') {
    const nonzero = Array.isArray(out.data) ? out.data.filter((r) => Object.values(r).some((v) => v !== 0 && v !== null && v !== '0' && v !== false)).length : out.nrows;
    verdict = out.ok ? (nonzero === 0 ? 'PASS' : 'FAIL') : (isGateRefusal(out) ? 'PASS' : 'INCONCLUSIVE');
  } else if (expected === 'null') {
    verdict = out.ok ? (out.data === null || out.data === false ? 'PASS' : 'FAIL') : (isGateRefusal(out) ? 'PASS' : 'INCONCLUSIVE');
  }
  const rec = { identity, object: fn, op: 'RPC', variant, req: `POST /rest/v1/rpc/${fn} ${JSON.stringify(args)}`, status: out.status, code: out.code, msg: out.msg.slice(0, 220), rows: out.nrows,
    expected, verdict, note, result: out.ok ? JSON.stringify(out.data)?.slice(0, 160) : undefined };
  if (ownerControl) { rec.control = true; record(rec); if (verdict !== 'PASS') ownerDeviations.push(rec); return out; }
  ran++; if (verdict === 'PASS') passed++; if (verdict === 'INCONCLUSIVE') inconclusive++;
  record(rec); if (verdict === 'FAIL' || verdict === 'INCONCLUSIVE') fails.push(rec);
  return out;
}
const ownerDeviations = [];

// Run one case for every identity. `mk(identity)` builds FRESH args (fixtures) per identity.
// exp: (identity) => expected ; owner is a control.
async function every(fn, variant, mk, exp, opts = {}) {
  for (const identity of ORDER) {
    const args = await mk(identity);
    await check({ identity, fn, variant, args, expected: exp(identity), okAlt: opts.okAlt, note: opts.note || '', ownerControl: identity === 'admin_aal2' });
  }
}
const open = (...who) => (id) => (who.includes(id) ? 'open' : 'closed');
const closedFor = (...who) => (id) => (who.includes(id) ? 'closed' : 'open');
const USER = ['user', 'admin_aal2'];
const ADMIN = ['admin_aal2'];

// ---- fixtures returning args -----------------------------------------------------------------------
const invPosted = async () => ({ id: await fx.postedSales() });
let dcSeq = 10;

// =================================================================================================
// POSTING FUNCTIONS
// =================================================================================================
await every('post_sales_invoice', 'plain', async () => ({ p_invoice_id: fx.mkSales(), p_override_credit: false }), open(...USER));
await every('post_sales_invoice', 'credit-limit override (party over limit, p_override_credit=true)', async () => ({ p_invoice_id: fx.mkSales({ party: C.ramesh, qty: 1, rate: 500000 }), p_override_credit: true }),
  (id) => (id === 'admin_aal2' ? 'open' : 'closed'), { okAlt: /DN_CREDIT_LIMIT/ });
await every('post_cash_sale', '', async () => ({ p_invoice_id: fx.mkSales({ party: C.walkin }), p_account_id: C.cash }), open(...USER));
await every('post_delivery_challan', '', async () => ({ p_challan_id: fx.mkChallan() }), open(...USER));
await every('post_payment', 'receipt', async () => ({ p_payment_id: fx.mkPayment({ dir: 'receipt', party: C.kishore, amount: 100 }) }), open(...USER));
await every('post_payment', 'OUTGOING payment (direction=payment)', async () => ({ p_payment_id: fx.mkPayment({ dir: 'payment', party: C.krishna, mode: 'neft', acct: C.bank, amount: 100 }) }), open(...ADMIN));
await every('post_payment', 'receipt with DISCOUNT > 0', async () => {
  const inv = await fx.postedSales({ party: C.kishore, qty: 1, rate: 350 });
  return { p_payment_id: fx.mkPayment({ dir: 'receipt', party: C.kishore, amount: 400, discount: 13, alloc: { type: 'sales_invoice', id: inv, amount: 413 } }) };
}, open(...ADMIN));
await every('post_purchase_invoice', '', async () => ({ p_invoice_id: fx.mkPurchase() }), open(...ADMIN));
await every('post_expense_voucher', 'advance <= 5000 (counter work)', async () => ({ p_voucher_id: fx.mkExpense({ type: 'advance', party: C.suribabu, amount: 100 }) }), open(...USER));
await every('post_expense_voucher', 'advance > 5000', async () => ({ p_voucher_id: fx.mkExpense({ type: 'advance', party: C.suribabu, amount: 6000 }) }), open(...ADMIN));
await every('post_expense_voucher', 'plain expense', async () => ({ p_voucher_id: fx.mkExpense({ type: 'expense', amount: 100 }) }), open(...ADMIN));
await every('post_expense_voucher', 'SALARY voucher', async () => ({ p_voucher_id: fx.mkExpense({ type: 'salary', party: C.suribabu, amount: 100 }) }), open(...ADMIN));
await every('post_expense_voucher', 'WAGES voucher', async () => ({ p_voucher_id: fx.mkExpense({ type: 'wages', party: C.ramana, amount: 100 }) }), open(...ADMIN));
await every('post_stock_adjustment', '', async () => ({ p_adjustment_id: fx.mkAdjustment() }), open(...ADMIN));
await every('post_stock_transfer', '', async () => ({ p_transfer_id: fx.mkTransfer() }), open(...ADMIN));
await every('receive_stock_transfer', '', async () => { const t = fx.mkTransfer(); const r = await fx.ownerRpc('post_stock_transfer', { p_transfer_id: t }); if (r.status >= 300) throw new Error('fixture transfer ' + r.text); return { p_transfer_id: t }; }, open(...ADMIN));

// =================================================================================================
// CANCELLATION / REOPEN
// =================================================================================================
await every('cancel_document', 'sales_invoice', async () => ({ p_source_type: 'sales_invoice', p_source_id: await fx.postedSales(), p_reason: 'attack test' }), open(...ADMIN));
await every('cancel_document', 'payment (receipt)', async () => ({ p_source_type: 'payment', p_source_id: await fx.postedPayment({ party: C.kishore, amount: 50 }), p_reason: 'attack test' }), open(...ADMIN));
await every('cancel_document', 'expense_voucher', async () => { const v = fx.mkExpense({ type: 'expense', amount: 10 }); const r = await fx.ownerRpc('post_expense_voucher', { p_voucher_id: v }); if (r.status >= 300) throw new Error(r.text); return { p_source_type: 'expense_voucher', p_source_id: v, p_reason: 'attack test' }; }, open(...ADMIN));
await every('cancel_document', 'purchase_invoice', async () => { const v = fx.mkPurchase(); const r = await fx.ownerRpc('post_purchase_invoice', { p_invoice_id: v }); if (r.status >= 300) throw new Error(r.text); return { p_source_type: 'purchase_invoice', p_source_id: v, p_reason: 'attack test' }; }, open(...ADMIN));
await every('cancel_document', 'delivery_challan', async () => { const v = fx.mkChallan(); const r = await fx.ownerRpc('post_delivery_challan', { p_challan_id: v }); if (r.status >= 300) throw new Error(r.text); return { p_source_type: 'delivery_challan', p_source_id: v, p_reason: 'attack test' }; }, open(...ADMIN));
await every('cancel_document', 'day_close (REOPEN a day close)', async () => {
  const d = `2026-04-${String(dcSeq++).padStart(2, '0')}`;
  const r = await fx.ownerRpc('post_day_close', { p_date: d, p_counted: 0, p_note: 'fixture', p_expected_seen: null });
  if (r.status >= 300 && !/already_closed/.test(r.text)) throw new Error('fixture day close ' + r.text);
  return { p_source_type: 'day_close', p_source_id: one(`select id from day_closes where close_date='${d}' and status<>'cancelled'`) || '00000000-0000-0000-0000-000000000000', p_reason: 'attack test' };
}, open(...ADMIN));
for (const st of ['manual', 'opening', 'credit_note', 'debit_note', 'stock_transfer', 'stock_adjustment']) {
  await every('cancel_document', `${st} (arbitrary id)`, async () => ({ p_source_type: st, p_source_id: '00000000-0000-0000-0000-000000000001', p_reason: 'attack test' }), open(...ADMIN));
}

// =================================================================================================
// CHEQUES
// =================================================================================================
await every('deposit_cheque', '', async () => ({ p_payment_id: await fx.postedChequeReceipt() }), open(...USER));
await every('mark_cheque_cleared', '', async () => { const p = await fx.postedChequeReceipt(); const r = await fx.ownerRpc('deposit_cheque', { p_payment_id: p }); if (r.status >= 300) throw new Error(r.text); return { p_payment_id: p }; }, open(...USER));
await every('bounce_cheque', '', async () => ({ p_payment_id: await fx.postedChequeReceipt(), p_reason: 'attack test' }), open(...ADMIN));

// =================================================================================================
// OWNER-ONLY (aal2) FUNCTIONS
// =================================================================================================
await every('set_period_lock', 'lock 2027-02', async () => ({ p_month: '2027-02-01', p_locked: true, p_reason: 'attack test' }), open(...ADMIN));
sql(`update fiscal_periods set is_locked=false where month='2027-02-01'`);
await every('ensure_fiscal_year', '', async () => ({ p_label: '2031-32' }), open(...ADMIN));
await every('post_opening_balances', '', async () => ({ p_date: '2026-03-31', p_expected_equity: 0 }), open(...ADMIN));
await every('cancel_opening_balances', '', async () => ({ p_reason: 'attack test' }), open(...ADMIN));
await every('go_live_readiness', '', async () => ({}), open(...ADMIN));
await every('gstr1_data', '', async () => ({ p_month: '2026-09-01' }), open(...ADMIN));
await every('gstr3b_summary', '', async () => ({ p_month: '2026-09-01' }), open(...ADMIN));
for (const identity of ORDER) {
  // each identity tries to make ITSELF an active admin; the owner control acts on another account
  const target = identity === 'admin_aal2' ? IDS.user : (IDS[identity].userId ? IDS[identity] : IDS.user);
  const args = { p_user_id: target.userId, p_email: target.email, p_name: 'ATTACK', p_role: identity === 'admin_aal2' ? 'user' : 'admin', p_is_active: true };
  await check({ identity, fn: 'admin_set_user', variant: 'promote self to admin / reactivate self', args, expected: identity === 'admin_aal2' ? 'open' : 'closed', ownerControl: identity === 'admin_aal2' });
}
// the deactivated user's row must still be inactive and the `user` still a user
console.log('post-check app_users:', sql(`select string_agg(email||':'||role||':'||is_active, ' ; ') from app_users where email like 'attack-%'`));

// =================================================================================================
// READ-SHAPED FUNCTIONS
// =================================================================================================
sql(`delete from opening_lines where batch_id in (select id from opening_batches where status='draft')`); sql(`delete from opening_batches where status='draft'`);
const ob = one(`insert into opening_batches (status) values ('draft') returning id`); sql(`insert into opening_lines (batch_id, kind, party_id, side, amount) values ('${ob}', 'party', '${C.kishore}', 'receivable', 12345)`);
await every('employee_pay_rates', '', async () => ({}), (id) => (id === 'admin_aal2' ? 'open' : 'empty'));
await every('trial_balance_asat', '', async () => ({ p_date: '2026-09-26' }), (id) => (id === 'admin_aal2' ? 'open' : 'empty'));
await every('pnl_range', '', async () => ({ p_from: '2026-04-01', p_to: '2026-09-30' }), (id) => (id === 'admin_aal2' ? 'open' : 'empty'));
await every('balance_sheet_asat', '', async () => ({ p_date: '2026-09-26' }), (id) => (id === 'admin_aal2' ? 'open' : 'empty'));
await every('opening_preview', '', async () => ({}), (id) => (id === 'admin_aal2' ? 'open' : 'empty'));
await every('current_app_role', '', async () => ({}), (id) => (id === 'user' || id === 'admin_aal2' ? 'open' : 'null'));
await every('is_active_member', '', async () => ({}), (id) => (id === 'user' || id === 'admin_aal2' ? 'open' : 'null'));
await every('day_close_preview', '', async () => ({ p_date: '2026-09-25' }), open(...USER));
sql(`delete from opening_lines where batch_id='${ob}'`); sql(`delete from opening_batches where id='${ob}'`);
await every('stock_on_hand', '', async () => ({ p_item: C.ppc, p_warehouse: C.head }), (id) => (id === 'user' || id === 'admin_aal2' ? 'open' : 'empty'));
await every('record_invoice_ewb', '', async () => ({ p_invoice_id: await fx.postedSales(), p_transport_mode: 'road', p_distance_km: 10, p_transporter_name: 'ATTACK', p_transporter_gstin: null, p_vehicle_no: 'AP39XX1234', p_ewb_no: '123456789012', p_ewb_date: '2026-09-26', p_ewb_valid_until: '2026-09-28T00:00:00Z' }), open(...USER));
// set_my_locale is a no-op (not an error) for a non-member, so judge by what it WROTE, not by the HTTP status.
for (const identity of ORDER) {
  const uid = IDS[identity].userId;
  if (uid) sql(`update app_users set locale='en' where user_id='${uid}'`);
  const out = await rpc(identity, 'set_my_locale', { p_locale: 'te' });
  const wrote = uid ? one(`select locale from app_users where user_id='${uid}'`) === 'te' : false;
  const mayWrite = USER.includes(identity);
  const verdict = mayWrite ? (out.ok && wrote ? 'PASS' : 'FAIL') : (wrote || (identity === 'anon' && out.ok) ? 'FAIL' : 'PASS');
  const rec = { identity, object: 'set_my_locale', op: 'RPC', variant: 'writes only for a member', req: `POST /rest/v1/rpc/set_my_locale {"p_locale":"te"}`, status: out.status, code: out.code, msg: out.msg.slice(0, 120), rows: out.nrows, expected: mayWrite ? 'writes' : 'no write', verdict, result: `locale written: ${wrote}` };
  if (identity === 'admin_aal2') { rec.control = true; record(rec); if (verdict !== 'PASS') ownerDeviations.push(rec); continue; }
  ran++; if (verdict === 'PASS') passed++; record(rec); if (verdict === 'FAIL') fails.push(rec);
}
await every('is_money_account', '(no grant to anyone)', async () => ({ p_account_id: C.cash }), () => 'closed');
await every('next_doc_no', '(internal; would burn an invoice number)', async () => ({ p_series: 'DN', p_date: '2026-09-26' }), () => 'closed');
await every('_post_sales_invoice', '(internal; skip_credit=true, override=true)', async () => ({ p_invoice_id: fx.mkSales({ party: C.ramesh, qty: 1, rate: 500000 }), p_skip_credit: true, p_override_credit: true }), () => 'closed');
await every('_gst_out_lines', '(internal)', async () => ({ p_from: '2026-04-01', p_to: '2026-09-30' }), () => 'closed');
// Helpers: INFO, except where a fix (attack-test F4/F5) says an identity must get nothing.
const NO_ONE = { gstin_checksum_ok: ['anon'], hidden_payroll_entry_ids: ['anon', 'admin_aal1', 'user_off'], hidden_payroll_voucher_ids: ['anon', 'admin_aal1', 'user_off'] };
for (const identity of ORDER) {
  for (const [fn, args] of [['gstin_checksum_ok', { g: '37AAACK1234A1Z9' }], ['gst_uqc', { p_uom: 'BAG' }], ['hidden_payroll_entry_ids', {}], ['hidden_payroll_voucher_ids', {}]]) {
    const out = await rpc(identity, fn, args);
    const strict = NO_ONE[fn]?.includes(identity);
    const leaked = out.ok && (Array.isArray(out.data) ? out.data.length > 0 : out.data === true);
    const verdict = strict ? (leaked ? 'FAIL' : 'PASS') : 'INFO';
    record({ identity, object: fn, op: 'RPC', variant: strict ? 'helper (closed)' : 'helper (info)', req: `POST /rest/v1/rpc/${fn} ${JSON.stringify(args)}`, status: out.status, code: out.code, msg: out.msg.slice(0, 120), rows: out.nrows, expected: strict ? 'closed' : 'info', verdict, result: out.ok ? JSON.stringify(out.data)?.slice(0, 160) : undefined });
    if (verdict === 'FAIL') fails.push({ identity, object: fn, op: 'RPC', status: out.status, msg: 'helper answered a no-one identity', verdict });
  }
}
// legacy anon JWT on every callable function (second anon shape)
for (const f of ['post_sales_invoice', 'post_payment', 'cancel_document', 'go_live_readiness', 'gstr1_data', 'admin_set_user', 'employee_pay_rates', 'post_day_close', 'set_period_lock']) {
  const r = await http('POST', `/rest/v1/rpc/${f}`, { token: LEGACY_ANON, apikey: LEGACY_ANON, body: {} });
  ran++; const refused = r.status >= 400; if (refused) passed++;
  record({ identity: 'anon(legacy-jwt)', object: f, op: 'RPC', variant: 'empty args', req: `POST /rest/v1/rpc/${f} {}`, status: r.status, code: errCode(r), msg: errMsg(r).slice(0, 120), expected: 'closed', verdict: refused ? 'PASS' : 'FAIL' });
  if (!refused) fails.push({ identity: 'anon(legacy-jwt)', object: f, op: 'RPC', status: r.status, msg: r.text.slice(0, 100), verdict: 'FAIL' });
}

// =================================================================================================
// DAY CLOSE ORDERING (user)
// =================================================================================================
{
  const prev = (d) => fx.ownerRpc('day_close_preview', { p_date: d });
  const dc = async (identity, d, counted = 0) => { const p = await rpc(identity, 'day_close_preview', { p_date: d }); const exp = p.ok && p.data?.[0]?.expected != null ? Number(p.data[0].expected) : null; return { p_date: d, p_counted: counted, p_note: 'attack test', p_expected_seen: exp }; };
  // clean any closes from earlier fixtures on the dates we use
  for (const identity of ['anon', 'admin_aal1', 'user_off']) {
    await check({ identity, fn: 'post_day_close', variant: 'sign-in level refusal', args: { p_date: '2026-09-24', p_counted: 0, p_note: 'x', p_expected_seen: 0 }, expected: 'closed' });
  }
  await check({ identity: 'user', fn: 'post_day_close', variant: 'in-order close 2026-09-24 (allowed)', args: await dc('user', '2026-09-24'), expected: 'open' });
  await check({ identity: 'user', fn: 'post_day_close', variant: 'OUT OF ORDER: 2026-09-22 after 2026-09-24 exists', args: await dc('user', '2026-09-22'), expected: 'closed', okAlt: /later_close_exists/ });
  await check({ identity: 'user', fn: 'post_day_close', variant: 'future date 2026-09-27', args: await dc('user', '2026-09-27'), expected: 'closed', okAlt: /future_date/ });
  await check({ identity: 'user', fn: 'post_day_close', variant: 'far future 2099-12-31', args: { p_date: '2099-12-31', p_counted: 0, p_note: 'x', p_expected_seen: 0 }, expected: 'closed', okAlt: /future_date|PERIOD_LOCKED/ });
  await check({ identity: 'user', fn: 'post_day_close', variant: 'same day twice', args: await dc('user', '2026-09-24'), expected: 'closed', okAlt: /already_closed/ });
  const closeId = one(`select id from day_closes where close_date='2026-09-24' and status<>'cancelled'`);
  await check({ identity: 'user', fn: 'cancel_document', variant: 'REOPEN 2026-09-24 close as user', args: { p_source_type: 'day_close', p_source_id: closeId || '00000000-0000-0000-0000-000000000000', p_reason: 'attack' }, expected: 'closed' });
  console.log('day close still posted after user reopen attempt:', one(`select status from day_closes where close_date='2026-09-24' order by created_at desc limit 1`));
  // owner control: out of order is allowed for the owner, and the owner can reopen
  await check({ identity: 'admin_aal2', fn: 'post_day_close', variant: 'OWNER out-of-order close 2026-09-22 (allowed)', args: await dc('admin_aal2', '2026-09-22'), expected: 'open', ownerControl: true });
  const c2 = one(`select id from day_closes where close_date='2026-09-22' and status<>'cancelled'`);
  await check({ identity: 'admin_aal2', fn: 'cancel_document', variant: 'OWNER reopens 2026-09-22 (allowed)', args: { p_source_type: 'day_close', p_source_id: c2 || '00000000-0000-0000-0000-000000000000', p_reason: 'control' }, expected: 'open', ownerControl: true });
}

fs.writeFileSync(OUT + '/fails-2.json', JSON.stringify(fails, null, 1));
fs.writeFileSync(OUT + '/owner-deviations-2.json', JSON.stringify(ownerDeviations, null, 1));
saveResults('results-2');
console.log(JSON.stringify({ ran, passed, inconclusive, fail: fails.filter((f) => f.verdict === 'FAIL').length, ownerDeviations: ownerDeviations.length }));
