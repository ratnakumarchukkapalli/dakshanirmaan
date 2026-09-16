-- Must pass (change 01, foundation-schema): review-fix checks.
-- 1. doc_sequences is keyed by series (not source_type) and all 7 series are seeded for FY 2026-27.
-- 2. organization is a true singleton (a second row is rejected).
-- 3. Document header tables' updated_at is maintained by trigger on UPDATE (draft concurrency).
-- 4. Both roles may DELETE their own draft documents (RLS delete_draft policy).
begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

-- 1. doc_sequences: exactly 7 rows for FY 2026-27, one per series.
select is(
  (select count(*)::int from doc_sequences where fy_label = '2026-27'),
  7,
  'doc_sequences has exactly 7 rows for FY 2026-27'
);

select set_eq(
  $$ select series from doc_sequences where fy_label = '2026-27' $$,
  ARRAY['DN', 'PB', 'CN', 'DB', 'RCPT', 'PAY', 'EXP'],
  'doc_sequences series for FY 2026-27 are exactly the seven seeded series'
);

-- 2. organization singleton: a second row must be rejected.
select throws_ok(
  $$ insert into organization (legal_name, state_code) values ('Second Org', '27') $$,
  '23505',
  'duplicate key value violates unique constraint "organization_singleton_key"',
  'organization stays a singleton: inserting a second row raises'
);

-- 3. updated_at bumps on draft update. Setup as postgres (bypasses RLS).
insert into parties (name, type, state_code) values ('Review Fix Test Party', 'customer', '37');

create temp table _inv as
with ins as (
  insert into sales_invoices (invoice_date, party_id, place_of_supply, warehouse_id)
  select current_date, p.id, '37', (select id from warehouses where is_default limit 1)
  from parties p where p.name = 'Review Fix Test Party'
  returning id, updated_at
)
select * from ins;

grant select on _inv to authenticated;

select pg_sleep(0.01);

update sales_invoices set invoice_date = invoice_date + 1
where id = (select id from _inv);

select ok(
  (select updated_at from sales_invoices where id = (select id from _inv))
    > (select updated_at from _inv),
  'updated_at is bumped by trigger after a draft header update'
);

-- 4. DELETE of a draft, as an active member (reuse the JWT-claims pattern from 00001). Last step.
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'reviewfix-member@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('33333333-3333-3333-3333-333333333333', 'user', 'Review Fix Member', true);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

delete from sales_invoices where id = (select id from _inv);

select is(
  (select count(*)::int from sales_invoices where id = (select id from _inv)),
  0,
  'active member can delete a draft sales_invoices row'
);

reset role;

select * from finish();

rollback;
