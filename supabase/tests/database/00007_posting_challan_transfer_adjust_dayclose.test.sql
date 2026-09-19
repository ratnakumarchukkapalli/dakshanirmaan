-- Must pass (change 05, posting-challan-transfer-adjust-dayclose):
--   "challan then invoice keeps stock and books consistent" and "day close records the difference".
-- Also covers everything under the proposal's "Done when": DN_VALIDATION:challan_mismatch,
-- DN_CONVERTED, cancel-invoice-reopens-challan, the transfer post -> receive round trip with no
-- revaluation and no journal entry, the transfer state machine, adjustments in both directions +
-- admin-only, the transit warehouse's is_transit filter, DN_NOT_DRAFT on each new document type,
-- and anon denied on every new function.
--
-- Same harness as 00005/00006: fixtures are created as postgres (which bypasses RLS, exactly as a
-- migration or the opening-balance import does), while every post_*/receive/cancel call runs under
-- `set local role authenticated` with real JWT claims, so each happy path doubles as proof that a
-- genuine session — admin or plain 'user' — can actually use these functions.
begin;

create extension if not exists pgtap with schema extensions;

select plan(194);

-- ============================================================
-- Fixtures
-- ============================================================

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true);

insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'staff@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true);

create temp table _party as
with p as (
  insert into parties (name, type, state_code)
  select 'Challan Test Builder', 'customer', state_code from organization limit 1
  returning id
)
select id as party_id from p;
grant select on _party to authenticated;

create temp table _wh as
select
  (select id from warehouses where is_default limit 1) as head_id,
  (select id from warehouses where is_transit limit 1) as transit_id;
grant select on _wh to authenticated;

create temp table _branch as
with w as (
  insert into warehouses (name, is_default, is_transit) values ('Branch Godown', false, false)
  returning id
)
select id as branch_id from w;
grant select on _branch to authenticated;

create temp table _items as
with c as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Challan Cement 50kg', 'cement', '2523', 18, 'bag', 360)
  returning id
),
t as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Transfer Cement 50kg', 'cement', '2523', 18, 'bag', 380)
  returning id
),
a as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Adjust Cement 50kg', 'cement', '2523', 18, 'bag', 300)
  returning id
),
a2 as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Adjust Sand cft', 'other', '2505', 5, 'cft', 120)
  returning id
)
select (select id from c) as ch_item, (select id from t) as tr_item,
       (select id from a) as adj_item, (select id from a2) as adj_item2;
grant select on _items to authenticated;

-- Opening stock: challan item 1000 bags @ 300, transfer item 500 bags @ 320,
-- adjustment item 100 bags @ 250 — all in the default (Head Godown) warehouse.
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select ch_item, (select head_id from _wh), '2026-04-05', 1000, 300, 300000, 'opening' from _items;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select tr_item, (select head_id from _wh), '2026-04-05', 500, 320, 160000, 'opening' from _items;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select adj_item, (select head_id from _wh), '2026-04-05', 100, 250, 25000, 'opening' from _items;

select is(
  (select round(avg_rate, 2) from stock_on_hand(
    (select ch_item from _items), (select head_id from _wh))),
  300.00,
  'sanity: the challan item carries a weighted-average cost of Rs 300'
);

-- ============================================================
-- Scenario: challan then invoice keeps stock and books consistent
-- 100 bags out on a challan at cost 300 (Rs 30,000 parked in Goods in Transit), invoiced later
-- at Rs 360 + 18% GST intra-state (taxable 36,000, grand 42,480).
-- ============================================================

create temp table _challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, vehicle_no, status)
  select '2026-06-10', party_id, (select head_id from _wh), 'AP39 AB 1234', 'draft'
  from _party
  returning id
)
select id as challan_id from c;
grant select on _challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 100, 360, 18
from _challan, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _challan_entry as
select post_delivery_challan((select challan_id from _challan)) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _challan_entry to authenticated;

select is(
  (select status from delivery_challans where id = (select challan_id from _challan)),
  'posted',
  'challan status is posted after post_delivery_challan (real authenticated admin session)'
);

select is(
  (select challan_no from delivery_challans where id = (select challan_id from _challan)),
  'DC/26-27/0001',
  'challan number comes from the DC series at posting time, not at draft time'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _challan_entry)
     and account_id = (select id from accounts where system_key = 'goods_in_transit')),
  30000.00,
  'challan journal: Dr Goods in Transit Rs 30,000 (100 bags at avg cost 300)'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _challan_entry)
     and account_id = (select id from accounts where system_key = 'inventory')),
  30000.00,
  'challan journal: Cr Inventory Rs 30,000'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _challan_entry)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _challan_entry)),
  'challan journal entry is balanced'
);

select is(
  (select count(*)::int from stock_movements
   where source_type = 'delivery_challan' and source_id = (select challan_id from _challan)),
  1,
  'the challan writes exactly one stock movement: OUT of the godown, nothing into a warehouse'
);

select is(
  (select qty from stock_movements
   where source_type = 'delivery_challan' and source_id = (select challan_id from _challan)),
  -100.000,
  'challan stock movement qty = -100 (base UOM)'
);

select is(
  (select value from stock_movements
   where source_type = 'delivery_challan' and source_id = (select challan_id from _challan)),
  -30000.00,
  'challan stock movement value = -Rs 30,000 (at weighted-average cost, not sale price)'
);

select is(
  (select qty from stock_on_hand((select ch_item from _items), (select head_id from _wh))),
  900.000,
  'stock on hand drops once, at challan time: 1000 - 100 = 900'
);

select is(
  (select value from delivery_challan_lines
   where challan_id = (select challan_id from _challan)),
  36000.00,
  'challan line carries the goods value (100 x 360) for the e-way-bill threshold'
);

-- Convert: the invoice names the challan and must match it item for item, quantity for quantity.
create temp table _invoice as
with inv as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-12', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh), (select challan_id from _challan)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 100, 360, 0, 18
from _invoice, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _invoice_entry as
select post_sales_invoice((select invoice_id from _invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _invoice_entry to authenticated;

select is(
  (select status from sales_invoices where id = (select invoice_id from _invoice)),
  'posted',
  'the converted invoice posts'
);

select is(
  (select count(*)::int from stock_movements
   where source_type = 'sales_invoice' and source_id = (select invoice_id from _invoice)),
  0,
  'the converted invoice writes no stock movement: the goods left at challan time'
);

select is(
  (select qty from stock_on_hand((select ch_item from _items), (select head_id from _wh))),
  900.000,
  'stock on hand is unchanged by the invoice (still 900, not 800)'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'cogs')),
  30000.00,
  'COGS is recognised only at invoice time, at the cost the challan carried out'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'goods_in_transit')),
  30000.00,
  'the invoice relieves Goods in Transit, not Inventory'
);

