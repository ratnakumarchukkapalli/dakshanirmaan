-- Change 25 (exports-portability): log_export() writes the audit row for every export.
--
-- Must pass: not callable by anon / service_role / public; a counter, an owner at aal1 and a
-- signed-out caller are refused and write nothing; an owner at aal2 writes exactly one audit row
-- (action 'export', entity = kind, after = {fy}, actor = the owner) for each of the three kinds; an
-- unknown kind, a null kind, a null or absurd year are refused and write nothing; the owner can
-- read the row back on the audit trail, the counter cannot; a counter still reads the audit rows
-- that are not export rows (guard for the audit_log policy rewrite); a deactivated owner at aal2
-- is refused.
begin;

create extension if not exists pgtap with schema extensions;

select plan(26);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
create function _signed_out() returns void language sql as $$
  select set_config('request.jwt.claims', '', true) $$;
-- audit rows for exports, read as the table owner so the count never depends on who is asking
create function _exports() returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from audit_log where action = 'export' $$;
grant execute on function _as_owner(), _as_owner_aal1(), _as_counter(), _signed_out(), _exports() to authenticated, anon;

-- ============================================================
-- Grants
-- ============================================================
select ok(not has_function_privilege('anon', 'public.log_export(text, int)', 'EXECUTE'), 'anon cannot execute log_export');
select ok(not has_function_privilege('service_role', 'public.log_export(text, int)', 'EXECUTE'), 'service_role cannot execute log_export');
select ok(has_function_privilege('authenticated', 'public.log_export(text, int)', 'EXECUTE'), 'authenticated can execute log_export');
select ok((select prosecdef from pg_proc where oid = 'public.log_export(text, int)'::regprocedure), 'log_export is SECURITY DEFINER');
select ok((select proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.log_export(text, int)'::regprocedure), 'search_path is pinned');

-- ============================================================
-- Who may call it
-- ============================================================
set local role authenticated;
select _as_counter();
select throws_ok($$select log_export('books', 2026)$$, 'P0001', 'DN_FORBIDDEN', 'counter: refused');
select _as_owner_aal1();
select throws_ok($$select log_export('books', 2026)$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: refused');
select _signed_out();
select throws_ok($$select log_export('books', 2026)$$, 'P0001', 'DN_FORBIDDEN', 'signed out (no uid): refused');
select is(_exports(), 0, 'refused calls wrote nothing');

-- ============================================================
-- Owner at aal2
-- ============================================================
select _as_owner();
select lives_ok($$select log_export('books', 2026)$$, 'owner aal2: books export logged');
select is(_exports(), 1, 'exactly one audit row');
select is(
  (select jsonb_build_object('action', action, 'entity', entity, 'after', after, 'actor', actor)
     from audit_log where action = 'export'),
  jsonb_build_object('action', 'export', 'entity', 'books', 'after', jsonb_build_object('fy', 2026),
                     'actor', '33333333-3333-3333-3333-333333333333'),
  'row carries action, kind, FY and the actor');

select lives_ok($$select log_export('tally', 2025)$$, 'tally kind accepted');
select lives_ok($$select log_export('archive', 2026)$$, 'archive kind accepted');
select is(_exports(), 3, 'one row per call');

-- ============================================================
-- Bad input writes nothing
-- ============================================================
select throws_ok($$select log_export('payroll', 2026)$$, 'P0001', 'DN_VALIDATION:invalid_export_kind', 'unknown kind refused');
select throws_ok($$select log_export(null, 2026)$$, 'P0001', 'DN_VALIDATION:invalid_export_kind', 'null kind refused');
select throws_ok($$select log_export('books', null)$$, 'P0001', 'DN_VALIDATION:invalid_financial_year', 'null year refused');
select throws_ok($$select log_export('books', 1999)$$, 'P0001', 'DN_VALIDATION:invalid_financial_year', 'year before 2000 refused');
select throws_ok($$select log_export('books', 2999)$$, 'P0001', 'DN_VALIDATION:invalid_financial_year', 'year far in the future refused');
select is(_exports(), 3, 'refused input wrote nothing');

-- ============================================================
-- Who can read it back
-- ============================================================
select is((select count(*)::int from audit_log where action = 'export'), 3, 'owner reads the export rows on the audit trail');
select _as_counter();
select is((select count(*)::int from audit_log where action = 'export'), 0, 'counter cannot read the audit trail');

-- ============================================================
-- Regression guards
-- ============================================================
-- The audit_log read policy was rewritten with this change: other rows stay readable by a counter.
reset role;
insert into audit_log (actor, action, entity) values (null, 'post', 'sales_invoices');
set local role authenticated;
select _as_counter();
select is((select count(*)::int from audit_log where entity = 'sales_invoices'), 1, 'counter still reads audit rows that are not export rows');

-- A deactivated owner, even holding an aal2 token, is refused.
reset role;
-- (the last active owner cannot be deactivated, so there is a second one)
insert into auth.users (id, email) values ('55555555-5555-5555-5555-555555555555', 'admin2@example.test');
insert into app_users (user_id, role, name, is_active, email) values ('55555555-5555-5555-5555-555555555555', 'admin', 'Second Admin', true, 'admin2@example.test');
update app_users set is_active = false where user_id = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select _as_owner();
select throws_ok($$select log_export('books', 2026)$$, 'P0001', 'DN_FORBIDDEN', 'deactivated owner at aal2: refused');
select is(_exports(), 3, 'and nothing was written');

select * from finish();
rollback;
