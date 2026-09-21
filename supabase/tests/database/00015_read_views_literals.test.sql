-- Must pass (change 06 review follow-up): literal-only assertions for ageing / interest and for
-- discount accounting.
--
-- Why this file exists. 00008 asserts ageing buckets and interest by recomputing the expectation
-- with the same expression the view uses, so a `/31` for `/30` or an off-by-one at a bucket edge
-- would still pass, and its fixtures are fixed 2026 dates against a moving today. 00009 asserts
-- discount accounting only indirectly (open amounts, AR cleared). Here every expected value is a
-- number worked out by hand and written down; nothing is computed with the view's formula. The
-- only arithmetic left in the fixtures is DATE arithmetic (today - N) that places an invoice, which
-- is what "an invoice N days old" means.
--
-- "Today" is the organization's date (its timezone column), exactly as the views define it, so the
-- file is stable on any run day. Invoices are dated today-30 .. today-91 and the FY 2026-27 periods
-- (Apr 2026 - Mar 2027) are the only ones seeded, so the file is valid for run days from 2026-07-01
-- (today-91 must be >= 2026-04-01) through 2027-03-31 (receipts/payments are dated today). Outside
-- that window post_* would raise DN_PERIOD_LOCKED; that is a seed limit, not a bug in the views.
--
-- Boundary as documented by v_party_aging: buckets are days since the INVOICE date
--   0-30 / 31-60 / 61-90 / 90+   (age 30 -> 0-30, 31 -> 31-60, 60 -> 31-60, 61 -> 61-90,
--                                 90 -> 61-90, 91 -> 90+)
-- and v_party_interest documents: interest = open x rate_pm/100 x overdue_days/30, rounded to 2,
-- overdue_days = max(today - (invoice_date + credit_days), 0), only rows with overdue_days > 0.
--
-- Same harness as 00008/00009: drafts as postgres, posting through the real functions in a real
-- `authenticated` aal2 admin session. Nothing is inserted into journal_lines/stock_movements.
begin;

create extension if not exists pgtap with schema extensions;

select plan(63);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true);

create temp table _ids (name text primary key, id uuid not null);
grant select on _ids to authenticated;
create function pg_temp.i(p_name text) returns uuid language sql stable as
  $$ select id from _ids where name = $1 $$;

-- The organization's "today", the same clock v_open_sales_invoices uses for as_of.
create temp table _t as
select (now() at time zone (select timezone from organization limit 1))::date as today;
grant select on _t to authenticated;

-- credit_limit keeps its default 0 (= no limit), so no DN_CREDIT_LIMIT can interfere.
with ag as (
  insert into parties (name, type, state_code, credit_days, interest_rate_pm)
  select 'Literal Ageing', 'customer', state_code, 0, 2.00 from organization limit 1 returning id),
cd as (
  insert into parties (name, type, state_code, credit_days, interest_rate_pm)
  select 'Literal Due Day', 'customer', state_code, 10, 2.00 from organization limit 1 returning id),
dn as (insert into parties (name, type, state_code)
         select 'Literal Disc Cash', 'customer', state_code from organization limit 1 returning id),
dq as (insert into parties (name, type, state_code)
         select 'Literal Disc Cheque', 'customer', state_code from organization limit 1 returning id),
cp as (insert into parties (name, type, state_code)
         select 'Literal Caps', 'customer', state_code from organization limit 1 returning id),
sp as (insert into parties (name, type, state_code)
         select 'Literal Supplier', 'supplier', state_code from organization limit 1 returning id),
it as (insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
         values ('Literal Zero-rated Item', 'other', '0000', 0, 'pcs', 100) returning id)
insert into _ids
select 'ag', id from ag union all select 'cd', id from cd
union all select 'dn', id from dn union all select 'dq', id from dq
union all select 'cp', id from cp union all select 'sup', id from sp
union all select 'item', id from it
union all select 'head', id from warehouses where is_default
union all select 'bank', id from accounts where system_key = 'bank'
union all select 'cash', id from accounts where system_key = 'cash';

