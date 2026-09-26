// Tamper tests: what can a counter `user` push THROUGH the doors that are open to them?
import fs from 'node:fs';
import { http, loadIdentities, record, saveResults, errCode, errMsg, OUT, REPO } from './lib.mjs';
import * as fx from './fx.mjs';
const { C, sql, one, rows } = fx;

const IDS = loadIdentities().ids;
if (Date.now() - loadIdentities().createdAt > 50 * 60 * 1000) throw new Error('tokens too old; rerun setup.mjs');
const tok = (k) => IDS[k].token;
const U = (m, p, b, h = {}) => http(m, `/rest/v1/${p}`, { token: tok('user'), body: b, headers: { Prefer: 'return=representation', ...h } });
const rpcAs = (identity, fn, args) => http('POST', `/rest/v1/rpc/${fn}`, { token: tok(identity), body: args });
const dn = (r) => (r.json?.message ?? r.text ?? '').toString().slice(0, 90);
const short = (r) => `${r.status}${errCode(r) ? ' ' + errCode(r) : ''}${r.status >= 400 ? ' ' + dn(r) : ''}`;

let n = 0, bad = 0;
const findings = [];
async function t(id, title, spec, fn) {
  n++;
  let res;
  try { res = await fn(); } catch (e) { res = { req: '(script error)', actual: String(e.message).slice(0, 200), bad: null, note: 'script error - investigate' }; }
  const verdict = res.bad === null ? 'INCONCLUSIVE' : res.bad ? 'FAIL' : 'PASS';
  if (verdict === 'FAIL') bad++;
  const rec = { identity: 'user', object: id, op: 'TAMPER', variant: title, req: res.req, actual: res.actual, spec, verdict, note: res.note || '', expected: 'refused / no effect' };
  record(rec);
  if (verdict !== 'PASS') findings.push(rec);
  console.log(`${verdict.padEnd(12)} ${id.padEnd(6)} ${title} => ${res.actual}`);
}
const post = (id, override = false) => rpcAs('user', 'post_sales_invoice', { p_invoice_id: id, p_override_credit: override });
const posted = (id) => rows(`select invoice_no, status, place_of_supply, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, journal_entry_id, created_by, buyer_gstin, challan_id from sales_invoices where id='${id}'`)[0];

// -------------------------------------------------------------------------------------------------
// A. Posted documents: change amounts / status / lines / journal (each on a FRESH posted doc)
// -------------------------------------------------------------------------------------------------
{
  const inv = await fx.postedSales();
  const before = posted(inv);
  const r1 = await U('PATCH', `sales_invoices?id=eq.${inv}`, { grand_total: 1, taxable_total: 1, cgst_total: 0, sgst_total: 0 });
  const r2 = await U('PATCH', `sales_invoices?id=eq.${inv}`, { status: 'draft' });
  const r3 = await U('PATCH', `sales_invoices?id=eq.${inv}`, { status: 'cancelled' });
  const r4 = await U('PATCH', `sales_invoice_lines?invoice_id=eq.${inv}`, { qty: 999, rate: 1 });
  const r5 = await U('DELETE', `sales_invoice_lines?invoice_id=eq.${inv}`);
  const r6 = await U('DELETE', `sales_invoices?id=eq.${inv}`);
  const after = posted(inv);
  const same = JSON.stringify(before) === JSON.stringify(after);
  await t('A1', 'change a POSTED invoice: amounts, status->draft, status->cancelled, lines, delete', 'db-architecture: posted documents immutable; INSERT/UPDATE on draft documents only',
    () => ({ req: `PATCH/DELETE sales_invoices?id=eq.${inv} and sales_invoice_lines?invoice_id=eq.${inv}`, actual: `amounts:${short(r1)} rows=${r1.json?.length ?? 0}; status->draft:${short(r2)} rows=${r2.json?.length ?? 0}; ->cancelled:${short(r3)} rows=${r3.json?.length ?? 0}; lines:${short(r4)} rows=${r4.json?.length ?? 0}; del lines rows=${r5.json?.length ?? 0}; del header rows=${r6.json?.length ?? 0}; row unchanged=${same}`, bad: !same }));
  // journal of that invoice
  const je = before.journal_entry_id;
  const j1 = await U('PATCH', `journal_lines?entry_id=eq.${je}`, { debit: 0, credit: 0 });
  const j2 = await U('DELETE', `journal_entries?id=eq.${je}`);
  const j3 = await U('PATCH', `journal_entries?id=eq.${je}`, { status: 'cancelled' });
  const cnt = one(`select count(*) from journal_lines where entry_id='${je}'`);
  await t('A2', "rewrite the posted invoice's journal (update lines, delete/cancel entry)", 'security-deployment: ledger tables have no direct write grants to any role',
    () => ({ req: `PATCH journal_lines?entry_id=eq.${je}; DELETE/PATCH journal_entries?id=eq.${je}`, actual: `lines:${short(j1)}; delete:${short(j2)}; cancel:${short(j3)}; lines still there=${cnt}`, bad: [j1, j2, j3].some((x) => x.status < 300 && x.json?.length > 0) || Number(cnt) === 0 }));
}