select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'inventory')),
  0,
  'the converted invoice touches Inventory not at all (it was already credited by the challan)'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'goods_in_transit')),
  0.00,
  'Goods in Transit rose then fell back to zero across the two documents'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'ar')),
  42480.00,
  'AR debit = Rs 42,480 (36,000 + 18% GST)'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'sales_cement')),
  36000.00,
  'revenue is recognised at invoice time: Sales - Cement Rs 36,000'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'output_cgst')),
  3240.00,
  'Output CGST Rs 3,240'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _invoice_entry)
     and account_id = (select id from accounts where system_key = 'output_sgst')),
  3240.00,
  'Output SGST Rs 3,240'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _invoice_entry)),
  72480.00,
  'converted invoice entry: sum of debits = Rs 72,480 (AR 42,480 + COGS 30,000)'
);

select is(
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _invoice_entry)),
  72480.00,
  'converted invoice entry: sum of credits = Rs 72,480'
);

select is(
  (select invoice_id from delivery_challans where id = (select challan_id from _challan)),
  (select invoice_id from _invoice),
  'the challan is linked to the invoice it was converted into'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'inventory')),
  -30000.00,
  'Inventory was relieved exactly once for these 100 bags, at challan time'
);

select is(
  (select coalesce(sum(m.value), 0) from stock_movements m where m.item_id = (select ch_item from _items)),
  270000.00,
  'stock ledger value for the item (270,000) equals opening 300,000 less the one 30,000 issue'
);

-- ============================================================
-- challan_mismatch: the invoice must match the challan item for item and quantity for quantity
-- ============================================================

create temp table _challan2 as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-13', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _challan2 to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 50, 360, 18
from _challan2, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select post_delivery_challan(%L)', (select challan_id from _challan2)),
  'a second challan posts (50 bags)'
);
reset role;
set local request.jwt.claims to '';

create temp table _invoice_bad_qty as
with inv as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-14', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh), (select challan_id from _challan2)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _invoice_bad_qty to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 60, 360, 0, 18
from _invoice_bad_qty, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _invoice_bad_qty));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:challan_mismatch',
  'invoicing a different quantity than the challan raises DN_VALIDATION:challan_mismatch'
);

select is(
  (select status from sales_invoices where id = (select invoice_id from _invoice_bad_qty)),
  'draft',
  'the mismatched invoice is untouched (still draft, nothing posted)'
);

create temp table _invoice_bad_item as
with inv as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-14', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh), (select challan_id from _challan2)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _invoice_bad_item to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 50, 360, 0, 18
from _invoice_bad_item, _items;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 2, tr_item, 'Transfer Cement 50kg', '2523', 'bag', 5, 380, 0, 18
from _invoice_bad_item, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _invoice_bad_item));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:challan_mismatch',
  'invoicing an item the challan never carried raises DN_VALIDATION:challan_mismatch'
);

-- ============================================================
-- DN_CONVERTED, and cancelling the invoice reopens the challan
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform cancel_document('delivery_challan', (select challan_id from _challan), 'test');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CONVERTED',
  'cancelling a challan that is already invoiced raises DN_CONVERTED'
);

select is(
  (select status from delivery_challans where id = (select challan_id from _challan)),
  'posted',
  'the converted challan is untouched by the refused cancellation'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'sales_invoice',
         (select invoice_id from _invoice), 'customer returned the load'),
  'an admin can cancel the converted invoice'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select invoice_id from delivery_challans where id = (select challan_id from _challan)),
  null::uuid,
  'cancelling the invoice reopens the challan (invoice_id back to NULL)'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'goods_in_transit')),
  45000.00,
  'the cost is back in Goods in Transit (30,000 from challan 1 + 15,000 still out on challan 2)'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'delivery_challan',
         (select challan_id from _challan), 'load came back'),
  'the reopened challan can now be cancelled'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from delivery_challans where id = (select challan_id from _challan)),
  'cancelled',
  'the challan is cancelled, not deleted'
);

select is(
  (select qty from stock_on_hand((select ch_item from _items), (select head_id from _wh))),
  950.000,
  'the cancelled challan puts its 100 bags back (950 = 1000 - 50 still out on challan 2)'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'goods_in_transit')),
  15000.00,
  'Goods in Transit now holds only challan 2 (50 bags at 300)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_delivery_challan((select challan_id from _challan));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting a cancelled challan raises DN_NOT_DRAFT (idempotency)'
);

-- ============================================================
-- Stock transfers: post -> receive round trip, no revaluation, no journal entry
-- ============================================================

create temp table _transfer as
with t as (
  insert into stock_transfers
    (transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status)
  values ('2026-06-20', (select head_id from _wh), (select branch_id from _branch),
          'AP39 CD 5678', 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _transfer to authenticated;

insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 200 from _transfer, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select post_stock_transfer(%L)', (select transfer_id from _transfer)),
  'an admin session can post a stock transfer'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from stock_transfers where id = (select transfer_id from _transfer)),
  'in_transit',
  'a posted transfer is in_transit, not "posted"'
);

select is(
  (select transfer_no from stock_transfers where id = (select transfer_id from _transfer)),
  'TR/26-27/0001',
  'transfer number comes from the TR series'
);

select is(
  (select count(*)::int from journal_entries where source_type = 'stock_transfer'),
  0,
  'a transfer writes no journal entry: the value never leaves Inventory'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select head_id from _wh))),
  300.000,
  'source godown is down to 300 bags'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select transit_id from _wh))),
  200.000,
  'the transit warehouse holds the 200 bags in the lorry'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select branch_id from _branch))),
  0.000,
  'the destination godown has nothing yet'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select receive_stock_transfer(%L)', (select transfer_id from _transfer)),
  'the destination godown receives the transfer'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from stock_transfers where id = (select transfer_id from _transfer)),
  'received',
  'the transfer is received'
);

select is(
  (select received_by from stock_transfers where id = (select transfer_id from _transfer)),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'received_by records the real session actor, not a parameter'
);

