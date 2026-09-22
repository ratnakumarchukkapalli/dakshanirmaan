-- Change 11 follow-up: the partial unique index that makes convertChallanToInvoice's
-- idempotency (api spec acceptance: "challan conversion is idempotent") race-proof at the
-- database level, not just in the app's select-then-insert check.
--
-- Pure schema/constraint test: fixtures are inserted directly as postgres, no posting function
-- or role gate is exercised here (those are covered by 00007).
begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

create temp table _party as
with p as (
  insert into parties (name, type, state_code)
  select 'Unique Draft Test Party', 'customer', state_code from organization limit 1
  returning id
)
select id as party_id from p;

create temp table _wh as select id as wh_id from warehouses where is_default limit 1;

create temp table _dc as
with c as (
  insert into delivery_challans (challan_date, party_id, warehouse_id, status)
  select '2026-09-22', party_id, (select wh_id from _wh), 'posted' from _party
  returning id
)
select id as dc_id from c;

-- The first draft invoice against this open challan is ordinary business.
select lives_ok(
  $$ insert into sales_invoices (invoice_date, party_id, place_of_supply, warehouse_id, challan_id)
     select '2026-09-22', party_id, state_code, (select wh_id from _wh), (select dc_id from _dc)
     from _party, organization $$,
  'the first draft invoice against an open challan is ordinary business'
);

-- A second draft invoice against the SAME challan is refused by the unique index.
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, warehouse_id, challan_id)
  select '2026-09-22', party_id, state_code, (select wh_id from _wh), (select dc_id from _dc)
  from _party, organization;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'sales_invoices_one_draft_per_challan',
  'a second draft invoice for the same challan is refused by the unique index'
);

-- Once that first draft leaves 'draft' (posted, or cancelled after a reversal), a fresh draft
-- against the same challan_id must still be insertable -- the index only ever restricts DRAFT
-- rows, never the document's history.
update sales_invoices set status = 'posted' where challan_id = (select dc_id from _dc);
select lives_ok(
  $$ insert into sales_invoices (invoice_date, party_id, place_of_supply, warehouse_id, challan_id)
     select '2026-09-22', party_id, state_code, (select wh_id from _wh), (select dc_id from _dc)
     from _party, organization $$,
  'a fresh draft is insertable once the earlier row for the same challan is no longer a draft'
);

-- ...but a second fresh draft while that one is still a draft is refused again.
select set_config('pgtap_test.raised_msg', '', false);
do $$ begin
  insert into sales_invoices (invoice_date, party_id, place_of_supply, warehouse_id, challan_id)
  select '2026-09-22', party_id, state_code, (select wh_id from _wh), (select dc_id from _dc)
  from _party, organization;
exception when others then perform set_config('pgtap_test.raised_msg', sqlerrm, true); end; $$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'sales_invoices_one_draft_per_challan',
  'the index keeps enforcing at most one draft per challan going forward'
);

select * from finish();
rollback;