// -------------------------------------------------------------------------------------------------
// B. Draft tampering, then POST as the counter user
// -------------------------------------------------------------------------------------------------
{
  // B1 place_of_supply
  const d = fx.mkSales({ party: C.kishore });
  const p = await U('PATCH', `sales_invoices?id=eq.${d}`, { place_of_supply: '36' });
  const pr = await post(d);
  const row = posted(d);
  await t('B1', 'set place_of_supply on a draft (party is in state 37, set 36), then post', 'db-architecture posting: tax recomputed from snapshots and place of supply; client totals ignored',
    () => ({ req: `PATCH /rest/v1/sales_invoices?id=eq.${d} {"place_of_supply":"36"} ; rpc post_sales_invoice`, actual: `patch ${short(p)} rows=${p.json?.length ?? 0}; post ${short(pr)}; posted place_of_supply=${row?.place_of_supply} cgst=${row?.cgst_total} sgst=${row?.sgst_total} igst=${row?.igst_total}`, bad: p.status < 300 && (p.json?.length ?? 0) > 0 && Number(row?.igst_total) > 0, note: 'Fixed by change 27: post_sales_invoice derives place_of_supply (delivery state, else the party state). Effect tested: does an inter-state tax split reach the ledger for an in-state customer?' }));
  // B2 server-owned columns
  const d2 = fx.mkSales({ party: C.kishore });
  const oldEntry = one(`select id from journal_entries where source_type='sales_invoice' order by created_at limit 1`);
  const p2 = await U('PATCH', `sales_invoices?id=eq.${d2}`, { invoice_no: 'DN/26-27/9999', journal_entry_id: oldEntry, created_by: IDS.admin_aal2.userId, grand_total: 1, taxable_total: 1, cgst_total: 0, sgst_total: 0, round_off: 99, buyer_gstin: '37AAACK1234A1Z9' });
  const pr2 = await post(d2);
  const row2 = posted(d2);
  const expectTotal = one(`select round(sum(l.qty*l.rate*(1-coalesce(l.discount_pct,0)/100)*(1+l.gst_rate/100)))::text from sales_invoice_lines l where l.invoice_id='${d2}'`);
  await t('B2', 'forge server-owned columns on a draft (invoice_no, journal_entry_id, created_by, totals, round_off, buyer_gstin), then post', 'db-architecture: numbers assigned inside the posting function; totals recomputed; buyer GSTIN snapshot set by trigger at post',
    () => ({ req: `PATCH sales_invoices?id=eq.${d2} {invoice_no,journal_entry_id,created_by,grand_total,taxable_total,cgst_total,sgst_total,round_off,buyer_gstin}; post`, actual: `patch ${short(p2)} rows=${p2.json?.length ?? 0}; post ${short(pr2)}; invoice_no=${row2?.invoice_no} grand_total=${row2?.grand_total} (recomputed expected ~${expectTotal}) round_off=${row2?.round_off} entry=${row2?.journal_entry_id === oldEntry ? 'FORGED ENTRY' : 'own'} created_by=${row2?.created_by === IDS.admin_aal2.userId ? 'owner (FORGED)' : row2?.created_by === IDS.user.userId ? 'user' : row2?.created_by} buyer_gstin=${row2?.buyer_gstin}`,
      bad: row2?.status === 'posted' && (row2.invoice_no === 'DN/26-27/9999' || row2.journal_entry_id === oldEntry || Number(row2.grand_total) === 1 || Number(row2.round_off) === 99), note: 'created_by forgery is tested separately (B3b)' }));
}
{
  const dd = fx.mkSales();
  const p = await U('PATCH', `sales_invoices?id=eq.${dd}`, { created_by: IDS.admin_aal2.userId });
  const ins = await U('POST', 'sales_invoices', { invoice_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', warehouse_id: C.head, status: 'draft', created_by: IDS.admin_aal2.userId });
  const cb = ins.json?.[0]?.created_by;
  // replace the placeholder B3 record with the real one
  await t('B3b', 'forge created_by on a draft (PATCH) and on INSERT', 'db-architecture: created_by UUID REFERENCES auth.users (attribution)',
    () => ({ req: `PATCH sales_invoices?id=eq.${dd} {"created_by":"<owner uid>"}; POST sales_invoices {...,"created_by":"<owner uid>"}`, actual: `patch ${short(p)} rows=${p.json?.length ?? 0} created_by=${p.json?.[0]?.created_by === IDS.admin_aal2.userId ? 'OWNER (forged)' : p.json?.[0]?.created_by}; insert ${short(ins)} created_by=${cb === IDS.admin_aal2.userId ? 'OWNER (forged)' : cb}`, bad: p.json?.[0]?.created_by === IDS.admin_aal2.userId || cb === IDS.admin_aal2.userId }));
}
{
  // B4 challan_id tamper: point a draft invoice at someone else's un-invoiced challan and post
  const ch = fx.mkChallan();
  const rc = await fx.ownerRpc('post_delivery_challan', { p_challan_id: ch });
  const d = fx.mkSales({ party: C.amaravati });
  const p = await U('PATCH', `sales_invoices?id=eq.${d}`, { challan_id: ch });
  const pr = await post(d);
  const chRow = rows(`select status, invoice_id from delivery_challans where id='${ch}'`)[0];
  await t('B4', "point a draft invoice (party Amaravati) at Kishore's un-billed challan (challan_id) and post", 'db-architecture: a challan is converted only by an invoice for the same party/goods; challans stay un-invoiced until billed',
    () => ({ req: `PATCH sales_invoices?id=eq.${d} {"challan_id":"${ch}"}; post`, actual: `patch ${short(p)} rows=${p.json?.length ?? 0}; post ${short(pr)}; challan invoice_id=${chRow?.invoice_id ?? 'null'} status=${chRow?.status}`, bad: pr.status < 300 && chRow?.invoice_id === d, note: 'A challan that is marked billed by an unrelated invoice drops out of the un-billed attention list while the goods it dispatched were never invoiced.' }));
}
{
  // B5 line tampering (each on a fresh draft, patch the single line, then post)
  const variants = [
    ['gst_rate 18 -> 0', { gst_rate: 0 }, (r) => Number(r.cgst_total) + Number(r.sgst_total) + Number(r.igst_total) === 0],
    ['qty -> -10 (negative sale)', { qty: -10 }, (r) => Number(r.grand_total) < 0],
    ['rate -> -350', { rate: -350 }, (r) => Number(r.grand_total) < 0],
    ['discount_pct -> 150', { discount_pct: 150 }, (r) => Number(r.grand_total) < 0],
    ['discount_pct -> -50 (markup)', { discount_pct: -50 }, () => false],
    ['qty -> 0', { qty: 0 }, (r) => true],
    ['taxable_value forged to 1', { taxable_value: 1 }, (r) => Number(r.taxable_total) === 1],
    ['hsn_code/item_name garbage', { hsn_code: 'ZZZZ', item_name: 'FORGED NAME' }, () => 'name'],
    ['qty 1e9 (overflow / absurd)', { qty: 1000000000 }, (r) => true],
    ['rate 0.00001 (sub-paisa)', { rate: 0.00001 }, (r) => true],
  ];
  for (const [title, patch, isBad] of variants) {
    const d = fx.mkSales({ party: C.amaravati });
    const p = await U('PATCH', `sales_invoice_lines?invoice_id=eq.${d}`, patch);
    const pr = await post(d);
    const row = posted(d);
    const stockAfter = one(`select coalesce(sum(qty),0) from stock_movements where source_id='${d}'`);
    let violation = false, extra = '';
    if (p.status < 300 && pr.status < 300 && row?.status === 'posted') {
      const v = isBad(row);
      if (v === 'name') { const ln = rows(`select item_name, hsn_code from sales_invoice_lines where invoice_id='${d}'`)[0]; violation = ln.item_name === 'FORGED NAME' || ln.hsn_code === 'ZZZZ'; extra = ` line snapshot: name=${ln.item_name} hsn=${ln.hsn_code}`; }
      else violation = !!v;
    }
    await t('B5', `line tamper on draft then post: ${title}`, 'db-architecture posting: snapshots re-read from items at post time; tax recomputed; stock never negative; sane quantities/rates',
      () => ({ req: `PATCH sales_invoice_lines?invoice_id=eq.${d} ${JSON.stringify(patch)}; post_sales_invoice`, actual: `patch ${short(p)}; post ${short(pr)}${pr.status < 300 ? `; posted total=${row.grand_total} taxable=${row.taxable_total} cgst=${row.cgst_total} igst=${row.igst_total} stock_qty_moved=${stockAfter}` : ''}${extra}`, bad: violation }));
  }
}
{
  // B6 header tamper
  const dW = fx.mkSales({ party: C.amaravati });
  await U('PATCH', `sales_invoices?id=eq.${dW}`, { warehouse_id: C.transit });
  const prW = await post(dW);
  await t('B6', 'post an invoice out of the hidden In Transit warehouse', 'db-architecture: transit warehouse refused for sales', () => ({ req: `PATCH sales_invoices?id=eq.${dW} {"warehouse_id":"<transit>"}; post`, actual: `post ${short(prW)}`, bad: prW.status < 300 }));
  const dS = fx.mkSales({ party: C.krishna });
  const prS = await post(dS);
  await t('B7', 'sell to a SUPPLIER-type party', 'db-architecture posting: party must be an active customer/both', () => ({ req: `post_sales_invoice on draft with party=Krishna Cement (supplier)`, actual: `post ${short(prS)}`, bad: prS.status < 300 }));
  const inactive = one(`insert into parties (name, type, state_code, is_active) values ('ATTACK-INACTIVE-${Date.now()}', 'customer', '37', false) returning id`);
  const dI = fx.mkSales({ party: inactive });
  const prI = await post(dI);
  await t('B8', 'sell to an INACTIVE customer', 'db-architecture posting: party is_active', () => ({ req: `post_sales_invoice on draft with an inactive party`, actual: `post ${short(prI)}`, bad: prI.status < 300 }));
  // double / cancelled re-post
  const dD = fx.mkSales({ party: C.amaravati });
  const first = await post(dD); const second = await post(dD);
  await t('B9', 'post the same invoice twice', 'db-architecture: idempotent on non-draft (DN_NOT_DRAFT)', () => ({ req: 'post_sales_invoice x2', actual: `first ${short(first)}; second ${short(second)}`, bad: !(first.status < 300 && second.status >= 400 && /DN_NOT_DRAFT/.test(dn(second))) }));
  const dC = await fx.postedSales({ party: C.amaravati });
  await fx.ownerRpc('cancel_document', { p_source_type: 'sales_invoice', p_source_id: dC, p_reason: 'fixture' });
  const rp = await post(dC);
  await t('B10', 'post a CANCELLED invoice again', 'db-architecture: only drafts post', () => ({ req: 'post_sales_invoice on a cancelled invoice', actual: `post ${short(rp)}`, bad: rp.status < 300 }));
}
{
  // B11 period lock: locked month and a month with no period row
  const dL = fx.mkSales({ party: C.amaravati });
  sql(`update sales_invoices set invoice_date='2027-01-15' where id='${dL}'`);
  const lk = await fx.ownerRpc('set_period_lock', { p_month: '2027-01-01', p_locked: true, p_reason: 'attack test lock' });
  const prL = await post(dL);
  await fx.ownerRpc('set_period_lock', { p_month: '2027-01-01', p_locked: false, p_reason: 'attack test unlock' });
  await t('B11', 'post into a LOCKED period (2027-01)', 'db-architecture: locked period rejects posting (DN_PERIOD_LOCKED)', () => ({ req: 'post_sales_invoice on invoice dated 2027-01-15 while 2027-01 is locked', actual: `lock ${short(lk)}; post ${short(prL)}`, bad: prL.status < 300 }));
  const dM = fx.mkSales({ party: C.amaravati });
  sql(`update sales_invoices set invoice_date='2035-05-10' where id='${dM}'`);
  const prM = await post(dM);
  await t('B12', 'post into a month that has NO fiscal_periods row (2035-05)', 'daksh-review rule 1: a missing period row raises', () => ({ req: 'post_sales_invoice on invoice dated 2035-05-10', actual: `post ${short(prM)}`, bad: prM.status < 300 }));
  const dB = fx.mkSales({ party: C.amaravati });
  sql(`update sales_invoices set invoice_date='2026-05-10' where id='${dB}'`);
  const prB = await post(dB);
  await t('B13', 'BACK-DATE an invoice by 4.5 months into an open period as counter staff', 'not specified: spec only locks periods; recorded as an observation', () => ({ req: 'post_sales_invoice on invoice dated 2026-05-10', actual: `post ${short(prB)}`, bad: false, note: 'Observation only: the database lets the counter post into any unlocked month; if the owner expects same-day billing, lock closed months.' }));
}


{
  // B1b/B1c: invalid state code, and the mirror case (inter-state customer forced to intra-state)
  const dz = fx.mkSales({ party: C.kishore });
  const pz = await U('PATCH', `sales_invoices?id=eq.${dz}`, { place_of_supply: '99' });
  const prz = await post(dz); const rz = posted(dz);
  await t('B1b', "set place_of_supply to a state code that does not exist ('99'), then post", 'db-architecture: place_of_supply CHAR(2) is a GST state code', () => ({ req: `PATCH sales_invoices?id=eq.${dz} {"place_of_supply":"99"}; post`, actual: `patch ${short(pz)} rows=${pz.json?.length ?? 0}; post ${short(prz)}; posted pos=${rz?.place_of_supply} igst=${rz?.igst_total}`, bad: prz.status < 300 && rz?.place_of_supply === '99' }));
  const dh = fx.mkSales({ party: C.hyd, place: '36' });
  const ph = await U('PATCH', `sales_invoices?id=eq.${dh}`, { place_of_supply: '37' });
  const prh = await post(dh); const rh = posted(dh);
  await t('B1c', 'inter-state customer (Hyderabad, 36) forced to intra-state (37): CGST+SGST instead of IGST', 'db-architecture: IGST on inter-state supply', () => ({ req: `PATCH sales_invoices?id=eq.${dh} {"place_of_supply":"37"}; post`, actual: `patch ${short(ph)} rows=${ph.json?.length ?? 0}; post ${short(prh)}; posted pos=${rh?.place_of_supply} cgst=${rh?.cgst_total} sgst=${rh?.sgst_total} igst=${rh?.igst_total}`, bad: prh.status < 300 && Number(rh?.igst_total) === 0 }));
}
// -------------------------------------------------------------------------------------------------
// C. Concurrency: duplicate posts and numbering
// -------------------------------------------------------------------------------------------------
{
  const d = fx.mkSales({ party: C.amaravati });
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(d)));
  const okc = rs.filter((r) => r.status < 300).length;
  const entries = one(`select count(*) from journal_entries where source_id='${d}' and source_type='sales_invoice'`);
  await t('C1', 'six parallel posts of the SAME draft', 'db-architecture concurrency: two simultaneous posts cannot produce duplicate numbers', () => ({ req: '6 x post_sales_invoice(same id) in parallel', actual: `successes=${okc}; journal entries for it=${entries}; others: ${[...new Set(rs.filter((r) => r.status >= 300).map(dn))].join(' / ')}`, bad: okc !== 1 || Number(entries) !== 1 }));
  const ds = Array.from({ length: 8 }, () => fx.mkSales({ party: C.amaravati }));
  const before = one(`select next_no from doc_sequences where series='DN'`);
  const rs2 = await Promise.all(ds.map((x) => post(x)));
  const nos = rows(`select invoice_no from sales_invoices where id in (${ds.map((x) => `'${x}'`).join(',')}) order by invoice_no`).map((r) => r.invoice_no);
  const nums = nos.map((s) => Number(s.split('/').pop()));
  const contiguous = nums.length === 8 && nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
  await t('C2', 'eight parallel posts of eight different drafts: numbers unique and gap-free', 'db-architecture: numbers assigned inside the posting function under a row lock, gapless', () => ({ req: '8 x post_sales_invoice(different ids) in parallel', actual: `ok=${rs2.filter((r) => r.status < 300).length}; numbers=${nums.join(',')}; unique=${new Set(nums).size === nums.length}; contiguous=${contiguous}`, bad: new Set(nums).size !== nums.length || !contiguous }));
}