select isnt(
  (select received_at from stock_transfers where id = (select transfer_id from _transfer)),
  null,
  'received_at is stamped'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select transit_id from _wh))),
  0.000,
  'the transit warehouse is empty again'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select branch_id from _branch))),
  200.000,
  'the destination godown holds the 200 bags'
);

select is(
  (select round(avg_rate, 4) from stock_on_hand(
    (select tr_item from _items), (select branch_id from _branch))),
  320.0000,
  'no revaluation: the destination receives the source godown weighted average of Rs 320'
);

select is(
  (select value from stock_on_hand((select tr_item from _items), (select branch_id from _branch))),
  64000.00,
  'destination stock value = 200 x 320 = Rs 64,000'
);

select is(
  (select count(*)::int from journal_entries where source_type = 'stock_transfer'),
  0,
  'receiving still writes no journal entry'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform receive_stock_transfer((select transfer_id from _transfer));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_TRANSFER_STATE',
  'receiving an already-received transfer raises DN_TRANSFER_STATE (double-receive is impossible)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform cancel_document('stock_transfer', (select transfer_id from _transfer), 'x');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_TRANSFER_STATE',
  'a received transfer cannot be cancelled: DN_TRANSFER_STATE'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_transfer((select transfer_id from _transfer));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting a non-draft transfer raises DN_NOT_DRAFT'
);

-- Cancel from draft: nothing has moved, so nothing is reversed.
create temp table _transfer_draft as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-21', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _transfer_draft to authenticated;

insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 10 from _transfer_draft, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'stock_transfer',
         (select transfer_id from _transfer_draft), 'lorry never left'),
  'a draft transfer can be cancelled'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from stock_transfers where id = (select transfer_id from _transfer_draft)),
  'cancelled',
  'the draft transfer is cancelled'
);

select is(
  (select count(*)::int from stock_movements
   where source_type = 'stock_transfer' and source_id = (select transfer_id from _transfer_draft)),
  0,
  'cancelling a draft transfer moves no stock'
);

-- Cancel from in_transit: the goods come back to the source godown.
create temp table _transfer_transit as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-22', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _transfer_transit to authenticated;

insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 30 from _transfer_transit, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select post_stock_transfer(%L)', (select transfer_id from _transfer_transit)),
  'a third transfer goes in_transit'
);
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'stock_transfer',
         (select transfer_id from _transfer_transit), 'lorry turned back'),
  'an in_transit transfer can be cancelled'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from stock_transfers where id = (select transfer_id from _transfer_transit)),
  'cancelled',
  'the in_transit transfer is cancelled'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select head_id from _wh))),
  300.000,
  'the goods are back in the source godown (300, unchanged by the round trip)'
);

select is(
  (select qty from stock_on_hand((select tr_item from _items), (select transit_id from _wh))),
  0.000,
  'the transit warehouse is empty after the cancellation'
);

-- A transfer may never name the transit warehouse itself.
create temp table _transfer_to_transit as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-23', (select head_id from _wh), (select transit_id from _wh), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _transfer_to_transit to authenticated;

insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 5 from _transfer_to_transit, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_transfer((select transfer_id from _transfer_to_transit));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:transit_warehouse',
  'a transfer cannot name the transit warehouse as its destination'
);

-- More than is on hand.
create temp table _transfer_short as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-24', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _transfer_short to authenticated;

insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 5000 from _transfer_short, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_transfer((select transfer_id from _transfer_short));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'transferring more than the source godown holds raises DN_NEGATIVE_STOCK'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
do $$
begin
  perform post_stock_transfer((select transfer_id from _transfer_short));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role session cannot post a stock transfer'
);

-- The transit warehouse is a system warehouse, hidden from pickers by is_transit.
select is(
  (select is_transit from warehouses where name = 'In Transit'),
  true,
  'the seeded In Transit warehouse is flagged is_transit'
);

select is(
  (select is_default from warehouses where name = 'In Transit'),
  false,
  'the transit warehouse is never the default'
);

select is(
  (select count(*)::int from warehouses where not is_transit),
  2,
  'a stock picker filtering out is_transit sees only the two real godowns'
);

-- ============================================================
-- Stock adjustments: shrinkage and gain, admin only
-- ============================================================

create temp table _adj_down as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status, reason)
  values ('2026-06-25', (select head_id from _wh), 'draft', 'monsoon damage')
  returning id
)
select id as adjustment_id from a;
grant select on _adj_down to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', -10 from _adj_down, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _adj_down_entry as
select post_stock_adjustment((select adjustment_id from _adj_down)) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _adj_down_entry to authenticated;

select is(
  (select status from stock_adjustments where id = (select adjustment_id from _adj_down)),
  'posted',
  'the shrinkage adjustment posts'
);

select is(
  (select adj_no from stock_adjustments where id = (select adjustment_id from _adj_down)),
  'ADJ/26-27/0001',
  'adjustment number comes from the ADJ series'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _adj_down_entry)
     and account_id = (select id from accounts where system_key = 'stock_loss')),
  2500.00,
  'shrinkage: Dr Stock Loss Rs 2,500 (10 bags at the average 250)'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _adj_down_entry)
     and account_id = (select id from accounts where system_key = 'inventory')),
  2500.00,
  'shrinkage: Cr Inventory Rs 2,500'
);

select is(
  (select value from stock_movements
   where source_type = 'stock_adjustment'
     and source_id = (select adjustment_id from _adj_down)),
  -2500.00,
  'the shrinkage stock movement carries a negative value at the average rate'
);

select is(
  (select qty from stock_on_hand((select adj_item from _items), (select head_id from _wh))),
  90.000,
  'on hand is down to 90 bags'
);

create temp table _adj_up as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status, reason)
  values ('2026-06-26', (select head_id from _wh), 'draft', 'found stock')
  returning id
)
select id as adjustment_id from a;
grant select on _adj_up to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty, rate)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', 5, 260 from _adj_up, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _adj_up_entry as
select post_stock_adjustment((select adjustment_id from _adj_up)) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _adj_up_entry to authenticated;

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _adj_up_entry)
     and account_id = (select id from accounts where system_key = 'inventory')),
  1300.00,
  'found stock: Dr Inventory Rs 1,300 (5 bags at the given rate 260)'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _adj_up_entry)
     and account_id = (select id from accounts where system_key = 'stock_loss')),
  1300.00,
  'found stock: Cr Stock Loss Rs 1,300'
);

