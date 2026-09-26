-- Must pass (change 04, posting-purchase-payment): the acceptance scenario
-- "cheque bounce re-opens the invoices", plus everything under the proposal's "Done when":
-- purchase invoices (ITC / non-ITC, intra / inter-state, round-off), receipts and payments
-- (cash, bank, cheque, discount), every expense-voucher shape (generic expense, employee
-- advance, salary with advance recovery, named daily wages, unnamed hamali, RCM freight),
-- allocation caps and direction mismatch, DN_NOT_DRAFT, DN_CHEQUE_STATE, the 'user' role gates
-- (no purchases, no bounce, advance capped at Rs 5,000), weighted average after two purchases,
-- purchase cancellation with allocations / with the stock already sold, and anon denied EXECUTE
-- on every new function.
--
-- Same discipline as change 03's file: every post_*/cancel_*/cheque call runs under
-- `set local role authenticated` with real JWT claims, never as postgres, because the actor is
-- auth.uid() and because that is the only way a happy path also proves a real session can call
-- the function at all. Fixtures (drafts, opening stock) are created as postgres on purpose.
-- Sigma-debit = Sigma-credit is asserted on every entry this file creates.
begin;

create extension if not exists pgtap with schema extensions;

select plan(187);

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

create temp table _warehouse as select id as warehouse_id from warehouses where is_default limit 1;
grant select on _warehouse to authenticated;

create temp table _parties as
with sup as (
  insert into parties (name, type, state_code)
  select 'Local Cement Supplier', 'supplier', state_code from organization limit 1
  returning id
),
isup as (
  insert into parties (name, type, state_code)
  values ('Out of State Supplier', 'supplier', '29')
  returning id
),
cust as (
  insert into parties (name, type, state_code)
  select 'Test Builder', 'customer', state_code from organization limit 1
  returning id
),
emp as (
  insert into parties (name, type, state_code, monthly_salary)
  select 'Ramesh (Godown Staff)', 'employee', state_code, 20000 from organization limit 1
  returning id
),
worker as (
  insert into parties (name, type, state_code, daily_wage)
  select 'Suresh (Hamali)', 'employee', state_code, 600 from organization limit 1
  returning id
),
lorry as (
  insert into parties (name, type, state_code)
  select 'Lorry Owner (GTA)', 'supplier', state_code from organization limit 1
  returning id
)
select (select id from sup) as supplier_id,
       (select id from isup) as isupplier_id,
       (select id from cust) as customer_id,
       (select id from emp) as employee_id,
       (select id from worker) as worker_id,
       (select id from lorry) as lorry_id;
grant select on _parties to authenticated;

create temp table _items as
with p as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Purchase Cement 50kg', 'cement', '2523', 18, 'bag', 360) returning id
),
n as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Non-ITC Item', 'other', '0000', 18, 'pcs', 150) returning id
),
i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Interstate Item', 'other', '0000', 18, 'pcs', 150) returning id
),
r as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Round Off Purchase Item', 'other', '0000', 0, 'pcs', 120) returning id
),
s as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Sale Item', 'other', '0000', 18, 'pcs', 200) returning id
),
b as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Bounce Scenario Item', 'other', '0000', 18, 'pcs', 200) returning id
),
c as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Sold-On Item', 'other', '0000', 18, 'pcs', 200) returning id
),
d as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Clean Cancel Item', 'other', '0000', 18, 'pcs', 200) returning id
),
f as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock)
  values ('Service Line (not stock)', 'other', '9965', 18, 'trip', 1500, false) returning id
)
select (select id from p) as pitem, (select id from n) as nitem,
       (select id from i) as iitem, (select id from r) as ritem,
       (select id from s) as sitem, (select id from b) as bitem,
       (select id from c) as citem, (select id from d) as ditem,
       (select id from f) as fitem;
grant select on _items to authenticated;

-- Opening stock only for the items that get sold; every purchased item starts at zero so the
-- weighted-average assertions are exact.
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select sitem, (select warehouse_id from _warehouse), '2026-04-05', 1000, 100, 100000, 'opening' from _items;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select bitem, (select warehouse_id from _warehouse), '2026-04-05', 1000, 50, 50000, 'opening' from _items;

create temp table _accounts as
select
  (select id from accounts where system_key = 'ap') as ap,
  (select id from accounts where system_key = 'ar') as ar,
  (select id from accounts where system_key = 'inventory') as inventory,
  (select id from accounts where system_key = 'input_cgst') as in_cgst,
  (select id from accounts where system_key = 'input_sgst') as in_sgst,
  (select id from accounts where system_key = 'input_igst') as in_igst,
  (select id from accounts where system_key = 'round_off') as round_off,
  (select id from accounts where system_key = 'cash') as cash,
  (select id from accounts where system_key = 'bank') as bank,
  (select id from accounts where system_key = 'cheques_in_hand') as chq,
  (select id from accounts where system_key = 'discount_allowed') as disc_allowed,
  (select id from accounts where system_key = 'discount_received') as disc_received,
  (select id from accounts where system_key = 'employee_advance') as emp_advance,
  (select id from accounts where system_key = 'salary_payable') as salary_payable,
  (select id from accounts where system_key = 'salaries') as salaries,
  (select id from accounts where system_key = 'loading_unloading') as loading,
  (select id from accounts where system_key = 'freight_inward') as freight_in,
  (select id from accounts where system_key = 'rcm_payable') as rcm_payable,
  (select id from accounts where system_key = 'godown_rent') as godown_rent;
grant select on _accounts to authenticated;

select isnt(
  (select chq from _accounts), null,
  'change 04 seeds the cheques_in_hand system account (1130)'
);

-- ============================================================
-- post_purchase_invoice: ITC-eligible, intra-state
-- 100 bags @ Rs 300, 18% GST -> taxable 30,000 + CGST 2,700 + SGST 2,700 = 35,400
-- ============================================================

create temp table _pi1 as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible)
  select '2026-06-10', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), 'SUP/001', true
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi1 to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, pitem, 'Purchase Cement 50kg', '2523', 'bag', 100, 300, 0, 18
from _pi1, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi1_posted as
select post_purchase_invoice((select invoice_id from _pi1)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from purchase_invoices where id = (select invoice_id from _pi1)),
  'posted',
  'purchase invoice is posted by a real authenticated admin session'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi1_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pi1_posted)),
  'ITC purchase entry is balanced'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi1_posted)),
  35400.00,
  'ITC purchase entry side-total = Rs 35,400'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi1_posted)
     and account_id = (select inventory from _accounts)),
  30000.00,
  'Inventory is debited with the taxable value only when ITC is claimable'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi1_posted)
     and account_id = (select in_cgst from _accounts)),
  2700.00,
  'Input CGST debit = Rs 2,700'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi1_posted)
     and account_id = (select in_sgst from _accounts)),
  2700.00,
  'Input SGST debit = Rs 2,700'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _pi1_posted)
     and account_id = (select ap from _accounts)),
  35400.00,
  'AP control line credit = Rs 35,400 (grand total)'
);
select is(
  (select party_id from journal_lines
   where entry_id = (select entry_id from _pi1_posted)
     and account_id = (select ap from _accounts)),
  (select supplier_id from _parties),
  'the AP control line carries the supplier party_id (party rule)'
);
select is(
  (select invoice_no from purchase_invoices where id = (select invoice_id from _pi1)),
  'PB/26-27/0001',
  'purchase invoice number comes from the PB series'
);
select is(
  (select qty from stock_movements
   where source_type = 'purchase_invoice' and source_id = (select invoice_id from _pi1)),
  100.000,
  'stock IN qty = +100 (base UOM)'
);
select is(
  (select value from stock_movements
   where source_type = 'purchase_invoice' and source_id = (select invoice_id from _pi1)),
  30000.00,
  'stock IN value = landed cost Rs 30,000 (tax excluded, it is claimable)'
);
select is(
  (select actor from audit_log
   where entity = 'purchase_invoices' and entity_id = (select invoice_id from _pi1)
     and action = 'post'),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'audit_log.actor is the real session uid'
);

