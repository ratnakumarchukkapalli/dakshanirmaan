-- Must pass (change 08, auth-users):
--  * only an admin whose session passed TOTP (aal2) can add / disable / enable people
--  * users cannot lock the business out (self-change, last admin) or exceed 10 active users
--  * app_users cannot be written or deleted directly by an app session
--  * set_my_locale only ever touches the caller's own row
begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- Hermetic: a real owner row may already exist (created by the bootstrap script on this database).
-- Park every pre-existing person as inactive so the admin / 10-person counts below start from
-- zero. The guard is switched off only for this housekeeping, inside this rolled-back transaction.
alter table app_users disable trigger app_users_guard;
update app_users set is_active = false;
alter table app_users enable trigger app_users_guard;

-- Cast: A and B admins, U a counter user, T a new person with an Auth account but no app row,
-- F a former admin who has been disabled.
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000f', 'f@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'a@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'b@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'u@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000e', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'admin', 'Admin A', true, 'a@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', 'admin', 'Admin B', true, 'b@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', 'user',  'Counter U', true, 'u@example.test'),
  ('aaaaaaaa-0000-0000-0000-00000000000f', 'admin', 'Former Admin F', false, 'f@example.test');

-- ---------- who may call admin_set_user ----------
set local role authenticated;

-- Admin, first step only (aal1): refused.
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'admin without the authenticator step (aal1) is refused');

-- Admin with no aal claim at all: refused.
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'admin with no aal claim is refused');

-- Counter user, even at aal2: refused.
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'user role is refused even at aal2');

-- Signed in but not a member: refused.
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000e","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'non-member is refused');

-- No identity at all: refused.
set local request.jwt.claims to '{"role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'no identity is refused');

-- anon cannot even execute it.
reset role;
set local role anon;
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  '42501', null, 'anon has no execute privilege');
reset role;

-- ---------- the happy path ----------
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}';

select lives_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', '  T@Example.Test ', ' Newcomer T ', 'user', true)$$,
  'admin at aal2 can add a person');
select is(
  (select email || '|' || name || '|' || role::text || '|' || (invited_by = 'aaaaaaaa-0000-0000-0000-00000000000a')::text
     from app_users where user_id = 'aaaaaaaa-0000-0000-0000-00000000000d'),
  't@example.test|Newcomer T|user|true',
  'email lower-cased, name trimmed, invited_by is the admin');
select is(
  (select count(*)::int from audit_log
    where action = 'user_create' and entity_id = 'aaaaaaaa-0000-0000-0000-00000000000d'
      and actor = 'aaaaaaaa-0000-0000-0000-00000000000a'),
  1, 'creation is written to the audit log');

select lives_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'Newcomer T', 'user', false)$$,
  'admin can disable a person');
select is(
  (select is_active from app_users where user_id = 'aaaaaaaa-0000-0000-0000-00000000000d'),
  false, 'person is now inactive');
select lives_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'Newcomer T', 'user', true)$$,
  'admin can re-enable a person');
select is(
  (select array_agg(action order by created_at, action) from audit_log
    where entity_id = 'aaaaaaaa-0000-0000-0000-00000000000d' and action like 'user\_%'),
  array['user_create', 'user_disable', 'user_enable']::text[],
  'disable and enable are audited under their own names') ;

-- Another person's address, differing only by case, is refused with a clear code (not a raw
-- unique-index violation). 'stranger' has an Auth account but no app row.
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000e', 'T@EXAMPLE.TEST', 'Stranger', 'user', true)$$,
  'P0001', 'DN_VALIDATION:email_taken', 'an email already used by someone else (any case) is refused');

-- ---------- validation and self-protection ----------
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 'not-an-email', 'T', 'user', true)$$,
  'P0001', 'DN_VALIDATION:email', 'a bad email is refused');
