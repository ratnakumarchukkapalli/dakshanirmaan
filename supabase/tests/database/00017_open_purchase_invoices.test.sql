-- Change 12 (payments-ui): v_open_purchase_invoices is the mirror of v_open_sales_invoices
-- (00008_read_views.test.sql covers that side) for the outgoing-payment allocation grid.
--
-- Pure schema/view test: fixtures are inserted directly as postgres with status = 'posted'
-- already set, no posting function is exercised (that machinery is covered by 00006).
begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

create temp table _party as
with p as (
  insert into parties (name, type, state_code, credit_days)
  select 'Open PI View Test Supplier', 'supplier', state_code, 30 from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _wh as select id as wh_id from warehouses where is_default limit 1;

-- A freshly posted bill with nothing allocated against it yet: fully open.
create temp table _pi as
with i as (
  insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, grand_total, warehouse_id)
  select '2026-09-01', party_id, state_code, 'posted', 10000.00, (select wh_id from _wh) from _party, organization
  returning id
)
select id as pi_id from i;

select is(
  (select open_amount from v_open_purchase_invoices where invoice_id = (select pi_id from _pi)),
  10000.00::numeric(14,2),
  'a freshly posted bill with no allocations or debit notes is open for its full amount'
);

-- A posted payment allocating part of it: open_amount drops by exactly that allocation.
create temp table _pay as
with pay as (
  insert into payments (direction, payment_date, party_id, mode, amount, account_id, status)
  select 'payment', '2026-09-05', party_id, 'neft', 4000.00, (select id from accounts where system_key = 'cash'), 'draft'
  from _party
  returning id
)
select id as pay_id from pay;

insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
select (select pay_id from _pay), 'purchase_invoice', (select pi_id from _pi), 4000.00;
-- Security pass (20261011100000): allocations are written while the payment is a draft.
update payments set status = 'posted' where id = (select pay_id from _pay);

select is(
  (select open_amount from v_open_purchase_invoices where invoice_id = (select pi_id from _pi)),
  6000.00::numeric(14,2),
  'a posted payment allocation reduces open_amount by exactly its own amount'
);

-- A posted debit note for the remainder: open_amount reaches zero and the row leaves the view.
insert into debit_notes (note_date, party_id, place_of_supply, status, against_invoice_id, grand_total)
select '2026-09-10', party_id, state_code, 'posted', (select pi_id from _pi), 6000.00
from _party, organization;

select is(
  (select count(*) from v_open_purchase_invoices where invoice_id = (select pi_id from _pi)),
  0::bigint,
  'once allocations plus debit notes equal the bill, it drops out of the open view entirely'
);

-- A draft bill (never posted) never appears, however large.
create temp table _pi_draft as
with i as (
  insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, grand_total, warehouse_id)
  select '2026-09-12', party_id, state_code, 'draft', 50000.00, (select wh_id from _wh) from _party, organization
  returning id
)
select id as pi_id from i;

select is(
  (select count(*) from v_open_purchase_invoices where invoice_id = (select pi_id from _pi_draft)),
  0::bigint,
  'a draft (never posted) bill never appears in the open view'
);

select * from finish();
rollback;