-- Second purchase of the same item at a different rate: weighted average moves.
create temp table _pi2 as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible)
  select '2026-06-12', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), true
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi2 to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, pitem, 'Purchase Cement 50kg', '2523', 'bag', 100, 320, 0, 18
from _pi2, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi2_posted as
select post_purchase_invoice((select invoice_id from _pi2)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select qty from stock_on_hand((select pitem from _items), (select warehouse_id from _warehouse))),
  200.000,
  'on-hand qty after two purchases = 200'
);
select is(
  (select avg_rate from stock_on_hand((select pitem from _items), (select warehouse_id from _warehouse))),
  310.0000,
  'weighted average after two purchases = (30,000 + 32,000) / 200 = Rs 310'
);

-- ============================================================
-- post_purchase_invoice: ITC NOT eligible -> tax is capitalised into stock
-- ============================================================

create temp table _pi_noitc as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible)
  select '2026-06-13', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), false
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi_noitc to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, nitem, 'Non-ITC Item', '0000', 'pcs', 10, 100, 0, 18
from _pi_noitc, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi_noitc_posted as
select post_purchase_invoice((select invoice_id from _pi_noitc)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi_noitc_posted)
     and account_id = (select inventory from _accounts)),
  1180.00,
  'non-ITC purchase capitalises the tax into Inventory (1,000 + 90 + 90)'
);
select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _pi_noitc_posted)
     and account_id in ((select in_cgst from _accounts), (select in_sgst from _accounts),
                        (select in_igst from _accounts))),
  0,
  'non-ITC purchase claims no input tax credit'
);
select is(
  (select value from stock_movements
   where source_type = 'purchase_invoice' and source_id = (select invoice_id from _pi_noitc)),
  1180.00,
  'non-ITC stock IN value is the tax-inclusive landed cost'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi_noitc_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pi_noitc_posted)),
  'non-ITC purchase entry is balanced'
);

-- ============================================================
-- post_purchase_invoice: inter-state supplier -> IGST
-- ============================================================

create temp table _pi_inter as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible)
  select '2026-06-14', isupplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), true
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi_inter to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, iitem, 'Interstate Item', '0000', 'pcs', 10, 100, 0, 18
from _pi_inter, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi_inter_posted as
select post_purchase_invoice((select invoice_id from _pi_inter)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi_inter_posted)
     and account_id = (select in_igst from _accounts)),
  180.00,
  'inter-state purchase debits Input IGST (1,000 taxable @ 18%)'
);
select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _pi_inter_posted)
     and account_id in ((select in_cgst from _accounts), (select in_sgst from _accounts))),
  0,
  'inter-state purchase has no CGST/SGST lines'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi_inter_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pi_inter_posted)),
  'inter-state purchase entry is balanced'
);

-- ============================================================
-- Purchase round-off: the debit side carries it (mirror image of the sales side)
-- ============================================================

create temp table _pi_round as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible)
  select '2026-06-15', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), true
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi_round to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ritem, 'Round Off Purchase Item', '0000', 'pcs', 1, 100.60, 0, 0
from _pi_round, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi_round_posted as
select post_purchase_invoice((select invoice_id from _pi_round)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select round_off from purchase_invoices where id = (select invoice_id from _pi_round)),
  0.40,
  'purchase round_off = +0.40 (raw 100.60 rounds up to 101)'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pi_round_posted)
     and account_id = (select round_off from _accounts)),
  0.40,
  'a purchase paid up to the rupee debits Round Off (it is an expense)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi_round_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pi_round_posted)),
  'purchase round-off entry is balanced'
);

-- ============================================================
-- post_purchase_invoice guards: non-stock line, 'user' role, DN_NOT_DRAFT
-- ============================================================

create temp table _pi_service as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-16', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _pi_service to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, fitem, 'Service Line (not stock)', '9965', 'trip', 1, 1500, 0, 18
from _pi_service, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_purchase_invoice((select invoice_id from _pi_service));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:non_stock_line',
  'a service line on a purchase invoice is refused (freight belongs on a linked expense voucher)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_purchase_invoice((select invoice_id from _pi_service));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role session cannot post a purchase invoice'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_purchase_invoice((select invoice_id from _pi1));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting an already-posted purchase invoice raises DN_NOT_DRAFT (idempotency)'
);

-- ============================================================
-- post_payment: cash receipt with an allocation
-- ============================================================

create temp table _si1 as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-20', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _si1 to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, sitem, 'Sale Item', '0000', 'pcs', 100, 200, 0, 18 from _si1, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L)', (select invoice_id from _si1)),
  'fixture sales invoice posts (grand total Rs 23,600)'
);
reset role;
set local request.jwt.claims to '';

create temp table _rcpt1 as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-06-21', customer_id, 'cash', 23600,
         (select cash from _accounts), 'draft'
  from _parties
  returning id
)
select id as payment_id from pay;
grant select on _rcpt1 to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select payment_id, 'sales_invoice', (select invoice_id from _si1), 23600 from _rcpt1;
reset role;
set local request.jwt.claims to '';


-- A receipt is one of the two things a counter user may post.
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
create temp table _rcpt1_posted as
select post_payment((select payment_id from _rcpt1)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from payments where id = (select payment_id from _rcpt1)),
  'posted',
  'a cash receipt posts under a real user-role session'
);
select is(
  (select voucher_no from payments where id = (select payment_id from _rcpt1)),
  'RCPT/26-27/0001',
  'receipts number from the RCPT series'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _rcpt1_posted)
     and account_id = (select cash from _accounts)),
  23600.00,
  'cash receipt debits Cash'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _rcpt1_posted)
     and account_id = (select ar from _accounts)),
  23600.00,
  'cash receipt credits AR for the party'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _rcpt1_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _rcpt1_posted)),
  'cash receipt entry is balanced'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_payment((select payment_id from _rcpt1));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting a posted payment raises DN_NOT_DRAFT (idempotency)'
);

-- ============================================================
-- post_payment: receipt with cash discount
-- ============================================================

create temp table _rcpt_disc as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
  select 'receipt', '2026-06-22', customer_id, 'upi', 9900, 100,
         (select bank from _accounts), 'draft'
  from _parties
  returning id
)
select id as payment_id from pay;
grant select on _rcpt_disc to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _rcpt_disc_posted as
select post_payment((select payment_id from _rcpt_disc)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _rcpt_disc_posted)
     and account_id = (select disc_allowed from _accounts)),
  100.00,
  'a receipt with a cash discount debits Discount Allowed'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _rcpt_disc_posted)
     and account_id = (select ar from _accounts)),
  10000.00,
  'AR is relieved by amount + discount (9,900 + 100)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _rcpt_disc_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _rcpt_disc_posted)),
  'discounted receipt entry is balanced'
);

