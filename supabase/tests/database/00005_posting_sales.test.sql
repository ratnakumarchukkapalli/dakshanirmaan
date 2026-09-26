-- Must pass (change 03, posting-sales): "posting a sales invoice keeps books balanced";
-- "cancelled invoice reverses, never deletes". Rebuilt against the pre-implementation +
-- system-design audit (2026-09-16): actor is now auth.uid(), never a parameter, so every
-- post_sales_invoice/cancel_document call below runs under `set local role authenticated` with
-- real JWT claims — this also means every "happy path" assertion here doubles as proof that a
-- genuine authenticated session (not just postgres, which bypasses everything) can actually use
-- these functions, both as admin and as a plain 'user'. Also covers: credit limit + admin
-- override, non-stock (freight) lines, DN_HAS_ALLOCATIONS, round-off direction, the IGST path,
-- DN_NOT_DRAFT, DN_NEGATIVE_STOCK (+ atomicity), DN_VALIDATION:no_lines/invalid_party,
-- idempotency, next_doc_no gapless per series, and that anon has no access at all.
-- Fixture numbers for the two named scenarios are DESIGN.md §3's worked example (credit sale of
-- 100 bags UltraTech @ ₹360 + 500 kg 12mm TMT @ ₹58/kg, GST 18% intra-state).
begin;

create extension if not exists pgtap with schema extensions;

select plan(67);

-- ============================================================
-- Fixtures (as postgres: opening stock and draft creation bypass RLS on purpose, same as any
-- other migration/seed step — only the post_*/cancel_document calls themselves need a real
-- authenticated session, and are wrapped individually below).
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
  select 'Test Builder', 'customer', state_code from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _items as
with c as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('UltraTech Cement 50kg', 'cement', '2523', 18, 'bag', 360)
  returning id
),
s as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('12mm TMT Bar', 'steel', '7214', 18, 'kg', 58)
  returning id
)
select (select id from c) as cement_id, (select id from s) as steel_id;

create temp table _warehouse as
select id as warehouse_id from warehouses where is_default limit 1;

-- Opening stock so weighted-average lands exactly on DESIGN.md §3's rates:
-- cement avg ₹318 (1000 bags @ 318), TMT avg ₹47.20 (2000 kg @ 47.20).
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select cement_id, (select warehouse_id from _warehouse), '2026-04-05', 1000, 318, 318000, 'opening'
from _items;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select steel_id, (select warehouse_id from _warehouse), '2026-04-05', 2000, 47.20, 94400, 'opening'
from _items;

select is(
  (select round(avg_rate, 2) from stock_on_hand(
    (select cement_id from _items), (select warehouse_id from _warehouse))),
  318.00,
  'sanity: stock_on_hand reports the seeded cement weighted-average rate'
);

-- Draft invoice: 100 bags cement @360 + 500 kg TMT @58, intra-state (party state = org state).
create temp table _invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-10', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, cement_id, 'UltraTech Cement 50kg', '2523', 'bag', 100, 360, 0, 18
from _invoice, _items;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 2, steel_id, '12mm TMT Bar', '7214', 'kg', 500, 58, 0, 18
from _invoice, _items;

-- ============================================================
-- Scenario: posting a sales invoice keeps books balanced (posted by a real admin session)
-- ============================================================

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _posted as
select post_sales_invoice((select invoice_id from _invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from sales_invoices where id = (select invoice_id from _invoice)),
  'posted',
  'invoice status is posted after post_sales_invoice, called by a real authenticated admin session'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _posted)),
  132100.00,
  'journal entry Σdebit = ₹132,100 (AR 76,700 + COGS 55,400)'
);

select is(
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _posted)),
  132100.00,
  'journal entry Σcredit = ₹132,100'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'ar')),
  76700.00,
  'AR control line debit = ₹76,700'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'output_cgst')),
  5850.00,
  'Output CGST credit = ₹5,850'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'output_sgst')),
  5850.00,
  'Output SGST credit = ₹5,850'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'sales_cement')),
  36000.00,
  'Sales - Cement credit = ₹36,000'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'sales_steel')),
  29000.00,
  'Sales - Steel credit = ₹29,000'
);

