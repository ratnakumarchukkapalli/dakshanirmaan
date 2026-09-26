-- Must pass (change 19 aal2-enforcement; security-deployment "Non-functional clarifications",
-- Sessions: admin actions require aal2; change 08 KNOWN GAPS 1):
--  * "owner at step 1 cannot post, cancel, or read the books through the API": an admin whose
--    session is aal1 (or carries no aal claim) is refused by every post_* / cancel / cheque /
--    transfer-receive / day-close function, sees no business rows in any table or v_* view, and
--    cannot write parties, items or the organisation row (change 09 policies)
--  * the same owner at aal2 does all of it
--  * a step-1 owner can still read their own app_users row (the proxy and /login/mfa need it)
--  * the 'user' role behaves identically at aal1 and aal2
--
-- Functions that lock the document before the role check (sales / challan / purchase / payment /
-- expense / transfer / adjustment) are exercised on real drafts, so the refusal is the role gate
-- and not DN_NOT_DRAFT.
begin;

create extension if not exists pgtap with schema extensions;

select plan(110);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('77777777-7777-7777-7777-777777777777', 'owner2@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test'),
  ('77777777-7777-7777-7777-777777777777', 'admin', 'Second Owner', true, 'owner2@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000001', 'Ramesh Builders', 'customer', state_code from organization limit 1;
insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000002', 'Cement Supplier', 'supplier', state_code from organization limit 1;

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', 'cement', '2523', 28, 'bag', 400);

insert into warehouses (id, name) values ('e0000000-0000-0000-0000-000000000002', 'Second Godown');

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 300, 300000, 'opening'
  from warehouses where is_default and not is_transit;

-- Sales drafts: d1 owner post + cancel, d2 owner cash sale, d3 / d4 counter at aal1 / aal2.
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select v.id::uuid, '2026-06-10', 'a0000000-0000-0000-0000-000000000001', o.state_code, 'draft',
       (select id from warehouses where is_default and not is_transit)
  from organization o,
       (values ('d0000000-0000-0000-0000-000000000001'), ('d0000000-0000-0000-0000-000000000002'),
               ('d0000000-0000-0000-0000-000000000003'), ('d0000000-0000-0000-0000-000000000004')) v(id);
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select id, 1, 'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', '2523', 'bag', 10, 400, 0, 28
  from sales_invoices;

insert into delivery_challans (id, challan_date, party_id, warehouse_id, status)
select 'd1000000-0000-0000-0000-000000000001', '2026-06-10', 'a0000000-0000-0000-0000-000000000001',
       id, 'draft'
  from warehouses where is_default and not is_transit;
insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
values ('d1000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001',
        'UltraTech OPC 53 50kg', '2523', 'bag', 5, 400, 28);

insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, supplier_bill_date)
select 'd2000000-0000-0000-0000-000000000001', '2026-06-10', 'a0000000-0000-0000-0000-000000000002',
       o.state_code, 'draft', w.id, 'SB-1', '2026-06-10'
  from organization o, warehouses w where w.is_default and not w.is_transit;
insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d2000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001',
        'UltraTech OPC 53 50kg', '2523', 'bag', 100, 300, 30000, 28);

-- Payments: p1 cash receipt; p2 / p3 cheque receipts (p2 deposit + clear, p3 deposit + bounce).
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status)
select 'd3000000-0000-0000-0000-000000000001', 'receipt', '2026-06-11', 'a0000000-0000-0000-0000-000000000001',
       'cash', 1000, id, 'draft' from accounts where system_key = 'cash';
insert into payments (id, direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, account_id, cheque_bank, status)
select v.id::uuid, 'receipt', '2026-06-11', 'a0000000-0000-0000-0000-000000000001', 'cheque', v.no, '2026-06-11',
       500, a.id, 'SBI Chirala', 'draft'
  from accounts a,
       (values ('d3000000-0000-0000-0000-000000000002', '004417'), ('d3000000-0000-0000-0000-000000000003', '004418')) v(id, no)
 where a.system_key = 'bank';

insert into expense_vouchers (id, voucher_date, status, voucher_type, pay_account_id)
select 'd4000000-0000-0000-0000-000000000001', '2026-06-11', 'draft', 'expense', id from accounts where system_key = 'cash';
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount)
select 'd4000000-0000-0000-0000-000000000001', 1, id, 200 from accounts where system_key = 'loading_unloading';