// -------------------------------------------------------------------------------------------------
// D. PostgREST tricks: upsert / bulk / embed
// -------------------------------------------------------------------------------------------------
{
  const inv = await fx.postedSales();
  const up = await U('POST', 'sales_invoices?on_conflict=id', { id: inv, invoice_date: '2026-09-26', party_id: C.kishore, place_of_supply: '37', warehouse_id: C.head, status: 'draft', grand_total: 1 }, { Prefer: 'resolution=merge-duplicates,return=representation' });
  const after = posted(inv);
  await t('D1', 'UPSERT (merge-duplicates) over a posted invoice id, sending status draft', 'db-architecture: INSERT/UPDATE on draft documents only', () => ({ req: `POST sales_invoices?on_conflict=id {id:<posted>,status:"draft",grand_total:1} Prefer: resolution=merge-duplicates`, actual: `${short(up)} rows=${up.json?.length ?? 0}; posted row now status=${after.status} grand_total=${after.grand_total}`, bad: after.status !== 'posted' || Number(after.grand_total) === 1 }));
  const postedBefore = one(`select count(*) from sales_invoices where status='posted'`);
  const bulk = await U('PATCH', `sales_invoices?id=not.is.null`, { vehicle_no: 'BULK-ATTACK' });
  const changedPosted = one(`select count(*) from sales_invoices where status<>'draft' and vehicle_no='BULK-ATTACK'`);
  await t('D2', 'bulk PATCH with a match-all filter over sales_invoices', 'db-architecture: only drafts are writable', () => ({ req: `PATCH sales_invoices?id=not.is.null {vehicle_no:"BULK-ATTACK"}`, actual: `${short(bulk)} rows_changed=${bulk.json?.length ?? 0}; NON-draft rows changed=${changedPosted}`, bad: Number(changedPosted) > 0 }));
  sql(`update sales_invoices set vehicle_no=null where vehicle_no='BULK-ATTACK'`);
  const bulkDel = await U('DELETE', `sales_invoices?id=not.is.null`);
  const postedAfter = one(`select count(*) from sales_invoices where status='posted'`);
  await t('D3', 'bulk DELETE with a match-all filter over sales_invoices', 'db-architecture: no delete of posted documents', () => ({ req: `DELETE sales_invoices?id=not.is.null`, actual: `${short(bulkDel)} rows_deleted=${bulkDel.json?.length ?? 0}; posted before=${postedBefore} after=${postedAfter}`, bad: postedAfter !== postedBefore }));
}