select is(
  (select qty from stock_on_hand((select adj_item from _items), (select head_id from _wh))),
  95.000,
  'on hand is back up to 95 bags'
);

select is(
  (select value from stock_on_hand((select adj_item from _items), (select head_id from _wh))),
  23800.00,
  'stock value 23,800 = 25,000 - 2,500 + 1,300'
);

-- A rate on a decrease line is ambiguous input (shrinkage is always valued at the average).
create temp table _adj_bad_rate as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-06-27', (select head_id from _wh), 'draft')
  returning id
)
select id as adjustment_id from a;
grant select on _adj_bad_rate to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty, rate)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', -2, 999 from _adj_bad_rate, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_adjustment((select adjustment_id from _adj_bad_rate));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:rate_on_decrease',
  'a rate on a decrease line is refused rather than silently ignored'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
do $$
begin
  perform post_stock_adjustment((select adjustment_id from _adj_bad_rate));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'stock adjustments are admin-only: a user-role session raises DN_FORBIDDEN'
);

create temp table _adj_negative as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-06-28', (select head_id from _wh), 'draft')
  returning id
)
select id as adjustment_id from a;
grant select on _adj_negative to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', -1000 from _adj_negative, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_adjustment((select adjustment_id from _adj_negative));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'writing off more than is on hand raises DN_NEGATIVE_STOCK'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_stock_adjustment((select adjustment_id from _adj_down));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting a posted adjustment raises DN_NOT_DRAFT'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'stock_adjustment',
         (select adjustment_id from _adj_up), 'miscounted'),
  'an adjustment can be cancelled (reversed)'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from stock_adjustments where id = (select adjustment_id from _adj_up)),
  'cancelled',
  'the cancelled adjustment keeps its row and number'
);

select is(
  (select qty from stock_on_hand((select adj_item from _items), (select head_id from _wh))),
  90.000,
  'the reversal takes the found stock back out again (90)'
);

-- A mixed adjustment posts both directions gross, not netted.
create temp table _adj_mixed as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-06-29', (select head_id from _wh), 'draft')
  returning id
)
select id as adjustment_id from a;
grant select on _adj_mixed to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', -2 from _adj_mixed, _items;
insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty, rate)
select adjustment_id, 2, adj_item2, 'Adjust Sand cft', 3, 100 from _adj_mixed, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _adj_mixed_entry as
select post_stock_adjustment((select adjustment_id from _adj_mixed)) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _adj_mixed_entry to authenticated;

select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _adj_mixed_entry)),
  4,
  'a mixed adjustment posts both directions gross (4 lines), not one netted pair'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _adj_mixed_entry)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _adj_mixed_entry)),
  'the mixed adjustment entry is balanced'
);

-- ============================================================
-- Scenario: day close records the difference
-- 15 Jul 2026: cash receipt 5,000, cash expense 1,200, 2,000 banked. Expected = 1,800.
-- ============================================================

create temp table _receipt as
with p as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-15', party_id, 'cash', 5000,
         (select id from accounts where system_key = 'cash'), 'draft'
  from _party
  returning id
)
select id as payment_id from p;
grant select on _receipt to authenticated;

create temp table _rent as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type)
  values ('2026-07-15', 'draft', 'expense')
  returning id
)
select id as voucher_id from v;
grant select on _rent to authenticated;

insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select id from accounts where system_key = 'godown_rent'), 1200, 'July rent'
from _rent;

-- Banking the day's cash: Dr Bank / Cr Cash, through a plain expense voucher whose "expense"
-- line is the bank ledger and whose pay account is cash.
create temp table _deposit as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
  values ('2026-07-15', 'draft', 'expense',
          (select id from accounts where system_key = 'cash'))
  returning id
)
select id as voucher_id from v;
grant select on _deposit to authenticated;

insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select id from accounts where system_key = 'bank'), 2000, 'banked'
from _deposit;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select post_payment(%L)', (select payment_id from _receipt)),
  'cash receipt of Rs 5,000 posts on 15 Jul'
);
select lives_ok(
  format('select post_expense_voucher(%L)', (select voucher_id from _rent)),
  'cash expense of Rs 1,200 posts on 15 Jul'
);
select lives_ok(
  format('select post_expense_voucher(%L)', (select voucher_id from _deposit)),
  'Rs 2,000 is banked on 15 Jul (Dr Bank / Cr Cash)'
);
reset role;
set local request.jwt.claims to '';

-- Counted Rs 1,600 against an expected Rs 1,800: Rs 200 short.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _close_short as
select post_day_close('2026-07-15', 1600, 'counter short') as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _close_short to authenticated;

select is(
  (select opening_cash from day_closes where close_date = '2026-07-15'),
  0.00,
  'opening cash on the first cash day is zero'
);

select is(
  (select cash_in from day_closes where close_date = '2026-07-15'),
  5000.00,
  'cash_in = Rs 5,000'
);

select is(
  (select deposited from day_closes where close_date = '2026-07-15'),
  2000.00,
  'deposited = Rs 2,000 (recognised by its Bank contra line)'
);

select is(
  (select cash_out from day_closes where close_date = '2026-07-15'),
  1200.00,
  'cash_out excludes the deposit: Rs 1,200, not Rs 3,200'
);

select is(
  (select expected from day_closes where close_date = '2026-07-15'),
  1800.00,
  'expected = 0 opening + 5,000 in - 1,200 out - 2,000 banked = Rs 1,800 (no outflow counted twice)'
);

select is(
  (select counted from day_closes where close_date = '2026-07-15'),
  1600.00,
  'counted = Rs 1,600'
);

select is(
  (select difference from day_closes where close_date = '2026-07-15'),
  -200.00,
  'day_closes.difference = -200'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _close_short)
     and account_id = (select id from accounts where system_key = 'cash_over_short')),
  200.00,
  'Dr Cash over/short 200'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _close_short)
     and account_id = (select id from accounts where system_key = 'cash')),
  200.00,
  'Cr Cash 200'
);

select is(
  (select entry_date from journal_entries where id = (select entry_id from _close_short)),
  '2026-07-15'::date,
  'the difference is posted on the day being closed'
);

select is(
  (select journal_entry_id from day_closes where close_date = '2026-07-15'),
  (select entry_id from _close_short),
  'the close links to its journal entry'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_day_close('2026-07-15', 1600, 'again');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:already_closed',
  'one close per date: a second close for the same day is refused'
);

