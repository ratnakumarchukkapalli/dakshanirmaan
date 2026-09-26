-- Must pass (change 06 follow-up, migration 20260919130000_allocation_discount.sql):
-- a payment's allocations may total amount + discount, in both directions.
--
-- post_payment credits AR (debits AP) by amount + discount. Change 04 capped allocations at
-- `amount`, so an invoice settled by cash + discount stayed open by the discount forever. Owner
-- decision: the discount is allocatable value like cash. The per-invoice open-amount cap, the N1
-- unique constraint and every other allocation rule are unchanged, and are re-asserted here.
--
-- Same harness as 00005-00008: drafts as postgres, posting through the real functions in real
-- `authenticated` sessions.
begin;

create extension if not exists pgtap with schema extensions;

select plan(43);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true);
insert into auth.users (id, email) values
  ('44444444-4444-4444-4444-444444444444', 'staff@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true);

create temp table _ids (name text primary key, id uuid not null);
grant select on _ids to authenticated;
create function pg_temp.i(p_name text) returns uuid language sql stable as
  $$ select id from _ids where name = $1 $$;

with a as (insert into parties (name, type, state_code)
             select 'Discount Customer A', 'customer', state_code from organization limit 1 returning id),
     b as (insert into parties (name, type, state_code)
             select 'Discount Customer B', 'customer', state_code from organization limit 1 returning id),
     s as (insert into parties (name, type, state_code)
             select 'Discount Supplier', 'supplier', state_code from organization limit 1 returning id),
     cc as (insert into parties (name, type, state_code)
             select 'Discount Customer Cancel', 'customer', state_code from organization limit 1 returning id),
     cq as (insert into parties (name, type, state_code)
             select 'Discount Customer Cheque', 'customer', state_code from organization limit 1 returning id),
     it as (insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
              values ('Zero-rated Item', 'other', '0000', 0, 'pcs', 100) returning id)
insert into _ids
select 'ca', id from a union all select 'cb', id from b union all select 'sup', id from s
union all select 'cc', id from cc union all select 'cq', id from cq
union all select 'item', id from it
union all select 'head', id from warehouses where is_default
union all select 'bank', id from accounts where system_key = 'bank'
union all select 'cash', id from accounts where system_key = 'cash';

-- Purchase: 100 pcs @ 50 = 5,000 (gst 0, so grand total is exactly 5,000).
with h as (
  insert into purchase_invoices
    (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
  select '2026-06-01', pg_temp.i('sup'), state_code, 'draft', pg_temp.i('head'), 'DISC/1'
  from organization limit 1 returning id)
insert into _ids select 'pb', id from h;
insert into purchase_invoice_lines
  (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values (pg_temp.i('pb'), 1, pg_temp.i('item'), 'Zero-rated Item', '0000', 'pcs', 100, 50, 0, 0);

-- Sales, 10 pcs @ 100 = 1,000 each: SA1 (settled below), SA2 (left open), SB1 (part-settled).
create function pg_temp.draft_sale(p_key text, p_party text)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
  select '2026-06-10', pg_temp.i(p_party), state_code, 'draft', pg_temp.i('head')
  from organization limit 1 returning id into v_id;
  insert into _ids values (p_key, v_id);
  insert into sales_invoice_lines
    (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values (v_id, 1, pg_temp.i('item'), 'Zero-rated Item', '0000', 'pcs', 10, 100, 0, 0);
end $$;
select pg_temp.draft_sale('sa1', 'ca');
select pg_temp.draft_sale('sa2', 'ca');
select pg_temp.draft_sale('sb1', 'cb');
select pg_temp.draft_sale('sc1', 'cc');
select pg_temp.draft_sale('sq1', 'cq');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$
begin
  perform post_purchase_invoice(pg_temp.i('pb'));
  perform post_sales_invoice(pg_temp.i('sa1'));
  perform post_sales_invoice(pg_temp.i('sa2'));
  perform post_sales_invoice(pg_temp.i('sb1'));
  perform post_sales_invoice(pg_temp.i('sc1'));
  perform post_sales_invoice(pg_temp.i('sq1'));
end $$;
reset role;
set local request.jwt.claims to '';

select is((select grand_total from sales_invoices where id = pg_temp.i('sa1')), 1000.00::numeric,
  'sanity: the invoice is exactly Rs 1,000');

-- ============================================================
-- Receipt 900 + discount 100 settles a 1,000 invoice in full
-- ============================================================

create function pg_temp.draft_receipt(p_key text, p_party text, p_amount numeric, p_discount numeric)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
  values ('receipt', '2026-06-20', pg_temp.i(p_party), 'cash', p_amount, p_discount,
          pg_temp.i('cash'), 'draft') returning id into v_id;
  insert into _ids values (p_key, v_id);
end $$;

select pg_temp.draft_receipt('r1', 'ca', 900, 100);
select lives_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''sales_invoice'', %L, 1000)', pg_temp.i('r1'), pg_temp.i('sa1')),
  'a receipt of 900 + 100 discount may allocate 1,000 (amount + discount) to one invoice');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', pg_temp.i('r1')),
  'and it posts (a discount is admin-only, so this is an admin session)');
reset role;
set local request.jwt.claims to '';

select is((select status from payments where id = pg_temp.i('r1')), 'posted', 'the receipt is posted');
select is((select debit from journal_lines jl join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('r1') and jl.account_id = pg_temp.i('cash')),
  900.00::numeric, 'cash is debited with the 900 actually received');
select is((select credit from journal_lines jl join payments p on p.journal_entry_id = jl.entry_id
           where p.id = pg_temp.i('r1') and jl.party_id = pg_temp.i('ca')),
  1000.00::numeric, 'AR is credited with 900 + 100, exactly what the allocation settles');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('sa1')), 0,
  'the invoice is closed: it is no longer an open invoice');