insert into stock_transfers (id, transfer_date, from_warehouse_id, to_warehouse_id, status)
select 'd5000000-0000-0000-0000-000000000001', '2026-06-12', id, 'e0000000-0000-0000-0000-000000000002', 'draft'
  from warehouses where is_default and not is_transit;
insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
values ('d5000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', 'bag', 20);

insert into stock_adjustments (id, adj_date, warehouse_id, status)
select 'd6000000-0000-0000-0000-000000000001', '2026-06-12', id, 'draft'
  from warehouses where is_default and not is_transit;
insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
values ('d6000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', -1);

set local role authenticated;

-- ============================================================
-- 1. The helpers
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select is(current_app_role(), null, 'aal1 owner: current_app_role() is NULL, not user');
select is(is_active_member(), false, 'aal1 owner: not a member');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is(current_app_role(), null, 'owner with no aal claim: current_app_role() is NULL');
select is(is_active_member(), false, 'owner with no aal claim: not a member');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is(current_app_role(), 'admin'::app_role, 'aal2 owner: admin');
select is(is_active_member(), true, 'aal2 owner: a member');

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is(current_app_role(), 'user'::app_role, 'aal1 counter: user');
select is(is_active_member(), true, 'aal1 counter: a member');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is(current_app_role(), 'user'::app_role, 'counter with no aal claim: user');

-- ============================================================
-- 2. Owner at aal1: every posting / cancelling function is refused
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';

