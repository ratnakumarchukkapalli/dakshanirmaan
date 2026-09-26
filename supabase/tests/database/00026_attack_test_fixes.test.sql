-- Must pass (2026-09 adversarial permission test, migration 20261001100000):
--  L1/F4  catalog guard, run on every future migration: no function in public is executable by
--         anon (or PUBLIC), every table in public has RLS on, every table with a created_by
--         column carries the stamping trigger
--  F2     place_of_supply is derived at post time (shipping state when it is one of the party's
--         own addresses, else the party's state); a forged draft value never steers the tax split;
--         a shipping state that is not the party's is refused; a non-existent code is refused
--  F1     allocations of a posted receipt cannot be inserted, changed or deleted by a session;
--         a draft receipt's allocations still can
--  F3     created_by is the session's own id on insert and cannot be rewritten
--  F5     the payroll-id helpers show ids to a counter user only; set_my_locale writes for a
--         member only (an admin at aal1 and a deactivated user get a no-op)
begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

-- ============================================================
-- 1. Catalog guard (L1, F4)
-- ============================================================

select is(
  (select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  '',
  'no function in public is executable by anon (a new one needs an explicit revoke from public, anon)');

select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')),
  '',
  'every table in public has row level security enabled');

select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'created_by' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_trigger t
                       where t.tgrelid = c.oid and t.tgname = 'set_created_by' and not t.tgisinternal)),
  '',
  'every table with a created_by column stamps it from the session (set_created_by trigger)');

select is(has_function_privilege('anon', 'public.gstin_checksum_ok(text)', 'EXECUTE'), false,
  'F4: gstin_checksum_ok is not executable by anon');
select is(has_function_privilege('authenticated', 'public.gstin_checksum_ok(text)', 'EXECUTE'), true,
  'F4: authenticated keeps it (CHECK constraints run as the writer)');

select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce(c.reloptions::text ilike '%security_invoker=true%', false)),
  '',
  'every view in public is security_invoker (it runs as the caller, so RLS applies)');

select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')),
  '',
  'anon holds no privilege on any table or view in public');

-- ============================================================
-- Fixtures
-- ============================================================

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'gone@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'user', 'Gone Staff', true, 'gone@example.test');
update app_users set is_active = false where user_id = '55555555-5555-5555-5555-555555555555';

-- Customer in the organisation's state (37), with a second delivery site in Telangana (36).
insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000001', 'Ramesh Builders', 'customer', state_code from organization limit 1;
insert into party_addresses (id, party_id, label, address, state_code, is_default) values
  ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Office', '{}', '37', true),
  ('aa000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Hyderabad site', '{}', '36', false);

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'Test Cement', 'cement', '2523', 18, 'bag', 100);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 50, 50000, 'opening'
  from warehouses where is_default and not is_transit;

-- Six sales drafts, 10 bags @ 100 = 1,000 taxable, 18% GST. Home state is 37.
--  d1: forged place_of_supply 36, no shipping snapshot         -> must post intra (CGST+SGST)
--  d2: forged place_of_supply 99                               -> must post intra
--  d3: shipping snapshot in 36 (a real site), place_of_supply 37 -> must post inter (IGST), pos 36
--  d4: shipping snapshot in 29 (not one of the party's states) -> refused
--  d5: shipping snapshot in 55 (not a state at all)            -> refused
--  d6: honest draft, posted for the allocation tests
create function pg_temp.draft(p_id uuid, p_pos text, p_ship jsonb) returns void language plpgsql as $$
begin
  insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, shipping_address)
  values (p_id, '2026-06-10', 'a0000000-0000-0000-0000-000000000001', p_pos, 'draft',
          (select id from warehouses where is_default and not is_transit), p_ship);
  insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values (p_id, 1, 'c0000000-0000-0000-0000-000000000001', 'Test Cement', '2523', 'bag', 10, 100, 0, 18);
end $$;

select pg_temp.draft('d0000000-0000-0000-0000-000000000001', '37', null);
select pg_temp.draft('d0000000-0000-0000-0000-000000000002', '37', null);
select pg_temp.draft('d0000000-0000-0000-0000-000000000003', '37', '{"label":"Hyderabad site","state_code":"36"}');
select pg_temp.draft('d0000000-0000-0000-0000-000000000004', '37', '{"label":"Elsewhere","state_code":"29"}');
select pg_temp.draft('d0000000-0000-0000-0000-000000000005', '37', '{"label":"Nowhere","state_code":"55"}');
select pg_temp.draft('d0000000-0000-0000-0000-000000000006', '37', null);

