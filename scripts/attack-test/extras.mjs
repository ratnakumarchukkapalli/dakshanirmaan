// Known-limit derivations, payroll leak probes, and auth-layer attacks (local stack only).
import fs from 'node:fs';
import { http, loadIdentities, record, saveResults, errCode, errMsg, PUB, LEGACY_ANON, signIn, enrollAndVerify, jwtClaims, totp, SECRET, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const { C, sql, one, rows } = fx;

const ids = loadIdentities();
if (Date.now() - ids.createdAt > 50 * 60 * 1000) throw new Error('tokens too old; rerun setup.mjs');
const IDS = ids.ids;
const tok = (k) => IDS[k].token;
const G = (identity, path, extra = {}) => http('GET', `/rest/v1/${path}`, { token: tok(identity), ...extra });
const sum = (arr, k) => arr.reduce((a, r) => a + Number(r[k] ?? 0), 0);
const out = [];
function rec(id, title, identity, req, actual, verdict, spec, note = '') {
  const r = { identity, object: id, op: 'PROBE', variant: title, req, actual, verdict, spec, note, expected: 'as spec' };
  out.push(r); record(r);
  console.log(`${verdict.padEnd(6)} ${id.padEnd(4)} ${title} => ${actual}`);
}

// ================================================================================================
// K. Known limits, made concrete (spec: db-architecture "Known limit (accepted for Phase 1)")
// ================================================================================================
{
  // K1: bank & cash balances: owner-only view vs what the counter can add up
  const bank = C.bank, cash = C.cash;
  const ownerMB = (await G('admin_aal2', 'v_money_balances?select=code,balance')).json;
  const userMB = (await G('user', 'v_money_balances?select=code,balance')).json;
  const lines = async (acct) => (await G('user', `journal_lines?account_id=eq.${acct}&select=debit,credit&limit=10000`)).json;
  const bl = await lines(bank), cl = await lines(cash);
  const derivedBank = sum(bl, 'debit') - sum(bl, 'credit'), derivedCash = sum(cl, 'debit') - sum(cl, 'credit');
  const oBank = Number(ownerMB.find((r) => r.code === '1120')?.balance), oCash = Number(ownerMB.find((r) => r.code === '1110')?.balance);
  rec('K1', "bank/cash balances: owner-only `v_money_balances` refuses the counter, but `journal_lines` on the bank/cash accounts adds up to the same number", 'user',
    `GET v_money_balances (0 rows) vs GET journal_lines?account_id=eq.<bank>&select=debit,credit`, `v_money_balances rows for user=${userMB.length}; user-derived bank=${derivedBank.toFixed(2)} (owner view ${oBank.toFixed(2)}); cash=${derivedCash.toFixed(2)} (owner view ${oCash.toFixed(2)}; gap = hidden payroll cash)`,
    Math.abs(derivedBank - oBank) < 0.01 ? 'KNOWN' : 'INFO', 'db-architecture Known limit + frontend-architecture: cash & bank book owner only', 'Payroll bank/cash legs are hidden; everything else is derivable.');
  // K2: P&L
  const inc = await G('user', `accounts?type=in.(income,expense)&select=id,code,name,type`); const acctType = Object.fromEntries(inc.json.map((a) => [a.id, a.type]));
  const jl = (await G('user', `journal_lines?select=account_id,debit,credit&limit=10000`)).json;
  const profit = jl.reduce((a, r) => (acctType[r.account_id] === 'income' ? a + Number(r.credit) - Number(r.debit) : acctType[r.account_id] === 'expense' ? a - (Number(r.debit) - Number(r.credit)) : a), 0);
  const ownerPnl = (await G('admin_aal2', 'v_pnl?select=profit_effect&limit=10000')).json; const userPnl = (await G('user', 'v_pnl?select=profit_effect&limit=10000')).json;
  rec('K2', 'profit & loss: `v_pnl` refuses the counter but income/expense lines are readable and add to the same profit', 'user', `GET v_pnl (rows=${userPnl.length}) vs GET accounts + journal_lines`,
    `v_pnl rows for user=${userPnl.length}; user-derived net profit=${profit.toFixed(2)}; owner v_pnl profit=${sum(ownerPnl, 'profit_effect').toFixed(2)} (gap = hidden payroll)`, 'KNOWN', 'db-architecture Known limit: "Revisit before go-live"', 'The `v_pnl`/`v_balance_sheet`/`v_trial_balance` gates are view-level only.');
  // K3: stock cost. CLOSED by change 28 (owner-only in the database): the counter's request that names rate/value is refused,
  // and the cost columns of the stock views are NULL for a counter. This row is a regression check, no longer a known limit.
  const smCost = await G('user', 'stock_movements?select=item_id,qty,rate,value&limit=5');
  const smStar = await G('user', 'stock_movements?select=*&limit=5');
  const smQty = await G('user', 'stock_movements?select=item_id,qty&limit=5');
  const ss = (await G('user', 'v_stock_summary?select=*&limit=50')).json;
  const costCols = Array.isArray(ss) && ss[0] ? Object.keys(ss[0]).filter((c) => /rate|value|cost/i.test(c)) : [];
  const costLeak = Array.isArray(ss) ? ss.filter((r) => costCols.some((c) => r[c] !== null && r[c] !== undefined)).length : -1;
  const k3ok = smCost.status >= 400 && smStar.status >= 400 && smQty.status < 300 && Array.isArray(ss) && costLeak === 0;
  rec('K3', 'stock COST (change 28): `stock_movements.rate/value` refused to the counter; cost columns of `v_stock_summary` are NULL', 'user', `GET stock_movements?select=rate,value; select=*; GET v_stock_summary`,
    `rate,value => ${smCost.status} ${errCode(smCost)}; select=* => ${smStar.status} ${errCode(smStar)}; qty columns => ${smQty.status}; v_stock_summary cost columns [${costCols.join(',')}] non-null rows=${costLeak}`, k3ok ? 'PASS' : 'FAIL',
    'change 28: stock cost owner-only in the database (STATUS.md owner decision 1)', 'Residual derivation of cost from purchase documents is K4 (accepted).');
  const pil = (await G('user', 'purchase_invoice_lines?select=item_name,rate&limit=2')).json;
  const soh = (await http('POST', '/rest/v1/rpc/stock_on_hand', { token: tok('user'), body: { p_item: C.ppc, p_warehouse: C.head } })).json;
  rec('K4', 'supplier cost prices and payables readable by the counter', 'user', `GET purchase_invoice_lines?select=item_name,rate; rpc stock_on_hand`, `purchase line rate=${JSON.stringify(pil[0])}; stock_on_hand (cost is NULL for a counter since change 28)=${JSON.stringify(soh)}`, 'KNOWN', 'same owner decision 1 (cost hidden from counter); dashboard "To pay" is hidden in the UI by default only', 'Accepted residual (report K1-K4).');
  // K5: day_closes inference
  const wagesDay = one(`select voucher_date from expense_vouchers where voucher_type='wages' and status='posted' order by voucher_date desc limit 1`);
  const wages = one(`select sum(l.amount) from expense_voucher_lines l join expense_vouchers v on v.id=l.voucher_id where v.voucher_type='wages' and v.status='posted' and v.voucher_date='${wagesDay}'`);
  const prev = (await http('POST', '/rest/v1/rpc/day_close_preview', { token: tok('user'), body: { p_date: wagesDay } })).json?.[0];
  const cashLines = (await G('user', `journal_lines?account_id=eq.${C.cash}&select=credit,journal_entries!inner(entry_date)&journal_entries.entry_date=eq.${wagesDay}&limit=5000`)).json;
  const visibleOut = Array.isArray(cashLines) ? sum(cashLines, 'credit') : NaN;
  rec('K5', 'payroll cash inferred from the day-close preview (visible cash-out vs previewed cash-out)', 'user', `rpc day_close_preview(${wagesDay}) vs GET journal_lines on cash for that day`, `preview cash_out=${prev?.cash_out} vs visible cash credits=${visibleOut}; wages voucher that day=${wages}`, Math.abs(Number(prev?.cash_out) - visibleOut - Number(wages)) < 1 ? 'KNOWN' : 'INFO',
    'db-architecture clarification (a): "inference only ... reveals that net amount paid, not to whom"', '');
}

// ================================================================================================
// P. Payroll: nothing about salary/wages/pay rates may reach a counter user
// ================================================================================================
{
  const chk = async (id, title, path, identity = 'user', want = 0, spec = 'db-architecture clarification: owner-only salary data (change 13)') => {
    const r = await G(identity, path);
    const n = Array.isArray(r.json) ? r.json.length : -1;
    const ok = r.status === 401 || r.status === 403 || (n === want);
    rec(id, title, identity, `GET /rest/v1/${path}`, `${r.status}${errCode(r) ? ' ' + errCode(r) : ''} rows=${n}`, ok ? 'PASS' : 'FAIL', spec);
  };
  await chk('P1', 'salary/wages expense vouchers', 'expense_vouchers?voucher_type=in.(salary,wages)&select=id,voucher_type');
  await chk('P2', 'salary/wages voucher lines (embedded through the header)', 'expense_voucher_lines?select=id,expense_vouchers!inner(voucher_type)&expense_vouchers.voucher_type=in.(salary,wages)');
  const ownerSalEntries = one(`select count(*) from journal_entries e join expense_vouchers v on v.id=e.source_id where e.source_type='expense_voucher' and v.voucher_type in ('salary','wages')`);
  await chk('P3', `journal entries sourced from salary/wages vouchers (owner sees ${ownerSalEntries})`, `journal_entries?source_type=eq.expense_voucher&select=id,source_id,narration&limit=1000`, 'user', Number(one(`select count(*) from journal_entries e join expense_vouchers v on v.id=e.source_id where e.source_type='expense_voucher' and v.voucher_type='expense'`)) + Number(one(`select count(*) from journal_entries e join expense_vouchers v on v.id=e.source_id where e.source_type='expense_voucher' and v.voucher_type='advance'`)));
  const sp = C.salariesAcct;
  const salLines = await G('user', `journal_lines?select=debit,credit,account_id&account_id=in.(${sp},${one(`select id from accounts where system_key='salary_payable'`)})`);
  rec('P4', 'ledger lines on the Salaries (5500) / Salary payable accounts', 'user', 'GET journal_lines?account_id=in.(<salaries>,<salary_payable>)', `rows=${salLines.json?.length}`, (salLines.json?.length ?? 0) === 0 ? 'PASS' : 'FAIL', 'db-architecture clarification: payroll ledger rows owner-only');
  await chk('P5', 'audit trail rows of salary/wages vouchers', `audit_log?entity=eq.expense_vouchers&select=id,after&limit=1000`, 'user', Number(one(`select count(*) from audit_log where entity='expense_vouchers' and entity_id not in (select id from expense_vouchers where voucher_type in ('salary','wages'))`)));
  await chk('P6', 'employee pay-rate columns on parties', 'parties?select=monthly_salary,daily_wage', 'user', -1);
  await chk('P7', 'pay-rate as a filter oracle (parties?monthly_salary=gt.0)', 'parties?monthly_salary=gt.0&select=id', 'user', -1);
  await chk('P8', 'v_employees (staff list with pay)', 'v_employees?select=*', 'user', 0);
  await chk('P9', 'v_employee_ledger (advance/salary ledger)', 'v_employee_ledger?select=*', 'user', 0);
  const dbk = await G('user', 'v_day_book?select=*&limit=1000'); const leak = (dbk.json || []).filter((r) => /salary|wage/i.test(JSON.stringify(r)));
  rec('P10', 'day book rows that mention salary/wages', 'user', 'GET v_day_book', `rows=${dbk.json?.length}; matching salary|wage=${leak.length}`, leak.length === 0 ? 'PASS' : 'FAIL', 'db-architecture clarification: v_day_book has no payroll rows for a user');
  const dref = await G('user', 'v_document_refs?select=*&limit=1000'); const leak2 = (dref.json || []).filter((r) => /salary|wage/i.test(JSON.stringify(r)));
  rec('P11', 'v_document_refs rows for salary/wages vouchers', 'user', 'GET v_document_refs', `rows=${dref.json?.length}; matching=${leak2.length}`, leak2.length === 0 ? 'PASS' : 'FAIL', 'same');
  const ep = await http('POST', '/rest/v1/rpc/employee_pay_rates', { token: tok('user'), body: {} });
  rec('P12', 'employee_pay_rates()', 'user', 'POST rpc/employee_pay_rates', `${ep.status} rows=${ep.json?.length}`, (ep.json?.length ?? 0) === 0 ? 'PASS' : 'FAIL', 'same');
  const hid = await http('POST', '/rest/v1/rpc/hidden_payroll_entry_ids', { token: tok('user'), body: {} });
  rec('P13', 'hidden_payroll_entry_ids(): the counter can list the ids of hidden payroll entries', 'user', 'POST rpc/hidden_payroll_entry_ids', `${hid.status} returned ${hid.json?.length ?? 0} ids`, (hid.json?.length ?? 0) > 0 ? 'KNOWN' : 'PASS', 'db-architecture clarification (b): reveals that hidden entries exist, never amounts', 'Also callable by an aal1 admin and a deactivated user (see P14).');
  for (const who of ['admin_aal1', 'user_off']) {
    const h = await http('POST', '/rest/v1/rpc/hidden_payroll_entry_ids', { token: tok(who), body: {} });
    rec('P14', 'hidden_payroll_entry_ids() for a no-one identity', who, 'POST rpc/hidden_payroll_entry_ids', `${h.status} returned ${h.json?.length ?? 0} ids`, (h.json?.length ?? 0) > 0 ? 'FAIL' : 'PASS', 'change 19: an admin below aal2 / a deactivated user is no-one', 'ids only, no amounts');
  }
}

// ================================================================================================
// M. Auth layer (GoTrue): can an aal1 admin get to aal2 without the authenticator?
// ================================================================================================
{
  const a1 = IDS.admin_aal1;
  // M1: enrol a NEW factor while at aal1 (the owner already has a verified one)
  const en = await http('POST', '/auth/v1/factors', { token: a1.token, body: { factor_type: 'totp', friendly_name: 'attacker' } });
  let aal = 'n/a', step = `enroll ${en.status} ${errCode(en)} ${errMsg(en).slice(0, 80)}`;
  if (en.status === 200) {
    const secret = en.json.totp.secret; const fid = en.json.id;
    const ch = await http('POST', `/auth/v1/factors/${fid}/challenge`, { token: a1.token, body: {} });
    const v = await http('POST', `/auth/v1/factors/${fid}/verify`, { token: a1.token, body: { challenge_id: ch.json.id, code: totp(secret) } });
    step += `; verify ${v.status} ${errMsg(v).slice(0, 60)}`;
    if (v.status === 200) {
      aal = jwtClaims(v.json.access_token).aal;
      // and use it
      const use = await http('POST', '/rest/v1/rpc/go_live_readiness', { token: v.json.access_token, body: {} });
      step += `; new token aal=${aal}; go_live_readiness (owner-only) with it => ${use.status}`;
    }
  }
  rec('M1', 'aal1 admin (password only) enrols a NEW authenticator factor and verifies it to obtain an aal2 token', 'admin_aal1', 'POST /auth/v1/factors, /challenge, /verify with the aal1 access token', step, aal === 'aal2' ? 'FAIL' : 'PASS',
    'change 19: an admin who has not passed the authenticator step is no-one', 'If FAIL: the password alone is enough to become aal2 - change 19 protects nothing against a stolen owner password.');
  // M2: unenrol the verified factor at aal1
  const un = await http('DELETE', `/auth/v1/factors/${a1.factorId}`, { token: a1.token });
  rec('M2', 'aal1 admin removes the owner\'s existing verified factor (DELETE /auth/v1/factors/{id})', 'admin_aal1', `DELETE /auth/v1/factors/${a1.factorId}`, `${un.status} ${errMsg(un).slice(0, 100)}`, un.status < 300 ? 'FAIL' : 'PASS', 'change 19', 'Removing the factor at aal1 would let the attacker enrol their own (M1) or keep aal1 access to nothing.');
  // M3: refresh keeps aal1
  const rf = await http('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: a1.refresh } });
  rec('M3', 'refresh token of the aal1 session', 'admin_aal1', 'POST /auth/v1/token?grant_type=refresh_token', `${rf.status} aal=${rf.status === 200 ? jwtClaims(rf.json.access_token).aal : '-'}`, rf.status === 200 && jwtClaims(rf.json.access_token).aal === 'aal2' ? 'FAIL' : 'PASS', 'change 19');
  // M4: signup / OTP creation
  const su = await http('POST', '/auth/v1/signup', { body: { email: `attacker-${Date.now()}@attack.test`, password: 'Attack-Test-Local-1' } });
  rec('M4', 'public sign-up', 'anon', 'POST /auth/v1/signup', `${su.status} ${errCode(su)} ${errMsg(su).slice(0, 80)}`, su.status >= 400 ? 'PASS' : 'FAIL', 'db-architecture: public signup SHALL be disabled');
  const otp = await http('POST', '/auth/v1/otp', { body: { email: `attacker2-${Date.now()}@attack.test`, create_user: true } });
  rec('M5', 'sign-up through the email OTP endpoint (create_user=true)', 'anon', 'POST /auth/v1/otp {create_user:true}', `${otp.status} ${errCode(otp)} ${errMsg(otp).slice(0, 80)}`, otp.status >= 400 ? 'PASS' : 'FAIL', 'db-architecture: public signup SHALL be disabled');
  const anonUser = await http('POST', '/auth/v1/signup', { body: {} });
  rec('M6', 'anonymous sign-in', 'anon', 'POST /auth/v1/signup {} (anonymous)', `${anonUser.status} ${errMsg(anonUser).slice(0, 80)}`, anonUser.status >= 400 ? 'PASS' : 'FAIL', 'security-deployment: no OAuth/anonymous accounts');
  // M7: user rewrites their own metadata; must not change the role the database sees
  const upd = await http('PUT', '/auth/v1/user', { token: tok('user'), body: { data: { role: 'admin', aal: 'aal2' } } });
  const me = await http('POST', '/rest/v1/rpc/current_app_role', { token: tok('user'), body: {} });
  const rr = await http('POST', '/rest/v1/rpc/go_live_readiness', { token: tok('user'), body: {} });
  rec('M7', 'user edits own user_metadata to {role:admin, aal:aal2} (self-service auth API)', 'user', 'PUT /auth/v1/user {data:{role:"admin",aal:"aal2"}}', `update ${upd.status}; current_app_role=${JSON.stringify(me.json)}; go_live_readiness ${rr.status} ${errMsg(rr).slice(0, 40)}`, rr.status < 300 ? 'FAIL' : 'PASS', 'db-architecture: role comes from app_users only');
  // M8: deactivated user: the auth layer still hands out sessions; the database must treat them as no-one
  const off = IDS.user_off;
  const s = await http('POST', '/auth/v1/token?grant_type=password', { body: { email: off.email, password: ids.password } });
  const who = await http('GET', '/auth/v1/user', { token: tok('user_off') });
  rec('M8', 'deactivated user can still sign in and hold a valid session (only the database refuses them)', 'user_off', 'POST /auth/v1/token (password) and GET /auth/v1/user', `sign-in ${s.status}; /auth/v1/user with old token ${who.status}`, 'INFO', 'db-architecture: deactivation is is_active=false', 'By design the block is in the database (matrix shows every table/function refuses). Consider also banning the auth user when deactivating so no fresh token is issued.');
  // M9: GraphQL and OpenAPI surface
  const gq = await http('POST', '/graphql/v1', { body: { query: '{ __schema { queryType { fields { name } } } }' } });
  const nFieldsAnon = gq.json?.data?.__schema?.queryType?.fields?.length;
  const gqU = await http('POST', '/graphql/v1', { token: tok('user_off'), body: { query: '{ salesInvoicesCollection(first: 3) { edges { node { id invoiceNo grandTotal } } } }' } });
  const gqA = await http('POST', '/graphql/v1', { body: { query: '{ salesInvoicesCollection(first: 3) { edges { node { id } } } }' } });
  const gqM = await http('POST', '/graphql/v1', { token: tok('admin_aal1'), body: { query: 'mutation { insertIntoSalesInvoicesCollection(objects: [{invoiceDate: "2026-09-26", partyId: "' + C.kishore + '", placeOfSupply: "37", warehouseId: "' + C.head + '", status: "draft"}]) { affectedCount } }' } });
  rec('M9', 'GraphQL endpoint (pg_graphql): schema for anon; query as deactivated user; mutation as aal1 admin', 'anon', 'POST /graphql/v1', `anon introspection fields=${nFieldsAnon ?? 'refused ' + gq.status}; anon query rows=${JSON.stringify(gqA.json?.data ?? gqA.json?.errors?.[0]?.message)?.slice(0, 80)}; deactivated user rows=${JSON.stringify(gqU.json?.data ?? gqU.json?.errors?.[0]?.message)?.slice(0, 90)}; aal1 mutation=${JSON.stringify(gqM.json?.data ?? gqM.json?.errors?.[0]?.message)?.slice(0, 90)}`,
    (nFieldsAnon ?? 0) > 0 || gqM.json?.data?.insertIntoSalesInvoicesCollection?.affectedCount > 0 ? 'FAIL' : 'PASS', 'db-architecture: anon holds no privileges; RLS applies to every API');
  const oa = await http('GET', '/rest/v1/', { apikey: PUB });
  const paths = oa.json?.paths ? Object.keys(oa.json.paths).length : -1;
  const oaU = await http('GET', '/rest/v1/', { token: tok('user') });
  rec('M10', 'OpenAPI document (GET /rest/v1/): what an unauthenticated caller learns about the schema', 'anon', 'GET /rest/v1/ with apikey only', `anon status ${oa.status} paths=${paths}; user paths=${oaU.json?.paths ? Object.keys(oaU.json.paths).length : -1}`, paths > 1 ? 'FAIL' : 'PASS', 'db-architecture: anon holds no privileges', 'PostgREST lists only what the role can see; anon sees none.');
  const plan = await http('GET', '/rest/v1/sales_invoices?select=id', { token: tok('user'), headers: { Accept: 'application/vnd.pgrst.plan' } });
  rec('M11', 'EXPLAIN plan header (Accept: application/vnd.pgrst.plan)', 'user', 'GET sales_invoices with Accept vnd.pgrst.plan', `${plan.status}`, plan.status === 200 ? 'FAIL' : 'PASS', 'hardening: the query plan reveals policy expressions');
  const nx = await http('GET', '/rest/v1/sales_invoices', { apikey: PUB }); const ne = await http('GET', '/rest/v1/no_such_table_xyz', { apikey: PUB });
  rec('M12', 'table-name enumeration: an unauthenticated caller can tell existing tables (401) from missing ones (404)', 'anon', 'GET /rest/v1/sales_invoices vs /rest/v1/no_such_table_xyz', `existing => ${nx.status} ${errCode(nx)}; missing => ${ne.status} ${errCode(ne)}`, nx.status !== ne.status ? 'INFO' : 'PASS', 'hardening', 'Standard PostgREST behaviour; table names are in the open-source repo anyway.');
  // storage
  const st = await http('GET', '/storage/v1/bucket', { apikey: PUB });
  rec('M13', 'Storage API buckets for anon', 'anon', 'GET /storage/v1/bucket', `${st.status} ${JSON.stringify(st.json)?.slice(0, 80)}`, Array.isArray(st.json) && st.json.length > 0 ? 'FAIL' : 'PASS', 'no buckets are configured');
}

fs.writeFileSync(OUT + '/findings-4.json', JSON.stringify(out, null, 1));
saveResults('results-4');
console.log(JSON.stringify({ probes: out.length, fail: out.filter((x) => x.verdict === 'FAIL').length, known: out.filter((x) => x.verdict === 'KNOWN').length }));