select throws_ok(
  $$select admin_set_user('99999999-9999-9999-9999-999999999999', 'x@example.test', 'X', 'user', true)$$,
  'P0001', 'DN_VALIDATION:no_auth_account', 'a person with no Auth account is refused');
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000a', 'a@example.test', 'Admin A', 'user', true)$$,
  'P0001', 'DN_VALIDATION:self_change', 'an admin cannot demote themselves');
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000a', 'a@example.test', 'Admin A', 'admin', false)$$,
  'P0001', 'DN_VALIDATION:self_change', 'an admin cannot disable themselves');

-- ---------- direct writes are closed ----------
select throws_ok(
  $$update app_users set name = 'Hacked' where user_id = 'aaaaaaaa-0000-0000-0000-00000000000c'$$,
  '42501', null, 'an app session cannot update app_users directly');

select throws_ok(
  $$insert into app_users (user_id, role, name, is_active, email)
    values ('aaaaaaaa-0000-0000-0000-00000000000e', 'admin', 'Self-made admin', true, 'stranger@example.test')$$,
  '42501', null, 'an app session cannot insert into app_users directly');
select throws_ok(
  $$truncate app_users$$,
  '42501', null, 'an app session cannot truncate app_users');

-- ---------- set_my_locale ----------
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal1"}';
select lives_ok($$select set_my_locale('te')$$, 'a member can set their own language');
select throws_ok($$select set_my_locale('fr')$$, 'P0001', 'DN_VALIDATION:locale', 'an unknown language is refused');
reset role;
select is(
  (select string_agg(user_id::text || '=' || locale, ',' order by user_id::text)
     from app_users where user_id in ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-00000000000c')),
  'aaaaaaaa-0000-0000-0000-00000000000a=en,aaaaaaaa-0000-0000-0000-00000000000c=te',
  'only the caller''s own row changed');

-- A disabled member: their old admin row grants nothing. Even at aal2 they cannot manage people,
-- and set_my_locale silently matches no row for them.
set local role authenticated;
set local request.jwt.claims to '{"sub":"aaaaaaaa-0000-0000-0000-00000000000f","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select admin_set_user('aaaaaaaa-0000-0000-0000-00000000000d', 't@example.test', 'T', 'user', true)$$,
  'P0001', 'DN_FORBIDDEN', 'a disabled admin is refused even at aal2');
select lives_ok($$select set_my_locale('te')$$, 'a disabled member calling set_my_locale does not error...');
reset role;
select is(
  (select locale from app_users where user_id = 'aaaaaaaa-0000-0000-0000-00000000000f'),
  'en', '...but their row is not written');

-- anon cannot execute set_my_locale.
set local role anon;
select throws_ok($$select set_my_locale('te')$$, '42501', null, 'anon has no execute privilege on set_my_locale');
reset role;

-- ---------- guard trigger (as the database owner: it must hold for every code path) ----------
select throws_ok(
  $$delete from app_users where user_id = 'aaaaaaaa-0000-0000-0000-00000000000c'$$,
  'P0001', 'DN_VALIDATION:users_are_deactivated_not_deleted', 'people are never deleted');

-- Admin B steps aside, leaving A as the only active admin; then A cannot be removed.
update app_users set is_active = false where user_id = 'aaaaaaaa-0000-0000-0000-00000000000b';
select throws_ok(
  $$update app_users set is_active = false where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a'$$,
  'P0001', 'DN_VALIDATION:last_admin', 'the last active admin cannot be disabled');

-- Fill to exactly 10 active people, then the 11th is refused.
insert into auth.users (id, email)
  select gen_random_uuid(), 'fill' || g || '@example.test' from generate_series(1, 10) g;
insert into app_users (user_id, role, name, is_active, email)
  select u.id, 'user', 'Fill', true, u.email
    from (select id, email from auth.users where email like 'fill%@example.test'
           order by email limit greatest(10 - (select count(*)::int from app_users where is_active), 0)) u;
select is((select count(*)::int from app_users where is_active), 10, 'setup: exactly 10 active people');
select throws_ok(
  $$insert into app_users (user_id, role, name, is_active, email)
      select id, 'user', 'Eleventh', true, email from auth.users where email = 'stranger@example.test'$$,
  'P0001', 'DN_VALIDATION:max_active_users', 'an 11th active person is refused');

select * from finish();

rollback;