-- ============================================================
-- 2. F2 — place of supply is derived
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$update sales_invoices set place_of_supply = '36' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  'setup: a counter user can still PATCH the draft column (it is only a display value now)');
select throws_ok(
  $$update sales_invoices set place_of_supply = '55' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a non-existent state code is refused by the table CHECK, whoever writes it');
select lives_ok($$update sales_invoices set place_of_supply = '99' where id = 'd0000000-0000-0000-0000-000000000002'$$,
  'setup: place_of_supply 99 is a valid code, so the draft accepts it');

select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$, 'd1 (forged 36) posts');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$, 'd2 (forged 99) posts');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000003')$$, 'd3 (delivery site in 36) posts');
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000004')$$,
  'P0001', 'DN_VALIDATION:place_of_supply', 'd4: a shipping state that is not one of the party''s is refused');
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000005')$$,
  'P0001', 'DN_VALIDATION:place_of_supply', 'd5: a shipping state that does not exist is refused');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000006')$$, 'd6 posts');

reset role;
set local request.jwt.claims to '';

select is(
  (select place_of_supply || ' ' || cgst_total || ' ' || sgst_total || ' ' || igst_total
     from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001'),
  '37 90.00 90.00 0.00',
  'd1: the forged 36 was ignored: posted in the party''s state 37 with CGST+SGST');
select is(
  (select place_of_supply || ' ' || cgst_total || ' ' || sgst_total || ' ' || igst_total
     from sales_invoices where id = 'd0000000-0000-0000-0000-000000000002'),
  '37 90.00 90.00 0.00',
  'd2: the forged 99 was ignored: CGST+SGST, place of supply 37');
select is(
  (select place_of_supply || ' ' || cgst_total || ' ' || sgst_total || ' ' || igst_total
     from sales_invoices where id = 'd0000000-0000-0000-0000-000000000003'),
  '36 0.00 0.00 180.00',
  'd3: a real delivery site in another state posts IGST, and the posted document says 36 (not the draft''s 37)');
select is(
  (select sum(jl.credit) from journal_lines jl join accounts a on a.id = jl.account_id
    where a.system_key = 'output_igst'
      and jl.entry_id = (select journal_entry_id from sales_invoices where id = 'd0000000-0000-0000-0000-000000000003')),
  180.00::numeric, 'd3: the ledger carries the tax on Output IGST');
select is((select status::text from sales_invoices where id = 'd0000000-0000-0000-0000-000000000004'), 'draft',
  'd4: the refused post left the draft as it was');

-- ============================================================
-- 3. F1 — allocations of a posted receipt
-- ============================================================

-- Rows a statement touched (RLS hides rows instead of raising on UPDATE/DELETE).
create function pg_temp.rows_touched(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status) values
  ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-06-20', 'a0000000-0000-0000-0000-000000000001',
   'cash', 500, (select id from accounts where system_key = 'cash'), 'draft'),
  ('e0000000-0000-0000-0000-000000000002', 'receipt', '2026-06-21', 'a0000000-0000-0000-0000-000000000001',
   'cash', 300, (select id from accounts where system_key = 'cash'), 'draft');
insert into payment_allocations (id, payment_id, invoice_type, invoice_id, amount) values
  ('ba000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'sales_invoice',
   'd0000000-0000-0000-0000-000000000006', 400);

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'the counter user posts the receipt');

select throws_ok(
  $$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
    values ('e0000000-0000-0000-0000-000000000001', 'sales_invoice', 'd0000000-0000-0000-0000-000000000001', 100)$$,
  '42501', null, 'F1: a session cannot add an allocation to a posted receipt');
select is(
  pg_temp.rows_touched($$update payment_allocations set amount = 1 where id = 'ba000000-0000-0000-0000-000000000001'$$),
  0, 'F1: a session cannot change an allocation of a posted receipt');
select is(
  pg_temp.rows_touched($$delete from payment_allocations where id = 'ba000000-0000-0000-0000-000000000001'$$),
  0, 'F1: a session cannot delete an allocation of a posted receipt');

-- A draft receipt is still a plan the operator may edit.
select lives_ok(
  $$insert into payment_allocations (id, payment_id, invoice_type, invoice_id, amount)
    values ('ba000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', 'sales_invoice',
            'd0000000-0000-0000-0000-000000000001', 100)$$,
  'a draft receipt still takes allocations');
select is(
  pg_temp.rows_touched($$update payment_allocations set amount = 200 where id = 'ba000000-0000-0000-0000-000000000002'$$),
  1, 'and lets them be changed');
select is(
  pg_temp.rows_touched($$delete from payment_allocations where id = 'ba000000-0000-0000-0000-000000000002'$$),
  1, 'and deleted');

reset role;
set local request.jwt.claims to '';
select is((select amount from payment_allocations where id = 'ba000000-0000-0000-0000-000000000001'), 400.00::numeric,
  'the posted receipt''s allocation is exactly as posted');

-- The owner edits a draft receipt's allocations too (and it takes the same caps).
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into payment_allocations (id, payment_id, invoice_type, invoice_id, amount)
    values ('ba000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002', 'sales_invoice',
            'd0000000-0000-0000-0000-000000000001', 100)$$,
  'the owner adds an allocation to a draft receipt');