// -------------------------------------------------------------------------------------------------
// E. Payments and vouchers: values the counter can steer
// -------------------------------------------------------------------------------------------------
{
  const mk = (over = {}) => { const p = fx.mkPayment({ party: C.kishore, amount: 100, ...over }); return p; };
  const tryPay = async (title, setup, badFn, spec = 'db-architecture: money legs only on money accounts; receipt from a customer for a positive amount') => {
    const p = mk();
    sql(setup(p));
    const pr = await rpcAs('user', 'post_payment', { p_payment_id: p });
    const row = rows(`select status, amount, account_id, party_id, direction, mode from payments where id='${p}'`)[0];
    await t('E1', title, spec, () => ({ req: `payments draft SQL-tampered [${setup('<id>').slice(0, 110)}]; post_payment as user`, actual: `post ${short(pr)}; status=${row.status}`, bad: pr.status < 300 && badFn(row) }));
  };
  // the counter can PATCH these on its own draft through the API; the SQL here just applies the same change
  await tryPay('receipt with NEGATIVE amount (would move cash out under a receipt)', (p) => `update payments set amount=-500 where id='${p}'`, () => true);
  await tryPay('receipt with ZERO amount', (p) => `update payments set amount=0 where id='${p}'`, () => true);
  await tryPay('receipt into a NON-money account (accounts receivable)', (p) => `update payments set account_id='${C.ar}' where id='${p}'`, () => true);
  await tryPay('receipt FROM a supplier party', (p) => `update payments set party_id='${C.krishna}' where id='${p}'`, () => true);
  await tryPay('receipt from an employee party', (p) => `update payments set party_id='${C.suribabu}' where id='${p}'`, () => true);
  // prove the same edits are reachable through the API as the user
  const p = mk();
  const api = await U('PATCH', `payments?id=eq.${p}`, { amount: -500, account_id: C.ar, direction: 'payment', discount: 50 });
  await t('E2', 'the same payment edits ARE reachable through the API by the counter user (PATCH on a draft)', 'db-architecture: INSERT/UPDATE on draft documents: both roles', () => ({ req: `PATCH payments?id=eq.${p} {amount:-500,account_id:<AR>,direction:"payment",discount:50}`, actual: `${short(api)} rows=${api.json?.length ?? 0}`, bad: false, note: 'Expected by spec (drafts are editable); the protection is at post time (E1).' }));
  // allocation abuse
  const inv = await fx.postedSales({ party: C.hyd, qty: 1, rate: 350 });
  const p3 = mk({ amount: 100 });
  const a1 = await U('POST', 'payment_allocations', { payment_id: p3, invoice_type: 'sales_invoice', invoice_id: inv, amount: 100 });
  await t('E3', "allocate Kishore's receipt to ANOTHER party's invoice (Hyderabad Projects)", 'db-architecture allocations: an allocation must be to an invoice of the same party', () => ({ req: `POST payment_allocations {payment_id:<Kishore receipt>, invoice_id:<Hyderabad invoice>}`, actual: `${short(a1)} rows=${a1.json?.length ?? 0}`, bad: a1.status < 300 && (a1.json?.length ?? 0) > 0 }));
  const inv2 = await fx.postedSales({ party: C.kishore, qty: 1, rate: 350 });
  const p4 = mk({ amount: 100 });
  const a2 = await U('POST', 'payment_allocations', { payment_id: p4, invoice_type: 'sales_invoice', invoice_id: inv2, amount: 99999 });
  await t('E4', 'allocate MORE than the receipt amount / invoice total', 'db-architecture allocations: sum(allocations) <= payment amount and <= invoice open amount', () => ({ req: `POST payment_allocations {amount:99999} for a 100 receipt against a 413 invoice`, actual: `${short(a2)} rows=${a2.json?.length ?? 0}`, bad: a2.status < 300 && (a2.json?.length ?? 0) > 0 }));
  const a3 = await U('POST', 'payment_allocations', { payment_id: p4, invoice_type: 'sales_invoice', invoice_id: inv2, amount: -50 });
  await t('E5', 'NEGATIVE allocation amount', 'db-architecture allocations: amount > 0', () => ({ req: `POST payment_allocations {amount:-50}`, actual: `${short(a3)} rows=${a3.json?.length ?? 0}`, bad: a3.status < 300 && (a3.json?.length ?? 0) > 0 }));
}
{
  // advance voucher abuse (counter may post advances <= 5000; nothing else)
  const advance = async (title, voucherSql, lineSql, bounds = {}) => {
    const v = one(`insert into expense_vouchers (voucher_date, status, voucher_type, party_id, pay_account_id) values (current_date, 'draft', 'advance', ${bounds.party === undefined ? `'${C.suribabu}'` : bounds.party}, ${bounds.pay ?? `'${C.cash}'`}) returning id`);
    for (const [i, l] of lineSql.entries()) sql(`insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration) values ('${v}', ${i + 1}, ${l.acct}, ${l.amt}, 'attack fixture')`);
    const pr = await rpcAs('user', 'post_expense_voucher', { p_voucher_id: v });
    const je = pr.status < 300 ? rows(`select a.code, a.name, jl.debit, jl.credit from journal_lines jl join accounts a on a.id=jl.account_id join journal_entries e on e.id=jl.entry_id where e.source_type='expense_voucher' and e.source_id='${v}' order by jl.line_no`) : [];
    return { v, pr, je };
  };
  const sales = `'${one(`select id from accounts where system_key='sales_cement'`)}'`;
  const rent = `'${C.rentAcct}'`;
  const adv = `'${C.advanceAcct}'`;
  let r = await advance('x', null, [{ acct: sales, amt: 4000 }]);
  await t('F1', "'advance' voucher whose line debits an INCOME account (Sales) instead of Employee Advance", 'db-architecture: user may only record employee advances; no expense posting', () => ({ req: `expense_vouchers(voucher_type=advance, party=employee) + line account=Sales-Cement 4000; post_expense_voucher as user`, actual: `post ${short(r.pr)}; journal: ${r.je.map((j) => `${j.code} ${j.name} Dr${j.debit} Cr${j.credit}`).join(' | ')}`, bad: r.pr.status < 300 && !r.je.some((j) => /Advance/i.test(j.name)) }));
  r = await advance('x', null, [{ acct: rent, amt: 4000 }]);
  await t('F2', "'advance' voucher whose line debits an EXPENSE account (Godown rent): counter posts an expense", 'db-architecture: no purchases/expenses posting for user', () => ({ req: `advance voucher, line account=Godown Rent 4000; post as user`, actual: `post ${short(r.pr)}; journal: ${r.je.map((j) => `${j.code} ${j.name} Dr${j.debit} Cr${j.credit}`).join(' | ')}`, bad: r.pr.status < 300 && r.je.some((j) => /rent/i.test(j.name)) }));
  r = await advance('x', null, [{ acct: adv, amt: 4000 }, { acct: adv, amt: 4000 }]);
  await t('F3', 'advance voucher of TWO lines of 4,000 (8,000 > the 5,000 cap)', 'db-architecture: advances <= 5,000', () => ({ req: `advance voucher, 2 lines x 4000 (gross 8000); post as user`, actual: `post ${short(r.pr)}`, bad: r.pr.status < 300 }));
  r = await advance('x', null, [{ acct: adv, amt: 4999 }], { pay: `'${C.bank}'` });
  await t('F4', 'advance paid from the BANK account (not the cash drawer)', 'not specified (spec: counter records advances); recorded as an observation', () => ({ req: `advance voucher 4999 pay_account=Bank; post as user`, actual: `post ${short(r.pr)}`, bad: false, note: 'Observation: a counter user can move up to 5,000 per voucher out of the bank account, with no per-day or per-person cap.' }));
  r = await advance('x', null, [{ acct: adv, amt: 4000 }], { party: `'${C.kishore}'` });
  await t('F5', 'advance to a NON-employee party (a customer)', 'db-architecture: voucher party must be an active employee', () => ({ req: `advance voucher party=customer Kishore; post as user`, actual: `post ${short(r.pr)}`, bad: r.pr.status < 300 }));
  r = await advance('x', null, [{ acct: adv, amt: -4000 }]);
  await t('F6', 'advance voucher with a NEGATIVE line amount (cash IN, reduces the employee advance)', 'db-architecture: amounts > 0', () => ({ req: `advance voucher line amount=-4000; post as user`, actual: `post ${short(r.pr)}`, bad: r.pr.status < 300 }));
  // A user that flips the voucher type after drafting
  const v = fx.mkExpense({ type: 'advance', party: C.suribabu, amount: 100 });
  const flip = await U('PATCH', `expense_vouchers?id=eq.${v}`, { voucher_type: 'salary', period_month: '2026-09-01' }, { Prefer: 'return=minimal' });
  const nowType = one(`select voucher_type from expense_vouchers where id='${v}'`);
  const pv = await rpcAs('user', 'post_expense_voucher', { p_voucher_id: v });
  await t('F7', 'draft an advance, PATCH voucher_type to salary, post', 'db-architecture: salary/wages posting is admin only', () => ({ req: `PATCH expense_vouchers?id=eq.${v} {voucher_type:"salary"}; post as user`, actual: `patch(return=minimal) ${short(flip)}; voucher_type now ${nowType}; post ${short(pv)}`, bad: pv.status < 300 && nowType !== 'advance' }));
}