select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'cogs')),
  55400.00,
  'COGS debit = ₹55,400'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _posted)
     and account_id = (select id from accounts where system_key = 'inventory')),
  55400.00,
  'Inventory credit = ₹55,400'
);

select is(
  (select round_off from sales_invoices where id = (select invoice_id from _invoice)),
  0.00,
  'round_off is ₹0 (raw total already a whole rupee)'
);

select is(
  (select qty from stock_movements
   where item_id = (select cement_id from _items) and source_type = 'sales_invoice'
     and source_id = (select invoice_id from _invoice)),
  -100.000,
  'cement stock_movements OUT qty = -100 (base UOM)'
);

select is(
  (select value from stock_movements
   where item_id = (select cement_id from _items) and source_type = 'sales_invoice'
     and source_id = (select invoice_id from _invoice)),
  -31800.00,
  'cement stock_movements OUT value = -₹31,800 (100 @ avg 318)'
);

select is(
  (select qty from stock_movements
   where item_id = (select steel_id from _items) and source_type = 'sales_invoice'
     and source_id = (select invoice_id from _invoice)),
  -500.000,
  'TMT stock_movements OUT qty = -500 (base UOM)'
);

select is(
  (select value from stock_movements
   where item_id = (select steel_id from _items) and source_type = 'sales_invoice'
     and source_id = (select invoice_id from _invoice)),
  -23600.00,
  'TMT stock_movements OUT value = -₹23,600 (500 @ avg 47.20)'
);

select is(
  (select invoice_no from sales_invoices where id = (select invoice_id from _invoice)),
  'DN/26-27/0001',
  'invoice_no assigned from the DN series, FY 2026-27, first of the year'
);

select is(
  (select actor from audit_log
   where entity = 'sales_invoices' and entity_id = (select invoice_id from _invoice)
     and action = 'post'),
  '33333333-3333-3333-3333-333333333333'::uuid,
  'audit_log.actor is the real session uid, not a caller-supplied value'
);

-- ============================================================
-- Scenario: cancelled invoice reverses, never deletes (cancelled by the same admin session)
-- ============================================================

create temp table _original_entry as
select journal_entry_id as entry_id from sales_invoices
where id = (select invoice_id from _invoice);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _cancelled as
select cancel_document(
  'sales_invoice', (select invoice_id from _invoice), 'test: wrong quantity billed'
) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select status from sales_invoices where id = (select invoice_id from _invoice)),
  'cancelled',
  'invoice status is cancelled after cancel_document'
);

select is(
  (select count(*)::int from journal_entries where id = (select entry_id from _original_entry)),
  1,
  'original journal entry still exists (cancellation never deletes)'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _original_entry)),
  132100.00,
  'original journal entry lines are unchanged (still Σdebit = ₹132,100)'
);

select is(
  (select reversed_by from journal_entries where id = (select entry_id from _original_entry)),
  (select entry_id from _cancelled),
  'original entry.reversed_by links to the new reversal entry'
);

select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _cancelled)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _cancelled)),
  'reversal entry is itself balanced'
);

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _cancelled)
     and account_id = (select id from accounts where system_key = 'ar')),
  76700.00,
  'reversal entry mirrors the AR line (debit becomes credit)'
);

select is(
  (select round(avg_rate, 2) from stock_on_hand(
    (select cement_id from _items), (select warehouse_id from _warehouse))),
  318.00,
  'cement weighted-average rate unchanged after full reversal'
);

select is(
  (select qty from stock_on_hand(
    (select cement_id from _items), (select warehouse_id from _warehouse))),
  1000.000,
  'cement on-hand qty returns to 1000 after cancellation'
);

select is(
  (select qty from stock_on_hand(
    (select steel_id from _items), (select warehouse_id from _warehouse))),
  2000.000,
  'TMT on-hand qty returns to 2000 after cancellation'
);