-- ============================================================
-- post_payment: outgoing payment with discount received
-- ============================================================

create temp table _pay_disc as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
  select 'payment', '2026-06-23', supplier_id, 'neft', 34400, 1000,
         (select bank from _accounts), 'draft'
  from _parties
  returning id
)
select id as payment_id from pay;
grant select on _pay_disc to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select payment_id, 'purchase_invoice', (select invoice_id from _pi1), 34400 from _pay_disc;
reset role;
set local request.jwt.claims to '';


select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_payment((select payment_id from _pay_disc));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role session cannot post an outgoing payment'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pay_disc_posted as
select post_payment((select payment_id from _pay_disc)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select voucher_no from payments where id = (select payment_id from _pay_disc)),
  'PAY/26-27/0001',
  'outgoing payments number from the PAY series, independently of RCPT'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _pay_disc_posted)
     and account_id = (select ap from _accounts)),
  35400.00,
  'an outgoing payment debits AP by amount + discount'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _pay_disc_posted)
     and account_id = (select disc_received from _accounts)),
  1000.00,
  'the supplier discount is credited to Discount Received'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _pay_disc_posted)
     and account_id = (select bank from _accounts)),
  34400.00,
  'Bank is credited with the cash actually paid'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pay_disc_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pay_disc_posted)),
  'outgoing payment entry is balanced'
);

-- ============================================================
-- Allocation trigger: caps and direction
-- ============================================================

create temp table _si_cap as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-24', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties
  returning id
)
select id as invoice_id from inv;
grant select on _si_cap to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, sitem, 'Sale Item', '0000', 'pcs', 10, 200, 0, 18 from _si_cap, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L)', (select invoice_id from _si_cap)),
  'cap-test sales invoice posts (grand total Rs 2,360)'
);
reset role;
set local request.jwt.claims to '';

create temp table _cap_payment as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-06-25', customer_id, 'cash', 1000, (select cash from _accounts), 'draft'
  from _parties
  returning id
)
select id as payment_id from pay;
grant select on _cap_payment to authenticated;

-- Every allocation below is written under a real authenticated session, not as postgres
-- (review finding B1): the cap trigger reads RLS-protected tables, so running these as the
-- superuser would have hidden the very hole the review found — a policy-filtered read makes a
-- cap silently pass. If the trigger ever loses SECURITY DEFINER again, these go red.
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select invoice_id from _si_cap), 1500 from _cap_payment;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_exceeds_payment',
  'allocating more than the payment amount is refused'
);

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'purchase_invoice', (select invoice_id from _pi2), 500 from _cap_payment;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_direction',
  'a receipt cannot be allocated to a purchase invoice (direction mismatch)'
);

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select invoice_id from _si1), 1000 from _cap_payment;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_exceeds_invoice',
  'allocating more than the invoice open amount is refused (invoice already fully settled)'
);

select set_config('pgtap_test.raised_msg', '', false);
do $$
declare v_draft uuid;
begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-25', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id into v_draft;

  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', v_draft, 100 from _cap_payment;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_invoice_not_posted',
  'an allocation against a draft invoice is refused'
);

select lives_ok(
  $$ insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
     select payment_id, 'sales_invoice', (select invoice_id from _si_cap), 1000
     from _cap_payment $$,
  'an allocation within both caps is accepted'
);
reset role;
set local request.jwt.claims to '';

-- ============================================================
-- ACCEPTANCE SCENARIO: cheque bounce re-opens the invoices
-- A cheque receipt of Rs 35,400 allocated across two invoices (11,800 + 23,600), deposited,
-- then bounced.
-- ============================================================

create temp table _bounce_invoices as
with a as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-01', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
),
b as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-01', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select (select id from a) as inv_a, (select id from b) as inv_b;
grant select on _bounce_invoices to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select inv_a, 1, bitem, 'Bounce Scenario Item', '0000', 'pcs', 50, 200, 0, 18
from _bounce_invoices, _items;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select inv_b, 1, bitem, 'Bounce Scenario Item', '0000', 'pcs', 100, 200, 0, 18
from _bounce_invoices, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L)', (select inv_a from _bounce_invoices)),
  'bounce scenario: first invoice posts (Rs 11,800)'
);
select lives_ok(
  format('select post_sales_invoice(%L)', (select inv_b from _bounce_invoices)),
  'bounce scenario: second invoice posts (Rs 23,600)'
);
reset role;
set local request.jwt.claims to '';

create temp table _chq as
with pay as (
  insert into payments
    (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount,
     account_id, cheque_bank, status)
  select 'receipt', '2026-07-02', customer_id, 'cheque', '004417', '2026-07-02', 35400,
         (select bank from _accounts), 'SBI Chirala', 'draft'
  from _parties
  returning id
)
select id as payment_id from pay;
grant select on _chq to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select payment_id, 'sales_invoice', (select inv_a from _bounce_invoices), 11800 from _chq;
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select payment_id, 'sales_invoice', (select inv_b from _bounce_invoices), 23600 from _chq;
reset role;
set local request.jwt.claims to '';


set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _chq_posted as
select post_payment((select payment_id from _chq)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _chq_posted)
     and account_id = (select chq from _accounts)),
  35400.00,
  'a cheque receipt debits Cheques in Hand, never Bank'
);
select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _chq_posted)
     and account_id = (select bank from _accounts)),
  0,
  'a cheque receipt touches no bank ledger at posting time'
);
select is(
  (select cheque_status from payments where id = (select payment_id from _chq))::text,
  'in_hand',
  'a posted cheque receipt starts at cheque_status = in_hand'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _chq_deposit as
select deposit_cheque((select payment_id from _chq)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select cheque_status from payments where id = (select payment_id from _chq))::text,
  'deposited',
  'deposit_cheque moves the cheque to deposited'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _chq_deposit)
     and account_id = (select bank from _accounts)),
  35400.00,
  'deposit_cheque debits Bank'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _chq_deposit)
     and account_id = (select chq from _accounts)),
  35400.00,
  'deposit_cheque credits Cheques in Hand'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _chq_deposit)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _chq_deposit)),
  'deposit entry is balanced'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform deposit_cheque((select payment_id from _chq));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CHEQUE_STATE',
  'depositing an already-deposited cheque raises DN_CHEQUE_STATE'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform bounce_cheque((select payment_id from _chq), 'insufficient funds');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role session cannot bounce a cheque'
);