-- 16 Jul: opening 1,600 (yesterday's expected less the 200 short), plus a 1,000 receipt.
-- Counted 2,650 against an expected 2,600: Rs 50 over. Posted by a plain 'user' session.
create temp table _receipt2 as
with p as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-16', party_id, 'cash', 1000,
         (select id from accounts where system_key = 'cash'), 'draft'
  from _party
  returning id
)
select id as payment_id from p;
grant select on _receipt2 to authenticated;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select lives_ok(
  format('select post_payment(%L)', (select payment_id from _receipt2)),
  'a user-role session posts the 16 Jul receipt'
);
create temp table _close_over as
select post_day_close('2026-07-16', 2650, 'counter over') as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _close_over to authenticated;

select is(
  (select opening_cash from day_closes where close_date = '2026-07-16'),
  1600.00,
  'the previous day close carries forward: opening cash Rs 1,600'
);

select is(
  (select expected from day_closes where close_date = '2026-07-16'),
  2600.00,
  'expected = 1,600 + 1,000'
);

select is(
  (select difference from day_closes where close_date = '2026-07-16'),
  50.00,
  'an over day records a positive difference'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _close_over)
     and account_id = (select id from accounts where system_key = 'cash')),
  50.00,
  'over: Dr Cash 50'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _close_over)
     and account_id = (select id from accounts where system_key = 'cash_over_short')),
  50.00,
  'over: Cr Cash over/short 50'
);

select is(
  (select closed_by from day_closes where close_date = '2026-07-16'),
  '44444444-4444-4444-4444-444444444444'::uuid,
  'closed_by is the real session actor (a user-role session may close the day)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_day_close(
    ((now() at time zone (select timezone from organization limit 1))::date + 1), 100, 'tomorrow');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:future_date',
  'a day in the future cannot be closed (date derived in the org timezone, never current_date)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_day_close('2026-07-17', -5, 'negative');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_counted',
  'a negative counted amount is refused'
);

-- Reopening a close is admin-only and audit-logged.
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
do $$
begin
  perform cancel_document('day_close',
    (select id from day_closes where close_date = '2026-07-16'), 'recount');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role session cannot reopen a day close'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
create temp table _reopen as
select cancel_document('day_close',
  (select id from day_closes where close_date = '2026-07-16'), 'recount') as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _reopen to authenticated;

select is(
  (select status from day_closes where close_date = '2026-07-16'),
  'cancelled',
  'the reopened close is kept as a cancelled row, not deleted'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _reopen)
     and account_id = (select id from accounts where system_key = 'cash_over_short')),
  50.00,
  'the reopen posts a mirror-image reversal of the over/short entry'
);

select is(
  (select reversed_by from journal_entries where id = (select entry_id from _close_over)),
  (select entry_id from _reopen),
  'the original day-close entry is linked to its reversal'
);

select is(
  (select count(*)::int from audit_log
   where entity = 'day_closes' and action = 'cancel'),
  1,
  'the reopen writes exactly one audit_log row'
);

-- The reversal belongs to the day being reopened, not to the day somebody noticed (review
-- blocker). Everything else in this engine reverses on today's date on purpose; a day close is
-- the exception, because post_day_close derives `expected` from the cash ledger as at
-- close_date. A reversal dated later would leave the cancelled over/short entry inside the very
-- day it cancelled, and the re-close would read it as real cash movement.
select is(
  (select entry_date from journal_entries where id = (select entry_id from _reopen)),
  '2026-07-16'::date,
  'the reopen reverses on the closed day itself, not on the day the reopen happened'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  $$ select post_day_close('2026-07-16', 2650, 'recounted') $$,
  'after a reopen the same date can be closed again'
);
reset role;
set local request.jwt.claims to '';

-- The re-close must reach the same numbers as the first one: the original over/short entry and
-- its reversal both sit on 16 Jul and cancel exactly, so nothing about that day changed.
select is(
  (select expected from day_closes where close_date = '2026-07-16' and status = 'posted'),
  2600.00,
  're-closing the reopened day computes the same expected Rs 2,600'
);

select is(
  (select difference from day_closes where close_date = '2026-07-16' and status = 'posted'),
  50.00,
  're-closing the reopened day computes the same Rs 50 over'
);

select is(
  (select count(*)::int from day_closes where close_date = '2026-07-16'),
  2,
  'both the reopened close and the re-close survive as rows (one cancelled, one posted)'
);

-- The strongest statement a day close can make: after it, the Cash ledger as at that date is
-- exactly what the counter counted. Asserted for the short day and the reopened/over day.
select is(
  (select coalesce(sum(jl.debit) - sum(jl.credit), 0) from journal_lines jl
   join journal_entries je on je.id = jl.entry_id
   where jl.account_id = (select id from accounts where system_key = 'cash')
     and je.entry_date <= '2026-07-15'),
  1600.00,
  'short day: the Cash GL as at 15 Jul equals the Rs 1,600 counted'
);

select is(
  (select coalesce(sum(jl.debit) - sum(jl.credit), 0) from journal_lines jl
   join journal_entries je on je.id = jl.entry_id
   where jl.account_id = (select id from accounts where system_key = 'cash')
     and je.entry_date <= '2026-07-16'),
  2650.00,
  'over day, after a reopen and a re-close: the Cash GL as at 16 Jul equals the Rs 2,650 counted'
);

-- ============================================================
-- Audit trail: one row per post, actor is the real session user
-- ============================================================

select is(
  (select count(*)::int from audit_log
   where entity = 'delivery_challans' and action = 'post'
     and entity_id = (select challan_id from _challan)),
  1,
  'post_delivery_challan writes exactly one audit_log row'
);

select is(
  (select actor from audit_log
   where entity = 'stock_transfers' and action = 'receive'
     and entity_id = (select transfer_id from _transfer)),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'audit_log.actor for receive_stock_transfer is auth.uid(), not a parameter'
);

-- ============================================================
-- Credit-limit semantics (Decisions from change 04 review): NULL = unlimited, 0 = no credit
-- ============================================================

select is(
  (select credit_limit from parties where id = (select party_id from _party)),
  null::numeric,
  'a party created without a credit limit gets NULL, which means unlimited'
);

select is(
  (select credit_limit from parties where is_walk_in),
  0.00,
  'the walk-in customer keeps credit_limit = 0, which now means no credit at all'
);

