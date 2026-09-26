-- Must pass (change 06, read-views):
--   "trial balance view balances after 03-05 fixtures", the reconciliations (party balances vs
--   the AR/AP control lines, ageing vs AR, stock summary vs stock_on_hand and the Inventory GL,
--   employee ledger vs the advance/payable accounts), admin-only views returning zero rows for a
--   `user`, anon denied everywhere, and one v_attention row per applicable kind.
--
-- Same harness as 00005-00007: every document is created as postgres (a draft, exactly as the app
-- would write one) and then posted/cancelled/banked through the real post_*/cancel/receive
-- functions in a real `authenticated` session. Nothing is ever inserted into journal_lines or
-- stock_movements. View reads run as postgres with the admin's JWT claims set (so
-- current_app_role() resolves, RLS is bypassed and the arithmetic is what is being tested);
-- role/RLS behaviour is then tested with genuine `authenticated` and `anon` sessions.
--
-- "Today" is the organization's (IST) date, as in the views. Fixture documents use fixed 2026-27
-- dates; the cheque and day-close fixtures are relative to today. Assertions about date-driven
-- kinds (GST due, FY periods) recompute the expectation from first principles rather than
-- assuming the run date.
begin;

create extension if not exists pgtap with schema extensions;

select plan(158);

-- ============================================================
-- Fixtures: people, master data
-- ============================================================

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true);
insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'staff@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true);

create temp table _ids (name text primary key, id uuid not null);
grant select on _ids to authenticated, anon;
create function pg_temp.i(p_name text) returns uuid language sql stable as
  $$ select id from _ids where name = $1 $$;

create temp table _t as
select (now() at time zone 'Asia/Kolkata')::date as today,
       (now() at time zone 'Asia/Kolkata')::date - 1 as yesterday;
grant select on _t to authenticated;

with c1 as (
  insert into parties (name, type, state_code, credit_days, interest_rate_pm)
  select 'View Builder One', 'customer', state_code, 15, 2.00 from organization limit 1
  returning id),
c2 as (
  insert into parties (name, type, state_code)
  select 'View Builder Two', 'customer', state_code from organization limit 1
  returning id),
sp as (
  insert into parties (name, type, state_code)
  select 'View Supplier', 'supplier', state_code from organization limit 1
  returning id),
bp as (
  insert into parties (name, type, state_code)
  select 'View Trader Both', 'both', state_code from organization limit 1
  returning id),
em as (
  insert into parties (name, type, state_code)
  select 'View Employee', 'employee', state_code from organization limit 1
  returning id)
insert into _ids
select 'c1', id from c1 union all select 'c2', id from c2 union all select 'sup', id from sp
union all select 'both', id from bp union all select 'emp', id from em;

with cem as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate, reorder_level)
  values ('View Cement 50kg', 'cement', '2523', 18, 'bag', 360, 10000) returning id),
stl as (
  insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
  values ('View Steel 8mm', 'steel', '7214', 18, 'kg', 70) returning id)
insert into _ids select 'cem', id from cem union all select 'steel', id from stl;

insert into _ids
select 'head', id from warehouses where is_default
union all select 'transit', id from warehouses where is_transit;
with w as (
  insert into warehouses (name, is_default, is_transit) values ('View Branch', false, false)
  returning id)
insert into _ids select 'branch', id from w;

insert into _ids
select k, id from (values
  ('a_cash', 'cash'), ('a_bank', 'bank'), ('a_ar', 'ar'), ('a_ap', 'ap'),
  ('a_inv', 'inventory'), ('a_adv', 'employee_advance'), ('a_pay', 'salary_payable'),
  ('a_salaries', 'salaries'), ('a_rent', 'godown_rent'), ('a_sales', 'sales_cement'),
  ('a_cogs', 'cogs'), ('a_git', 'goods_in_transit')
) as m(k, sk) join accounts a on a.system_key = m.sk;

-- ============================================================
-- Fixtures: draft documents (as the app writes them)
-- ============================================================

-- Purchases: 500 cement @300 + 200 steel @60 from the supplier; 10 cement @300 from the
-- both-party. Inventory = taxable value (ITC eligible).
with h as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible)
  select '2026-06-01', pg_temp.i('sup'), state_code, 'draft', pg_temp.i('head'), 'SUP/V1', true
  from organization limit 1 returning id)
insert into _ids select 'pb1', id from h;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values
  (pg_temp.i('pb1'), 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', 500, 300, 0, 18),
  (pg_temp.i('pb1'), 2, pg_temp.i('steel'), 'View Steel 8mm', '7214', 'kg', 200, 60, 0, 18);

with h as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible)
  select '2026-06-02', pg_temp.i('both'), state_code, 'draft', pg_temp.i('head'), 'BOTH/V1', true
  from organization limit 1 returning id)