select is(
  (select after ->> 'reason' from audit_log
   where entity = 'sales_invoices' and entity_id = (select invoice_id from _invoice)
     and action = 'cancel'),
  'test: wrong quantity billed',
  'audit_log records the cancellation reason'
);

-- ============================================================
-- Round-off direction: both signs balance and hit the right side of the round_off account.
-- Posted by the 'user' role for one, admin for the other — both must be able to post.
-- ============================================================

create temp table _round_items as
with u as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Round Up Item', 'other', '0000', 0, 'pcs', 100.60)
  returning id
),
d as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Round Down Item', 'other', '0000', 0, 'pcs', 100.40)
  returning id
)
select (select id from u) as up_id, (select id from d) as down_id;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select up_id, (select warehouse_id from _warehouse), '2026-04-05', 10, 50, 500, 'opening'
from _round_items;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select down_id, (select warehouse_id from _warehouse), '2026-04-05', 10, 50, 500, 'opening'
from _round_items;

create temp table _round_up_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-12', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _round_up_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, up_id, 'Round Up Item', '0000', 'pcs', 1, 100.60, 0, 0
from _round_up_invoice, _round_items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
create temp table _round_up_posted as
select post_sales_invoice((select invoice_id from _round_up_invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select round_off from sales_invoices where id = (select invoice_id from _round_up_invoice)),
  0.40,
  'round-up invoice (posted as user role): round_off = +0.40 (raw 100.60 rounds to grand 101)'
);
select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _round_up_posted)
     and account_id = (select id from accounts where system_key = 'round_off')),
  0.40,
  'round-up invoice: round_off account is credited (reduces the expense)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _round_up_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _round_up_posted)),
  'round-up invoice: entry is balanced'
);

create temp table _round_down_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-12', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _round_down_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, down_id, 'Round Down Item', '0000', 'pcs', 1, 100.40, 0, 0
from _round_down_invoice, _round_items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _round_down_posted as
select post_sales_invoice((select invoice_id from _round_down_invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select round_off from sales_invoices where id = (select invoice_id from _round_down_invoice)),
  -0.40,
  'round-down invoice: round_off = -0.40 (raw 100.40 rounds to grand 100)'
);
select is(
  (select debit from journal_lines
   where entry_id = (select entry_id from _round_down_posted)
     and account_id = (select id from accounts where system_key = 'round_off')),
  0.40,
  'round-down invoice: round_off account is debited (an expense)'
);
select is(
  (select sum(debit) from journal_lines where entry_id = (select entry_id from _round_down_posted)),
  (select sum(credit) from journal_lines where entry_id = (select entry_id from _round_down_posted)),
  'round-down invoice: entry is balanced'
);

-- ============================================================
-- Inter-state sale: IGST instead of CGST+SGST
-- ============================================================

create temp table _interstate_party as
with p as (
  insert into parties (name, type, state_code)
  values ('Out of State Builder', 'customer', '29')
  returning id
)
select id as party_id from p;

create temp table _interstate_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-13', party_id, '29', 'draft', (select warehouse_id from _warehouse)
  from _interstate_party
  returning id
)
select id as invoice_id from inv;
grant select on _interstate_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, cement_id, 'UltraTech Cement 50kg', '2523', 'bag', 10, 360, 0, 18
from _interstate_invoice, _items;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _interstate_posted as
select post_sales_invoice((select invoice_id from _interstate_invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _interstate_posted)
     and account_id = (select id from accounts where system_key = 'output_igst')),
  648.00,
  'interstate invoice credits Output IGST (3,600 taxable @ 18%)'
);
select is(
  (select count(*)::int from journal_lines
   where entry_id = (select entry_id from _interstate_posted)
     and account_id in (
       select id from accounts where system_key in ('output_cgst', 'output_sgst')
     )),
  0,
  'interstate invoice has no CGST/SGST lines'
);