select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_sales_invoice refused');
select throws_ok($$select post_cash_sale('d0000000-0000-0000-0000-000000000002', (select id from accounts where system_key = 'cash'))$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_cash_sale refused');
select throws_ok($$select post_delivery_challan('d1000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_delivery_challan refused');
select throws_ok($$select post_purchase_invoice('d2000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_purchase_invoice refused');
select throws_ok($$select post_payment('d3000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_payment refused');
select throws_ok($$select post_expense_voucher('d4000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_expense_voucher refused');
select throws_ok($$select post_stock_transfer('d5000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_stock_transfer refused');
select throws_ok($$select post_stock_adjustment('d6000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_stock_adjustment refused');
select throws_ok($$select * from day_close_preview('2026-06-01')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: day_close_preview refused');
select throws_ok($$select post_day_close('2026-06-01', 0, 'test')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: post_day_close refused');

-- Same owner with no aal claim at all: refused the same way (sample).
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'owner with no aal claim: post_sales_invoice refused');

-- Nothing was posted by the refusals.
reset role;
select is((select count(*)::int from journal_entries), 0, 'the refused calls posted nothing');
select is((select count(*)::int from sales_invoices where status = 'draft'), 4, 'every sales draft is still a draft');
set local role authenticated;

-- ============================================================
-- 3. Same owner at aal2: all of them work
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_sales_invoice works');
select lives_ok($$select post_cash_sale('d0000000-0000-0000-0000-000000000002', (select id from accounts where system_key = 'cash'))$$,
  'aal2 owner: post_cash_sale works');
select lives_ok($$select post_delivery_challan('d1000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_delivery_challan works');
select lives_ok($$select post_purchase_invoice('d2000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_purchase_invoice works');
select lives_ok($$select post_payment('d3000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_payment works');
select lives_ok($$select post_payment('d3000000-0000-0000-0000-000000000002')$$,
  'aal2 owner: cheque receipt 1 posts');
select lives_ok($$select post_payment('d3000000-0000-0000-0000-000000000003')$$,
  'aal2 owner: cheque receipt 2 posts');
select lives_ok($$select post_expense_voucher('d4000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_expense_voucher works');
select lives_ok($$select post_stock_transfer('d5000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_stock_transfer works');
select lives_ok($$select post_stock_adjustment('d6000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: post_stock_adjustment works');
select lives_ok($$select * from day_close_preview('2026-06-01')$$,
  'aal2 owner: day_close_preview works');

-- Functions that need a posted document: aal1 refused, then aal2 works, one pair at a time.
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok($$select receive_stock_transfer('d5000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: receive_stock_transfer refused');
select throws_ok($$select deposit_cheque('d3000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: deposit_cheque refused');
select throws_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000001', 'test')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: cancel_document refused');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select receive_stock_transfer('d5000000-0000-0000-0000-000000000001')$$,
  'aal2 owner: receive_stock_transfer works');
select lives_ok($$select deposit_cheque('d3000000-0000-0000-0000-000000000002')$$,
  'aal2 owner: deposit_cheque works');
select lives_ok($$select deposit_cheque('d3000000-0000-0000-0000-000000000003')$$,
  'aal2 owner: the second cheque is deposited');
select lives_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000001', 'test')$$,
  'aal2 owner: cancel_document works');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok($$select mark_cheque_cleared('d3000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: mark_cheque_cleared refused');
select throws_ok($$select bounce_cheque('d3000000-0000-0000-0000-000000000003', 'insufficient funds')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 owner: bounce_cheque refused');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select mark_cheque_cleared('d3000000-0000-0000-0000-000000000002')$$,
  'aal2 owner: mark_cheque_cleared works');
select lives_ok($$select bounce_cheque('d3000000-0000-0000-0000-000000000003', 'insufficient funds')$$,
  'aal2 owner: bounce_cheque works');
select lives_ok($$select post_day_close('2026-06-01', (select expected from day_close_preview('2026-06-01')), 'test')$$,
  'aal2 owner: post_day_close works');

reset role;
select is((select status::text from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001'), 'cancelled',
  'the aal2 cancel really cancelled the invoice');
select is((select status from stock_transfers where id = 'd5000000-0000-0000-0000-000000000001'), 'received',
  'the aal2 receive really received the transfer');
select is((select count(*)::int from day_closes where close_date = '2026-06-01'), 1,
  'the aal2 day close really closed the day');
set local role authenticated;

-- ============================================================
-- 4. Owner at aal1 reads nothing: sample tables, every v_* view; own app_users row still readable
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';

select is((select count(*)::int from sales_invoices), 0, 'aal1 owner: no sales invoices');
select is((select count(*)::int from purchase_invoices), 0, 'aal1 owner: no purchase invoices');
select is((select count(*)::int from payments), 0, 'aal1 owner: no payments');
select is((select count(*)::int from journal_entries), 0, 'aal1 owner: no journal entries');
select is((select count(*)::int from journal_lines), 0, 'aal1 owner: no journal lines');
select is((select count(*)::int from stock_movements), 0, 'aal1 owner: no stock movements');
select is((select count(*)::int from parties), 0, 'aal1 owner: no parties');
select is((select count(*)::int from items), 0, 'aal1 owner: no items');
select is((select count(*)::int from accounts), 0, 'aal1 owner: no accounts');
select is((select count(*)::int from organization), 0, 'aal1 owner: no organisation row');
select is((select count(*)::int from audit_log), 0, 'aal1 owner: no audit log');

select is((select count(*)::int from v_attention), 0, 'aal1 owner: v_attention empty');
select is((select count(*)::int from v_balance_sheet), 0, 'aal1 owner: v_balance_sheet empty');
select is((select count(*)::int from v_bank_recon), 0, 'aal1 owner: v_bank_recon empty');
select is((select count(*)::int from v_day_book), 0, 'aal1 owner: v_day_book empty');
select is((select count(*)::int from v_document_refs), 0, 'aal1 owner: v_document_refs empty');
select is((select count(*)::int from v_employee_ledger), 0, 'aal1 owner: v_employee_ledger empty');
select is((select count(*)::int from v_employees), 0, 'aal1 owner: v_employees empty');
select is((select count(*)::int from v_money_balances), 0, 'aal1 owner: v_money_balances empty');
select is((select count(*)::int from v_money_ledger), 0, 'aal1 owner: v_money_ledger empty');
select is((select count(*)::int from v_open_purchase_invoices), 0, 'aal1 owner: v_open_purchase_invoices empty');
select is((select count(*)::int from v_open_sales_invoices), 0, 'aal1 owner: v_open_sales_invoices empty');
select is((select count(*)::int from v_party_aging), 0, 'aal1 owner: v_party_aging empty');
select is((select count(*)::int from v_party_balances), 0, 'aal1 owner: v_party_balances empty');
select is((select count(*)::int from v_party_interest), 0, 'aal1 owner: v_party_interest empty');
select is((select count(*)::int from v_party_ledger), 0, 'aal1 owner: v_party_ledger empty');
select is((select count(*)::int from v_pnl), 0, 'aal1 owner: v_pnl empty');
select is((select count(*)::int from v_sales_daily), 0, 'aal1 owner: v_sales_daily empty');
select is((select count(*)::int from v_sales_daily_category), 0, 'aal1 owner: v_sales_daily_category empty');
select is((select count(*)::int from v_stock_ledger), 0, 'aal1 owner: v_stock_ledger empty');
select is((select count(*)::int from v_stock_ledger_all), 0, 'aal1 owner: v_stock_ledger_all empty');
select is((select count(*)::int from v_stock_summary), 0, 'aal1 owner: v_stock_summary empty');
select is((select count(*)::int from v_stock_summary_all), 0, 'aal1 owner: v_stock_summary_all empty');
select is((select count(*)::int from v_trial_balance), 0, 'aal1 owner: v_trial_balance empty');

select is((select count(*)::int from app_users), 1, 'aal1 owner: reads exactly one app_users row');
select is((select user_id from app_users), '33333333-3333-3333-3333-333333333333'::uuid,
  'aal1 owner: and it is their own (the login flow still works)');

-- Views are not empty for the aal2 owner (so the zeros above are the gate, not missing data).
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select ok((select count(*) from v_day_book) > 0, 'aal2 owner: v_day_book has rows');
select ok((select count(*) from v_trial_balance) > 0, 'aal2 owner: v_trial_balance has rows');
select ok((select count(*) from v_stock_summary) > 0, 'aal2 owner: v_stock_summary has rows');
select ok((select count(*) from v_money_ledger) > 0, 'aal2 owner: v_money_ledger has rows');
select ok((select count(*) from journal_entries) > 0, 'aal2 owner: journal entries visible');
select is((select count(*)::int from app_users), 3, 'aal2 owner: every app_users row');

-- ============================================================
-- 5. Owner at aal1 cannot write masters (change 09 policies and parties_guard)
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';

select throws_ok($$insert into parties (name, type, state_code) values ('Intruder', 'customer', '37')$$,
  '42501', null, 'aal1 owner: cannot insert a party');
select throws_ok($$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
                   values ('Intruder item', 'cement', '2523', 28, 'bag', 1)$$,
  '42501', null, 'aal1 owner: cannot insert an item');
select lives_ok($$update parties set name = 'Hijacked' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'aal1 owner: a party update runs');
select lives_ok($$update items set sale_rate = 1 where id = 'c0000000-0000-0000-0000-000000000001'$$,
  'aal1 owner: an item update runs');
select lives_ok($$update organization set legal_name = 'Hijacked'$$,
  'aal1 owner: an organisation update runs');

reset role;
select is((select name from parties where id = 'a0000000-0000-0000-0000-000000000001'), 'Ramesh Builders',
  'aal1 owner: the party was not changed');
select is((select sale_rate from items where id = 'c0000000-0000-0000-0000-000000000001'), 400.00::numeric,
  'aal1 owner: the item was not changed');
select isnt((select legal_name from organization), 'Hijacked', 'aal1 owner: the organisation was not changed');
set local role authenticated;

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$insert into parties (name, type, state_code) values ('Real Customer', 'customer', '37')$$,
  'aal2 owner: inserts a party');
select lives_ok($$update items set sale_rate = 410 where id = 'c0000000-0000-0000-0000-000000000001'$$,
  'aal2 owner: updates an item');
reset role;
select is((select sale_rate from items where id = 'c0000000-0000-0000-0000-000000000001'), 410.00::numeric,
  'aal2 owner: the item update landed');
set local role authenticated;

-- ============================================================
-- 6. Counter user: identical at aal1 and aal2
-- ============================================================
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000003')$$,
  'aal1 counter: posts a sales invoice');
select throws_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000003', 'test')$$,
  'P0001', 'DN_FORBIDDEN', 'aal1 counter: cancel refused (role, as before)');
create temp table _counter_aal1 as
select (select count(*) from sales_invoices) as invoices, (select count(*) from v_day_book) as day_book,
       (select count(*) from app_users) as users;

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
select is((select count(*) from sales_invoices), (select invoices from _counter_aal1),
  'counter: same sales invoices visible at aal1 and aal2');
select is((select count(*) from v_day_book), (select day_book from _counter_aal1),
  'counter: same day book at aal1 and aal2');
select is((select count(*) from app_users), (select users from _counter_aal1),
  'counter: same app_users rows at aal1 and aal2');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000004')$$,
  'aal2 counter: posts a sales invoice');
select throws_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000004', 'test')$$,
  'P0001', 'DN_FORBIDDEN', 'aal2 counter: cancel refused (role, as before)');

-- A second owner at aal1 cannot use the first owner's work either (the rule is per session).
set local request.jwt.claims to '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from sales_invoices), 0, 'second owner at aal1: no sales invoices');
select throws_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000004', 'test')$$,
  'P0001', 'DN_FORBIDDEN', 'second owner at aal1: cancel refused');

select * from finish();
rollback;