-- Purchase: 100 pcs @ 50 = 5,000 (gst 0, so the bill is exactly 5,000). Stock for the sales below,
-- and the bill the supplier discount payment settles.
with h as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
  select '2026-06-01', pg_temp.i('sup'), state_code, 'draft', pg_temp.i('head'), 'LIT/1'
  from organization limit 1 returning id)
insert into _ids select 'pb', id from h;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values (pg_temp.i('pb'), 1, pg_temp.i('item'), 'Literal Zero-rated Item', '0000', 'pcs', 100, 50, 0, 0);

-- One line, qty 1, gst 0: the invoice total is exactly p_total, dated p_age days before today.
create function pg_temp.draft_sale(p_key text, p_party text, p_age int, p_total numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select (select today from _t) - p_age, pg_temp.i(p_party), state_code, 'draft', pg_temp.i('head')
  from organization limit 1 returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into sales_invoice_lines
    (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values (v_id, 1, pg_temp.i('item'), 'Literal Zero-rated Item', '0000', 'pcs', 1, p_total, 0, 0);
end $$;

-- Ageing fixture: credit_days 0, so overdue days = age. Every total is distinct, so a misplaced
-- invoice changes some bucket to a different number.
select pg_temp.draft_sale('a30', 'ag', 30, 10000);
select pg_temp.draft_sale('a31', 'ag', 31, 2000);
select pg_temp.draft_sale('a60', 'ag', 60, 3000);
select pg_temp.draft_sale('a61', 'ag', 61, 400);
select pg_temp.draft_sale('a90', 'ag', 90, 500);
select pg_temp.draft_sale('a91', 'ag', 91, 60);
-- Due-day fixture: credit_days 10. d0 is due exactly today; d1 was due yesterday.
select pg_temp.draft_sale('d0', 'cd', 10, 3000);
select pg_temp.draft_sale('d1', 'cd', 11, 6000);
-- Discount fixtures and cap fixtures.
select pg_temp.draft_sale('sn', 'dn', 0, 1000);
select pg_temp.draft_sale('sq', 'dq', 0, 1000);
select pg_temp.draft_sale('k1', 'cp', 0, 2000);
select pg_temp.draft_sale('k2', 'cp', 0, 1000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
declare k text;
begin
  perform post_purchase_invoice(pg_temp.i('pb'));
  foreach k in array array['a30','a31','a60','a61','a90','a91','d0','d1','sn','sq','k1','k2'] loop
    perform post_sales_invoice(pg_temp.i(k));
  end loop;
end $$;
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select array_agg(grand_total order by grand_total) from sales_invoices
           where party_id = pg_temp.i('ag')),
  array[60.00, 400.00, 500.00, 2000.00, 3000.00, 10000.00]::numeric[],
  'sanity: the six ageing invoices total exactly 60 / 400 / 500 / 2,000 / 3,000 / 10,000');
select is((select grand_total from purchase_invoices where id = pg_temp.i('pb')), 5000.00::numeric,
  'sanity: the purchase bill is exactly Rs 5,000');

-- ============================================================
-- Part A1: ageing buckets, one literal per bucket
-- ============================================================
-- Amounts by age: 30d 10,000 | 31d 2,000 | 60d 3,000 | 61d 400 | 90d 500 | 91d 60.
-- Expected: 0-30 = 10,000; 31-60 = 2,000 + 3,000 = 5,000; 61-90 = 400 + 500 = 900; 90+ = 60;
-- open total = 15,960. Any boundary off by one moves a distinct amount into a neighbouring bucket.

select is((select bucket_0_30 from v_party_aging where party_id = pg_temp.i('ag')), 10000.00::numeric,
  'ageing 0-30: only the 30-day-old invoice (30 stays in the first bucket)');
select is((select bucket_31_60 from v_party_aging where party_id = pg_temp.i('ag')), 5000.00::numeric,
  'ageing 31-60: the 31-day (2,000) and 60-day (3,000) invoices, both edges inclusive');
select is((select bucket_61_90 from v_party_aging where party_id = pg_temp.i('ag')), 900.00::numeric,
  'ageing 61-90: the 61-day (400) and 90-day (500) invoices, both edges inclusive');
select is((select bucket_90_plus from v_party_aging where party_id = pg_temp.i('ag')), 60.00::numeric,
  'ageing 90+: only the 91-day-old invoice');
select is((select open_total from v_party_aging where party_id = pg_temp.i('ag')), 15960.00::numeric,
  'ageing: open total = 10,000 + 2,000 + 3,000 + 400 + 500 + 60');
select is((select array[ar_balance, other_ar, unallocated, unapplied_discount]
           from v_party_aging where party_id = pg_temp.i('ag')),
  array[15960.00, 0.00, 0.00, 0.00]::numeric[],
  'ageing: AR = 15,960, nothing unexplained, no receipts');

-- The due-day customer: both invoices are 10 and 11 days old, so both sit in 0-30.
select is((select array[bucket_0_30, bucket_31_60, bucket_61_90, bucket_90_plus, open_total]
           from v_party_aging where party_id = pg_temp.i('cd')),
  array[9000.00, 0.00, 0.00, 0.00, 9000.00]::numeric[],
  'ageing: invoices 10 and 11 days old are both in 0-30 (9,000)');

-- ============================================================
-- Part A2: age and overdue days per invoice, then interest per invoice
-- ============================================================
-- Ordered by amount ascending: 60 (91d), 400 (61d), 500 (90d), 2,000 (31d), 3,000 (60d), 10,000 (30d).
select is((select array_agg(age_days order by open_amount) from v_open_sales_invoices
           where party_id = pg_temp.i('ag')),
  array[91, 61, 90, 31, 60, 30],
  'open invoices: age in days is exactly 91 / 61 / 90 / 31 / 60 / 30');
select is((select array_agg(overdue_days order by open_amount) from v_open_sales_invoices
           where party_id = pg_temp.i('ag')),
  array[91, 61, 90, 31, 60, 30],
  'open invoices: with credit_days 0, overdue days = age');

-- Hand computation, 2 % per month, months = overdue_days / 30:
--   10,000 x 2 % x 30/30 = 200.00
--    2,000 x 2 % x 31/30 = 40 x 31 / 30 = 41.3333  -> 41.33
--    3,000 x 2 % x 60/30 = 60 x 2       = 120.00
--      400 x 2 % x 61/30 =  8 x 61 / 30 = 16.2667  -> 16.27
--      500 x 2 % x 90/30 = 10 x 3       =  30.00
--       60 x 2 % x 91/30 = 1.2 x 91 / 30 = 3.64
--   total 411.24
select is((select interest from v_party_interest where invoice_id = pg_temp.i('a30')), 200.00::numeric,
  'interest: 10,000 open, 30 days overdue, 2 % a month = exactly 200.00 (a /31 would give 193.55)');
select is((select array_agg(interest order by open_amount) from v_party_interest
           where party_id = pg_temp.i('ag')),
  array[3.64, 16.27, 30.00, 41.33, 120.00, 200.00]::numeric[],
  'interest: 3.64 / 16.27 / 30.00 / 41.33 / 120.00 / 200.00 for 60 / 400 / 500 / 2,000 / 3,000 / 10,000');
select is((select interest from v_party_aging where party_id = pg_temp.i('ag')), 411.24::numeric,
  'ageing: accrued interest = 200.00 + 41.33 + 120.00 + 16.27 + 30.00 + 3.64 = 411.24');
select is((select array_agg(overdue_months order by open_amount) from v_party_interest
           where party_id = pg_temp.i('ag')),
  array[3.0333, 2.0333, 3.0000, 1.0333, 2.0000, 1.0000]::numeric[],
  'interest: overdue_months = 91/30, 61/30, 90/30, 31/30, 60/30, 30/30 to 4 places');

-- ============================================================
-- Part A3: the exact due-day boundary (credit_days = 10)
-- ============================================================
-- d0: dated today-10, due today -> not overdue. d1: dated today-11, due yesterday -> 1 day overdue:
--   6,000 x 2 % x 1/30 = 120 / 30 = 4.00
select is((select array[overdue_days, age_days] from v_open_sales_invoices where invoice_id = pg_temp.i('d0')),
  array[0, 10],
  'due today: age 10, overdue_days = 0');
select is((select array[overdue_days, age_days] from v_open_sales_invoices where invoice_id = pg_temp.i('d1')),
  array[1, 11],
  'due yesterday: age 11, overdue_days = 1');
select is((select due_date from v_open_sales_invoices where invoice_id = pg_temp.i('d0')),
  (select today from _t),
  'the invoice dated today-10 on credit_days 10 is due today');
select is((select due_date from v_open_sales_invoices where invoice_id = pg_temp.i('d1')),
  (select today - 1 from _t),
  'the invoice dated today-11 on credit_days 10 was due yesterday');
select is((select count(*)::int from v_party_interest where invoice_id = pg_temp.i('d0')), 0,
  'interest: an invoice due today is not overdue and has no interest row');
select is((select array[overdue_days::numeric, interest, overdue_months]
           from v_party_interest where invoice_id = pg_temp.i('d1')),
  array[1, 4.00, 0.0333]::numeric[],
  'interest: due yesterday = 1 day overdue, 6,000 x 2 % / 30 = 4.00, 0.0333 months');
select is((select count(*)::int from v_party_interest where party_id = pg_temp.i('cd')), 1,
  'interest: exactly one overdue row for that customer (the one due yesterday)');
select is((select interest from v_party_aging where party_id = pg_temp.i('cd')), 4.00::numeric,
  'ageing: that customer''s accrued interest is 4.00');

-- ============================================================
-- Part B1: receipt 900 + discount 100 on a 1,000 credit invoice
-- ============================================================

create function pg_temp.draft_receipt(p_key text, p_party text, p_amount numeric, p_discount numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
  values ('receipt', (select today from _t), pg_temp.i(p_party), 'cash', p_amount, p_discount,
          pg_temp.i('cash'), 'draft') returning id into v_id;
  insert into _ids values (p_key, v_id);
end $$;

select pg_temp.draft_receipt('rn', 'dn', 900, 100);
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('rn'), 'sales_invoice', pg_temp.i('sn'), 1000);

select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ar' and jl.party_id = pg_temp.i('dn')),
  1000.00::numeric, 'before the receipt: the customer owes exactly 1,000');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('rn'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select array_agg(a.system_key || ':' || jl.debit || ':' || jl.credit order by a.system_key)
           from journal_lines jl join accounts a on a.id = jl.account_id
           join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('rn')),
  array['ar:0.00:1000.00', 'cash:900.00:0.00', 'discount_allowed:100.00:0.00'],
  'receipt entry is exactly: Dr cash 900.00, Dr discount_allowed 100.00, Cr AR 1,000.00');