-- ============================================================
-- Non-stock line (freight billed to the customer): revenue only, no stock movement.
-- ============================================================

create temp table _freight_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock)
  values ('Freight charged to customer', 'other', '9965', 18, 'trip', 1500, false)
  returning id
)
select id as item_id from i;

create temp table _freight_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-14', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _freight_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Freight charged to customer', '9965', 'trip', 1, 1500, 0, 18
from _freight_invoice, _freight_item;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _freight_posted as
select post_sales_invoice((select invoice_id from _freight_invoice)) as entry_id;
reset role;
set local request.jwt.claims to '';

select is(
  (select credit from journal_lines
   where entry_id = (select entry_id from _freight_posted)
     and account_id = (select id from accounts where system_key = 'freight_recovered')),
  1500.00,
  'non-stock line credits Freight Recovered, not a category sales account'
);
select is(
  (select count(*)::int from stock_movements
   where source_type = 'sales_invoice' and source_id = (select invoice_id from _freight_invoice)),
  0,
  'non-stock line creates no stock_movements row'
);

-- ============================================================
-- Credit limit: block over-limit, admin-only override, non-admin override request ignored.
-- ============================================================

create temp table _credit_party as
with p as (
  insert into parties (name, type, state_code, credit_limit)
  select 'Credit Limited Builder', 'customer', state_code, 50000
  from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _credit_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Credit Test Item', 'other', '0000', 18, 'pcs', 360)
  returning id
)
select id as item_id from i;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 1000, 300, 300000, 'opening'
from _credit_item;

-- Within limit: 50 units @ 360, taxable 18,000, grand 21,240 (well under 50,000).
create temp table _credit_ok_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-16', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _credit_party
  returning id
)
select id as invoice_id from inv;
grant select on _credit_ok_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Credit Test Item', '0000', 'pcs', 50, 360, 0, 18
from _credit_ok_invoice, _credit_item;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L)', (select invoice_id from _credit_ok_invoice)),
  'an invoice within the party credit limit posts normally'
);
reset role;
set local request.jwt.claims to '';

-- Over limit: 21,240 already on the books + 100 units @ 360 (taxable 36,000, grand 42,480)
-- = 63,720 > 50,000.
create temp table _credit_over_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-16', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _credit_party
  returning id
)
select id as invoice_id from inv;
grant select on _credit_over_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Credit Test Item', '0000', 'pcs', 100, 360, 0, 18
from _credit_over_invoice, _credit_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _credit_over_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CREDIT_LIMIT',
  'posting past the credit limit raises DN_CREDIT_LIMIT'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _credit_over_invoice), true);
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_CREDIT_LIMIT',
  'a user-role override request is ignored: still raises DN_CREDIT_LIMIT'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L, true)', (select invoice_id from _credit_over_invoice)),
  'an admin session with p_override_credit=true can post past the limit'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select status from sales_invoices where id = (select invoice_id from _credit_over_invoice)),
  'posted',
  'the overridden invoice is posted'
);
select is(
  (select (after ->> 'override')::bool from audit_log
   where entity = 'sales_invoices' and entity_id = (select invoice_id from _credit_over_invoice)
     and action = 'post'),
  true,
  'audit_log records the credit-limit override'
);

-- ============================================================
-- Cancellation is blocked while a payment is allocated to the invoice.
-- ============================================================

create temp table _alloc_payment as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'receipt', '2026-06-17', party_id, 'cash', 1000,
         (select id from accounts where system_key = 'cash'), 'draft'
  from _party
  returning id
)
select id as payment_id from pay;
grant select on _alloc_payment to authenticated;

-- Amount is the invoice's whole grand total (Rs 101), not an arbitrary Rs 1,000: change 04's
-- payment_allocations trigger caps every allocation at the invoice's open amount, so the
-- original over-allocation would now be rejected at INSERT and this fixture would never reach
-- the cancel_document call it exists to test. Forced by a later change's schema; the assertion
-- it feeds (DN_HAS_ALLOCATIONS) is unchanged.
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select payment_id, 'sales_invoice', (select invoice_id from _round_up_invoice),
       (select grand_total from sales_invoices where id = (select invoice_id from _round_up_invoice))