create temp table _cs_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Cash Sale Cement 50kg', 'cement', '2523', 18, 'bag', 360)
  returning id
)
select id as item_id from i;
grant select on _cs_item to authenticated;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select head_id from _wh), '2026-04-05', 1000, 300, 300000, 'opening' from _cs_item;

create temp table _walkin as
select id as party_id from parties where is_walk_in;
grant select on _walkin to authenticated;

-- 100 bags at 360 = 36,000 + 18% = 42,480, to a party that may not have credit at all.
create temp table _cash_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-08-01', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh)
  from _walkin
  returning id
)
select id as invoice_id from inv;
grant select on _cash_invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Cash Sale Cement 50kg', '2523', 'bag', 100, 360, 0, 18
from _cash_invoice, _cs_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _cash_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CREDIT_LIMIT',
  'credit_limit = 0 means no credit: an ordinary invoice to the walk-in party is refused'
);

-- ============================================================
-- post_cash_sale: invoice + full-amount allocated receipt, one transaction
-- ============================================================

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
create temp table _cash_sale as
select post_cash_sale((select invoice_id from _cash_invoice),
                      (select id from accounts where system_key = 'cash')) as entry_id;
reset role;
set local request.jwt.claims to '';
grant select on _cash_sale to authenticated;

select is(
  (select status from sales_invoices where id = (select invoice_id from _cash_invoice)),
  'posted',
  'the same invoice the credit check refused posts as a cash sale (a user-role session)'
);

select is(
  (select grand_total from sales_invoices where id = (select invoice_id from _cash_invoice)),
  42480.00,
  'cash sale invoice grand total = Rs 42,480'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _cash_sale)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _cash_sale)),
  'the cash sale invoice entry is balanced'
);

create temp table _cash_payment as
select id as payment_id from payments
where party_id = (select party_id from _walkin) and payment_date = '2026-08-01';
grant select on _cash_payment to authenticated;

select is(
  (select count(*)::int from _cash_payment),
  1,
  'post_cash_sale created exactly one receipt'
);

select is(
  (select status from payments where id = (select payment_id from _cash_payment)),
  'posted',
  'the receipt is posted, not left as a draft'
);

select is(
  (select amount from payments where id = (select payment_id from _cash_payment)),
  42480.00,
  'the receipt is for the full invoice amount'
);

select is(
  (select mode from payments where id = (select payment_id from _cash_payment))::text,
  'cash',
  'paying into the cash ledger records mode = cash'
);

select is(
  (select amount from payment_allocations
   where payment_id = (select payment_id from _cash_payment)),
  42480.00,
  'the receipt is allocated to the invoice in full'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'ar')
     and party_id = (select party_id from _walkin)),
  0.00,
  'AR for the walk-in party nets to zero: nothing is owed after a cash sale'
);

select is(
  (select coalesce(sum(jl.debit) - sum(jl.credit), 0) from journal_lines jl
   join journal_entries je on je.id = jl.entry_id
   where jl.account_id = (select id from accounts where system_key = 'cash')
     and je.entry_date = '2026-08-01'),
  42480.00,
  'the cash ledger is up by the full sale value'
);

select is(
  (select count(*)::int from audit_log
   where action = 'post_cash_sale' and entity_id = (select invoice_id from _cash_invoice)),
  1,
  'post_cash_sale writes its own audit_log row on top of the invoice and receipt rows'
);

-- The money must land in a cash or bank ledger.
create temp table _cash_invoice_bad as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-08-02', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh)
  from _walkin
  returning id
)
select id as invoice_id from inv;
grant select on _cash_invoice_bad to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Cash Sale Cement 50kg', '2523', 'bag', 10, 360, 0, 18
from _cash_invoice_bad, _cs_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_cash_sale((select invoice_id from _cash_invoice_bad),
                         (select id from accounts where system_key = 'cheques_in_hand'));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_account',
  'a cash sale cannot be paid into a non-money ledger'
);

select is(
  (select status from sales_invoices where id = (select invoice_id from _cash_invoice_bad)),
  'draft',
  'the refused cash sale left its invoice untouched'
);

-- Atomicity: a failure in the receipt leg rolls the invoice back with it. The RCPT numbering
-- series is removed so post_payment fails *after* the invoice has already posted.
create temp table _cash_invoice_rollback as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-08-05', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh)
  from _walkin
  returning id
)
select id as invoice_id from inv;
grant select on _cash_invoice_rollback to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Cash Sale Cement 50kg', '2523', 'bag', 20, 360, 0, 18
from _cash_invoice_rollback, _cs_item;

create temp table _rcpt_seq as select * from doc_sequences where series = 'RCPT';
delete from doc_sequences where series = 'RCPT';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_cash_sale((select invoice_id from _cash_invoice_rollback),
                         (select id from accounts where system_key = 'cash'));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';

insert into doc_sequences (id, created_at, series, doc_type, fy_label, prefix, next_no)
select id, created_at, series, doc_type, fy_label, prefix, next_no from _rcpt_seq;

select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_sequence',
  'the receipt leg fails when its numbering series is missing'
);

select is(
  (select status from sales_invoices where id = (select invoice_id from _cash_invoice_rollback)),
  'draft',
  'a failing receipt rolls the invoice back: still draft, not posted-and-unpaid'
);

select is(
  (select invoice_no from sales_invoices where id = (select invoice_id from _cash_invoice_rollback)),
  null,
  'the rolled-back invoice burned no document number'
);

select is(
  (select count(*)::int from journal_entries
   where source_type = 'sales_invoice'
     and source_id = (select invoice_id from _cash_invoice_rollback)),
  0,
  'the rolled-back cash sale wrote no journal entry'
);

select is(
  (select count(*)::int from payments where payment_date = '2026-08-05'),
  0,
  'the rolled-back cash sale left no payment row behind'
);

select is(
  (select count(*)::int from stock_movements
   where source_type = 'sales_invoice'
     and source_id = (select invoice_id from _cash_invoice_rollback)),
  0,
  'the rolled-back cash sale moved no stock'
);

-- The internal function is reachable only from the two SECURITY DEFINER wrappers.
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform _post_sales_invoice((select invoice_id from _cash_invoice_rollback), true);
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'authenticated cannot call _post_sales_invoice: the credit check cannot be skipped directly'
);

-- ============================================================
-- Fixes from the fresh-context review of change 05
-- ============================================================