create temp table _ar_before_bounce as
select coalesce(sum(debit) - sum(credit), 0) as bal
from journal_lines
where account_id = (select ar from _accounts) and party_id = (select customer_id from _parties);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _chq_bounced as
select bounce_cheque((select payment_id from _chq), 'insufficient funds') as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select cheque_status from payments where id = (select payment_id from _chq))::text,
  'bounced',
  'bounce: cheque_status = bounced'
);
select is(
  (select bounce_reversal_entry_id from payments where id = (select payment_id from _chq)),
  (select entry_id from _chq_bounced),
  'bounce: bounce_reversal_entry_id points at the reversal entry'
);
select is(
  (select count(*)::int from payment_allocations where payment_id = (select payment_id from _chq)),
  0,
  'bounce: every allocation of the receipt is gone'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _chq_bounced)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _chq_bounced)),
  'bounce: the reversal entry is balanced'
);
select is(
  (select sum(debit) from journal_lines
   where entry_id = (select entry_id from _chq_bounced)
     and account_id = (select ar from _accounts)),
  35400.00,
  'bounce: AR is debited back by the full receipt (the customer owes us again)'
);
select is(
  (select sum(credit) from journal_lines
   where entry_id = (select entry_id from _chq_bounced)
     and account_id = (select bank from _accounts)),
  35400.00,
  'bounce: the deposit is reversed out of Bank too'
);
select is(
  (select reversed_by from journal_entries where id = (select entry_id from _chq_posted)),
  (select entry_id from _chq_bounced),
  'bounce: the original receipt entry is linked to the reversal'
);
select is(
  (select reversed_by from journal_entries where id = (select entry_id from _chq_deposit)),
  (select entry_id from _chq_bounced),
  'bounce: the deposit entry is linked to the same reversal'
);
select is(
  (select i.grand_total - coalesce((
     select sum(a.amount) from payment_allocations a
     where a.invoice_type = 'sales_invoice' and a.invoice_id = i.id), 0)
   from sales_invoices i where i.id = (select inv_a from _bounce_invoices)),
  11800.00,
  'bounce: first invoice is fully open again (Rs 11,800)'
);
select is(
  (select i.grand_total - coalesce((
     select sum(a.amount) from payment_allocations a
     where a.invoice_type = 'sales_invoice' and a.invoice_id = i.id), 0)
   from sales_invoices i where i.id = (select inv_b from _bounce_invoices)),
  23600.00,
  'bounce: second invoice is fully open again (Rs 23,600)'
);
select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select ar from _accounts) and party_id = (select customer_id from _parties)),
  (select bal from _ar_before_bounce) + 35400.00,
  'bounce: the party AR balance rises by the bounced amount'
);
select is(
  (select status from payments where id = (select payment_id from _chq)),
  'cancelled',
  'bounce: the receipt is marked cancelled so it can never be reversed a second time'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform bounce_cheque((select payment_id from _chq), 'again');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CHEQUE_STATE',
  'bouncing an already-bounced cheque raises DN_CHEQUE_STATE'
);

-- ============================================================
-- Cheque: clear path, and issued cheque on an outgoing payment
-- ============================================================

create temp table _chq2 as
with pay as (
  insert into payments
    (direction, payment_date, party_id, mode, instrument_no, amount, account_id, status)
  select 'receipt', '2026-07-05', customer_id, 'cheque', '004418', 1000,
         (select bank from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _chq2 to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', (select payment_id from _chq2)),
  'a second cheque receipt posts');
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform mark_cheque_cleared((select payment_id from _chq2));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CHEQUE_STATE',
  'a received cheque cannot clear before it is deposited'
);

-- Cheque banking is counter work (Decisions from change 04 review): both of these run under a
-- plain 'user' session, which is the person who actually walks the cheque to the bank. Only
-- bounce_cheque stays admin — asserted above.
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select deposit_cheque(%L)', (select payment_id from _chq2)),
  'a user-role session can deposit a cheque (cheque banking is counter work)');
select lives_ok(format('select mark_cheque_cleared(%L)', (select payment_id from _chq2)),
  'a user-role session can mark a deposited cheque cleared');
reset role;
set local request.jwt.claims to '';

select is(
  (select cheque_status from payments where id = (select payment_id from _chq2))::text,
  'cleared',
  'mark_cheque_cleared is a status-only transition'
);
select is(
  (select count(*)::int from journal_entries
   where source_type = 'payment' and source_id = (select payment_id from _chq2)),
  2,
  'clearing writes no journal entry (only the receipt and the deposit exist)'
);

create temp table _chq_out as
with pay as (
  insert into payments
    (direction, payment_date, party_id, mode, instrument_no, amount, account_id, status)
  select 'payment', '2026-07-06', supplier_id, 'cheque', '771001', 1180,
         (select bank from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _chq_out to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _chq_out_posted as
select post_payment((select payment_id from _chq_out)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select cheque_status from payments where id = (select payment_id from _chq_out))::text,
  'issued',
  'a cheque we issue is marked issued at posting time'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _chq_out_posted)
     and account_id = (select bank from _accounts)),
  1180.00,
  'a cheque payment credits Bank at issue (not Cheques in Hand)'
);

-- ============================================================
-- post_expense_voucher: generic expense, advance, salary, wages, hamali, RCM freight
-- ============================================================

create temp table _ev_rent as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
  values ('2026-07-10', 'draft', 'expense', (select cash from _accounts)) returning id
)
select id as voucher_id from v;
grant select on _ev_rent to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select godown_rent from _accounts), 8000, 'Godown rent July' from _ev_rent;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_rent_posted as
select post_expense_voucher((select voucher_id from _ev_rent)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select voucher_no from expense_vouchers where id = (select voucher_id from _ev_rent)),
  'EXP/26-27/0001',
  'expense vouchers number from the EXP series'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_rent_posted)
     and account_id = (select godown_rent from _accounts)),
  8000.00,
  'a plain expense voucher debits the expense account'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_rent_posted)
     and account_id = (select cash from _accounts)),
  8000.00,
  'and credits the paying ledger'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_rent_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_rent_posted)),
  'expense voucher entry is balanced'
);

-- Employee advance of Rs 5,000, posted by the counter user (their one money-out right).
create temp table _ev_adv as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-11', employee_id, 'draft', 'advance', (select cash from _accounts)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_adv to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select emp_advance from _accounts), 5000, 'Advance' from _ev_adv;

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
create temp table _ev_adv_posted as
select post_expense_voucher((select voucher_id from _ev_adv)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_adv_posted)
     and account_id = (select emp_advance from _accounts)),
  5000.00,
  'an advance debits Employee Advances'
);
select is(
  (select party_id from journal_lines
   where entry_id = (select entry_id from _ev_adv_posted)
     and account_id = (select emp_advance from _accounts)),
  (select employee_id from _parties),
  'the advance line carries the employee party_id (control account, party rule)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_adv_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_adv_posted)),
  'advance entry is balanced'
);

create temp table _ev_adv_big as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-11', employee_id, 'draft', 'advance', (select cash from _accounts)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_adv_big to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount)
select voucher_id, 1, (select emp_advance from _accounts), 6000 from _ev_adv_big;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_expense_voucher((select voucher_id from _ev_adv_big));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a user-role advance above Rs 5,000 raises DN_FORBIDDEN'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_expense_voucher(%L)', (select voucher_id from _ev_adv_big)),
  'the same Rs 6,000 advance posts for an admin'
);
reset role;
set local request.jwt.claims to '';