// -------------------------------------------------------------------------------------------------
// G. Challan / stock movements the counter can create
// -------------------------------------------------------------------------------------------------
{
  const ch = fx.mkChallan();
  const gp = await U('PATCH', `delivery_challan_lines?challan_id=eq.${ch}`, { qty: -50 });
  const stockBefore = one(`select coalesce(sum(qty),0) from stock_movements where item_id='${C.ppc}' and warehouse_id='${C.head}'`);
  const pr = await rpcAs('user', 'post_delivery_challan', { p_challan_id: ch });
  const stockAfter = one(`select coalesce(sum(qty),0) from stock_movements where item_id='${C.ppc}' and warehouse_id='${C.head}'`);
  await t('G1', 'challan line with NEGATIVE qty (creates stock out of thin air), post as user', 'db-architecture: stock adjustments increasing stock are admin-only; qty > 0', () => ({ req: `PATCH delivery_challan_lines?challan_id=eq.${ch} {qty:-50}; post_delivery_challan`, actual: `patch ${short(gp)} rows=${gp.json?.length ?? 0}; post ${short(pr)}; stock on hand ${stockBefore} -> ${stockAfter}`, bad: gp.status < 300 && (gp.json?.length ?? 0) > 0 && pr.status < 300 && Number(stockAfter) > Number(stockBefore) }));
  const ch2 = fx.mkChallan();
  const gp2 = await U('PATCH', `delivery_challan_lines?challan_id=eq.${ch2}`, { qty: 5000000 });
  const pr2 = await rpcAs('user', 'post_delivery_challan', { p_challan_id: ch2 });
  await t('G2', 'challan of more stock than exists (5,000,000) by counter (negative stock)', 'db-architecture: stock never negative unless admin override flag', () => ({ req: `challan qty 5000000; post as user`, actual: `patch ${short(gp2)}; post ${short(pr2)}`, bad: pr2.status < 300 && gp2.status < 300 }));
  const d = fx.mkSales({ party: C.amaravati, qty: 5000000 });
  const pr3 = await post(d);
  await t('G3', 'sell more stock than exists (5,000,000 bags)', 'db-architecture: stock never negative unless admin override flag', () => ({ req: `draft invoice qty 5000000; post as user`, actual: `post ${short(pr3)}`, bad: pr3.status < 300 }));
}