select is((select debit from journal_lines jl join accounts a on a.id = jl.account_id
           join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('rn') and a.system_key = 'discount_allowed'),
  100.00::numeric, 'the discount_allowed line is a debit of exactly 100.00');
select is((select array[sum(debit), sum(credit)] from journal_lines jl
           join payments p on p.journal_entry_id = jl.entry_id where p.id = pg_temp.i('rn')),
  array[1000.00, 1000.00]::numeric[], 'the entry balances: total debit 1,000.00 = total credit 1,000.00');
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('sn')), 0,
  'the invoice is fully settled: no longer open');
select is((select sum(amount) from payment_allocations where payment_id = pg_temp.i('rn')),
  1000.00::numeric, 'and the allocation is exactly 1,000.00 (cash 900 + discount 100)');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ar' and jl.party_id = pg_temp.i('dn')),
  0.00::numeric, 'AR for the customer is 0.00 after the discounted receipt');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select cancel_document('payment', pg_temp.i('rn'), 'literal: cancel discounted receipt');
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select count(*)::int from journal_entries
           where source_type = 'payment' and source_id = pg_temp.i('rn')),
  2, 'cancelling: the receipt entry plus one reversal entry');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           join journal_entries je on je.id = jl.entry_id
           where a.system_key = 'discount_allowed'
             and je.source_type = 'payment' and je.source_id = pg_temp.i('rn')),
  0.00::numeric, 'cancelling: discount_allowed nets to 0.00 across the receipt and its reversal');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           join journal_entries je on je.id = jl.entry_id
           where a.system_key = 'cash'
             and je.source_type = 'payment' and je.source_id = pg_temp.i('rn')),
  0.00::numeric, 'cancelling: cash nets to 0.00 too');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ar' and jl.party_id = pg_temp.i('dn')),
  1000.00::numeric, 'cancelling: AR is back to exactly 1,000.00');
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('rn')), 0,
  'cancelling: the allocations are gone');