-- Salary Rs 20,000 with the Rs 11,000 advance balance recovered in full.
create temp table _ev_salary as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-31', employee_id, 'draft', 'salary', (select bank from _accounts)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_salary to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select salaries from _accounts), 20000, 'Salary July 2026' from _ev_salary;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_salary_posted as
select post_expense_voucher((select voucher_id from _ev_salary)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_salary_posted)
     and account_id = (select salaries from _accounts)),
  20000.00,
  'salary: gross is debited to the Salaries expense'
);
select is(
  (select sum(credit) from journal_lines
   where entry_id = (select entry_id from _ev_salary_posted)
     and account_id = (select salary_payable from _accounts)),
  20000.00,
  'salary: Salary Payable is credited with the gross for the employee'
);
select is(
  (select sum(debit) from journal_lines
   where entry_id = (select entry_id from _ev_salary_posted)
     and account_id = (select salary_payable from _accounts)),
  20000.00,
  'salary: and immediately settled, so the employee ledger reads the month'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_salary_posted)
     and account_id = (select emp_advance from _accounts)),
  11000.00,
  'salary: the outstanding advance (5,000 + 6,000) is recovered'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_salary_posted)
     and account_id = (select bank from _accounts)),
  9000.00,
  'salary: only the net Rs 9,000 leaves the bank'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_salary_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_salary_posted)),
  'salary entry is balanced'
);
select is(
  (select coalesce(sum(debit) - sum(credit), 0) from journal_lines
   where account_id = (select emp_advance from _accounts)
     and party_id = (select employee_id from _parties)),
  0.00,
  'salary: the employee advance balance is back to zero'
);

-- Salary period (Decisions from change 04 review): a salary or wage voucher always ends up with
-- a period_month, so v_employee_ledger (change 06) can group by it instead of parsing narration.
select is(
  (select period_month from expense_vouchers where id = (select voucher_id from _ev_salary)),
  '2026-07-01'::date,
  'salary: period_month defaults to the first of the voucher month when the draft did not set it'
);

select is(
  (select period_month from expense_vouchers where id = (select voucher_id from _ev_rent)),
  null::date,
  'a generic expense voucher carries no period_month'
);

-- June salary paid in July: the draft says which month it is for, and posting keeps it.
create temp table _ev_salary_june as
with v as (
  insert into expense_vouchers
    (voucher_date, party_id, status, voucher_type, pay_account_id, period_month)
  select '2026-07-31', employee_id, 'draft', 'salary', (select bank from _accounts), '2026-06-01'
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_salary_june to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select salaries from _accounts), 20000, 'Salary June 2026'
from _ev_salary_june;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_expense_voucher(%L)', (select voucher_id from _ev_salary_june)),
  'a salary voucher for an earlier month posts'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select period_month from expense_vouchers where id = (select voucher_id from _ev_salary_june)),
  '2026-06-01'::date,
  'salary: an explicit period_month survives posting (June salary paid on 31 July)'
);

create temp table _ev_rent_period as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, period_month)
  values ('2026-07-31', 'draft', 'expense', '2026-07-01') returning id
)
select id as voucher_id from v;
grant select on _ev_rent_period to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select godown_rent from _accounts), 100, 'not a salary' from _ev_rent_period;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_expense_voucher((select voucher_id from _ev_rent_period));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:period_month_not_allowed',
  'period_month on a non-salary voucher is refused, not silently stored'
);

-- Daily wages for a named worker: same shape, expense account Loading & Unloading.
create temp table _ev_wages as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-31', worker_id, 'draft', 'wages', (select cash from _accounts)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_wages to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select loading from _accounts), 1800, '3 days @ 600' from _ev_wages;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_wages_posted as
select post_expense_voucher((select voucher_id from _ev_wages)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_wages_posted)
     and account_id = (select loading from _accounts)),
  1800.00,
  'named daily wages debit Loading & Unloading'
);
select is(
  (select sum(credit) from journal_lines
   where entry_id = (select entry_id from _ev_wages_posted)
     and account_id = (select salary_payable from _accounts)),
  1800.00,
  'named daily wages run through Salary Payable so the worker has a ledger'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_wages_posted)
     and account_id = (select cash from _accounts)),
  1800.00,
  'named daily wages pay out in full (no advance outstanding)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_wages_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_wages_posted)),
  'named-wages entry is balanced'
);

-- Unnamed casual hamali: no party at all.
create temp table _ev_hamali as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
  values ('2026-07-31', 'draft', 'wages', (select cash from _accounts)) returning id
)
select id as voucher_id from v;
grant select on _ev_hamali to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select loading from _accounts), 500, 'Casual hamali' from _ev_hamali;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_hamali_posted as
select post_expense_voucher((select voucher_id from _ev_hamali)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select count(*)::int from journal_lines where entry_id = (select entry_id from _ev_hamali_posted)),
  2,
  'unnamed hamali is a two-line entry: Dr Loading & Unloading / Cr Cash'
);
select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _ev_hamali_posted) and party_id is not null),
  0,
  'unnamed hamali carries no party anywhere in the entry'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_hamali_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_hamali_posted)),
  'hamali entry is balanced'
);

-- RCM freight (GTA 5%) linked to a purchase invoice.
create temp table _ev_rcm as
with v as (
  insert into expense_vouchers
    (voucher_date, party_id, status, voucher_type, pay_account_id, purchase_invoice_id)
  select '2026-07-12', lorry_id, 'draft', 'expense', (select cash from _accounts),
         (select invoice_id from _pi1)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _ev_rcm to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration, rcm)
select voucher_id, 1, (select freight_in from _accounts), 2000, 'Lorry freight, RCM', true
from _ev_rcm;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_rcm_posted as
select post_expense_voucher((select voucher_id from _ev_rcm)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_rcm_posted)
     and account_id = (select freight_in from _accounts)),
  2000.00,
  'RCM freight debits Freight Inward with the freight itself'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_rcm_posted)
     and account_id = (select rcm_payable from _accounts)),
  100.00,
  'RCM freight credits RCM Payable with 5% of the freight'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_rcm_posted)
     and account_id = (select in_cgst from _accounts)),
  50.00,
  'RCM freight debits Input CGST 2.5%'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _ev_rcm_posted)
     and account_id = (select in_sgst from _accounts)),
  50.00,
  'RCM freight debits Input SGST 2.5%'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_rcm_posted)
     and account_id = (select cash from _accounts)),
  2000.00,
  'the lorry owner is paid the freight only; the RCM tax is ours to remit'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_rcm_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_rcm_posted)),
  'RCM freight entry is balanced'
);
select is(
  (select purchase_invoice_id from expense_vouchers where id = (select voucher_id from _ev_rcm)),
  (select invoice_id from _pi1),
  'the RCM freight voucher stays linked to the purchase invoice it belongs to'
);

-- ============================================================
-- cancel_document: purchase invoice (allocations block, sold stock blocks, clean reversal),
-- payment, expense voucher
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('purchase_invoice', (select invoice_id from _pi1), 'test');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_HAS_ALLOCATIONS',
  'cancelling a purchase invoice an outgoing payment is allocated to raises DN_HAS_ALLOCATIONS'
);
select is(
  (select status from purchase_invoices where id = (select invoice_id from _pi1)),
  'posted',
  'the blocked purchase cancel changed nothing'
);

-- Purchase then sell: the reversal would drive stock negative.
create temp table _pi_sold as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-15', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _pi_sold to authenticated;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, citem, 'Sold-On Item', '0000', 'pcs', 100, 100, 0, 18 from _pi_sold, _items;