insert into _ids select 'pb2', id from h;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values (pg_temp.i('pb2'), 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', 10, 300, 0, 18);

-- Sales. SI1/SI2 to builder one, SI3 (cancelled later), SI4 to the both-party. Cement @360.
create function pg_temp.draft_sale(p_key text, p_party text, p_date date, p_qty numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select p_date, pg_temp.i(p_party), state_code, 'draft', pg_temp.i('head')
  from organization limit 1 returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into sales_invoice_lines
    (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values (v_id, 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', p_qty, 360, 0, 18);
end $$;
select pg_temp.draft_sale('si1', 'c1', '2026-06-10', 100);   -- 42,480
select pg_temp.draft_sale('si2', 'c1', '2026-08-20', 50);    -- 21,240
select pg_temp.draft_sale('si3', 'c1', '2026-07-01', 10);    -- 4,248 (cancelled below)
select pg_temp.draft_sale('si4', 'both', '2026-06-15', 5);   -- 2,124

-- Challans to builder two: CH1 stays un-invoiced, CH2 is converted into SI5.
create function pg_temp.draft_challan(p_key text, p_date date, p_qty numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into delivery_challans (challan_date, party_id, warehouse_id, vehicle_no, status)
  values (p_date, pg_temp.i('c2'), pg_temp.i('head'), 'AP39 VW 0001', 'draft') returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into delivery_challan_lines
    (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
  values (v_id, 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', p_qty, 360, 18);
end $$;
select pg_temp.draft_challan('ch1', '2026-06-10', 20);
select pg_temp.draft_challan('ch2', '2026-06-11', 10);

with h as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-14', pg_temp.i('c2'), state_code, 'draft', pg_temp.i('head'), pg_temp.i('ch2')
  from organization limit 1 returning id)
insert into _ids select 'si5', id from h;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values (pg_temp.i('si5'), 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', 10, 360, 0, 18);

-- Stock transfers: TR1 stays in transit, TR2 is received. Adjustment: 5 bags shrinkage.
create function pg_temp.draft_transfer(p_key text, p_date date, p_qty numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, status)
  values (p_date, pg_temp.i('head'), pg_temp.i('branch'), 'draft') returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
  values (v_id, 1, pg_temp.i('cem'), 'View Cement 50kg', 'bag', p_qty);
end $$;
select pg_temp.draft_transfer('tr1', '2026-06-20', 30);
select pg_temp.draft_transfer('tr2', '2026-06-21', 20);

with h as (
  insert into stock_adjustments (adj_date, warehouse_id, status, reason)
  values ('2026-06-25', pg_temp.i('head'), 'draft', 'view fixture shrinkage') returning id)
insert into _ids select 'adj1', id from h;
insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
values (pg_temp.i('adj1'), 1, pg_temp.i('cem'), 'View Cement 50kg', -5);

-- ============================================================
-- Post the documents through the real functions (admin session)
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_purchase_invoice(pg_temp.i('pb1'));
  perform post_purchase_invoice(pg_temp.i('pb2'));
  perform post_sales_invoice(pg_temp.i('si1'));
  perform post_sales_invoice(pg_temp.i('si2'));
  perform post_sales_invoice(pg_temp.i('si3'));
  perform post_sales_invoice(pg_temp.i('si4'));
  perform post_delivery_challan(pg_temp.i('ch1'));
  perform post_delivery_challan(pg_temp.i('ch2'));
  perform post_sales_invoice(pg_temp.i('si5'));
  perform cancel_document('sales_invoice', pg_temp.i('si3'), 'view fixture: cancelled invoice');
  perform post_stock_transfer(pg_temp.i('tr1'));
  perform post_stock_transfer(pg_temp.i('tr2'));
  perform receive_stock_transfer(pg_temp.i('tr2'));
  perform post_stock_adjustment(pg_temp.i('adj1'));
end $$;
reset role;
set local request.jwt.claims to '';

-- Receipts, cheques and payments (drafts + allocations, as the app writes them)
create function pg_temp.draft_pay(
  p_key text, p_dir text, p_date date, p_party text, p_mode payment_mode, p_amount numeric,
  p_discount numeric, p_acct text, p_instr_date date, p_alloc_type text, p_alloc_inv text,
  p_alloc_amt numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into payments
    (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, discount,
     account_id, status)
  values (p_dir, p_date, pg_temp.i(p_party), p_mode,
          case when p_mode = 'cheque' then 'CHQ-' || p_key end,
          p_instr_date, p_amount, p_discount, pg_temp.i(p_acct), 'draft')
  returning id into v_id;
  insert into _ids values (p_key, v_id);
  if p_alloc_inv is not null then
    insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
    values (v_id, p_alloc_type, pg_temp.i(p_alloc_inv), p_alloc_amt);
  end if;
end $$;

select pg_temp.draft_pay('r1',  'receipt', '2026-06-20', 'c1', 'cash',   20000, 0,  'a_cash', null, 'sales_invoice', 'si1', 20000);
select pg_temp.draft_pay('r2',  'receipt', '2026-08-25', 'c1', 'cash',   5000,  0,  'a_cash', null, null, null, null);
select pg_temp.draft_pay('r3',  'receipt', '2026-08-26', 'c1', 'upi',    1000,  50, 'a_bank', null, 'sales_invoice', 'si2', 1000);
select pg_temp.draft_pay('cq1', 'receipt', '2026-07-05', 'c1', 'cheque', 3000,  0,  'a_bank', '2026-07-05', 'sales_invoice', 'si1', 3000);
select pg_temp.draft_pay('cq2', 'receipt', '2026-07-06', 'c2', 'cheque', 4000,  0,  'a_bank',
  (select today + 2 from _t), null, null, null);
select pg_temp.draft_pay('pay1','payment', '2026-07-08', 'sup', 'neft',  50000, 0,  'a_bank', null, 'purchase_invoice', 'pb1', 50000);
select pg_temp.draft_pay('cq3', 'payment', '2026-07-09', 'sup', 'cheque', 1180, 0,  'a_bank',
  (select yesterday from _t), null, null, null);
-- A draft receipt planning 10,000 against SI2 that is never posted: must not reduce SI2's open amount.
select pg_temp.draft_pay('rdraft', 'receipt', '2026-08-27', 'c1', 'cash', 10000, 0, 'a_cash', null, 'sales_invoice', 'si2', 10000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select post_payment(pg_temp.i('r1'));   -- the counter user takes the first receipt
reset role;
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_payment(pg_temp.i('r2'));
  perform post_payment(pg_temp.i('r3'));
  perform post_payment(pg_temp.i('cq1'));
  perform post_payment(pg_temp.i('cq2'));
  perform post_payment(pg_temp.i('pay1'));
  perform post_payment(pg_temp.i('cq3'));
  perform bounce_cheque(pg_temp.i('cq1'), 'view fixture: bounced');
end $$;
reset role;
set local request.jwt.claims to '';

-- Expenses: rent, two advances (5,000 by the counter user, 6,000 by admin), salary 20,000 for July
-- recovering only 4,000 of the 11,000 advance, so 7,000 stays on the employee's advance account.
create function pg_temp.draft_voucher(
  p_key text, p_date date, p_type text, p_party text, p_acct text, p_line_acct text,
  p_amount numeric, p_period date, p_recovered numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into expense_vouchers
    (voucher_date, party_id, status, voucher_type, pay_account_id, period_month, advance_recovered)
  values (p_date, case when p_party is null then null else pg_temp.i(p_party) end, 'draft',
          p_type, pg_temp.i(p_acct), p_period, p_recovered)
  returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
  values (v_id, 1, pg_temp.i(p_line_acct), p_amount, 'view fixture ' || p_key);
end $$;
select pg_temp.draft_voucher('ev1', '2026-07-10', 'expense', null,  'a_cash', 'a_rent',     8000,  null, null);
select pg_temp.draft_voucher('ev2', '2026-07-11', 'advance', 'emp', 'a_cash', 'a_adv',      5000,  null, null);
select pg_temp.draft_voucher('ev3', '2026-07-12', 'advance', 'emp', 'a_cash', 'a_adv',      6000,  null, null);
select pg_temp.draft_voucher('ev4', '2026-07-31', 'salary',  'emp', 'a_bank', 'a_salaries', 20000, '2026-07-01', 4000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select post_expense_voucher(pg_temp.i('ev2'));
reset role;
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$
begin
  perform post_expense_voucher(pg_temp.i('ev1'));
  perform post_expense_voucher(pg_temp.i('ev3'));
  perform post_expense_voucher(pg_temp.i('ev4'));
end $$;
reset role;
set local request.jwt.claims to '';

-- Yesterday's day close, Rs 200 short. The count is derived from the ledger's own cash balance as
-- of yesterday, so the difference is exactly -200 whatever else is in the books.
alter table _t add column counted numeric;
update _t set counted = (
  select coalesce(sum(jl.debit - jl.credit), 0) - 200
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = pg_temp.i('a_cash') and je.entry_date <= (select yesterday from _t));

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select post_day_close((select yesterday from _t), (select counted from _t), 'view fixture');
reset role;
set local request.jwt.claims to '';

select cmp_ok((select counted from _t), '>=', 0::numeric,
  'sanity: the fixture cash balance leaves room for a Rs 200 short count');
select is((select difference from day_closes where close_date = (select yesterday from _t)
                                                 and status = 'posted'),
  -200.00::numeric, 'sanity: yesterday closed Rs 200 short');
select is((select count(*)::int from journal_entries), (select count(*)::int from journal_entries where status = 'posted'),
  'sanity: every fixture entry is posted');

-- From here on, read as the admin (claims only: postgres bypasses RLS, current_app_role() still
-- resolves from the JWT) unless a test says otherwise.
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

-- ============================================================
-- Trial balance, P&L, balance sheet
-- ============================================================

select is((select sum(total_debit) from v_trial_balance),
          (select sum(total_credit) from v_trial_balance),
  'trial balance: total debits = total credits after the change 03-05 fixtures');
select is((select sum(closing) from v_trial_balance), 0.00::numeric,
  'trial balance: closing balances net to zero');
select is((select sum(total_debit) from v_trial_balance),
          (select sum(debit) from journal_lines),
  'trial balance: total debits = every debit ever posted');
select is((select count(*)::int from v_trial_balance),
          (select count(*)::int from accounts where not is_group),
  'trial balance: one row per leaf account, zero-balance accounts included');
select is((select count(*)::int from v_trial_balance where account_id in
            (select id from accounts where is_group)),
  0, 'trial balance: group accounts are not listed');
select is((select closing from v_trial_balance where system_key = 'sales_cement'),
  -59400.00::numeric, 'trial balance: cement sales credit Rs 59,400 (SI3 cancelled nets to nothing)');
select is((select side from v_trial_balance where system_key = 'sales_cement'), 'credit',
  'trial balance: side is the side the closing falls on');
select is((select natural_side from v_trial_balance where system_key = 'inventory'), 'debit',
  'trial balance: natural_side follows the account type');
select is((select closing from v_trial_balance where system_key = 'ar'), 40042.00::numeric,
  'trial balance: AR = 37,670 (builder one) + 248 (builder two, net of the unallocated cheque) + 2,124');

select is((select sum(amount) from v_balance_sheet where section = 'asset'),
          (select sum(amount) from v_balance_sheet where section in ('liability', 'equity')),
  'balance sheet: assets = liabilities + equity (including the P&L profit row)');
select is((select sum(amount) from v_balance_sheet where is_current_profit),
          (select sum(profit_effect) from v_pnl),
  'balance sheet: the rolled-in profit row = the P&L net profit');
select is((select sum(profit_effect) from v_pnl),
          (select sum(amount) from v_pnl where account_type = 'income')
          - (select sum(amount) from v_pnl where account_type = 'expense'),
  'P&L: net = income - expense');
select is((select sum(profit_effect) from v_pnl where month = '2026-06-01'), 5400.00::numeric,
  'P&L: June net = revenue 41,400 - COGS 34,500 - shrinkage 1,500');
select is((select sum(amount) from v_pnl where system_key = 'sales_cement'), 59400.00::numeric,
  'P&L: the cancelled invoice leaves no revenue behind (reversal is a row like any other)');
select is((select min(fy_label) from v_pnl), '2026-27', 'P&L: fy_label is April-March');
select is((select sum(amount) from v_balance_sheet where section = 'asset' and account_id = pg_temp.i('a_inv')),
          (select sum(value) from stock_movements),
  'balance sheet: Inventory = the stock ledger''s total value');

-- ============================================================
-- Day book
-- ============================================================

select is((select count(*)::int from v_day_book), (select count(*)::int from journal_entries),
  'day book: one row per posted entry');
select is((select sum(total_debit) from v_day_book), (select sum(debit) from journal_lines),
  'day book: entry totals add up to every debit posted');
select is((select count(*)::int from v_day_book where is_reversal), 2,
  'day book: two reversal entries, the cancelled invoice and the bounced cheque');
select is((select count(*)::int from v_day_book where is_reversed), 2,
  'day book: and the two originals they reversed are flagged as reversed');
select is((select count(*)::int from v_day_book where is_reversal and narration like 'Reversal of%'), 1,
  'day book: the cancellation reversal carries its narration');
select is((select doc_no from v_day_book where source_type = 'sales_invoice' and not is_reversal
             and source_id = pg_temp.i('si1')),
  (select invoice_no from sales_invoices where id = pg_temp.i('si1')),
  'day book: shows the document number of a sales invoice');
select is((select doc_no from v_day_book where source_type = 'day_close'),
  'Day close ' || to_char((select yesterday from _t), 'DD-MM-YYYY'),
  'day book: a day close is referenced by its date');
select is((select count(*)::int from v_day_book where source_type in
            ('sales_invoice', 'purchase_invoice', 'payment', 'expense_voucher', 'delivery_challan')
            and doc_no is null),
  0, 'day book: every document-sourced entry resolves a reference');

-- ============================================================
-- Party ledger and balances
-- ============================================================

select is((select running_balance from v_party_ledger
           where party_id = pg_temp.i('c1') and account_key = 'ar'
           order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
  37670.00::numeric, 'party ledger: builder one closes at 42,480 + 21,240 - 20,000 - 5,000 - 1,050');
select is((select sum(debit - credit) from v_party_ledger where party_id = pg_temp.i('c1')),
  37670.00::numeric, 'party ledger: rows sum to the closing balance');
select is((select count(*)::int from v_party_ledger where party_id = pg_temp.i('c1') and is_reversal),
  2, 'party ledger: the cancellation and the bounce appear as their own reversal rows');
select is((select count(*)::int from v_party_ledger where party_id = pg_temp.i('c1') and doc_no is null),
  0, 'party ledger: every row carries its document number');
select is((select count(*)::int from v_party_ledger where party_id = pg_temp.i('emp')), 0,
  'party ledger: employee accounts are not here (v_employee_ledger)');
select is((select running_balance from v_party_ledger
           where party_id = pg_temp.i('sup') and account_key = 'ap'
           order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
  139980.00::numeric, 'party ledger: supplier payable = 191,160 - 50,000 - 1,180 (AP sign: positive = we owe)');
select is((select count(distinct account_key)::int from v_party_ledger where party_id = pg_temp.i('both')),
  2, 'party ledger: a both-party has AR and AP rows');
select is((select array_agg(account_key || ':' || running_balance order by account_key, entry_date, entry_no)
           from v_party_ledger where party_id = pg_temp.i('both')),
  array['ap:3540.00', 'ar:2124.00'],
  'party ledger: a both-party''s running balances are per (party, account): AP 3,540 and AR 2,124, never mixed');
select is((select array_agg(running_balance order by entry_date, entry_no)
           from v_party_ledger where party_id = pg_temp.i('c1') and account_key = 'ar'),
  array[42480.00, 22480.00, 26728.00, 23728.00, 44968.00, 39968.00, 38918.00, 34670.00, 37670.00]::numeric[],
  'party ledger: builder one''s running balance row by row (sale, receipt, SI3, cheque, sale, receipts, cancellation, bounce)');

select is((select count(*)::int from v_party_balances b
           where b.ar_balance is distinct from (
             select coalesce(sum(jl.debit - jl.credit), 0) from journal_lines jl
             join accounts a on a.id = jl.account_id and a.system_key = 'ar'
             where jl.party_id = b.party_id)
              or b.ap_balance is distinct from (
             select coalesce(sum(jl.credit - jl.debit), 0) from journal_lines jl
             join accounts a on a.id = jl.account_id and a.system_key = 'ap'
             where jl.party_id = b.party_id)),
  0, 'party balances: every party equals the sum of its AR/AP control-account lines');
select is((select sum(ar_balance) from v_party_balances),
          (select closing from v_trial_balance where system_key = 'ar'),
  'party balances: AR across parties = the AR control account');
select is((select sum(ap_balance) from v_party_balances),
          (select -closing from v_trial_balance where system_key = 'ap'),
  'party balances: AP across parties = the AP control account');
select is((select balance from v_party_balances where party_id = pg_temp.i('c1')), 37670.00::numeric,
  'party balances: a customer''s balance is what they owe us');
select is((select balance from v_party_balances where party_id = pg_temp.i('sup')), 139980.00::numeric,
  'party balances: a supplier''s balance is what we owe them');
select is((select array[ar_balance, ap_balance, net_balance, balance]
           from v_party_balances where party_id = pg_temp.i('both')),
  array[2124.00, 3540.00, -1416.00, -1416.00]::numeric[],
  'party balances: a both-party shows AR and AP separately, plus net (negative = we owe them)');
select is((select count(*)::int from v_party_balances where party_id = pg_temp.i('emp')), 0,
  'party balances: employees are not listed');

-- ============================================================
-- Open invoices, ageing and interest
-- ============================================================

create temp table _exp (who text, inv_date date, credit_days int, open_amt numeric, rate numeric);
insert into _exp values
  ('c1',   '2026-06-10', 15, 22480.00, 2.00),   -- 42,480 - 20,000 allocated (the bounced cheque's 3,000 is back)
  ('c1',   '2026-08-20', 15, 20240.00, 2.00),   -- 21,240 - 1,000 allocated; the 10,000 draft does not count
  ('both', '2026-06-15', 0,  2124.00,  0),
  ('c2',   '2026-06-14', 0,  4248.00,  0);      -- 10 bags invoiced from CH2

select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('si2')),
  20240.00::numeric, 'open invoices: a draft receipt''s allocation does not reduce the open amount');
select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('si1')),
  22480.00::numeric, 'open invoices: a bounced cheque re-opens the invoice it had settled');
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('si3')), 0,
  'open invoices: a cancelled invoice is not open');
select is((select count(*)::int from v_open_sales_invoices), 4,
  'open invoices: SI1, SI2, SI4 and SI5 are all that remain open');

select is((select open_total from v_party_aging where party_id = pg_temp.i('c1')), 42720.00::numeric,
  'ageing: builder one has 42,720 open');
select is((select row(bucket_0_30, bucket_31_60, bucket_61_90, bucket_90_plus)::text
           from v_party_aging where party_id = pg_temp.i('c1')),
  (select row(
     coalesce(sum(open_amt) filter (where (t.today - inv_date) <= 30), 0)::numeric(14,2),
     coalesce(sum(open_amt) filter (where (t.today - inv_date) between 31 and 60), 0)::numeric(14,2),
     coalesce(sum(open_amt) filter (where (t.today - inv_date) between 61 and 90), 0)::numeric(14,2),
     coalesce(sum(open_amt) filter (where (t.today - inv_date) > 90), 0)::numeric(14,2))::text
   from _exp, _t t where who = 'c1'),
  'ageing: buckets are days since the invoice date (0-30 / 31-60 / 61-90 / 90+)');
select is((select bucket_0_30 + bucket_31_60 + bucket_61_90 + bucket_90_plus from v_party_aging
           where party_id = pg_temp.i('c1')),
          (select open_total from v_party_aging where party_id = pg_temp.i('c1')),
  'ageing: the buckets add up to the open total');
select is((select unallocated from v_party_aging where party_id = pg_temp.i('c1')), 5000.00::numeric,
  'ageing: the on-account receipt shows separately as unallocated (not netted into the buckets)');
select is((select unapplied_discount from v_party_aging where party_id = pg_temp.i('c1')), 50.00::numeric,
  'ageing: a discount not allocated to any invoice is shown separately as unapplied_discount');
select is((select ar_balance from v_party_aging where party_id = pg_temp.i('c1')), 37670.00::numeric,
  'ageing: ar_balance is the party''s ledger balance');
select is((select count(*)::int from v_party_aging where other_ar <> 0), 0,
  'ageing: open - unallocated - discount = AR for every party (nothing unexplained in this fixture)');
select is((select sum(open_total - unallocated - unapplied_discount) from v_party_aging),
          (select closing from v_trial_balance where system_key = 'ar'),
  'ageing reconciles to the AR control account');
select is((select unallocated from v_party_aging where party_id = pg_temp.i('c2')), 4000.00::numeric,
  'ageing: a cheque in hand is an on-account receipt until it is allocated');

select is((select interest from v_party_aging where party_id = pg_temp.i('c1')),
  (select coalesce(sum(round(open_amt * rate / 100 * greatest(t.today - (inv_date + credit_days), 0) / 30, 2)), 0)
   from _exp, _t t where who = 'c1'),
  'ageing: interest = open x rate%/100 x overdue days/30, per invoice, rounded to 2');
select is((select interest from v_party_interest where invoice_id = pg_temp.i('si1')),
  (select round(open_amt * rate / 100 * (t.today - (inv_date + credit_days)) / 30, 2)
   from _exp, _t t where who = 'c1' and inv_date = '2026-06-10'),
  'interest: the oldest invoice, hand-computed');
select is((select interest from v_party_interest where party_id = pg_temp.i('c2')), 0.00::numeric,
  'interest: a party on rate 0 shows the overdue invoice with zero interest');
select is((select count(*)::int from v_party_interest where party_id = pg_temp.i('c1')),
  (select count(*)::int from _exp, _t t where who = 'c1' and t.today > inv_date + credit_days),
  'interest: only invoices past their credit days');
select is((select scale(interest)::int from v_party_interest where invoice_id = pg_temp.i('si1')), 2,
  'interest: rounded to 2 decimals in the view');
select is((select column_default from information_schema.columns
           where table_name = 'parties' and column_name = 'interest_rate_pm'),
  '0', 'parties.interest_rate_pm defaults to 0');
select is((select numeric_precision::text || ',' || numeric_scale::text from information_schema.columns
           where table_name = 'parties' and column_name = 'interest_rate_pm'),
  '5,2', 'parties.interest_rate_pm is NUMERIC(5,2)');

-- ============================================================
-- Stock
-- ============================================================

select cmp_ok((select count(*)::int from v_stock_summary_all), '>=', 4, 'stock summary: has rows');
select is((select count(*)::int
           from v_stock_summary_all s
           cross join lateral stock_on_hand(s.item_id, s.warehouse_id) h
           where (s.qty, s.value, s.avg_rate) is distinct from (h.qty, h.value, h.avg_rate)),
  0, 'stock summary: every item x warehouse row equals stock_on_hand()');
select is((select qty from v_stock_summary where item_id = pg_temp.i('cem') and warehouse_id = pg_temp.i('head')),
  270.000::numeric, 'stock summary: head godown cement = 510 - 155 sold - 30 challans - 5 shrinkage - 50 transferred');
select is((select qty from v_stock_summary where item_id = pg_temp.i('cem') and warehouse_id = pg_temp.i('branch')),
  20.000::numeric, 'stock summary: the received transfer is at the branch');
select is((select value from v_stock_summary where item_id = pg_temp.i('cem') and warehouse_id = pg_temp.i('head')),
  81000.00::numeric, 'stock summary: head cement value = 270 x 300');
select is((select avg_rate from v_stock_summary where item_id = pg_temp.i('cem') and warehouse_id = pg_temp.i('head')),
  300.0000::numeric, 'stock summary: average rate is NUMERIC(14,4)');
select is((select count(*)::int from v_stock_summary where is_transit), 0,
  'stock summary: the In Transit warehouse is excluded by default');
select is((select qty from v_stock_summary_all where item_id = pg_temp.i('cem') and is_transit),
  30.000::numeric, 'stock summary (_all): the un-received transfer sits in transit');
select is((select sum(value) from v_stock_summary_all),
          (select closing from v_trial_balance where system_key = 'inventory'),
  'stock summary (_all) value = the Inventory GL balance');
select is((select sum(value) from v_stock_summary) + 9000.00,
          (select closing from v_trial_balance where system_key = 'inventory'),
  'stock summary: excluding transit is short by exactly the 30 bags in the lorry');

select is((select count(*)::int
           from v_stock_summary_all s
           where not exists (
             select 1 from v_stock_ledger_all l
             where l.item_id = s.item_id and l.warehouse_id = s.warehouse_id
               and l.seq = (select max(seq) from v_stock_ledger_all x
                            where x.item_id = s.item_id and x.warehouse_id = s.warehouse_id)
               and l.running_qty = s.qty and l.running_value = s.value)),
  0, 'stock ledger: the final running qty/value of each item x warehouse = the summary');
select is((select count(*)::int from v_stock_ledger where is_transit), 0,
  'stock ledger: transit excluded by default');
select cmp_ok((select count(*)::int from v_stock_ledger_all where is_transit), '>=', 1,
  'stock ledger (_all): includes the transit movements');
select is((select count(*)::int from v_stock_ledger where is_reversal), 1,
  'stock ledger: the cancelled invoice''s stock-back movement is flagged as a reversal');
select is((select doc_no from v_stock_ledger where source_type = 'sales_invoice' and source_id = pg_temp.i('si1')),
  (select invoice_no from sales_invoices where id = pg_temp.i('si1')),
  'stock ledger: shows the document number of the sale');
select is((select count(*)::int from v_stock_ledger where source_type = 'sales_invoice'
            and source_id = pg_temp.i('si5')), 0,
  'stock ledger: the invoice converted from a challan moved no stock (it left with the challan)');

-- ============================================================
-- Employee ledger
-- ============================================================

select is((select advance_balance from v_employee_ledger
           where party_id = pg_temp.i('emp')
           order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
  7000.00::numeric, 'employee ledger: advances 11,000 less 4,000 recovered = 7,000 still owed by the employee');
select is((select payable_balance from v_employee_ledger
           where party_id = pg_temp.i('emp')
           order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
  0.00::numeric, 'employee ledger: the salary is settled, nothing payable');
select is((select closing from v_trial_balance where system_key = 'employee_advance'), 7000.00::numeric,
  'employee ledger: advance balance = the employee_advance account');
select is((select closing from v_trial_balance where system_key = 'salary_payable'), 0.00::numeric,
  'employee ledger: payable balance = the salary_payable account');
select is((select array_agg(distinct voucher_type order by voucher_type) from v_employee_ledger
           where party_id = pg_temp.i('emp')),
  array['advance', 'salary'], 'employee ledger: lines carry their voucher type');
select is((select array_agg(distinct period_month) from v_employee_ledger
           where party_id = pg_temp.i('emp') and voucher_type = 'salary'),
  array['2026-07-01'::date], 'employee ledger: salary lines carry the pay period (period_month)');
select is((select count(*)::int from v_employee_ledger where party_id = pg_temp.i('emp')
            and voucher_type = 'advance' and period_month is not null),
  0, 'employee ledger: advances have no pay period');
select is((select count(*)::int from v_employee_ledger where party_id <> pg_temp.i('emp')), 0,
  'employee ledger: only the employee''s own lines');
select is((select count(*)::int from v_employee_ledger where advance_balance is null or payable_balance is null),
  0, 'employee ledger: running balances are never NULL');
select is((select payable_balance from v_employee_ledger where party_id = pg_temp.i('emp')
           order by entry_date, entry_no, line_no limit 1),
  0.00::numeric, 'employee ledger: the first row (an advance) has payable_balance 0, not NULL');

-- ============================================================
-- Bank reconciliation
-- ============================================================

select is((select count(*)::int from v_bank_recon), 1,
  'bank recon: one row per bank ledger (the cash box is not a bank)');
select is((select book_balance from v_bank_recon),
          (select closing from v_trial_balance where system_key = 'bank'),
  'bank recon: with no statement, book balance = the bank ledger''s GL balance today');
select is((select book_balance_today from v_bank_recon),
          (select closing from v_trial_balance where system_key = 'bank'),
  'bank recon: book_balance_today is always the balance as of today');
select is((select bank_balance from v_bank_recon), null::numeric,
  'bank recon: no statement yet -> bank balance NULL');
select is((select difference from v_bank_recon), null::numeric,
  'bank recon: no statement yet -> difference NULL');
select is((select unmatched_lines from v_bank_recon), 0, 'bank recon: no statement yet -> 0 unmatched');

with old_s as (
  insert into bank_statements (account_id, period_from, period_to)
  values (pg_temp.i('a_bank'), '2026-07-01', '2026-07-31') returning id),
new_s as (
  insert into bank_statements (account_id, period_from, period_to)
  values (pg_temp.i('a_bank'), '2026-08-01', '2026-08-31') returning id),
l_old as (
  insert into bank_statement_lines (statement_id, txn_date, narration, credit, balance)
  select id, '2026-07-30', 'old', 100, 999.00 from old_s returning id)
insert into bank_statement_lines (statement_id, txn_date, narration, debit, credit, balance, match_status)
select id, d, n, db, cr, bal, ms from new_s, (values
  ('2026-08-30'::date, 'first',  0::numeric, 500::numeric, 1000.00::numeric, 'unmatched'),
  ('2026-08-31'::date, 'last',   50::numeric, 0::numeric, 1234.56::numeric, 'unmatched'),
  ('2026-08-31'::date, 'noise',  10::numeric, 0::numeric, null::numeric,    'ignored')
) as v(d, n, db, cr, bal, ms);

select is((select bank_balance from v_bank_recon), 1234.56::numeric,
  'bank recon: bank balance = the last printed balance of the latest statement');
select is((select difference from v_bank_recon),
          (select sum(jl.debit - jl.credit) from journal_lines jl
           join journal_entries je on je.id = jl.entry_id
           where jl.account_id = pg_temp.i('a_bank') and je.entry_date <= '2026-08-31') - 1234.56,
  'bank recon: difference = book balance as of the statement''s period_to - bank balance');
select is((select book_balance from v_bank_recon),
          (select sum(jl.debit - jl.credit) from journal_lines jl
           join journal_entries je on je.id = jl.entry_id
           where jl.account_id = pg_temp.i('a_bank') and je.entry_date <= '2026-08-31'),
  'bank recon: with a statement, book_balance is as of period_to');

-- A bank posting dated after the statement's period_to must not move the difference.
create temp table _diff_before as select difference, book_balance, book_balance_today from v_bank_recon;
select pg_temp.draft_voucher('ev6', '2026-09-05', 'expense', null, 'a_bank', 'a_rent', 100, null, null);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select post_expense_voucher(pg_temp.i('ev6'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is((select difference from v_bank_recon), (select difference from _diff_before),
  'bank recon: a posting dated after period_to does not change the difference');
select is((select book_balance from v_bank_recon), (select book_balance from _diff_before),
  'bank recon: nor the as-of book balance');
select is((select book_balance_today from v_bank_recon), (select book_balance_today from _diff_before) - 100,
  'bank recon: but book_balance_today moves with it');
select is((select unmatched_lines from v_bank_recon), 3,
  'bank recon: unmatched lines counted across statements (ignored lines are not)');
select is((select statement_period_to from v_bank_recon), '2026-08-31'::date,
  'bank recon: reports which statement it compared against');
select is((select closing_balance_ambiguous from v_bank_recon), false,
  'bank recon: a single balance on the last day is not ambiguous');

-- Last day with two different balances and no running-order relation between them: the view
-- still shows a value but says it cannot be sure.
with s as (
  insert into bank_statements (account_id, period_from, period_to)
  values (pg_temp.i('a_bank'), '2026-09-01', '2026-09-30') returning id)
insert into bank_statement_lines (statement_id, txn_date, narration, debit, credit, balance)
select s.id, '2026-09-30', v.n, v.db, v.cr, v.bal from s, (values
  ('x', 100::numeric, 0::numeric,  500::numeric),
  ('y', 0::numeric,   50::numeric, 700::numeric)) as v(n, db, cr, bal);
select is((select closing_balance_ambiguous from v_bank_recon), true,
  'bank recon: different last-day balances that the running order cannot settle are flagged ambiguous');
select ok((select bank_balance from v_bank_recon) in (500.00, 700.00),
  'bank recon: an ambiguous statement still shows one of the candidate balances');

-- Same shape, but the running order settles it: Y = X - 0 + 50. X is inserted *after* Y (later
-- created_at), so the naive greatest-(created_at, id) pick would be X = 500; the running order
-- says the day ended on Y = 550.
with s as (
  insert into bank_statements (account_id, period_from, period_to)
  values (pg_temp.i('a_bank'), '2026-10-01', '2026-10-31') returning id)
insert into bank_statement_lines (statement_id, txn_date, narration, debit, credit, balance, created_at)
select s.id, '2026-10-31', v.n, v.db, v.cr, v.bal, v.ts from s, (values
  ('y2', 0::numeric,   50::numeric, 550::numeric, now() - interval '1 minute'),
  ('x2', 100::numeric, 0::numeric,  500::numeric, now())) as v(n, db, cr, bal, ts);
select is((select bank_balance from v_bank_recon), 550.00::numeric,
  'bank recon: the balance consistent with running order beats the created_at tie-break');
select is((select closing_balance_ambiguous from v_bank_recon), false,
  'bank recon: and it is not flagged, because the running order settled it');

-- ============================================================
-- v_attention
-- ============================================================

select is((select count(*)::int from v_attention where kind = 'overdue_party'), 3,
  'attention: three parties are past their credit days');
select is((select amount from v_attention where kind = 'overdue_party' and subject_id = pg_temp.i('c1')),
  (select coalesce(sum(open_amt), 0) from _exp, _t t where who = 'c1' and t.today > inv_date + credit_days),
  'attention: overdue amount is the overdue open total');
select is((select interest from v_attention where kind = 'overdue_party' and subject_id = pg_temp.i('c1')),
  (select interest from v_party_aging where party_id = pg_temp.i('c1')),
  'attention: overdue rows carry the interest accrued');
select is((select severity from v_attention where kind = 'overdue_party' and subject_id = pg_temp.i('c1')),
  'critical', 'attention: more than 30 days overdue is critical');
select is((select count(*)::int from v_attention where kind = 'low_stock'), 1,
  'attention: exactly one item is below its reorder level');
select is((select subject_id from v_attention where kind = 'low_stock'), pg_temp.i('cem'),
  'attention: it is the cement (steel has no reorder level; transit stock is not counted)');
select is((select count(*)::int from v_attention where kind = 'cheque_due'), 2,
  'attention: two cheques due (one to deposit, one we issued); the bounced one is not listed');
select is((select severity from v_attention where kind = 'cheque_due' and subject_id = pg_temp.i('cq3')),
  'critical', 'attention: an issued cheque past its date is critical');
select is((select severity from v_attention where kind = 'cheque_due' and subject_id = pg_temp.i('cq2')),
  'warning', 'attention: a cheque in hand due in 2 days is a warning');
select is((select amount from v_attention where kind = 'cheque_due' and subject_id = pg_temp.i('cq2')),
  4000.00::numeric, 'attention: the cheque row carries its amount');
select is((select array_agg(subject_id) from v_attention where kind = 'stale_challan'),
  array[pg_temp.i('ch1')], 'attention: only the un-invoiced challan is stale (CH2 was converted)');
select is((select array_agg(subject_id) from v_attention where kind = 'transfer_in_transit'),
  array[pg_temp.i('tr1')], 'attention: only the transfer still on the road (TR2 was received)');
select is((select amount from v_attention where kind = 'day_close_difference'), -200.00::numeric,
  'attention: yesterday''s day-close difference');
select is((select count(*)::int from v_attention where kind = 'gst_due'),
  (select count(*)::int
   from _t t, generate_series(t.today, t.today + 7, interval '1 day') g(d)
   where extract(day from g.d) in (11, 20)
     and exists (select 1 from sales_invoices si
                 where si.status = 'posted'
                   and si.invoice_date >= (date_trunc('month', g.d) - interval '1 month')
                   and si.invoice_date < date_trunc('month', g.d))),
  'attention: GST due rows = the 11th/20th falling in the next 7 days whose prior month had sales');
select is((select count(*)::int from v_attention where kind = 'create_fy_periods'),
  (select case when extract(month from today) = 3
                and not exists (select 1 from fiscal_periods
                                where month = make_date(extract(year from today)::int, 4, 1))
               then 1 else 0 end
   from _t),
  'attention: "Create FY periods" only from 1 March, and only while April is missing');
-- Possible duplicate challan: goods that left on a challan and then went out again.
select is((select count(*)::int from v_attention where kind = 'challan_possible_duplicate'), 0,
  'attention: no possible duplicate in the base fixture (CH2 is smaller than CH1 and was invoiced)');

select pg_temp.draft_challan('ch3', '2026-06-12', 20);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select post_delivery_challan(pg_temp.i('ch3'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is((select array_agg(subject_id) from v_attention where kind = 'challan_possible_duplicate'),
  array[pg_temp.i('ch1')],
  'duplicate challan: a later challan for the same party, item and quantity flags the un-invoiced one');
select is((select severity from v_attention where kind = 'challan_possible_duplicate'), 'warning',
  'duplicate challan: a warning, never a block');

set local role authenticated;
select cancel_document('delivery_challan', pg_temp.i('ch3'), 'view fixture: duplicate was a mistake');
reset role;
select is((select count(*)::int from v_attention where kind = 'challan_possible_duplicate'), 0,
  'duplicate challan: clears when the other challan is cancelled');

select pg_temp.draft_sale('si6', 'c2', '2026-06-13', 20);
set local role authenticated;
select post_sales_invoice(pg_temp.i('si6'));
reset role;
select is((select array_agg(subject_id) from v_attention where kind = 'challan_possible_duplicate'),
  array[pg_temp.i('ch1')],
  'duplicate challan: a later invoice not linked to any challan flags it too');

with h as (
  insert into sales_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id)
  select '2026-06-14', pg_temp.i('c2'), state_code, 'draft', pg_temp.i('head'), pg_temp.i('ch1')
  from organization limit 1 returning id)
insert into _ids select 'si7', id from h;
insert into sales_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values (pg_temp.i('si7'), 1, pg_temp.i('cem'), 'View Cement 50kg', '2523', 'bag', 20, 360, 0, 18);
set local role authenticated;
select post_sales_invoice(pg_temp.i('si7'));
reset role;
select is((select count(*)::int from v_attention where kind = 'challan_possible_duplicate'), 0,
  'duplicate challan: clears when the challan is converted into an invoice');

set local role authenticated;
select cancel_document('sales_invoice', pg_temp.i('si7'), 'view fixture: reopen the challan');
reset role;
select is((select count(*)::int from v_attention where kind = 'challan_possible_duplicate'), 1,
  'duplicate challan: cancelling that invoice re-opens the challan and the warning returns');

set local role authenticated;
select cancel_document('delivery_challan', pg_temp.i('ch1'), 'view fixture: challan cancelled');
reset role;
select is((select count(*)::int from v_attention where kind = 'challan_possible_duplicate'), 0,
  'duplicate challan: clears when the challan itself is cancelled');

-- Employee ledger: a salary accrued for an employee who never had an advance. The filtered
-- running advance sum has no matching line yet; it must read 0, not NULL.
with e as (
  insert into parties (name, type, state_code)
  select 'View Employee Two', 'employee', state_code from organization limit 1 returning id)
insert into _ids select 'emp2', id from e;
select pg_temp.draft_voucher('ev5', '2026-08-01', 'salary', 'emp2', 'a_cash', 'a_salaries', 5000, '2026-08-01', null);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select post_expense_voucher(pg_temp.i('ev5'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
select is((select count(*)::int from v_employee_ledger where party_id = pg_temp.i('emp2')), 2,
  'employee ledger: a salary with no advance has just its two salary_payable rows');
select is((select count(*)::int from v_employee_ledger
           where party_id = pg_temp.i('emp2') and advance_balance is distinct from 0.00::numeric), 0,
  'employee ledger: an employee with no advance yet shows advance_balance = 0 on every row, not NULL');
select is((select payable_balance from v_employee_ledger where party_id = pg_temp.i('emp2')
           order by entry_date desc, entry_no desc, line_no desc limit 1),
  0.00::numeric, 'employee ledger: and the settled salary leaves payable_balance 0');

select ok(pg_get_viewdef('v_attention'::regclass) !~* 'current_date'
      and pg_get_viewdef('v_open_sales_invoices'::regclass) !~* 'current_date',
  'attention/ageing use the organization timezone, never CURRENT_DATE');

-- ============================================================
-- Roles: every view, four principals, through real sessions
-- ============================================================

create temp table _views (name text primary key);
insert into _views values
  ('v_document_refs'), ('v_open_sales_invoices'), ('v_trial_balance'), ('v_pnl'),
  ('v_balance_sheet'), ('v_day_book'), ('v_party_ledger'), ('v_party_balances'),
  ('v_party_interest'), ('v_party_aging'), ('v_stock_summary_all'), ('v_stock_summary'),
  ('v_stock_ledger_all'), ('v_stock_ledger'), ('v_employee_ledger'), ('v_bank_recon'),
  ('v_attention');
grant select on _views to authenticated, anon;
create temp table _acc (principal text, view_name text, n bigint, err text);
grant all on _acc to authenticated, anon;

-- Cannot use pg_temp.i() here: it is a helper for the postgres session only.
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare r record; v_n bigint;
begin
  for r in select name from _views loop
    begin
      execute format('select count(*) from public.%I', r.name) into v_n;
      insert into _acc values ('admin', r.name, v_n, null);
    exception when others then
      insert into _acc values ('admin', r.name, null, sqlerrm);
    end;
  end loop;
end $$;
reset role;

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
set local role authenticated;
do $$
declare r record; v_n bigint;
begin
  for r in select name from _views loop
    begin
      execute format('select count(*) from public.%I', r.name) into v_n;
      insert into _acc values ('user', r.name, v_n, null);
    exception when others then
      insert into _acc values ('user', r.name, null, sqlerrm);
    end;
  end loop;
end $$;
reset role;

-- An authenticated session with no app_users row at all.
set local request.jwt.claims to '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
set local role authenticated;
do $$
declare r record; v_n bigint;
begin
  for r in select name from _views loop
    begin
      execute format('select count(*) from public.%I', r.name) into v_n;
      insert into _acc values ('stranger', r.name, v_n, null);
    exception when others then
      insert into _acc values ('stranger', r.name, null, sqlerrm);
    end;
  end loop;
end $$;
reset role;

set local request.jwt.claims to '';
set local role anon;
do $$
declare r record; v_n bigint;
begin
  for r in select name from _views loop
    begin
      execute format('select count(*) from public.%I', r.name) into v_n;
      insert into _acc values ('anon', r.name, v_n, null);
    exception when others then
      insert into _acc values ('anon', r.name, null, sqlerrm);
    end;
  end loop;
end $$;
reset role;

select is((select count(*)::int from _acc where principal = 'admin' and err is not null), 0,
  'an authenticated admin can read every view without error');
select is((select count(*)::int from _acc where principal = 'admin' and n = 0), 0,
  'and every view has rows for the fixture books');
select is((select count(*)::int from _acc where principal = 'user' and err is not null), 0,
  'a user-role session gets no error from any view');
select is((select array_agg(view_name order by view_name) from _acc where principal = 'user' and n = 0),
  array['v_balance_sheet', 'v_bank_recon', 'v_employee_ledger', 'v_pnl', 'v_trial_balance'],
  'a user-role session gets zero rows from exactly the five admin-only views (books, salary, bank)');
select is((select count(*)::int from _acc where principal = 'user' and n > 0), 12,
  'and can read the other twelve');
select is((select count(*)::int from _acc where principal = 'stranger' and (err is not null or n <> 0)), 0,
  'an authenticated non-member reads zero rows from every view, no error (RLS applies through security_invoker)');
select is((select count(*)::int from _acc where principal = 'anon' and err ~ 'permission denied'), 17,
  'anon is denied on every one of the seventeen views');

-- user-role attention feed has no admin-only kinds

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
select is((select count(*)::int from v_attention where kind in ('gst_due', 'create_fy_periods')), 0,
  'attention: admin-only kinds never reach a user-role session');
select cmp_ok((select count(*)::int from v_attention where kind = 'overdue_party'), '>', 0,
  'attention: the shared kinds do');
select is((select count(*)::int from v_trial_balance) + (select count(*)::int from v_pnl)
          + (select count(*)::int from v_balance_sheet), 0,
  'P&L, balance sheet and trial balance: zero rows for a user even when claims resolve as postgres');
set local request.jwt.claims to '';
select is((select count(*)::int from v_trial_balance), 0,
  'no claims at all (current_app_role() NULL): admin-only views are empty, not an error');

-- ============================================================
-- Bank statement tables: RLS
-- ============================================================

select is((select count(*)::int from pg_class where relname in ('bank_statements', 'bank_statement_lines')
           and relrowsecurity), 2, 'bank statement tables have RLS enabled');

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
do $$ begin
  insert into bank_statements (account_id, period_from, period_to)
  values ((select id from _ids where name = 'a_bank'), '2026-09-01', '2026-09-30');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
select matches(current_setting('pgtap_test.raised_msg', true), 'row-level security',
  'a user-role session cannot write bank statements (admin only)');

select set_config('pgtap_test.raised_msg', 'none', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
do $$ begin
  insert into bank_statements (account_id, period_from, period_to)
  values ((select id from _ids where name = 'a_bank'), '2026-05-01', '2026-05-31');
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select is(current_setting('pgtap_test.raised_msg', true), 'none',
  'an admin session can write bank statements');

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into bank_statement_lines (statement_id, txn_date, match_status)
  select id, '2026-08-01', 'bogus' from bank_statements limit 1;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(current_setting('pgtap_test.raised_msg', true), 'match_status',
  'match_status is restricted to unmatched/auto/manual/ignored');

-- ============================================================
-- Hard rules
-- ============================================================

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'v\_%'
             and not coalesce(c.reloptions @> array['security_invoker=true'], false)),
  0, 'every v_* view is WITH (security_invoker = true)');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'v\_%'),
  -- Change 12 added v_open_purchase_invoices, the payment-allocation-grid mirror of
  -- v_open_sales_invoices for the outgoing-payment direction. Change 13 added v_employees (staff list).
  -- Change 14 added v_sales_daily, v_sales_daily_category and v_money_balances (dashboard).
  -- Change 15 added v_money_ledger (cash & bank book).
  23, 'twenty-three views exist (14 contracted + 2 stock _all + 2 internal helpers + open-purchase + employees + 3 dashboard + money ledger)');
select is((select count(*)::int from pg_matviews where schemaname = 'public'), 0,
  'nothing is materialised');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'public' and table_name like 'v\_%'
             and data_type in ('real', 'double precision')),
  0, 'no view column is a float type');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'public' and table_name like 'v\_%'
             and column_name in ('debit', 'credit', 'total_debit', 'total_credit', 'closing', 'amount', 'value',
                                 'balance', 'open_amount', 'interest', 'running_balance', 'running_value')
             and data_type <> 'numeric'),
  0, 'every money column is numeric');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'v\_%'
             and (has_table_privilege('anon', c.oid, 'select')
                  or has_table_privilege('service_role', c.oid, 'select')
                  or has_table_privilege('authenticated', c.oid, 'insert')
                  or has_table_privilege('authenticated', c.oid, 'update')
                  or has_table_privilege('authenticated', c.oid, 'delete')
                  or not has_table_privilege('authenticated', c.oid, 'select'))),
  0, 'grants: SELECT to authenticated only; nothing to anon or service_role; no view is writable');
select is((select count(*)::int from (values ('bank_statements'), ('bank_statement_lines')) v(tbl)
           where has_table_privilege('authenticated', tbl, 'truncate')
              or has_table_privilege('service_role', tbl, 'truncate')),
  0, 'bank statement tables: TRUNCATE (which ignores RLS) is not held by any client role');
select ok(has_function_privilege('authenticated', 'public.current_app_role()', 'execute')
      and (select provolatile = 's' from pg_proc where proname = 'current_app_role'),
  'current_app_role() is STABLE and executable by authenticated');

select * from finish();

rollback;
