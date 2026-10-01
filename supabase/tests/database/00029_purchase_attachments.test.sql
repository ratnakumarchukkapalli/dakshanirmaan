-- Change 21b (database half), migration 20261004100000. Must pass:
--  1. Purchase drafts are owner-only: a counter user, an admin at aal1, a deactivated user cannot
--     insert / update / delete draft purchase bills or lines; an admin at aal2 can.
--  2. attachments: owner-only (admin aal2) select / insert / delete, no update; uploader stamped
--     from the session; type, size and path shape checked; the file must exist in `docs` with the
--     declared size and type; the attachment of a POSTED or CANCELLED bill cannot be deleted (a draft's can);
--     a draft bill with attachments cannot be deleted.
--  3. Bucket `docs`: private, 5 MB, jpeg/png/pdf. storage.objects policies: only an owner, only
--     purchase_invoice/<existing bill id>/<uuid>.<jpg|png|pdf>; no overwrite; no upload to a cancelled
--     bill; no delete unless the bill is a draft. Counter, aal1 owner, deactivated user, anon: nothing.
begin;

create extension if not exists pgtap with schema extensions;

select plan(81);

-- ============================================================
-- Fixtures (as the database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'att-admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'att-staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'att-gone@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Att Admin', true, 'att-admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Att Staff', true, 'att-staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'user', 'Att Gone', true, 'att-gone@example.test');
update app_users set is_active = false where user_id = '55555555-5555-5555-5555-555555555555';

insert into parties (id, name, type, state_code)
select 'a1000000-0000-0000-0000-000000000001', 'Attachment Supplier', 'supplier', state_code from organization limit 1;
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c1000000-0000-0000-0000-000000000001', 'Attachment Cement', 'cement', '2523', 18, 'bag', 100);

-- b1 draft, b2 posted, b3 cancelled, b4 draft (deleted in a test), b5 posted then cancelled in a test
create function pg_temp.bill(p_id uuid, p_status doc_status) returns void language sql as $$
  insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
  select p_id, '2026-09-01', 'a1000000-0000-0000-0000-000000000001', state_code, p_status,
         (select id from warehouses where is_default and not is_transit) from organization;
$$;
select pg_temp.bill('b1000000-0000-0000-0000-000000000001', 'draft');
select pg_temp.bill('b1000000-0000-0000-0000-000000000002', 'posted');
select pg_temp.bill('b1000000-0000-0000-0000-000000000003', 'cancelled');
select pg_temp.bill('b1000000-0000-0000-0000-000000000004', 'draft');
select pg_temp.bill('b1000000-0000-0000-0000-000000000005', 'posted');
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 1,
   'c1000000-0000-0000-0000-000000000001', 'Attachment Cement', '2523', 'bag', 10, 300, 0, 18);

-- Stored files (as Storage would record them after an upload).
create function pg_temp.obj(p_name text, p_meta jsonb default '{"size":18,"mimetype":"image/png"}') returns void language sql as $$
  insert into storage.objects (bucket_id, name, metadata) values ('docs', p_name, p_meta);
$$;
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000002/f0000000-0000-0000-0000-000000000002.png');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000003/f0000000-0000-0000-0000-000000000003.png');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000004/f0000000-0000-0000-0000-000000000004.png');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000005/f0000000-0000-0000-0000-000000000005.png');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a1.png');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', '{}');
select pg_temp.obj('purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a3.pdf', '{}');
-- attachment rows already on file for the posted, cancelled and to-be-deleted bills
insert into attachments (id, entity, entity_id, storage_path, mime, bytes) values
  ('a7000000-0000-0000-0000-000000000002', 'purchase_invoice', 'b1000000-0000-0000-0000-000000000002',
   'purchase_invoice/b1000000-0000-0000-0000-000000000002/f0000000-0000-0000-0000-000000000002.png', 'image/png', 18),
  ('a7000000-0000-0000-0000-000000000004', 'purchase_invoice', 'b1000000-0000-0000-0000-000000000004',
   'purchase_invoice/b1000000-0000-0000-0000-000000000004/f0000000-0000-0000-0000-000000000004.png', 'image/png', 18),
  ('a7000000-0000-0000-0000-000000000005', 'purchase_invoice', 'b1000000-0000-0000-0000-000000000005',
   'purchase_invoice/b1000000-0000-0000-0000-000000000005/f0000000-0000-0000-0000-000000000005.png', 'image/png', 18);