from _alloc_payment;

-- ...and the receipt is now posted, not left as a draft: change 04's review (finding M7, owner
-- decision) scoped DN_HAS_ALLOCATIONS to allocations of *posted* payments, so that a draft
-- receipt somebody is still typing cannot freeze the invoice it points at. The assertion this
-- fixture feeds is unchanged; only the fixture had to become a real receipt.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_payment(%L)', (select payment_id from _alloc_payment)),
  'the allocated receipt posts (its allocation now blocks the invoice cancellation)'
);
reset role;
set local request.jwt.claims to '';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform cancel_document('sales_invoice', (select invoice_id from _round_up_invoice), 'test');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_HAS_ALLOCATIONS',
  'cancelling an invoice with a payment allocation raises DN_HAS_ALLOCATIONS'
);
select is(
  (select status from sales_invoices where id = (select invoice_id from _round_up_invoice)),
  'posted',
  'the invoice stays posted: the blocked cancel changed nothing'
);

delete from payment_allocations where payment_id = (select payment_id from _alloc_payment);

-- ============================================================
-- Admin-only negative-stock override (organization.allow_negative_stock).
-- ============================================================

update organization set allow_negative_stock = true;

create temp table _neg_item_admin as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Negative Override Item (admin)', 'other', '0000', 18, 'pcs', 100)
  returning id
)
select id as item_id from i;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 5, 100, 500, 'opening'
from _neg_item_admin;

create temp table _neg_invoice_admin as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-18', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _neg_invoice_admin to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Negative Override Item (admin)', '0000', 'pcs', 10, 100, 0, 18
from _neg_invoice_admin, _neg_item_admin;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('select post_sales_invoice(%L)', (select invoice_id from _neg_invoice_admin)),
  'admin can oversell when organization.allow_negative_stock is true'
);
reset role;
set local request.jwt.claims to '';

select is(
  (select qty from stock_on_hand(
    (select item_id from _neg_item_admin), (select warehouse_id from _warehouse))),
  -5.000,
  'on-hand qty is allowed to go negative for the admin override (5 - 10 = -5)'
);

create temp table _neg_item_user as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Negative Override Item (user)', 'other', '0000', 18, 'pcs', 100)
  returning id
)
select id as item_id from i;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 5, 100, 500, 'opening'
from _neg_item_user;

create temp table _neg_invoice_user as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-18', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _neg_invoice_user to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Negative Override Item (user)', '0000', 'pcs', 10, 100, 0, 18
from _neg_invoice_user, _neg_item_user;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _neg_invoice_user));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'the override is admin-only: a user-role oversell still raises DN_NEGATIVE_STOCK with the flag on'
);

update organization set allow_negative_stock = false;

-- ============================================================
-- RLS / auth regressions: anon has no EXECUTE on any of these functions; a real user-role
-- session cannot cancel (role gate enforced under a genuine session, not just via a parameter).
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform post_sales_invoice(gen_random_uuid());
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on post_sales_invoice'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform cancel_document('sales_invoice', gen_random_uuid(), 'x');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on cancel_document'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role anon;
do $$
begin
  perform next_doc_no('DN', current_date);
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'permission denied',
  'anon has no EXECUTE on next_doc_no (cannot burn GST document numbers)'
);

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform cancel_document('sales_invoice', (select invoice_id from _round_down_invoice), 'x');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_FORBIDDEN',
  'a real user-role session cannot cancel: role gate enforced under a genuine session'
);

-- ============================================================
-- Also covered: DN_NOT_DRAFT, DN_NEGATIVE_STOCK (+ atomicity), DN_VALIDATION:no_lines,
-- DN_VALIDATION:invalid_party, idempotency, next_doc_no gapless per series
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting a cancelled (non-draft) invoice raises DN_NOT_DRAFT'
);