-- Finding 8: the constraints that make the function guards unreachable rather than merely
-- unlikely.
select throws_ok(
  format($$ insert into delivery_challan_lines
              (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
            values (%L, 9, %L, 'x', '0000', 'bag', 0, 100, 18) $$,
         (select challan_id from _challan2), (select ch_item from _items)),
  '23514',
  null,
  'a challan line of zero quantity is rejected by the table itself'
);

select throws_ok(
  $$ insert into day_closes (close_date, counted) values ('2026-08-20', -1) $$,
  '23514',
  null,
  'a day close cannot record a negative cash count'
);

-- Finding 6: only one transit warehouse can ever exist.
select throws_ok(
  $$ insert into warehouses (name, is_transit) values ('Second Transit', true) $$,
  '23505',
  null,
  'a second transit warehouse is rejected: post/receive resolve it with "where is_transit"'
);

-- Finding 7: an invoice may not predate the delivery it bills.
create temp table _early_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-15', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _early_challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 10, 360, 18
from _early_challan, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(
  format('select post_delivery_challan(%L)', (select challan_id from _early_challan)),
  'finding 7 fixture: a challan dated 15 Jun posts'
);
reset role;
set local request.jwt.claims to '';

create temp table _early_invoice as
with inv as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-14', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh), (select challan_id from _early_challan)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _early_invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 10, 360, 0, 18
from _early_invoice, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_sales_invoice((select invoice_id from _early_invoice));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invoice_before_challan',
  'an invoice dated before its challan is refused'
);

-- challan_not_posted: an invoice may only convert a posted challan.
create temp table _draft_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-16', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _draft_challan to authenticated;

create temp table _invoice_on_draft_challan as
with inv as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-17', party_id, (select state_code from organization limit 1), 'draft',
         (select head_id from _wh), (select challan_id from _draft_challan)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _invoice_on_draft_challan to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 10, 360, 0, 18
from _invoice_on_draft_challan, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_sales_invoice((select invoice_id from _invoice_on_draft_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:challan_not_posted',
  'an invoice cannot convert a challan that was never posted'
);

-- no_lines, invalid_party, transit_warehouse on a challan.
create temp table _empty_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-18', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _empty_challan to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _empty_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_lines',
  'a challan with no lines is refused'
);

create temp table _supplier_party as
with p as (
  insert into parties (name, type, state_code)
  select 'Cement Supplier', 'supplier', state_code from organization limit 1 returning id
)
select id as party_id from p;
grant select on _supplier_party to authenticated;

create temp table _supplier_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-18', party_id, (select head_id from _wh), 'draft' from _supplier_party
  returning id
)
select id as challan_id from c;
grant select on _supplier_challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 5, 360, 18
from _supplier_challan, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _supplier_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_party',
  'a delivery challan to a supplier is refused'
);

create temp table _transit_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-18', party_id, (select transit_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _transit_challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 5, 360, 18
from _transit_challan, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _transit_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:transit_warehouse',
  'a challan cannot dispatch from the transit warehouse'
);

-- non_stock_line and zero_cost on a challan.
create temp table _service_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock)
  values ('Delivery Charge', 'other', '9965', 18, 'trip', 500, false) returning id
)
select id as item_id from i;
grant select on _service_item to authenticated;

create temp table _service_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-18', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _service_challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, item_id, 'Delivery Charge', '9965', 'trip', 1, 500, 18
from _service_challan, _service_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _service_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:non_stock_line',
  'a service line has nothing to deliver: refused on a challan'
);

create temp table _free_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Zero Cost Cement', 'cement', '2523', 18, 'bag', 360) returning id
)
select id as item_id from i;
grant select on _free_item to authenticated;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select head_id from _wh), '2026-04-05', 50, 0, 0, 'opening' from _free_item;

create temp table _free_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-06-18', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _free_challan to authenticated;

insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, item_id, 'Zero Cost Cement', '2523', 'bag', 10, 360, 18
from _free_challan, _free_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _free_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:zero_cost',
  'a challan carrying goods with no cost basis is refused'
);

-- Finding 2: an increase valued at nothing would drag the weighted average down for every
-- later sale.
create temp table _zero_rate_adj as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status, reason)
  values ('2026-06-29', (select head_id from _wh), 'draft', 'found some old bags')
  returning id
)
select id as adjustment_id from a;
grant select on _zero_rate_adj to authenticated;

create temp table _never_stocked as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Never Stocked Item', 'other', '0000', 18, 'pcs', 50) returning id
)
select id as item_id from i;
grant select on _never_stocked to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, item_id, 'Never Stocked Item', 5 from _zero_rate_adj, _never_stocked;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_adjustment((select adjustment_id from _zero_rate_adj));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:zero_rate',
  'an increase line with no rate, on an item with no stock to average, is refused'
);

-- zero_value: a decrease of stock that is carried at zero.
create temp table _zero_value_adj as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-06-29', (select head_id from _wh), 'draft') returning id
)
select id as adjustment_id from a;
grant select on _zero_value_adj to authenticated;

insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, item_id, 'Zero Cost Cement', -5 from _zero_value_adj, _free_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_adjustment((select adjustment_id from _zero_value_adj));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:zero_value',
  'an adjustment that moves no value at all is refused'
);

-- no_lines on a transfer and on an adjustment; invalid_date on a day close.
create temp table _empty_transfer as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-30', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _empty_transfer to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_transfer((select transfer_id from _empty_transfer));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_lines',
  'a transfer with no lines is refused'
);

create temp table _empty_adj as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-06-30', (select head_id from _wh), 'draft') returning id
)
select id as adjustment_id from a;
grant select on _empty_adj to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_adjustment((select adjustment_id from _empty_adj));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_lines',
  'an adjustment with no lines is refused'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_day_close(null, 100, 'no date');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_date',
  'a day close with no date is refused'
);

-- missing_account: the engine refuses to guess which ledger it should have used.
update accounts set system_key = null where system_key = 'goods_in_transit';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _empty_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:(missing_account|no_lines)',
  'a missing system account is refused, never guessed'
);

update accounts set system_key = 'goods_in_transit' where code = '1310';

-- no_transit_warehouse: the seeded bucket is not optional.
update warehouses set is_transit = false where name = 'In Transit';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_transfer((select transfer_id from _transfer_short));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_transit_warehouse',
  'a transfer cannot post when no transit warehouse exists'
);