-- Rows a statement touched (RLS hides rows instead of raising on UPDATE/DELETE).
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

-- Storage refuses DELETE statements unless this is set (its own guard against orphaned files);
-- the Storage API sets it. Setting it here lets the policies themselves be tested.
set local storage.allow_delete_query = 'true';

-- ============================================================
-- 1. Purchase drafts are owner-only
-- ============================================================
set local role authenticated;
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');

select throws_ok(
  $$insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
    values ('2026-09-02', 'a1000000-0000-0000-0000-000000000001', '37', 'draft',
            (select id from warehouses where is_default and not is_transit))$$,
  '42501', null, 'a counter user cannot insert a draft purchase bill');
select is(pg_temp.rows_touched($$update purchase_invoices set vehicle_no = 'X' where id = 'b1000000-0000-0000-0000-000000000001'$$),
  0, 'a counter user cannot edit a draft purchase bill');
select is(pg_temp.rows_touched($$delete from purchase_invoices where id = 'b1000000-0000-0000-0000-000000000001'$$),
  0, 'a counter user cannot delete a draft purchase bill');
select throws_ok(
  $$insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
    values ('b1000000-0000-0000-0000-000000000001', 2, 'c1000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 0, 18)$$,
  '42501', null, 'a counter user cannot add a line to a draft purchase bill');
select is(pg_temp.rows_touched($$update purchase_invoice_lines set qty = 999 where id = 'e1000000-0000-0000-0000-000000000001'$$),
  0, 'a counter user cannot change a draft bill''s line');
select is(pg_temp.rows_touched($$delete from purchase_invoice_lines where id = 'e1000000-0000-0000-0000-000000000001'$$),
  0, 'a counter user cannot delete a draft bill''s line');

select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal1');
select throws_ok(
  $$insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
    values ('2026-09-02', 'a1000000-0000-0000-0000-000000000001', '37', 'draft',
            (select id from warehouses where is_default and not is_transit))$$,
  '42501', null, 'an owner below aal2 cannot insert a draft purchase bill');
select is(pg_temp.rows_touched($$update purchase_invoices set vehicle_no = 'X' where id = 'b1000000-0000-0000-0000-000000000001'$$),
  0, 'an owner below aal2 cannot edit a draft purchase bill');

select pg_temp.act('55555555-5555-5555-5555-555555555555', 'aal1');
select throws_ok(
  $$insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
    values ('2026-09-02', 'a1000000-0000-0000-0000-000000000001', '37', 'draft',
            (select id from warehouses where is_default and not is_transit))$$,
  '42501', null, 'a deactivated user cannot insert a draft purchase bill');

select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select lives_ok(
  $$insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
    values ('b1000000-0000-0000-0000-0000000000f1', '2026-09-02', 'a1000000-0000-0000-0000-000000000001', '37', 'draft',
            (select id from warehouses where is_default and not is_transit))$$,
  'the owner at aal2 inserts a draft purchase bill');
select lives_ok(
  $$insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
    values ('b1000000-0000-0000-0000-0000000000f1', 1, 'c1000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 0, 18)$$,
  'and adds a line to it');
select is(pg_temp.rows_touched($$update purchase_invoice_lines set qty = 2 where invoice_id = 'b1000000-0000-0000-0000-0000000000f1'$$),
  1, 'and edits the line');
select is(pg_temp.rows_touched($$update purchase_invoices set vehicle_no = 'AP16' where id = 'b1000000-0000-0000-0000-0000000000f1'$$),
  1, 'and edits the bill');
select is(pg_temp.rows_touched($$delete from purchase_invoice_lines where invoice_id = 'b1000000-0000-0000-0000-0000000000f1'$$),
  1, 'and deletes the line');
select is(pg_temp.rows_touched($$delete from purchase_invoices where id = 'b1000000-0000-0000-0000-0000000000f1'$$),
  1, 'and deletes the draft');
select throws_ok(
  $$insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id)
    values ('2026-09-02', 'a1000000-0000-0000-0000-000000000001', '37', 'posted',
            (select id from warehouses where is_default and not is_transit))$$,
  '42501', null, 'even the owner cannot insert a bill already marked posted');

reset role;
set local request.jwt.claims to '';

-- ============================================================
-- 2. Catalog: bucket, policies, grants
-- ============================================================
select is(
  (select public::text || ' ' || file_size_limit || ' ' || array_to_string(array(select unnest(allowed_mime_types) order by 1), ',')
     from storage.buckets where id = 'docs'),
  'false 5242880 application/pdf,image/jpeg,image/png',
  'bucket docs is private, 5 MB, jpeg/png/pdf only');
select is(
  (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname like 'docs_%'),
  'docs_owner_delete:DELETE,docs_owner_insert:INSERT,docs_owner_select:SELECT',
  'storage.objects has select/insert/delete policies for docs and no update policy');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and not ('authenticated' = any (roles))),
  0, 'no storage.objects policy reaches anon or public');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.attachments'::regclass),
  'attachments has row level security on');