select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('sn')),
  1000.00::numeric, 'cancelling: the invoice is open for the full 1,000.00 again');

-- ============================================================
-- Part B2: bounced cheque receipt 900 + discount 100
-- ============================================================

insert into payments
  (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, discount, account_id, status)
select 'receipt', today, pg_temp.i('dq'), 'cheque', 'LIT-CHQ-1', today, 900, 100, pg_temp.i('bank'), 'draft'
from _t;
insert into _ids select 'rq', id from payments where instrument_no = 'LIT-CHQ-1';
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('rq'), 'sales_invoice', pg_temp.i('sq'), 1000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('rq'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select array_agg(a.system_key || ':' || jl.debit || ':' || jl.credit order by a.system_key)
           from journal_lines jl join accounts a on a.id = jl.account_id
           join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('rq')),
  array['ar:0.00:1000.00', 'cheques_in_hand:900.00:0.00', 'discount_allowed:100.00:0.00'],
  'cheque receipt entry is exactly: Dr cheques_in_hand 900.00, Dr discount_allowed 100.00, Cr AR 1,000.00');
select is((select array[sum(debit), sum(credit)] from journal_lines jl
           join payments p on p.journal_entry_id = jl.entry_id where p.id = pg_temp.i('rq')),
  array[1000.00, 1000.00]::numeric[], 'the cheque entry balances at 1,000.00');
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('sq')), 0,
  'the invoice is fully settled while the cheque stands');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select bounce_cheque(pg_temp.i('rq'), 'literal: bounced');
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           join journal_entries je on je.id = jl.entry_id
           where a.system_key = 'discount_allowed'
             and je.source_type = 'payment' and je.source_id = pg_temp.i('rq')),
  0.00::numeric, 'bounce: discount_allowed nets to 0.00 across the cheque entry and its reversal');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           join journal_entries je on je.id = jl.entry_id
           where a.system_key = 'cheques_in_hand'
             and je.source_type = 'payment' and je.source_id = pg_temp.i('rq')),
  0.00::numeric, 'bounce: cheques_in_hand nets to 0.00');
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ar' and jl.party_id = pg_temp.i('dq')),
  1000.00::numeric, 'bounce: AR is back to exactly 1,000.00');
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('rq')), 0,
  'bounce: the allocations are gone');