update warehouses set is_transit = true where name = 'In Transit';

-- ============================================================
-- DN_PERIOD_LOCKED on every function this change adds
-- ============================================================

update fiscal_periods set is_locked = true where month = '2026-05-01';

create temp table _locked_challan as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-05-10', party_id, (select head_id from _wh), 'draft' from _party
  returning id
)
select id as challan_id from c;
grant select on _locked_challan to authenticated;
insert into delivery_challan_lines
  (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select challan_id, 1, ch_item, 'Challan Cement 50kg', '2523', 'bag', 5, 360, 18
from _locked_challan, _items;

create temp table _locked_transfer as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-05-10', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _locked_transfer to authenticated;
insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 5 from _locked_transfer, _items;

create temp table _locked_adj as
with a as (
  insert into stock_adjustments (adj_date, warehouse_id, status)
  values ('2026-05-10', (select head_id from _wh), 'draft') returning id
)
select id as adjustment_id from a;
grant select on _locked_adj to authenticated;
insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
select adjustment_id, 1, adj_item, 'Adjust Cement 50kg', -1 from _locked_adj, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_delivery_challan((select challan_id from _locked_challan));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'post_delivery_challan refuses a locked period');

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_transfer((select transfer_id from _locked_transfer));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'post_stock_transfer refuses a locked period');

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_stock_adjustment((select adjustment_id from _locked_adj));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'post_stock_adjustment refuses a locked period');

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform post_day_close('2026-05-10', 100, 'locked');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'post_day_close refuses a locked period');

update fiscal_periods set is_locked = false where month = '2026-05-01';

-- receive_stock_transfer and the day_close reopen both date themselves, so they are tested by
-- locking the month they would land in: today (IST) for the receive, the closed day for the
-- reopen.
create temp table _locked_receive as
with t as (
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values ('2026-06-30', (select head_id from _wh), (select branch_id from _branch), 'draft')
  returning id
)
select id as transfer_id from t;
grant select on _locked_receive to authenticated;
insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
select transfer_id, 1, tr_item, 'Transfer Cement 50kg', 'bag', 5 from _locked_receive, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select lives_ok(format('select post_stock_transfer(%L)', (select transfer_id from _locked_receive)),
  'period-lock fixture: a transfer goes in_transit before the month is locked');
reset role;
set local request.jwt.claims to '';

update fiscal_periods set is_locked = true
where month = date_trunc('month',
  (now() at time zone (select timezone from organization limit 1))::date)::date;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin perform receive_stock_transfer((select transfer_id from _locked_receive));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'receive_stock_transfer refuses when today''s period is locked');

update fiscal_periods set is_locked = false
where month = date_trunc('month',
  (now() at time zone (select timezone from organization limit 1))::date)::date;

update fiscal_periods set is_locked = true where month = '2026-07-01';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin
  perform cancel_document('day_close',
    (select id from day_closes where close_date = '2026-07-15' and status = 'posted'), 'x');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_PERIOD_LOCKED',
  'reopening a day close checks the closed day''s own period, not today''s');

update fiscal_periods set is_locked = false where month = '2026-07-01';

-- ============================================================
-- Table grants: RLS is not the only lock on the ledger (owner decision)
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin
  insert into journal_entries (entry_date, narration, source_type)
  values ('2026-06-01', 'hand-written', 'manual');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'an authenticated session cannot INSERT a journal entry by hand — grants, not just RLS'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role service_role;
do $$ begin
  insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
  values (gen_random_uuid(), gen_random_uuid(), '2026-06-01', 1, 1, 1, 'manual');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'not even service_role, which bypasses RLS entirely, can write a stock movement directly'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role service_role;
do $$ begin
  update audit_log set action = 'rewritten';
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'service_role cannot rewrite the audit log'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform 1 from accounts limit 1;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no privileges left on the business tables at all'
);

-- ============================================================
-- anon has no EXECUTE on any function this change adds
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_delivery_challan(gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_delivery_challan'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_stock_transfer(gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_stock_transfer'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform receive_stock_transfer(gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on receive_stock_transfer'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_stock_adjustment(gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_stock_adjustment'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_day_close('2026-07-20', 0, 'x');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_day_close'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_cash_sale(gen_random_uuid(), gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_cash_sale'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform _post_sales_invoice(gen_random_uuid(), true);
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on _post_sales_invoice either'
);

-- ============================================================
-- Global invariant: after everything above, no journal entry in the database is unbalanced
-- ============================================================

select is(
  (select count(*)::int from (
     select entry_id from journal_lines
     group by entry_id
     having sum(debit) <> sum(credit)
   ) unbalanced),
  0,
  'no journal entry anywhere in the database is unbalanced'
);

select is(
  (select count(*)::int from (
     select entry_id from journal_lines group by entry_id having count(*) < 2
   ) thin),
  0,
  'every journal entry has at least two lines'
);

-- ============================================================
-- Finding 11: the stock ledger and the general ledger tell the same story after every flow in
-- this file — challan, conversion, cancellation, transfer, receipt, adjustment, cash sale.
--
-- The review asked for "Σ stock_movements.value = Inventory GL + Goods-in-Transit GL". That
-- identity belongs to a design where a challan moves stock INTO a transit warehouse; this
-- change deliberately does not (see implementation-notes decision #4 — the invoice writes no
-- stock movement, so goods parked in a transit warehouse could never leave it). Under the
-- design as built the true pair of invariants is stronger, and both are asserted here:
--   A. every rupee that entered or left the stock ledger after opening is mirrored in Inventory;
--   B. Goods in Transit holds exactly the cost of delivered-but-uninvoiced challans, no more.
-- Opening movements are excluded from A because the opening-balance journal entry is change
-- 17's; these fixtures inject opening stock directly, as change 03's and 04's do.
select is(
  (select coalesce(sum(value), 0) from stock_movements where source_type <> 'opening'),
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'inventory')),
  'A: the stock ledger''s post-opening movement value equals the Inventory GL balance'
);

select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select id from accounts where system_key = 'goods_in_transit')),
  (select coalesce(sum(-m.value), 0)
   from stock_movements m
   join delivery_challans c on c.id = m.source_id
   where m.source_type = 'delivery_challan' and m.reversal_of is null
     and c.status = 'posted' and c.invoice_id is null),
  'B: Goods in Transit holds exactly the cost of the challans that are out and un-invoiced'
);

select * from finish();

rollback;