select ok(
  not has_table_privilege('authenticated', 'public.attachments', 'UPDATE')
  and not has_table_privilege('anon', 'public.attachments', 'SELECT,INSERT,UPDATE,DELETE'),
  'attachments: no UPDATE for authenticated, nothing for anon');
select is(
  (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
    where schemaname = 'public' and tablename = 'attachments'),
  'delete_owner:DELETE,insert_owner:INSERT,select_owner:SELECT',
  'attachments policies: select, insert, delete; none for update');

-- ============================================================
-- 3. storage.objects as each identity
-- ============================================================
set local role authenticated;

-- owner at aal2
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select lives_ok(
  $$insert into storage.objects (bucket_id, name, metadata) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000011.jpg', '{"size":5,"mimetype":"image/jpeg"}')$$,
  'the owner uploads a photo for a draft bill');
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000002/f0000000-0000-0000-0000-000000000012.pdf')$$,
  'the owner uploads a PDF for a posted bill');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000003/f0000000-0000-0000-0000-000000000013.png')$$,
  '42501', null, 'not for a cancelled bill');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-0000000000ff/f0000000-0000-0000-0000-000000000014.png')$$,
  '42501', null, 'not for a bill that does not exist');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'sales_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000015.png')$$,
  '42501', null, 'not outside purchase_invoice/');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/bill photo.png')$$,
  '42501', null, 'not under a client-chosen file name');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000016.html')$$,
  '42501', null, 'not with an extension outside jpg/png/pdf');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/x/../f0000000-0000-0000-0000-000000000017.png')$$,
  '42501', null, 'not with extra path segments');
select is(
  (select count(*)::int from storage.objects where bucket_id = 'docs'),
  9, 'the owner sees every file in docs');
select is(
  pg_temp.rows_touched($$update storage.objects set name = 'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000099.png'
                          where name = 'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000011.jpg'$$),
  0, 'not even the owner can overwrite or move a file (no update policy)');
select is(
  pg_temp.rows_touched($$delete from storage.objects where name = 'purchase_invoice/b1000000-0000-0000-0000-000000000002/f0000000-0000-0000-0000-000000000002.png'$$),
  0, 'the owner cannot delete a POSTED bill''s file');
select is(
  pg_temp.rows_touched($$delete from storage.objects where name = 'purchase_invoice/b1000000-0000-0000-0000-000000000003/f0000000-0000-0000-0000-000000000003.png'$$),
  0, 'the owner cannot delete a CANCELLED bill''s file either (kept history)');
select is(
  pg_temp.rows_touched($$delete from storage.objects where name = 'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000011.jpg'$$),
  1, 'the owner can delete a draft bill''s file');