select is(pg_temp.rows_touched($$update payment_allocations set amount = 200 where id = 'ba000000-0000-0000-0000-000000000003'$$),
  1, 'changes it');
select is(pg_temp.rows_touched($$delete from payment_allocations where id = 'ba000000-0000-0000-0000-000000000003'$$),
  1, 'and deletes it');

-- cancel_document (SECURITY DEFINER) still clears the allocations of a posted receipt.
select lives_ok($$select cancel_document('payment', 'e0000000-0000-0000-0000-000000000001', 'test')$$,
  'the owner cancels the posted receipt that has an allocation');
reset role;
set local request.jwt.claims to '';
select is((select count(*)::int from payment_allocations where payment_id = 'e0000000-0000-0000-0000-000000000001'), 0,
  'cancel_document removed its allocations (it writes as the function owner, not through the new policies)');

-- ============================================================
-- 4. F3 — created_by
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, created_by)
    values ('d0000000-0000-0000-0000-0000000000f1', '2026-06-12', 'a0000000-0000-0000-0000-000000000001', '37', 'draft',
            (select id from warehouses where is_default and not is_transit), '33333333-3333-3333-3333-333333333333')$$,
  'a counter user inserts a draft naming the owner as creator');
select is((select created_by from sales_invoices where id = 'd0000000-0000-0000-0000-0000000000f1'),
  '44444444-4444-4444-4444-444444444444'::uuid, 'F3: the row says who really created it');
select lives_ok(
  $$update sales_invoices set created_by = '33333333-3333-3333-3333-333333333333'
     where id = 'd0000000-0000-0000-0000-0000000000f1'$$,
  'and tries to re-attribute it to the owner');
select is((select created_by from sales_invoices where id = 'd0000000-0000-0000-0000-0000000000f1'),
  '44444444-4444-4444-4444-444444444444'::uuid, 'F3: created_by did not change');
reset role;
set local request.jwt.claims to '';

-- ============================================================
-- 5. F5 — helpers answer members only
-- ============================================================

insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, period_month) values
  ('b0000000-0000-0000-0000-000000000001', '2026-09-05', null, 'draft', 'wages', '2026-09-01');
insert into journal_entries (id, entry_date, narration, source_type, source_id, posted_by, posted_at)
values ('b1000000-0000-0000-0000-000000000001', '2026-09-05', 'wages', 'expense_voucher',
        'b0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', now());

create function pg_temp.hidden(p_sub text, p_aal text) returns text language plpgsql as $$
declare v_out text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'aal', p_aal)::text, true);
  set local role authenticated;
  select (select count(*) from public.hidden_payroll_voucher_ids())
         || '/' || (select count(*) from public.hidden_payroll_entry_ids()) into v_out;
  reset role;
  return v_out;
end $$;

select is(pg_temp.hidden('44444444-4444-4444-4444-444444444444', 'aal1'), '1/1',
  'a counter user is shown the hidden payroll ids (the policies need them)');
select is(pg_temp.hidden('33333333-3333-3333-3333-333333333333', 'aal2'), '0/0',
  'the owner (aal2) is shown none: nothing is hidden from them');
select is(pg_temp.hidden('33333333-3333-3333-3333-333333333333', 'aal1'), '0/0',
  'F5: an admin who has not passed the authenticator step is shown none');
select is(pg_temp.hidden('55555555-5555-5555-5555-555555555555', 'aal1'), '0/0',
  'F5: a deactivated user is shown none');

-- Returns 'ok' or the error text.
create function pg_temp.set_locale_as(p_sub text, p_aal text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated', 'aal', p_aal)::text, true);
  set local role authenticated;
  perform public.set_my_locale('te');
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlerrm;
end $$;

select is(pg_temp.set_locale_as('33333333-3333-3333-3333-333333333333', 'aal1'), 'ok',
  'F5: set_my_locale from an admin at aal1 does not raise (00010: a non-member call is a no-op)');
select is((select locale from app_users where user_id = '33333333-3333-3333-3333-333333333333'), 'en',
  'F5: but it wrote nothing');
select is(pg_temp.set_locale_as('55555555-5555-5555-5555-555555555555', 'aal1'), 'ok',
  'set_my_locale from a deactivated user does not raise');
select is((select locale from app_users where user_id = '55555555-5555-5555-5555-555555555555'), 'en',
  'F5: but it wrote nothing');
select is(pg_temp.set_locale_as('44444444-4444-4444-4444-444444444444', 'aal1'), 'ok',
  'set_my_locale still works for an active counter user');
select is((select locale from app_users where user_id = '44444444-4444-4444-4444-444444444444'), 'te', 'and saves it');
select is(pg_temp.set_locale_as('33333333-3333-3333-3333-333333333333', 'aal2'), 'ok',
  'and for the owner at aal2');
select is((select locale from app_users where user_id = '33333333-3333-3333-3333-333333333333'), 'te', 'and saves it');

select * from finish();
rollback;