select is((select open_total from v_party_aging where party_id = pg_temp.i('ca')), 1000.00::numeric,
  'ageing: only the other invoice (SA2) is still open');
select is((select unapplied_discount from v_party_aging where party_id = pg_temp.i('ca')), 0.00::numeric,
  'ageing: unapplied_discount = 0, the discount was allocated');
select is((select unallocated from v_party_aging where party_id = pg_temp.i('ca')), 0.00::numeric,
  'ageing: unallocated = 0');
select is((select other_ar from v_party_aging where party_id = pg_temp.i('ca')), 0.00::numeric,
  'ageing still reconciles to AR exactly (nothing unexplained)');
select is((select ar_balance from v_party_aging where party_id = pg_temp.i('ca')), 1000.00::numeric,
  'ageing: AR = the one open invoice');
set local request.jwt.claims to '';

-- ============================================================
-- Over-allocation still raises, at amount + discount
-- ============================================================

select pg_temp.draft_receipt('r2', 'ca', 900, 100);
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values (pg_temp.i('r2'), 'sales_invoice', pg_temp.i('sa2'), 1000.01);
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(current_setting('pgtap_test.raised_msg', true), 'allocation_exceeds_payment',
  'allocating more than amount + discount (1,000.01 against 900 + 100) still raises');

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values (pg_temp.i('r2'), 'sales_invoice', pg_temp.i('sa2'), 1000.00);
  perform set_config('pgtap_test.raised_msg', 'ok', true);
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select is(current_setting('pgtap_test.raised_msg', true), 'ok',
  'the exact boundary (amount + discount) is accepted');

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values (pg_temp.i('r2'), 'sales_invoice', pg_temp.i('sa1'), 1);
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(current_setting('pgtap_test.raised_msg', true), 'allocation_exceeds_payment',
  'and the per-payment total counts every row: nothing more fits once the payment is fully allocated');

-- The per-invoice open-amount cap is untouched: 1,000 against an invoice that has only 1,000 open
-- passes, but one that is already closed does not accept it.
select pg_temp.draft_receipt('r3', 'ca', 900, 100);
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values (pg_temp.i('r3'), 'sales_invoice', pg_temp.i('sa1'), 500);
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(current_setting('pgtap_test.raised_msg', true), 'allocation_exceeds_invoice',
  'the per-invoice open-amount cap is unchanged: a closed invoice accepts nothing more');

