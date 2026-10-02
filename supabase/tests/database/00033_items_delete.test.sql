-- Must pass (change 26, delete-unused-items): an owner may delete an item that was never used.
--  * an owner at aal2 deletes an unused item; one audit_log row ('delete') keeps the old row
--  * an item used on a document line, a stock movement or an opening line cannot be deleted
--    (23503, plain foreign keys, nothing cascades) and no audit row is left behind
--  * a counter user (aal1 or aal2), an owner at aal1 and a non-member delete nothing
--  * the deleted item's name can be used again; insert/update auditing is unchanged
--  * other masters still have no DELETE; anon and service_role privileges are unchanged
begin;

create extension if not exists pgtap with schema extensions;

select plan(31);

create function pg_temp.rows_touched(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================================================
-- Privileges (catalog)
-- ============================================================
select is(has_table_privilege('authenticated', 'public.items', 'DELETE'), true,
  'authenticated holds DELETE on items (RLS decides who)');
select is(has_table_privilege('service_role', 'public.items', 'SELECT,INSERT,UPDATE,DELETE'), true,
  'service_role privileges on items are unchanged');
select is(has_table_privilege('anon', 'public.items', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false,
  'anon holds nothing on items');
select is(has_table_privilege('authenticated', 'public.items', 'TRUNCATE'), false,
  'authenticated cannot TRUNCATE items');
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c
    where c.oid in ('public.parties'::regclass, 'public.party_addresses'::regclass, 'public.organization'::regclass,
                    'public.accounts'::regclass, 'public.warehouses'::regclass)
      and has_table_privilege('authenticated', c.oid, 'DELETE')),
  null, 'parties, addresses, organisation, accounts and warehouses have no DELETE privilege');
select is(
  (select string_agg(polrelid::regclass::text, ', ' order by polrelid::regclass::text) from pg_policy
    where polcmd in ('d', '*')
      and polrelid in ('public.parties'::regclass, 'public.party_addresses'::regclass, 'public.organization'::regclass,
                       'public.accounts'::regclass, 'public.warehouses'::regclass)),
  null, 'no DELETE policy on parties, addresses, organisation, accounts or warehouses');
select is(
  (select count(*)::int from pg_constraint
    where confrelid = 'public.items'::regclass and contype = 'f' and confdeltype <> 'a'),
  0, 'every foreign key to items is NO ACTION (nothing cascades or nulls out)');