create temp table _si_sold as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-16', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _si_sold to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, citem, 'Sold-On Item', '0000', 'pcs', 60, 200, 0, 18 from _si_sold, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_purchase_invoice(%L)', (select invoice_id from _pi_sold)),
  'the sold-on purchase posts (100 units in)');
select lives_ok(format('select post_sales_invoice(%L)', (select invoice_id from _si_sold)),
  '60 of those units are then sold');
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('purchase_invoice', (select invoice_id from _pi_sold), 'test');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'cancelling a purchase whose stock has since been sold raises DN_NEGATIVE_STOCK'
);
select is(
  (select qty from stock_on_hand((select citem from _items), (select warehouse_id from _warehouse))),
  40.000,
  'the blocked purchase cancel left stock untouched (100 in, 60 out)'
);

-- Clean purchase cancellation.
create temp table _pi_clean as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-17', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _pi_clean to authenticated;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, ditem, 'Clean Cancel Item', '0000', 'pcs', 50, 100, 0, 18 from _pi_clean, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_purchase_invoice(%L)', (select invoice_id from _pi_clean)),
  'the clean-cancel purchase posts');
reset role;
set local request.jwt.claims to '';

create temp table _pi_clean_entry as
select journal_entry_id as entry_id from purchase_invoices
where id = (select invoice_id from _pi_clean);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _pi_clean_cancelled as
select cancel_document('purchase_invoice', (select invoice_id from _pi_clean), 'wrong supplier bill')
  as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from purchase_invoices where id = (select invoice_id from _pi_clean)),
  'cancelled',
  'purchase cancellation sets status = cancelled'
);
select is(
  (select reversed_by from journal_entries where id = (select entry_id from _pi_clean_entry)),
  (select entry_id from _pi_clean_cancelled),
  'the original purchase entry links to its reversal (never deleted)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _pi_clean_cancelled)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _pi_clean_cancelled)),
  'the purchase reversal entry is balanced'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _pi_clean_cancelled)
     and account_id = (select inventory from _accounts)),
  5000.00,
  'the purchase reversal credits Inventory back out'
);
select is(
  (select qty from stock_on_hand((select ditem from _items), (select warehouse_id from _warehouse))),
  0.000,
  'the purchased stock is removed again by the reversal'
);
select is(
  (select count(*)::int from stock_movements
   where source_type = 'purchase_invoice' and source_id = (select invoice_id from _pi_clean)
     and reversal_of is not null),
  1,
  'the reversal movement is tagged reversal_of, so it can never be re-reversed'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('purchase_invoice', (select invoice_id from _pi_clean), 'again');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_POSTED',
  'cancelling an already-cancelled purchase raises DN_NOT_POSTED (idempotency)'
);

-- Cancelling a receipt re-opens what it settled.
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _rcpt1_cancelled as
select cancel_document('payment', (select payment_id from _rcpt1), 'entered twice') as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from payments where id = (select payment_id from _rcpt1)),
  'cancelled',
  'cancelling a receipt sets status = cancelled'
);
select is(
  (select count(*)::int from payment_allocations where payment_id = (select payment_id from _rcpt1)),
  0,
  'cancelling a receipt removes its allocations, re-opening the invoice'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _rcpt1_cancelled)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _rcpt1_cancelled)),
  'the receipt reversal entry is balanced'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _rcpt1_cancelled)
     and account_id = (select ar from _accounts)),
  23600.00,
  'the receipt reversal debits AR back for the party'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('payment', (select payment_id from _chq2), 'test');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CHEQUE_STATE',
  'a cheque past in_hand cannot be cancelled by a book entry (bounce or bank recon instead)'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _ev_rent_cancelled as
select cancel_document('expense_voucher', (select voucher_id from _ev_rent), 'duplicate') as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from expense_vouchers where id = (select voucher_id from _ev_rent)),
  'cancelled',
  'cancelling an expense voucher sets status = cancelled'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _ev_rent_cancelled)
     and account_id = (select godown_rent from _accounts)),
  8000.00,
  'the expense reversal mirrors the original debit'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _ev_rent_cancelled)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _ev_rent_cancelled)),
  'the expense reversal entry is balanced'
);

-- ============================================================
-- Global invariant: every journal entry this file created is balanced
-- ============================================================

select is(
  (select count(*)::int from (
     select entry_id from journal_lines
     group by entry_id having sum(debit) <> sum(credit)
   ) unbalanced),
  0,
  'no journal entry in the database is unbalanced after every change-04 posting'
);

-- ============================================================
-- anon has no EXECUTE on any function this change adds
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform post_purchase_invoice(gen_random_uuid());
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on post_purchase_invoice');

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform post_payment(gen_random_uuid());
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on post_payment');

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform post_expense_voucher(gen_random_uuid());
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on post_expense_voucher');

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform deposit_cheque(gen_random_uuid());
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on deposit_cheque');

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform mark_cheque_cleared(gen_random_uuid());
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on mark_cheque_cleared');

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$ begin perform bounce_cheque(gen_random_uuid(), 'x');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'permission denied',
  'anon has no EXECUTE on bounce_cheque');

-- ============================================================
-- Fixes from the fresh-context review of change 04
-- ============================================================

-- B2: cancelling a purchase whose stock has been touched since. The failing case the review
-- proved: PRE-EXISTING stock at a different rate, so quantity alone still looks fine after the
-- reversal while the value left behind is wrong.
--   opening 10 @ 100 = 1,000; purchase 10 @ 200 = 2,000  -> 20 units, 3,000, avg 150
--   sell 5 at avg 150 = 750                              -> 15 units, 2,250
--   cancel purchase: 15 - 10 = 5 units >= 0, so the old quantity check passed, but the 5 units
--   left would carry 250 (avg 50) instead of the 500 they cost.
create temp table _b2_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Weighted Average Trap', 'other', '0000', 18, 'pcs', 300) returning id
)
select id as item_id from i;
grant select on _b2_item to authenticated;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 10, 100, 1000, 'opening'
from _b2_item;

create temp table _b2_purchase as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
  select '2026-07-10', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), 'B2/1'
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _b2_purchase to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Weighted Average Trap', '0000', 'pcs', 10, 200, 0, 18
from _b2_purchase, _b2_item;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_purchase_invoice(%L)', (select invoice_id from _b2_purchase)),
  'B2 fixture: the purchase posts (10 @ 200 on top of 10 @ 100)');
reset role;
set local request.jwt.claims to '';

select is(
  (select round(avg_rate, 2) from stock_on_hand(
    (select item_id from _b2_item), (select warehouse_id from _warehouse))),
  150.00,
  'B2 fixture: weighted average is now Rs 150 across both lots'
);

create temp table _b2_sale as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-11', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _b2_sale to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Weighted Average Trap', '0000', 'pcs', 5, 300, 0, 18
from _b2_sale, _b2_item;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_sales_invoice(%L)', (select invoice_id from _b2_sale)),
  'B2 fixture: 5 units are sold at the blended average');
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('purchase_invoice', (select invoice_id from _b2_purchase), 'wrong bill');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'B2: cancelling a purchase whose stock has since been consumed is refused, even though the '
  || 'remaining quantity would still be positive'
);

