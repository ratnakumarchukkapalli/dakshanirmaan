-- Change 27b (migration 20261004100000). Must pass:
--  party_addresses_guard (BEFORE INSERT OR UPDATE): an app session that is not an owner at aal2
--  cannot change a site's state_code and can add a site only in the party's own state (both
--  DN_VALIDATION:admin_only_field); it can still add a same-state site and edit label / lines.
--  An owner at aal2 can do both; an owner at aal1 and a deactivated user get nothing (RLS);
--  the database owner (seeds, no auth.uid()) is unaffected; the party_id lock still holds.
--  End to end: a counter user cannot get IGST onto an in-state customer's invoice by any address
--  route; once the owner adds an out-of-state site for that customer, the invoice posts IGST.
begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- ============================================================
-- Fixtures (as the database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'addr-admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'addr-staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'addr-gone@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Addr Admin', true, 'addr-admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Addr Staff', true, 'addr-staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'user', 'Addr Gone', true, 'addr-gone@example.test');
update app_users set is_active = false where user_id = '55555555-5555-5555-5555-555555555555';

-- An in-state customer (organisation state 37) with one billing site in 37; a second party for the lock test.
insert into parties (id, name, type, state_code) values
  ('a2000000-0000-0000-0000-000000000001', 'Kishore Test Contractors', 'customer', '37'),
  ('a2000000-0000-0000-0000-000000000002', 'Other Test Customer', 'customer', '37');
insert into party_addresses (id, party_id, label, address, state_code, is_default) values
  ('aa200000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Office', '{"line1":"Main Road"}', '37', true);

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c2000000-0000-0000-0000-000000000001', 'Address Test Cement', 'cement', '2523', 18, 'bag', 100);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c2000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 50, 50000, 'opening'
  from warehouses where is_default and not is_transit;

-- 10 bags @ 100 = 1,000 taxable, 18% GST.
create function pg_temp.draft(p_id uuid, p_pos text, p_ship jsonb) returns void language plpgsql as $$
begin
  insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, shipping_address)
  values (p_id, '2026-06-10', 'a2000000-0000-0000-0000-000000000001', p_pos, 'draft',
          (select id from warehouses where is_default and not is_transit), p_ship);
  insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values (p_id, 1, 'c2000000-0000-0000-0000-000000000001', 'Address Test Cement', '2523', 'bag', 10, 100, 0, 18);
end $$;

create function pg_temp.rows_touched(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

create function pg_temp.act(p_sub text, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'aal', p_aal)::text, true);
end $$;

create function pg_temp.split(p_id uuid) returns text language sql as $$
  select place_of_supply || ' ' || cgst_total || ' ' || sgst_total || ' ' || igst_total from sales_invoices where id = p_id
$$;

-- ============================================================
-- 1. The guard, per identity
-- ============================================================
set local role authenticated;

-- counter user
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select throws_ok(
  $$update party_addresses set state_code = '36' where id = 'aa200000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot change a site''s state');
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000001', 'Hyderabad site', '{"line1":"x"}', '36')$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot add a site outside the party''s state');
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000001', 'Nowhere', '{"line1":"x"}', '99')$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'not even with the centre-jurisdiction code 99');
select lives_ok(
  $$insert into party_addresses (id, party_id, label, address, state_code)
    values ('aa200000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'Poranki site', '{"line1":"NH16"}', '37')$$,
  'a counter user can still add a site in the party''s own state');
select is(
  pg_temp.rows_touched($$update party_addresses set label = 'Poranki yard', address = '{"line1":"NH16, km 4"}'
                          where id = 'aa200000-0000-0000-0000-000000000002'$$),
  1, 'and can edit a site''s label and lines');
select is(
  pg_temp.rows_touched($$update party_addresses set state_code = '37', label = 'Poranki yard 2'
                          where id = 'aa200000-0000-0000-0000-000000000002'$$),
  1, 'a PATCH that repeats the unchanged state is fine');
select throws_ok(
  $$update party_addresses set party_id = 'a2000000-0000-0000-0000-000000000002' where id = 'aa200000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:address_party_locked', 'the party lock still holds');

-- a counter user's own new party in another state may take a site in that state (the party's own state)
select lives_ok(
  $$insert into parties (id, name, type, state_code) values ('a2000000-0000-0000-0000-000000000003', 'Telangana Walk-in', 'customer', '36')$$,
  'setup: a counter user adds a customer whose state is 36');