-- ============================================================
-- Fixtures (database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000026', 'Delete Test Customer', 'customer', state_code from organization limit 1;

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000261', 'Unused Cement 50kg', 'cement', '2523', 28, 'bag', 400),
  ('c0000000-0000-0000-0000-000000000262', 'Invoiced Cement', 'cement', '2523', 28, 'bag', 400),
  ('c0000000-0000-0000-0000-000000000263', 'Moved TMT 12mm', 'steel', '7214', 18, 'kg', 60),
  ('c0000000-0000-0000-0000-000000000264', 'Opening TMT 16mm', 'steel', '7214', 18, 'kg', 60);

-- 262: on a (draft) sales invoice line only
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000261', '2026-09-05', 'a0000000-0000-0000-0000-000000000026', o.state_code, 'draft',
       (select id from warehouses where is_default and not is_transit)
  from organization o limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000261', 1, 'c0000000-0000-0000-0000-000000000262', 'Invoiced Cement', '2523', 'bag', 10, 400, 0, 28);

-- 263: on a stock movement only
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000263', id, '2026-04-05', 100, 50, 5000, 'opening'
  from warehouses where is_default and not is_transit;

-- 264: on a (draft) opening line only
insert into opening_batches (id) values ('0b000000-0000-0000-0000-000000000026');
insert into opening_lines (batch_id, kind, item_id, warehouse_id, qty, rate)
select '0b000000-0000-0000-0000-000000000026', 'stock', 'c0000000-0000-0000-0000-000000000264', id, 10, 55
  from warehouses where is_default and not is_transit;

create temp table audit_before on commit drop as select id from audit_log;
grant select on audit_before to authenticated;

-- ============================================================
-- Nobody but an owner at aal2 deletes
-- ============================================================
set local role authenticated;

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is(pg_temp.rows_touched($$delete from items where id = 'c0000000-0000-0000-0000-000000000261'$$), 0,
  'a counter user at aal1 deletes nothing');
select is(pg_temp.rows_touched($$delete from items$$), 0, 'a counter user at aal1 cannot delete any item');

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';
select is(pg_temp.rows_touched($$delete from items$$), 0, 'a counter user at aal2 cannot delete any item');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select is(pg_temp.rows_touched($$delete from items where id = 'c0000000-0000-0000-0000-000000000261'$$), 0,
  'an owner at aal1 deletes nothing (change 19)');

set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal2"}';
select is(pg_temp.rows_touched($$delete from items$$), 0, 'a non-member deletes nothing');

reset role;
select is((select count(*)::int from items where id::text like 'c0000000-0000-0000-0000-00000000026%'), 4,
  'all four items are still there');
select is((select count(*)::int from audit_log where id not in (select id from audit_before)), 0,
  'refused deletes leave no audit row');

-- ============================================================
-- Owner at aal2: used items are refused by the foreign keys
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select throws_ok($$delete from items where id = 'c0000000-0000-0000-0000-000000000262'$$, '23503', null,
  'an item on an invoice line cannot be deleted (foreign key)');
select throws_ok($$delete from items where id = 'c0000000-0000-0000-0000-000000000263'$$, '23503', null,
  'an item with a stock movement cannot be deleted (foreign key)');
select throws_ok($$delete from items where id = 'c0000000-0000-0000-0000-000000000264'$$, '23503', null,
  'an item on an opening line cannot be deleted (foreign key)');
select throws_ok($$delete from items$$, '23503', null,
  'a blanket delete fails as a whole while any used item is in it');

reset role;
select is((select count(*)::int from items where id::text like 'c0000000-0000-0000-0000-00000000026%'), 4,
  'the refused deletes removed nothing (the blanket delete rolled back the unused item too)');
select is((select count(*)::int from sales_invoice_lines where item_id = 'c0000000-0000-0000-0000-000000000262'), 1,
  'the invoice line is untouched');
select is((select count(*)::int from stock_movements where item_id = 'c0000000-0000-0000-0000-000000000263'), 1,
  'the stock movement is untouched');
select is((select count(*)::int from opening_lines where item_id = 'c0000000-0000-0000-0000-000000000264'), 1,
  'the opening line is untouched');
select is((select count(*)::int from audit_log where id not in (select id from audit_before)), 0,
  'a refused delete leaves no audit row (rolled back with the statement)');

-- ============================================================
-- Owner at aal2: an unused item is deleted and audited
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select is(pg_temp.rows_touched($$delete from items where id = 'c0000000-0000-0000-0000-000000000261'$$), 1,
  'an owner at aal2 deletes the unused item');

reset role;
select is((select count(*)::int from items where id = 'c0000000-0000-0000-0000-000000000261'), 0, 'the item is gone');
select results_eq(
  $$select actor, action, entity, entity_id, after is null, before ->> 'name', before ->> 'hsn_code',
           (before ->> 'sale_rate')::numeric, before ? 'created_at'
      from audit_log where id not in (select id from audit_before)$$,
  $$values ('33333333-3333-3333-3333-333333333333'::uuid, 'delete'::text, 'items'::text,
            'c0000000-0000-0000-0000-000000000261'::uuid, true, 'Unused Cement 50kg'::text, '2523'::text,
            400::numeric, false)$$,
  'exactly one audit row: delete by the owner, with the old row in before');

-- ============================================================
-- The name is free again; insert/update auditing unchanged
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select lives_ok(
  $$insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate)
    values ('c0000000-0000-0000-0000-000000000265', 'Unused Cement 50kg', 'cement', '2523', 28, 'bag', 410)$$,
  'the deleted item''s name can be used for a new item');
select lives_ok($$update items set sale_rate = 420 where id = 'c0000000-0000-0000-0000-000000000265'$$,
  'the new item can be edited');
select results_eq(
  $$select action, before, after from audit_log
     where entity = 'items' and entity_id = 'c0000000-0000-0000-0000-000000000265' and action = 'update'$$,
  $$values ('update'::text, '{"sale_rate": 410.0000}'::jsonb,
            '{"sale_rate": 420.0000}'::jsonb)$$,
  'update auditing still records only the changed column, before and after');
select is(
  (select after ->> 'name' from audit_log
    where entity = 'items' and entity_id = 'c0000000-0000-0000-0000-000000000265' and action = 'insert'),
  'Unused Cement 50kg', 'insert auditing still records the new row');

reset role;
select is((select count(*)::int from audit_log where entity = 'items' and action = 'delete' and created_at >= now()), 1,
  'only one delete was ever audited');

select * from finish();
rollback;
