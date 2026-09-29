-- Change 21a (purchases-ui): a supplier's bill number can be posted only once per supplier.
-- Index-level test: fixtures are inserted directly as postgres with status already set; the
-- posting functions are covered by 00006.
begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

create temp table _p as
with a as (
  insert into parties (name, type, state_code)
  select 'Bill Unique Supplier A', 'supplier', state_code from organization limit 1 returning id
),
b as (
  insert into parties (name, type, state_code)
  select 'Bill Unique Supplier B', 'supplier', state_code from organization limit 1 returning id
)
select (select id from a) as a_id, (select id from b) as b_id;

create temp table _wh as select id as wh_id from warehouses where is_default limit 1;

create function _bill(p_party uuid, p_no text, p_status doc_status) returns uuid
language sql as $$
  insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
  select '2026-09-01', p_party, state_code, p_status, (select wh_id from _wh), p_no from organization
  returning id
$$;

select lives_ok(
  $$select _bill((select a_id from _p), 'SUP/100', 'posted')$$,
  'a first posted bill with a supplier number is accepted');

select throws_ok(
  $$select _bill((select a_id from _p), 'SUP/100', 'posted')$$,
  '23505', null,
  'the same number from the same supplier cannot be posted twice');

select throws_ok(
  $$select _bill((select a_id from _p), '  sup/100 ', 'posted')$$,
  '23505', null,
  'case and surrounding spaces make no difference');

select lives_ok(
  $$select _bill((select b_id from _p), 'SUP/100', 'posted')$$,
  'another supplier may use the same number');

select lives_ok(
  $$select _bill((select a_id from _p), 'SUP/100', 'draft')$$,
  'a draft may repeat a number (the check happens when one of them is posted)');

update purchase_invoices set status = 'cancelled'
 where party_id = (select a_id from _p) and status = 'posted';
select lives_ok(
  $$select _bill((select a_id from _p), 'SUP/100', 'posted')$$,
  'a cancelled bill frees its number for a corrected copy');

-- Bills with no number (opening entries, older rows) or a blank one are outside the rule.
select lives_ok(
  $$select _bill((select b_id from _p), null, 'posted'), _bill((select b_id from _p), null, 'posted')$$,
  'two posted bills with no supplier number for one supplier are both allowed');
select lives_ok(
  $$select _bill((select b_id from _p), '  ', 'posted'), _bill((select b_id from _p), '', 'posted')$$,
  'blank numbers are outside the rule too');

-- The failure carries the index name, which the app matches on to give its friendly message.
select throws_like(
  $$select _bill((select a_id from _p), 'SUP/100', 'posted')$$,
  '%purchase_invoices_supplier_bill_uniq%',
  'the refusal names the index (the action maps it to its own sentence)');

-- The real posting path: a draft whose number is already posted for the supplier is refused
-- by post_purchase_invoice itself, atomically (nothing is left behind: no number, no stock, no entry).
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'bill-unique-admin@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values ('55555555-5555-5555-5555-555555555555', 'admin', 'Bill Unique Admin', true);
create temp table _it as
  with i as (insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
             values ('Bill Unique Item', 'other', '0000', 18, 'pcs', 100) returning id)
  select id as item_id from i;
create temp table _draft as
  select _bill((select a_id from _p), 'SUP/100', 'draft') as bill_id;
insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select bill_id, 1, (select item_id from _it), 'Bill Unique Item', '0000', 'pcs', 10, 50, 0, 18 from _draft;
-- the earlier tests cancelled the posted SUP/100 for supplier A and re-posted one: it is posted now
grant select on _draft to authenticated;
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal2"}';
select throws_like(
  $$select post_purchase_invoice((select bill_id from _draft))$$,
  '%purchase_invoices_supplier_bill_uniq%',
  'post_purchase_invoice refuses a draft whose supplier number is already posted');
reset role;
set local request.jwt.claims to '';
select is(
  (select count(*)::int from stock_movements where source_id = (select bill_id from _draft)),
  0,
  'the refused posting left no stock movement behind');

select * from finish();
rollback;