select lives_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000003', 'Site', '{"line1":"x"}', '36')$$,
  'and a site for that customer in 36 (the party''s own state)');

-- owner below aal2 and a deactivated user: nothing at all
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal1');
select is(pg_temp.rows_touched($$update party_addresses set state_code = '36' where id = 'aa200000-0000-0000-0000-000000000001'$$),
  0, 'an owner at aal1 cannot change a site''s state');
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000001', 'x', '{"line1":"x"}', '37')$$,
  '42501', null, 'an owner at aal1 cannot add a site');
select pg_temp.act('55555555-5555-5555-5555-555555555555', 'aal1');
select is(pg_temp.rows_touched($$update party_addresses set label = 'x' where id = 'aa200000-0000-0000-0000-000000000001'$$),
  0, 'a deactivated user cannot edit a site');
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000001', 'x', '{"line1":"x"}', '37')$$,
  '42501', null, 'a deactivated user cannot add a site');

reset role;
set local request.jwt.claims to '';
select is(
  (select string_agg(distinct state_code, ',') from party_addresses where party_id = 'a2000000-0000-0000-0000-000000000001'),
  '37', 'after all of that the in-state customer still has only state-37 sites');

-- ============================================================
-- 2. End to end: no address route to IGST for the counter
-- ============================================================
select pg_temp.draft('d2000000-0000-0000-0000-000000000001', '37', '{"label":"Hyderabad site","state_code":"36"}');
select pg_temp.draft('d2000000-0000-0000-0000-000000000002', '37', null);
select pg_temp.draft('d2000000-0000-0000-0000-000000000003', '37', '{"label":"Poranki yard 2","state_code":"37"}');

set local role authenticated;
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select throws_ok(
  $$select post_sales_invoice('d2000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_VALIDATION:place_of_supply', 'a draft shipped to a 36 site the customer does not have is refused');
select lives_ok(
  $$update sales_invoices set place_of_supply = '36' where id = 'd2000000-0000-0000-0000-000000000002'$$,
  'setup: the counter forges place_of_supply 36 on another draft');
select lives_ok($$select post_sales_invoice('d2000000-0000-0000-0000-000000000002')$$, 'that draft posts');
select lives_ok($$select post_sales_invoice('d2000000-0000-0000-0000-000000000003')$$, 'a draft shipped to the counter''s own same-state site posts');
reset role;
set local request.jwt.claims to '';
select is(pg_temp.split('d2000000-0000-0000-0000-000000000002'), '37 90.00 90.00 0.00',
  'the forged 36 was ignored: CGST+SGST');
select is(pg_temp.split('d2000000-0000-0000-0000-000000000003'), '37 90.00 90.00 0.00',
  'the same-state site posts CGST+SGST');
select is(
  (select coalesce(sum(igst_total), 0) from sales_invoices where party_id = 'a2000000-0000-0000-0000-000000000001' and status = 'posted'),
  0.00::numeric, 'no posted invoice of the in-state customer carries IGST');

-- The owner adds the real Hyderabad site; then the same draft posts IGST (posted by the counter).
set local role authenticated;
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select lives_ok(
  $$insert into party_addresses (id, party_id, label, address, state_code)
    values ('aa200000-0000-0000-0000-000000000036', 'a2000000-0000-0000-0000-000000000001', 'Hyderabad site', '{"line1":"Hitec City"}', '36')$$,
  'the owner at aal2 adds an out-of-state site');
select is(pg_temp.rows_touched($$update party_addresses set state_code = '36' where id = 'aa200000-0000-0000-0000-000000000002'$$),
  1, 'and can change a site''s state');
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select lives_ok($$select post_sales_invoice('d2000000-0000-0000-0000-000000000001')$$,
  'the counter now posts the draft shipped to the owner-added Hyderabad site');
reset role;
set local request.jwt.claims to '';
select is(pg_temp.split('d2000000-0000-0000-0000-000000000001'), '36 0.00 0.00 180.00',
  'and it posts IGST with place of supply 36');

-- The database owner (seeds, migrations: no auth.uid()) is unaffected.
select lives_ok(
  $$insert into party_addresses (party_id, label, address, state_code)
    values ('a2000000-0000-0000-0000-000000000002', 'Seeded far site', '{"line1":"x"}', '29')$$,
  'a seed (no session) can add an out-of-state site');
select lives_ok(
  $$update party_addresses set state_code = '33' where party_id = 'a2000000-0000-0000-0000-000000000002' and label = 'Seeded far site'$$,
  'and change its state');

select * from finish();
rollback;