select is(
  (select status from purchase_invoices where id = (select invoice_id from _b2_purchase)),
  'posted',
  'B2: the refused cancellation changed nothing'
);

select is(
  (select value from stock_on_hand(
    (select item_id from _b2_item), (select warehouse_id from _warehouse))),
  2250.00,
  'B2: stock value is untouched at Rs 2,250 (it would have become Rs 250 under the old check)'
);

-- B2 escalated: the same shape, but the reversal would drive the ledger VALUE negative while
-- quantity lands exactly on zero — the case the quantity check can never catch.
create temp table _b2b_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Value Goes Negative', 'other', '0000', 18, 'pcs', 300) returning id
)
select id as item_id from i;
grant select on _b2b_item to authenticated;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 10, 10, 100, 'opening'
from _b2b_item;

create temp table _b2b_purchase as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
  select '2026-07-12', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), 'B2/2'
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _b2b_purchase to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Value Goes Negative', '0000', 'pcs', 10, 200, 0, 18
from _b2b_purchase, _b2b_item;

create temp table _b2b_sale as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-13', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _b2b_sale to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Value Goes Negative', '0000', 'pcs', 10, 300, 0, 18
from _b2b_sale, _b2b_item;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_purchase_invoice(%L)', (select invoice_id from _b2b_purchase)),
  'B2 escalated fixture: purchase of 10 @ 200 on top of 10 @ 10');
select lives_ok(format('select post_sales_invoice(%L)', (select invoice_id from _b2b_sale)),
  'B2 escalated fixture: 10 units sold at the blended average of 105');
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('purchase_invoice', (select invoice_id from _b2b_purchase), 'wrong bill');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'B2 escalated: a reversal that would leave the stock ledger holding negative value is refused'
);

-- B2b: a sale with no cost basis at all is refused instead of posting at 100% margin.
create temp table _nocost_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('No Cost Basis Item', 'other', '0000', 18, 'pcs', 100) returning id
)
select id as item_id from i;
grant select on _nocost_item to authenticated;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 50, 0, 0, 'opening'
from _nocost_item;

create temp table _nocost_sale as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-14', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _nocost_sale to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'No Cost Basis Item', '0000', 'pcs', 10, 100, 0, 18
from _nocost_sale, _nocost_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_sales_invoice((select invoice_id from _nocost_sale));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_cost_basis',
  'B2: selling stock that carries no cost is refused, not posted as a 100%-margin sale'
);

-- M3: one party's money cannot settle another party's invoice. The receipt below belongs to a
-- second builder; _si_cap is the first customer's posted invoice.
create temp table _m3_other_party as
with p as (
  insert into parties (name, type, state_code)
  select 'Other Builder', 'customer', state_code from organization limit 1 returning id
)
select id as party_id from p;
grant select on _m3_other_party to authenticated;

create temp table _m3_payment as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-15', party_id, 'cash', 500, (select cash from _accounts), 'draft'
  from _m3_other_party returning id
)
select id as payment_id from pay;
grant select on _m3_payment to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select invoice_id from _si_cap), 100 from _m3_payment;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_party_mismatch',
  'M3: a receipt cannot be allocated to another party''s invoice'
);

-- M4: money must move through a real cash or bank ledger.
create temp table _m4_payment as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-15', customer_id, 'cash', 500,
         (select id from accounts where system_key = 'round_off'), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _m4_payment to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_payment((select payment_id from _m4_payment));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_account',
  'M4: a receipt into a non-money ledger (Round Off) is refused'
);

create temp table _m4_cheque as
with pay as (
  insert into payments
    (direction, payment_date, party_id, mode, instrument_no, amount, account_id, status)
  select 'receipt', '2026-07-15', customer_id, 'cheque', '009001', 500,
         (select cash from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _m4_cheque to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_payment((select payment_id from _m4_cheque));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_account',
  'M4: a cheque receipt cannot name the cash box as the account it will be banked into'
);

create temp table _m4_voucher as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
  values ('2026-07-15', 'draft', 'expense',
          (select id from accounts where system_key = 'cogs')) returning id
)
select id as voucher_id from v;
grant select on _m4_voucher to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select godown_rent from _accounts), 100, 'paid from COGS?' from _m4_voucher;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_expense_voucher((select voucher_id from _m4_voucher));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_account',
  'M4: an expense voucher cannot be paid out of a non-money ledger'
);

-- M5: the advance was already recovered by the salary, so reversing it would drive the
-- employee's advance ledger negative. Cancel the salary first.
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform cancel_document('expense_voucher', (select voucher_id from _ev_adv), 'entered twice');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:advance_already_recovered',
  'M5: cancelling an advance the salary has already recovered is refused'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'expense_voucher',
         (select voucher_id from _ev_salary), 'salary re-run'),
  'M5: the salary can be cancelled first (its reversal puts the advance back)'
);
select lives_ok(
  format('select cancel_document(%L, %L, %L)', 'expense_voucher',
         (select voucher_id from _ev_adv), 'entered twice'),
  'M5: and then the advance cancels cleanly, in the only safe order'
);
reset role;
set local request.jwt.claims to '';

-- M6: a cancelled payment can never be allocated.
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select invoice_id from _si_cap), 10 from _rcpt1;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_payment_cancelled',
  'M6: allocating a cancelled payment is refused by the trigger, not only by RLS'
);

-- M7: a draft receipt's allocation neither blocks a cancellation nor consumes open amount;
-- posting is where the race is resolved.
create temp table _m7_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-16', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _m7_invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, sitem, 'Sale Item', '0000', 'pcs', 10, 100, 0, 18 from _m7_invoice, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_sales_invoice(%L)', (select invoice_id from _m7_invoice)),
  'M7 fixture: an invoice of Rs 1,180 posts');
reset role;
set local request.jwt.claims to '';

create temp table _m7_draft_a as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-16', customer_id, 'cash', 1180, (select cash from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _m7_draft_a to authenticated;

create temp table _m7_draft_b as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-16', customer_id, 'cash', 1180, (select cash from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _m7_draft_b to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$ insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
     select payment_id, 'sales_invoice', (select invoice_id from _m7_invoice), 1180
     from _m7_draft_a $$,
  'M7: the first draft receipt may allocate the whole invoice');
select lives_ok(
  $$ insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
     select payment_id, 'sales_invoice', (select invoice_id from _m7_invoice), 1180
     from _m7_draft_b $$,
  'M7: a second draft receipt may allocate the same invoice — a draft reserves nothing');
reset role;
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', (select payment_id from _m7_draft_a)),
  'M7: the first draft posts');
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_payment((select payment_id from _m7_draft_b));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_exceeds_invoice',
  'M7: the second draft fails at posting time — two drafts cannot over-settle one invoice'
);

