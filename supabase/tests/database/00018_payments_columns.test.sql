-- Change 12 review fix: `payments.note` was selected by the app but never created. This file pins
-- every column the payments pages and actions read or write, so the next drift between the app's
-- queries and the schema fails here (against the real database) instead of only at runtime.
begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

-- payments: everything src/app/(app)/payments/**, src/lib/payments-data.ts and src/app/actions/payments.ts touch.
select has_column('public', 'payments', c, 'payments.' || c || ' exists')
from unnest(array[
  'id', 'status', 'updated_at', 'created_at', 'created_by', 'voucher_no', 'direction', 'payment_date',
  'party_id', 'mode', 'instrument_no', 'instrument_date', 'cheque_bank', 'cheque_status', 'amount',
  'discount', 'account_id', 'note'
]) as c;

-- payment_allocations: what the form, the list and the tiles read and write.
select has_column('public', 'payment_allocations', c, 'payment_allocations.' || c || ' exists')
from unnest(array['payment_id', 'invoice_type', 'invoice_id', 'amount']) as c;

-- The views the allocation grid and the balance card load.
select has_column('public', 'v_open_sales_invoices', c, 'v_open_sales_invoices.' || c || ' exists')
from unnest(array['invoice_id', 'party_id', 'invoice_no', 'invoice_date', 'age_days', 'open_amount']) as c;
select has_column('public', 'v_open_purchase_invoices', c, 'v_open_purchase_invoices.' || c || ' exists')
from unnest(array['invoice_id', 'party_id', 'invoice_no', 'invoice_date', 'age_days', 'open_amount']) as c;
select has_column('public', 'v_party_balances', c, 'v_party_balances.' || c || ' exists')
from unnest(array['party_id', 'ar_balance', 'ap_balance']) as c;

select is(
  (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'note'),
  'YES',
  'payments.note is nullable (a note is optional)'
);

-- A draft with a note round-trips.
create temp table _party as
with p as (
  insert into parties (name, type, state_code, credit_days)
  select 'Payments Note Test Customer', 'customer', state_code, 30 from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _pay as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status, note)
  select 'receipt', '2026-09-05', party_id, 'cash', 1000.00, (select id from accounts where system_key = 'cash'), 'draft', 'advance for September cement'
  from _party
  returning id
)
select id as pay_id from pay;

select is(
  (select note from payments where id = (select pay_id from _pay)),
  'advance for September cement',
  'a draft receipt with a note stores and returns it unchanged'
);

update payments set note = null where id = (select pay_id from _pay);
select is(
  (select note from payments where id = (select pay_id from _pay)),
  null,
  'the note can be cleared back to null'
);

select * from finish();
rollback;