// -------------------------------------------------------------------------------------------------
// H. Cheque state machine (counter work)
// -------------------------------------------------------------------------------------------------
{
  const c1 = await fx.postedChequeReceipt();
  const clr = await rpcAs('user', 'mark_cheque_cleared', { p_payment_id: c1 });
  const st1 = one(`select cheque_status from payments where id='${c1}'`);
  await t('H1', 'clear a cheque that was NEVER deposited (in_hand -> cleared)', 'db-architecture cheque states: in_hand -> deposited -> cleared', () => ({ req: `mark_cheque_cleared on an in_hand cheque`, actual: `${short(clr)}; cheque_status now ${st1}`, bad: clr.status < 300 && st1 === 'cleared' }));
  const c2 = await fx.postedChequeReceipt();
  const d1 = await rpcAs('user', 'deposit_cheque', { p_payment_id: c2 });
  const d2 = await rpcAs('user', 'deposit_cheque', { p_payment_id: c2 });
  await t('H2', 'deposit the same cheque twice', 'db-architecture: deposit only from in_hand', () => ({ req: `deposit_cheque x2`, actual: `first ${short(d1)}; second ${short(d2)}`, bad: d2.status < 300 }));
  const cash = await fx.postedPayment({ party: C.kishore, amount: 77, mode: 'cash' });
  const d3 = await rpcAs('user', 'deposit_cheque', { p_payment_id: cash });
  await t('H3', 'deposit a CASH receipt as if it were a cheque', 'db-architecture: only cheque receipts', () => ({ req: `deposit_cheque on a cash receipt`, actual: `${short(d3)}`, bad: d3.status < 300 }));
  const c3 = await fx.postedChequeReceipt();
  await fx.ownerRpc('bounce_cheque', { p_payment_id: c3, p_reason: 'fixture' });
  const d4 = await rpcAs('user', 'deposit_cheque', { p_payment_id: c3 });
  const c4 = await fx.postedChequeReceipt();
  await fx.ownerRpc('cancel_document', { p_source_type: 'payment', p_source_id: c4, p_reason: 'fixture' });
  const d5 = await rpcAs('user', 'deposit_cheque', { p_payment_id: c4 });
  await t('H4', 'deposit a BOUNCED cheque and a CANCELLED cheque receipt', 'db-architecture cheque states', () => ({ req: `deposit_cheque on bounced and on cancelled receipts`, actual: `bounced ${short(d4)}; cancelled ${short(d5)}`, bad: d4.status < 300 || d5.status < 300 }));
}
{
  // e-way bill function: can it touch anything else, or a draft/cancelled invoice?
  const d = fx.mkSales({ party: C.amaravati });
  const r = await rpcAs('user', 'record_invoice_ewb', { p_invoice_id: d, p_transport_mode: 'road', p_distance_km: 10, p_transporter_name: 'X', p_transporter_gstin: null, p_vehicle_no: 'AP39XX1234', p_ewb_no: '123456789012', p_ewb_date: '2026-09-26', p_ewb_valid_until: '2026-09-28T00:00:00Z' });
  await t('H5', 'record an e-way bill against a DRAFT invoice', 'db-architecture: EWB recorded on posted invoices', () => ({ req: `record_invoice_ewb on a draft`, actual: `${short(r)}`, bad: r.status < 300, note: 'observation if it succeeds: harmless data, but shows the function has no status check' }));
}

// -------------------------------------------------------------------------------------------------
fs.writeFileSync(OUT + '/findings-3.json', JSON.stringify(findings, null, 1));
saveResults('results-3');
console.log(JSON.stringify({ tests: n, fail: bad, nonpass: findings.length }));