-- ============================================================
-- N1: one payment cannot over-settle one invoice by splitting itself across rows.
-- The reproduction the review found: a 2,360 receipt writing two 1,180 allocations against a
-- single 1,180 invoice. Both rows used to insert (the cap counted only *posted* payments'
-- allocations, so a draft's own siblings were invisible) and post_payment used to compare each
-- row to the open amount on its own, so the invoice ended up 2,360 settled against 1,180 owed —
-- the party's ledger silently understated by 1,180.
-- Same discipline as the other allocation tests: real authenticated session, real JWT claims.
-- ============================================================

create temp table _n1_invoices as
with x as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-18', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
),
y as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-18', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
),
w as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-07-18', customer_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _parties returning id
)
select (select id from x) as inv_x, (select id from y) as inv_y, (select id from w) as inv_w;
grant select on _n1_invoices to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select inv_x, 1, sitem, 'Sale Item', '0000', 'pcs', 10, 100, 0, 18 from _n1_invoices, _items;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select inv_y, 1, sitem, 'Sale Item', '0000', 'pcs', 10, 100, 0, 18 from _n1_invoices, _items;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select inv_w, 1, sitem, 'Sale Item', '0000', 'pcs', 10, 100, 0, 18 from _n1_invoices, _items;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_sales_invoice(%L)', (select inv_x from _n1_invoices)),
  'N1 fixture: invoice X of Rs 1,180 posts');
select lives_ok(format('select post_sales_invoice(%L)', (select inv_y from _n1_invoices)),
  'N1 fixture: invoice Y of Rs 1,180 posts');
select lives_ok(format('select post_sales_invoice(%L)', (select inv_w from _n1_invoices)),
  'N1 fixture: invoice W of Rs 1,180 posts');
reset role;
set local request.jwt.claims to '';

create temp table _n1_receipt as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-07-18', customer_id, 'cash', 2360, (select cash from _accounts), 'draft'
  from _parties returning id
)
select id as payment_id from pay;
grant select on _n1_receipt to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$ insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
     select payment_id, 'sales_invoice', (select inv_x from _n1_invoices), 1180
     from _n1_receipt $$,
  'N1: the receipt may settle invoice X in full');

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select inv_x from _n1_invoices), 1180 from _n1_receipt;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:allocation_exceeds_invoice',
  'N1: a second allocation from the SAME receipt to the SAME invoice is refused at insert');

-- Splitting the same pair into amounts that each fit under the cap is refused too, by the
-- unique constraint: one payment settles one invoice through exactly one row.
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select inv_w from _n1_invoices), 100 from _n1_receipt;
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  select payment_id, 'sales_invoice', (select inv_w from _n1_invoices), 100 from _n1_receipt;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'payment_allocations_payment_invoice_key',
  'N1: two rows for the same (payment, invoice) pair are refused by the unique constraint');

-- The positive half: one payment settling two DIFFERENT invoices is ordinary business.
select lives_ok(
  $$ insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
     select payment_id, 'sales_invoice', (select inv_y from _n1_invoices), 1180
     from _n1_receipt $$,
  'N1: the same receipt may settle a different invoice as well');
reset role;
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', (select payment_id from _n1_receipt)),
  'N1: a receipt allocated across two different invoices posts');
reset role;
set local request.jwt.claims to '';

select is(
  (select count(*)::int from payment_allocations
   where payment_id = (select payment_id from _n1_receipt)),
  2,
  'N1: exactly two allocation rows survived — one per invoice');

select is(
  (select coalesce(sum(amount), 0) from payment_allocations
   where invoice_type = 'sales_invoice' and invoice_id = (select inv_x from _n1_invoices)),
  1180::numeric(14,2),
  'N1: invoice X is settled 1,180 against 1,180 owed, not 2,360');

-- M8 / M9: reverse charge.
create temp table _m8_purchase as
with inv as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, rcm)
  select '2026-07-17', supplier_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse), 'RCM/1', true
  from _parties returning id
)
select id as invoice_id from inv;
grant select on _m8_purchase to authenticated;

insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, pitem, 'Purchase Item', '0000', 'pcs', 10, 100, 0, 18
from _m8_purchase, _items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_purchase_invoice((select invoice_id from _m8_purchase));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:rcm_purchase_unsupported',
  'M8: a purchase invoice flagged rcm is refused rather than posted as an ordinary bill'
);

create temp table _m9_lorry as
with p as (
  insert into parties (name, type, state_code)
  values ('Interstate Lorry Owner', 'supplier', '29') returning id
)
select id as party_id from p;
grant select on _m9_lorry to authenticated;

create temp table _m9_voucher as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-17', party_id, 'draft', 'expense', (select cash from _accounts)
  from _m9_lorry returning id
)
select id as voucher_id from v;
grant select on _m9_voucher to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration, rcm)
select voucher_id, 1, (select freight_in from _accounts), 5000, 'interstate freight', true
from _m9_voucher;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_expense_voucher((select voucher_id from _m9_voucher));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:rcm_interstate',
  'M9: inter-state GTA freight is refused (the CGST/SGST split posted here would be wrong)'
);

-- m10 / m11 / m12: who an employee voucher may name.
create temp table _m10_voucher as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-17', customer_id, 'draft', 'advance', (select cash from _accounts)
  from _parties returning id
)
select id as voucher_id from v;
grant select on _m10_voucher to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, party_id, amount, narration)
select voucher_id, 1, (select emp_advance from _accounts), customer_id, 1000, 'advance'
from _m10_voucher, _parties;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_expense_voucher((select voucher_id from _m10_voucher));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_party',
  'm10: an employee advance to a customer is refused'
);

create temp table _m11_party as
with p as (
  insert into parties (name, type, state_code, is_active)
  select 'Retired Employee', 'employee', state_code, false from organization limit 1 returning id
)
select id as party_id from p;
grant select on _m11_party to authenticated;

create temp table _m11_voucher as
with v as (
  insert into expense_vouchers (voucher_date, party_id, status, voucher_type, pay_account_id)
  select '2026-07-17', party_id, 'draft', 'advance', (select cash from _accounts)
  from _m11_party returning id
)
select id as voucher_id from v;
grant select on _m11_voucher to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, party_id, amount, narration)
select voucher_id, 1, (select emp_advance from _accounts), party_id, 1000, 'advance'
from _m11_voucher, _m11_party;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_expense_voucher((select voucher_id from _m11_voucher));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_party',
  'm11: a voucher against a deactivated party is refused'
);

create temp table _m12_voucher as
with v as (
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
  values ('2026-07-17', 'draft', 'salary', (select cash from _accounts)) returning id
)
select id as voucher_id from v;
grant select on _m12_voucher to authenticated;
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
select voucher_id, 1, (select salaries from _accounts), 5000, 'whose salary?' from _m12_voucher;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin perform post_expense_voucher((select voucher_id from _m12_voucher));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:missing_party',
  'm12: a salary voucher with no employee is refused (unnamed hamali wages still post)'
);

-- m13: allocations leave an audit trail of their own.
select ok(
  (select count(*) from audit_log
   where entity = 'payment_allocations' and action = 'allocate') > 0,
  'm13: writing an allocation leaves an audit_log row'
);

select ok(
  (select count(*) from audit_log
   where entity = 'payment_allocations' and action = 'unallocate') > 0,
  'm13: deleting an allocation (bounce / cancel) leaves an audit_log row too'
);

select is(
  (select actor from audit_log
   where entity = 'payment_allocations' and action = 'allocate'
     and (after ->> 'payment_id')::uuid = (select payment_id from _m7_draft_a)),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'm13: the allocation audit row records the real session actor'
);

select * from finish();

rollback;
