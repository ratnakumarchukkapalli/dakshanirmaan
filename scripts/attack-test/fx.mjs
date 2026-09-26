// Fixtures for the attack test. Built as the database owner (psql as postgres) = test SETUP, not the attack.
// Posting fixtures go through the real RPC as the aal2 admin, exactly as the app would.
import { execFileSync } from 'node:child_process';
import { http, loadIdentities } from './lib.mjs';

export function sql(q) {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_Daksh_Nirmaan', 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();
}
export const rows = (q) => JSON.parse(sql(`select coalesce(json_agg(t),'[]'::json) from (${q}) t`));
export const one = (q) => sql(q).split('\n')[0];

const id = (q) => one(q);
export const C = {
  head: id(`select id from warehouses where is_default and not is_transit`),
  gann: id(`select id from warehouses where name='Gannavaram Godown'`),
  transit: id(`select id from warehouses where is_transit`),
  cash: id(`select id from accounts where system_key='cash'`),
  bank: id(`select id from accounts where system_key='bank'`),
  ar: id(`select id from accounts where system_key='ar'`),
  advanceAcct: id(`select id from accounts where system_key='employee_advance'`),
  salariesAcct: id(`select id from accounts where code='5500'`),
  rentAcct: id(`select id from accounts where system_key='godown_rent'`),
  ppc: id(`select id from items where name='UltraTech PPC 50kg'`),
  opc: id(`select id from items where name='UltraTech OPC 53 50kg'`),
  tmt12: id(`select id from items where name='Tata Tiscon Fe500D 12mm'`),
  ramesh: id(`select id from parties where name='Ramesh Builders'`),         // credit limit 200000
  kishore: id(`select id from parties where name='Kishore Contractors'`),
  lakshmi: id(`select id from parties where name='Lakshmi Hardware, Guntur'`),
  walkin: id(`select id from parties where is_walk_in`),
  krishna: id(`select id from parties where name='Krishna Cement Distributors'`),
  suribabu: id(`select id from parties where name='Suribabu'`),
  ramana: id(`select id from parties where name='Ramana'`),
  amaravati: id(`select id from parties where name='Amaravati Infra Pvt Ltd'`),
  hyd: id(`select id from parties where name='Hyderabad Projects LLP'`),
};

// ---- draft builders (return id) ----------------------------------------------------------------
export function mkSales({ party = C.amaravati, qty = 1, rate = 350, item = C.ppc, place = '37', gst = null } = {}) {
  const inv = id(`insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id) values (current_date, '${party}', '${place}', 'draft', '${C.head}') returning id`);
  sql(`insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, rate, discount_pct, taxable_value)
       select '${inv}', 1, i.id, i.name, i.hsn_code, i.base_uom, ${gst ?? 'i.gst_rate'}, ${qty}, ${rate}, 0, 0 from items i where i.id='${item}'`);
  return inv;
}
export function mkChallan() {
  const dc = id(`insert into delivery_challans (challan_date, party_id, warehouse_id, status) values (current_date, '${C.kishore}', '${C.head}', 'draft') returning id`);
  sql(`insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate, value)
       select '${dc}', 1, id, name, hsn_code, base_uom, 1, sale_rate, gst_rate, sale_rate from items where id='${C.ppc}'`);
  return dc;
}
export function mkPurchase() {
  const pi = id(`insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible) values (current_date, '${C.krishna}', '37', 'draft', '${C.head}', 'ATK-' || floor(random()*1e9), true) returning id`);
  sql(`insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
       select '${pi}', 1, id, name, hsn_code, base_uom, 10, 300, 0, gst_rate from items where id='${C.ppc}'`);
  return pi;
}
export function mkPayment({ dir = 'receipt', mode = 'cash', amount = 100, discount = null, party = C.kishore, acct = C.cash, alloc = null, instrument = null } = {}) {
  const p = id(`insert into payments (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, discount, account_id, status, cheque_bank)
     values ('${dir}', current_date, '${party}', '${mode}', ${instrument ? `'${instrument}'` : 'null'}, ${instrument ? 'current_date' : 'null'}, ${amount}, ${discount ?? 0}, '${acct}', 'draft', ${instrument ? `'SBI'` : 'null'}) returning id`);
  if (alloc) sql(`insert into payment_allocations (payment_id, invoice_type, invoice_id, amount) values ('${p}', '${alloc.type}', '${alloc.id}', ${alloc.amount ?? amount})`);
  return p;
}
export function mkExpense({ type = 'expense', amount = 100, party = null, acct = null } = {}) {
  const partyCol = party ? `'${party}'` : 'null';
  const ev = id(`insert into expense_vouchers (voucher_date, status, voucher_type, party_id, pay_account_id, period_month)
     values (current_date, 'draft', '${type}', ${partyCol}, '${C.cash}', ${type === 'salary' ? `date_trunc('month', current_date)::date` : 'null'}) returning id`);
  const a = acct ?? (type === 'advance' ? C.advanceAcct : type === 'salary' ? C.salariesAcct : C.rentAcct);
  sql(`insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration) values ('${ev}', 1, '${a}', ${amount}, 'attack fixture')`);
  return ev;
}
export function mkAdjustment() {
  const a = id(`insert into stock_adjustments (adj_date, warehouse_id, reason, status) values (current_date, '${C.head}', 'attack fixture', 'draft') returning id`);
  sql(`insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty) select '${a}', 1, id, name, -1 from items where id='${C.ppc}'`);
  return a;
}
export function mkTransfer() {
  const t = id(`insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status) values (current_date, '${C.head}', '${C.gann}', 'AP 00 XX 0000', 'draft') returning id`);
  sql(`insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty) select '${t}', 1, id, name, base_uom, 1 from items where id='${C.ppc}'`);
  return t;
}

// ---- owner (aal2 admin) RPC: used to post fixtures the same way the app does ------------------------
let _ids;
export function owner() { return (_ids ??= loadIdentities()).ids.admin_aal2; }
export async function ownerRpc(fn, args = {}) {
  const r = await http('POST', `/rest/v1/rpc/${fn}`, { token: owner().token, body: args });
  return r;
}
export async function postedSales(opts = {}) {
  const inv = mkSales(opts);
  const r = await ownerRpc('post_sales_invoice', { p_invoice_id: inv, p_override_credit: false });
  if (r.status >= 300) throw new Error('fixture post_sales_invoice failed: ' + r.text);
  return inv;
}
export async function postedPayment(opts = {}) {
  const p = mkPayment(opts);
  const r = await ownerRpc('post_payment', { p_payment_id: p });
  if (r.status >= 300) throw new Error('fixture post_payment failed: ' + r.text);
  return p;
}
export async function postedChequeReceipt() {
  const p = mkPayment({ dir: 'receipt', mode: 'cheque', amount: 500, party: C.kishore, acct: C.bank, instrument: String(Math.floor(100000 + Math.random() * 899999)) });
  const r = await ownerRpc('post_payment', { p_payment_id: p });
  if (r.status >= 300) throw new Error('fixture cheque post failed: ' + r.text);
  return p;
}