select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('sq')),
  1000.00::numeric, 'bounce: the invoice is open for the full 1,000.00 again');
select is((select status::text || '/' || cheque_status::text from payments where id = pg_temp.i('rq')),
  'cancelled/bounced', 'bounce: the payment is cancelled and marked bounced');

-- ============================================================
-- Part B3: supplier payment 4,500 + discount received 500 on a 5,000 bill
-- ============================================================

insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
select 'payment', today, pg_temp.i('sup'), 'neft', 4500, 500, pg_temp.i('bank'), 'draft' from _t;
insert into _ids select 'ps', id from payments where direction = 'payment' and amount = 4500 and discount = 500;
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('ps'), 'purchase_invoice', pg_temp.i('pb'), 5000);

select is((select sum(credit - debit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ap' and jl.party_id = pg_temp.i('sup')),
  5000.00::numeric, 'before the payment: we owe the supplier exactly 5,000');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('ps'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select array_agg(a.system_key || ':' || jl.debit || ':' || jl.credit order by a.system_key)
           from journal_lines jl join accounts a on a.id = jl.account_id
           join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('ps')),
  array['ap:5000.00:0.00', 'bank:0.00:4500.00', 'discount_received:0.00:500.00'],
  'payment entry is exactly: Dr AP 5,000.00, Cr bank 4,500.00, Cr discount_received 500.00');
select is((select credit from journal_lines jl join accounts a on a.id = jl.account_id
           join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('ps') and a.system_key = 'discount_received'),
  500.00::numeric, 'the discount_received line is a credit of exactly 500.00');
select is((select array[sum(debit), sum(credit)] from journal_lines jl
           join payments p on p.journal_entry_id = jl.entry_id where p.id = pg_temp.i('ps')),
  array[5000.00, 5000.00]::numeric[], 'the payment entry balances at 5,000.00');
select is((select sum(credit - debit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ap' and jl.party_id = pg_temp.i('sup')),
  0.00::numeric, 'the bill is fully settled: AP for the supplier is 0.00');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select cancel_document('payment', pg_temp.i('ps'), 'literal: cancel discounted payment');
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is((select sum(credit - debit) from journal_lines jl join accounts a on a.id = jl.account_id
           join journal_entries je on je.id = jl.entry_id
           where a.system_key = 'discount_received'
             and je.source_type = 'payment' and je.source_id = pg_temp.i('ps')),
  0.00::numeric, 'cancelling: discount_received nets to 0.00 across the payment and its reversal');
select is((select sum(credit - debit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ap' and jl.party_id = pg_temp.i('sup')),
  5000.00::numeric, 'cancelling: AP is back to exactly 5,000.00');
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('ps')), 0,
  'cancelling: the allocations are gone');

-- All three discounted documents are now reversed: nothing is left on either discount account.
select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'discount_allowed'),
  0.00::numeric, 'discount_allowed nets to 0.00 across all entries once every discounted receipt is reversed');
select is((select sum(credit - debit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'discount_received'),
  0.00::numeric, 'discount_received nets to 0.00 across all entries once the discounted payment is reversed');
select is((select count(*)::int from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key in ('discount_allowed', 'discount_received')),
  6, 'and the reversals really exist: 3 documents x (original + mirror) = 6 lines, not 0 lines');

-- ============================================================
-- Part B4: the two allocation caps raise their own, specific codes
-- ============================================================
-- Cap 1 (per payment, amount + discount): payment 900 + 100 -> at most 1,000 across all rows. The
--   target invoice K1 has 2,000 open, so cap 2 cannot be what fires.
-- Cap 2 (per invoice, open amount): payment 5,000, no discount, target invoice K2 has 1,000 open;
--   1,000.01 is far inside cap 1, so only cap 2 can fire.

select pg_temp.draft_receipt('kr', 'cp', 900, 100);
select throws_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 1000.01)', pg_temp.i('kr'), pg_temp.i('k1')),
  'P0001', 'DN_VALIDATION:allocation_exceeds_payment',
  'cap 1: 1,000.01 against 900 + 100 raises allocation_exceeds_payment (invoice has 2,000 open)');
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('kr')), 0,
  'cap 1: the rejected row was not written');
select lives_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 1000.00)', pg_temp.i('kr'), pg_temp.i('k1')),
  'cap 1: exactly amount + discount (1,000.00) is accepted');
select throws_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 0.01)', pg_temp.i('kr'), pg_temp.i('k2')),
  'P0001', 'DN_VALIDATION:allocation_exceeds_payment',
  'cap 1: one more paisa on another invoice (1,000.01 in total) raises allocation_exceeds_payment');

select pg_temp.draft_receipt('kr2', 'cp', 5000, 0);
select throws_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 1000.01)', pg_temp.i('kr2'), pg_temp.i('k2')),
  'P0001', 'DN_VALIDATION:allocation_exceeds_invoice',
  'cap 2: 1,000.01 against an invoice with 1,000.00 open raises allocation_exceeds_invoice');
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('kr2')), 0,
  'cap 2: the rejected row was not written');
select lives_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 1000.00)', pg_temp.i('kr2'), pg_temp.i('k2')),
  'cap 2: exactly the open amount (1,000.00) is accepted');

select * from finish();

rollback;