-- post_payment re-validates the total: shrink the discount after allocating, and posting fails.
select pg_temp.draft_receipt('r4', 'ca', 900, 100);
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('r4'), 'sales_invoice', pg_temp.i('sa2'), 1000);
update payments set discount = 0 where id = pg_temp.i('r4');
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_payment(pg_temp.i('r4'));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'allocation_exceeds_payment',
  'post_payment re-checks the total against amount + discount as it stands at posting time');
select is((select status from payments where id = pg_temp.i('r4')), 'draft',
  'and the failed post leaves the draft untouched');

-- ============================================================
-- Allocating only the cash leaves the discount as unapplied_discount
-- ============================================================

select pg_temp.draft_receipt('r5', 'cb', 900, 100);
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('r5'), 'sales_invoice', pg_temp.i('sb1'), 900);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('r5'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select array[open_total, unallocated, unapplied_discount, ar_balance, other_ar]
           from v_party_aging where party_id = pg_temp.i('cb')),
  array[100.00, 0.00, 100.00, 0.00, 0.00]::numeric[],
  'ageing: 900 allocated of 900 + 100 leaves the invoice open by 100 and unapplied_discount = 100');
set local request.jwt.claims to '';

-- ============================================================
-- Outgoing payment with a discount received, same rule
-- ============================================================

create temp table _pay as
with p as (
  insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
  values ('payment', '2026-06-25', pg_temp.i('sup'), 'neft', 4500, 500, pg_temp.i('bank'), 'draft')
  returning id)
select id as payment_id from p;
grant select on _pay to authenticated;

select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values ((select payment_id from _pay), 'purchase_invoice', pg_temp.i('pb'), 5000.01);
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(current_setting('pgtap_test.raised_msg', true), 'allocation_exceeds',
  'payments: allocating past the invoice or past amount + discount raises');

select lives_ok(
  format('insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
          values (%L, ''purchase_invoice'', %L, 5000)', (select payment_id from _pay), pg_temp.i('pb')),
  'payments: 4,500 + 500 discount received may allocate the full 5,000 bill');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', (select payment_id from _pay)),
  'payments: the outgoing payment posts');
reset role;
set local request.jwt.claims to '';

select is((select sum(debit - credit) from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'ap' and jl.party_id = pg_temp.i('sup')),
  0.00::numeric, 'payments: AP for the supplier is fully cleared by 4,500 cash + 500 discount');

-- ============================================================
-- Reversing a receipt that was settled with a discount re-opens the invoice fully
-- ============================================================

-- (a) cancel_document: 900 + 100 discount fully allocated to SC1, then cancelled.
select pg_temp.draft_receipt('rc', 'cc', 900, 100);
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('rc'), 'sales_invoice', pg_temp.i('sc1'), 1000);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('rc'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('sc1')), 0,
  'discounted receipt: the invoice is closed while the receipt stands');
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select cancel_document('payment', pg_temp.i('rc'), 'discount receipt cancelled');
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('rc')), 0,
  'cancelling a discounted receipt: its allocations are gone');
select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('sc1')), 1000.00::numeric,
  'cancelling a discounted receipt: the invoice is open for the full Rs 1,000 again');
select is((select array[open_total, unallocated, unapplied_discount, ar_balance, other_ar]
           from v_party_aging where party_id = pg_temp.i('cc')),
  array[1000.00, 0.00, 0.00, 1000.00, 0.00]::numeric[],
  'cancelling a discounted receipt: ageing shows the full 1,000 open, nothing unallocated, other_ar 0');
set local request.jwt.claims to '';

-- (b) bounce_cheque: cheque receipt 900 + 100 discount fully allocated to SQ1, then bounced.
insert into payments
  (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, discount, account_id, status)
values ('receipt', '2026-06-21', pg_temp.i('cq'), 'cheque', 'CHQ-D1', '2026-06-21', 900, 100,
        pg_temp.i('bank'), 'draft');
insert into _ids select 'rq', id from payments where instrument_no = 'CHQ-D1';
insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
values (pg_temp.i('rq'), 'sales_invoice', pg_temp.i('sq1'), 1000);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select post_payment(pg_temp.i('rq'));
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from v_open_sales_invoices where invoice_id = pg_temp.i('sq1')), 0,
  'discounted cheque: the invoice is closed while the cheque stands');
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select bounce_cheque(pg_temp.i('rq'), 'bounced');
reset role;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from payment_allocations where payment_id = pg_temp.i('rq')), 0,
  'bouncing a discounted cheque: its allocations are gone');
