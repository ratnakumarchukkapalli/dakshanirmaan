-- Must pass (change 01, foundation-schema): "RLS denies non-member"
-- A session with no active app_users row gets zero rows from a business table even though
-- rows exist. A session that *is* an active member gets rows back, so the test also proves
-- the policy isn't accidentally denying everyone.
begin;

create extension if not exists pgtap with schema extensions;

select plan(3);

-- Setup as postgres: sanity that seed data exists, plus one real active member to contrast with.
select ok(
  (select count(*) from accounts) > 0,
  'sanity: accounts has seed rows before the RLS checks run'
);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'member@dakshanirmaantraders.in');
insert into app_users (user_id, role, name, is_active) values
  ('11111111-1111-1111-1111-111111111111', 'user', 'Test Member', true);

-- Non-member: valid JWT shape, but no app_users row for this sub.
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","aal":"aal2"}';

select is(
  (select count(*)::int from accounts),
  0,
  'non-member session sees zero rows on accounts despite seed data existing'
);

-- Active member: same table, real membership.
set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","aal":"aal2"}';

select ok(
  (select count(*) from accounts) > 0,
  'active member session sees accounts rows'
);

reset role;

select * from finish();

rollback;