-- counter user, owner at aal1, deactivated user: no read, no upload, no delete
create function pg_temp.storage_shut(p_who text) returns setof text language plpgsql as $$
begin
  return next is((select count(*)::int from storage.objects where bucket_id = 'docs'), 0, p_who || ' sees no file in docs');
  return next throws_ok(
    $q$insert into storage.objects (bucket_id, name) values ('docs',
      'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000021.png')$q$,
    '42501', null, p_who || ' cannot upload');
  return next is(
    pg_temp.rows_touched($q$delete from storage.objects where name = 'purchase_invoice/b1000000-0000-0000-0000-000000000004/f0000000-0000-0000-0000-000000000004.png'$q$),
    0, p_who || ' cannot delete a draft bill''s file');
end $$;

select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select * from pg_temp.storage_shut('a counter user');
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal2');
select * from pg_temp.storage_shut('a counter user at aal2');
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal1');
select * from pg_temp.storage_shut('an owner at aal1');
select pg_temp.act('55555555-5555-5555-5555-555555555555', 'aal1');
select * from pg_temp.storage_shut('a deactivated user');

reset role;
set local request.jwt.claims to '';
set local role anon;
select is((select count(*)::int from storage.objects where bucket_id = 'docs'), 0, 'anon sees no file in docs');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('docs',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-000000000031.png')$$,
  '42501', null, 'anon cannot upload');
reset role;

-- ============================================================
-- 4. attachments rows
-- ============================================================
-- Type / size / path: table CHECKs, whoever writes (files with no recorded metadata, so only the CHECK speaks).
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', 'image/gif', 10)$$,
  '23514', null, 'a type outside jpeg/png/pdf is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', 'image/png', 5242881)$$,
  '23514', null, 'a file over 5 MB is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', 'image/png', 0)$$,
  '23514', null, 'an empty file is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a3.pdf', 'image/png', 10)$$,
  '23514', null, 'the extension must match the type');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000004',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', 'image/png', 10)$$,
  '23514', null, 'the path must sit under the row''s own bill (another bill''s file is refused)');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('sales_invoice', 'b1000000-0000-0000-0000-000000000001',
    'sales_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a2.png', 'image/png', 10)$$,
  '23514', null, 'only purchase_invoice is an entity today');

set local role authenticated;

-- the counter user, the aal1 owner, the deactivated user: nothing
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select is((select count(*)::int from attachments), 0, 'a counter user sees no attachment');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a1.png', 'image/png', 18)$$,
  'P0001', 'DN_FORBIDDEN', 'a counter user cannot add an attachment (refused before anything about the bill or file is said)');
select is(pg_temp.rows_touched($$delete from attachments where id = 'a7000000-0000-0000-0000-000000000004'$$),
  0, 'a counter user cannot delete a draft bill''s attachment');
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal1');
select is((select count(*)::int from attachments), 0, 'an owner at aal1 sees no attachment');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a1.png', 'image/png', 18)$$,
  'P0001', 'DN_FORBIDDEN', 'an owner at aal1 cannot add an attachment');
select pg_temp.act('55555555-5555-5555-5555-555555555555', 'aal1');
select is((select count(*)::int from attachments), 0, 'a deactivated user sees no attachment');

-- the owner at aal2
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000b9.png', 'image/png', 18)$$,
  'P0001', 'DN_VALIDATION:attachment_object_missing', 'a row for a file that was never uploaded is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a1.png', 'image/png', 4000)$$,
  'P0001', 'DN_VALIDATION:attachment_object_mismatch', 'a row whose size differs from the stored file is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-0000000000ee',
    'purchase_invoice/b1000000-0000-0000-0000-0000000000ee/f0000000-0000-0000-0000-0000000000a1.png', 'image/png', 18)$$,
  'P0001', 'DN_VALIDATION:attachment_entity_missing', 'a row for a bill that does not exist is refused');
select throws_ok(
  $$insert into attachments (entity, entity_id, storage_path, mime, bytes) values ('purchase_invoice', 'b1000000-0000-0000-0000-000000000003',
    'purchase_invoice/b1000000-0000-0000-0000-000000000003/f0000000-0000-0000-0000-000000000003.png', 'image/png', 18)$$,
  'P0001', 'DN_VALIDATION:attachment_entity_cancelled', 'a row for a cancelled bill is refused');