select is((select open_amount from v_open_sales_invoices where invoice_id = pg_temp.i('sq1')), 1000.00::numeric,
  'bouncing a discounted cheque: the invoice is open for the full Rs 1,000 again');
select is((select array[open_total, unallocated, unapplied_discount, ar_balance, other_ar]
           from v_party_aging where party_id = pg_temp.i('cq')),
  array[1000.00, 0.00, 0.00, 1000.00, 0.00]::numeric[],
  'bouncing a discounted cheque: ageing shows the full 1,000 open, nothing unallocated, other_ar 0');
set local request.jwt.claims to '';

-- ============================================================
-- A discount is admin-only to POST (owner decision 2026-09-19); a user may still save the draft
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
select lives_ok(
  format('insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
          values (''receipt'', ''2026-06-30'', %L, ''cash'', 901, 100, %L, ''draft'')',
         pg_temp.i('ca'), pg_temp.i('cash')),
  'a user can SAVE a draft receipt that carries a discount');
select lives_ok(
  format('insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
          values (''receipt'', ''2026-06-30'', %L, ''cash'', 902, 0, %L, ''draft'')',
         pg_temp.i('ca'), pg_temp.i('cash')),
  'and one without');
reset role;
set local request.jwt.claims to '';
insert into _ids select 'ru_disc', id from payments where amount = 901 and status = 'draft';
insert into _ids select 'ru_plain', id from payments where amount = 902 and status = 'draft';

select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_payment(pg_temp.i('ru_disc'));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_FORBIDDEN',
  'a user posting a receipt with discount 100 gets DN_FORBIDDEN');
select is((select status::text || '/' || coalesce(voucher_no, '-') || '/' || coalesce(journal_entry_id::text, '-')
           from payments where id = pg_temp.i('ru_disc')),
  'draft/-/-', 'and nothing was written: still a draft, no number, no journal entry');
select is((select count(*)::int from journal_entries
           where source_type = 'payment' and source_id = pg_temp.i('ru_disc')),
  0, 'no journal entry exists for it');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', pg_temp.i('ru_disc')),
  'an admin posts that very receipt fine');
reset role;
set local request.jwt.claims to '';

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', pg_temp.i('ru_plain')),
  'a user still posts a receipt with discount 0');
reset role;
set local request.jwt.claims to '';

-- Outgoing payment with a discount received: blocked for a user, allowed for an admin.
insert into payments (direction, payment_date, party_id, mode, amount, discount, account_id, status)
values ('payment', '2026-06-30', pg_temp.i('sup'), 'neft', 1000, 100, pg_temp.i('bank'), 'draft');
insert into _ids select 'pu_disc', id from payments where direction = 'payment' and amount = 1000 and status = 'draft';
select set_config('pgtap_test.raised_msg', '', false);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
do $$ begin
  perform post_payment(pg_temp.i('pu_disc'));
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
reset role;
set local request.jwt.claims to '';
select matches(current_setting('pgtap_test.raised_msg', true), 'DN_FORBIDDEN',
  'a user posting a payment with a discount received gets DN_FORBIDDEN');
select is((select status::text from payments where id = pg_temp.i('pu_disc')), 'draft',
  'and the payment is still a draft');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format('select post_payment(%L)', pg_temp.i('pu_disc')),
  'an admin posts the payment with a discount received');
reset role;
set local request.jwt.claims to '';

-- ============================================================
-- Nothing else moved: privileges on the replaced functions
-- ============================================================

select ok(has_function_privilege('authenticated', 'public.post_payment(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.post_payment(uuid)', 'execute'),
  'post_payment is still executable by authenticated and not by anon');
select ok(not has_function_privilege('authenticated', 'public.check_payment_allocation()', 'execute')
      and not has_function_privilege('anon', 'public.check_payment_allocation()', 'execute'),
  'the allocation cap trigger function is still not callable by any client role');

select * from finish();

rollback;