create temp table _short_item as
with i as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('Low Stock Item', 'other', '0000', 18, 'pcs', 100)
  returning id
)
select id as item_id from i;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select item_id, (select warehouse_id from _warehouse), '2026-04-05', 10, 100, 1000, 'opening'
from _short_item;

create temp table _short_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-11', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _short_invoice to authenticated;

insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, item_id, 'Low Stock Item', '0000', 'pcs', 20, 100, 0, 18
from _short_invoice, _short_item;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _short_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NEGATIVE_STOCK',
  'selling more than on-hand qty raises DN_NEGATIVE_STOCK'
);

select is(
  (select status from sales_invoices where id = (select invoice_id from _short_invoice)),
  'draft',
  'the over-sold invoice stays draft: the failed post wrote nothing'
);
select is(
  (select count(*)::int from journal_entries
   where source_type = 'sales_invoice' and source_id = (select invoice_id from _short_invoice)),
  0,
  'failed post wrote no journal_entries row (atomic rollback, not a partial post)'
);
select is(
  (select count(*)::int from stock_movements
   where source_type = 'sales_invoice' and source_id = (select invoice_id from _short_invoice)),
  0,
  'failed post wrote no stock_movements row (atomic rollback)'
);

create temp table _empty_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-15', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _party
  returning id
)
select id as invoice_id from inv;
grant select on _empty_invoice to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _empty_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:no_lines',
  'posting an invoice with no lines raises DN_VALIDATION:no_lines'
);

create temp table _inactive_party as
with p as (
  insert into parties (name, type, state_code, is_active)
  select 'Inactive Customer', 'customer', state_code, false from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _inactive_party_invoice as
with inv as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-15', party_id, (select state_code from organization limit 1), 'draft',
         (select warehouse_id from _warehouse)
  from _inactive_party
  returning id
)
select id as invoice_id from inv;
grant select on _inactive_party_invoice to authenticated;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select invoice_id, 1, up_id, 'Round Up Item', '0000', 'pcs', 1, 100, 0, 0
from _inactive_party_invoice, _round_items;

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _inactive_party_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_VALIDATION:invalid_party',
  'posting against an inactive party raises DN_VALIDATION:invalid_party'
);

-- Idempotency: re-posting an already-posted (not just cancelled) invoice.
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_sales_invoice((select invoice_id from _round_up_invoice));
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
reset role;
set local request.jwt.claims to '';
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'DN_NOT_DRAFT',
  're-posting an already-posted invoice raises DN_NOT_DRAFT (idempotency)'
);

-- next_doc_no gapless per series, from wherever the DN series currently stands (several
-- invoices above already consumed numbers; compute the expectation instead of hardcoding it).
-- Runs as postgres: next_doc_no has no grant to any role, only the owner may call it directly.
create temp table _dn_before as
select next_no from doc_sequences where series = 'DN' and fy_label = '2026-27';

select is(
  next_doc_no('DN', '2026-07-01'),
  'DN/26-27/' || lpad((select next_no from _dn_before)::text, 4, '0'),
  'next_doc_no continues the DN series gaplessly from its current position'
);
select is(
  next_doc_no('DN', '2026-07-01'),
  'DN/26-27/' || lpad(((select next_no from _dn_before) + 1)::text, 4, '0'),
  'next_doc_no increments again on the next call, same FY series'
);
select is(
  next_doc_no('PB', '2026-07-01'),
  'PB/26-27/0001',
  'next_doc_no keeps a different series (PB) independently numbered'
);

-- Fiscal-year rollover: a series with no row for a future FY gets one auto-created.
select is(
  next_doc_no('CN', '2027-06-01'),
  'CN/27-28/0001',
  'next_doc_no auto-creates the next FY row for a series that already exists'
);
select is(
  (select count(*)::int from doc_sequences where series = 'CN' and fy_label = '2027-28'),
  1,
  'the auto-created doc_sequences row exists exactly once'
);

select * from finish();

rollback;