select lives_ok(
  $$insert into attachments (id, entity, entity_id, storage_path, mime, bytes, uploaded_by) values ('a7000000-0000-0000-0000-000000000001',
    'purchase_invoice', 'b1000000-0000-0000-0000-000000000001',
    'purchase_invoice/b1000000-0000-0000-0000-000000000001/f0000000-0000-0000-0000-0000000000a1.png', 'image/png', 18,
    '44444444-4444-4444-4444-444444444444')$$,
  'the owner records an uploaded photo for a draft bill');
select is((select uploaded_by from attachments where id = 'a7000000-0000-0000-0000-000000000001'),
  '33333333-3333-3333-3333-333333333333'::uuid, 'uploaded_by is the session''s own id (a forged value is ignored)');
select is((select count(*)::int from attachments), 4, 'the owner sees every attachment');
select throws_ok(
  $$update attachments set bytes = 1 where id = 'a7000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'no one may change an attachment row');
select throws_ok(
  $$delete from attachments where id = 'a7000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:attachment_bill_posted', 'a POSTED bill''s attachment cannot be deleted (audit evidence)');
select throws_ok(
  $$delete from purchase_invoices where id = 'b1000000-0000-0000-0000-000000000004'$$,
  'P0001', 'DN_VALIDATION:bill_has_attachments', 'a draft bill with photos cannot be deleted until they are removed');
select is(pg_temp.rows_touched($$delete from attachments where id = 'a7000000-0000-0000-0000-000000000004'$$),
  1, 'the owner removes a draft bill''s attachment');
select is(pg_temp.rows_touched($$delete from purchase_invoices where id = 'b1000000-0000-0000-0000-000000000004'$$),
  1, 'and then the draft bill can be deleted');

reset role;
set local request.jwt.claims to '';
update purchase_invoices set status = 'cancelled' where id = 'b1000000-0000-0000-0000-000000000005';
set local role authenticated;
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select throws_ok($$delete from attachments where id = 'a7000000-0000-0000-0000-000000000005'$$,
  'P0001', 'DN_VALIDATION:attachment_bill_posted', 'once the bill is cancelled its attachment is still kept (history)');

-- Freight vouchers tied to a bill: owner-only link, posted bills only.
select pg_temp.act('44444444-4444-4444-4444-444444444444', 'aal1');
select throws_ok($$insert into expense_vouchers (voucher_date, status, purchase_invoice_id) values ('2026-09-02', 'draft', 'b1000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_FORBIDDEN', 'a counter user cannot tie an expense voucher to a bill');
select lives_ok($$insert into expense_vouchers (id, voucher_date, status) values ('f1000000-0000-0000-0000-000000000001', '2026-09-02', 'draft')$$,
  'a counter user can still write an ordinary expense voucher draft');
select throws_ok($$update expense_vouchers set purchase_invoice_id = 'b1000000-0000-0000-0000-000000000002' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_FORBIDDEN', 'nor link an existing draft to a bill afterwards');
select pg_temp.act('33333333-3333-3333-3333-333333333333', 'aal2');
select throws_ok($$insert into expense_vouchers (voucher_date, status, purchase_invoice_id) values ('2026-09-02', 'draft', 'b1000000-0000-0000-0000-000000000001')$$,
  'P0001', 'DN_VALIDATION:freight_bill_not_posted', 'the owner cannot attach freight to a draft bill');
select throws_ok($$insert into expense_vouchers (voucher_date, status, purchase_invoice_id) values ('2026-09-02', 'draft', 'b1000000-0000-0000-0000-000000000003')$$,
  'P0001', 'DN_VALIDATION:freight_bill_not_posted', 'nor to a cancelled bill');
select lives_ok($$insert into expense_vouchers (voucher_date, status, purchase_invoice_id) values ('2026-09-02', 'draft', 'b1000000-0000-0000-0000-000000000002')$$,
  'the owner can attach freight to a posted bill');

reset role;
set local request.jwt.claims to '';
set local role anon;
select throws_ok($$select count(*) from attachments$$, '42501', null, 'anon cannot read attachments at all');
reset role;

select * from finish();
rollback;
