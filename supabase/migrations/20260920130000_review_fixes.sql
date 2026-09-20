-- Review fixes for changes 08 (auth-users) and 09 (masters), found by the two independent
-- audits. Change 09's own migration was corrected in place (nothing had reached hosted); this
-- file carries the change-08 fix and the cross-cutting sweep, so it can never conflict with an
-- already-applied file.

-- ============================================================
-- 1. TRUNCATE
-- ============================================================
-- Supabase's default grants give anon/authenticated every table privilege, TRUNCATE included.
-- TRUNCATE ignores RLS and row triggers, so a leaked login could empty a table outright. The
-- earlier "second lock" revokes (changes 05, 08, 09) named insert/update/delete but not truncate.
revoke insert, update, delete, truncate on app_users from authenticated;
revoke delete, truncate on parties, party_addresses, items, organization from authenticated;

-- Sweep: no app-facing role truncates anything, now or in tables created later by this role.
revoke truncate on all tables in schema public from authenticated, anon;
alter default privileges in schema public revoke truncate on tables from authenticated, anon;

-- ============================================================
-- 2. admin_set_user: a clear error for a duplicate email
-- ============================================================
-- Identical to the change-08 function except for the email_taken pre-check. Without it a clash
-- with another person's address (ignoring case) surfaced as a raw unique-index violation.
create or replace function public.admin_set_user(
  p_user_id uuid,
  p_email text,
  p_name text,
  p_role app_role,
  p_is_active bool
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_before app_users;
  v_action text;
begin
  -- Admin only, and only once the authenticator-app step is done in THIS session.
  if v_actor is null
     or current_app_role() is distinct from 'admin'
     or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'DN_FORBIDDEN';
  end if;

  if p_user_id is null or p_role is null or p_is_active is null then
    raise exception 'DN_VALIDATION:missing_field';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'DN_VALIDATION:email';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception 'DN_VALIDATION:name';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'DN_VALIDATION:no_auth_account';
  end if;
  -- Someone else already uses this address (the unique index compares lower-cased).
  if exists (select 1 from app_users where lower(email) = v_email and user_id <> p_user_id) then
    raise exception 'DN_VALIDATION:email_taken';
  end if;

  select * into v_before from app_users where user_id = p_user_id for update;

  if found then
    -- You cannot demote or disable yourself; another admin has to do it.
    if p_user_id = v_actor and (p_role <> v_before.role or not p_is_active) then
      raise exception 'DN_VALIDATION:self_change';
    end if;
    update app_users
       set email = v_email, name = v_name, role = p_role, is_active = p_is_active
     where user_id = p_user_id;
    v_action := case
      when v_before.is_active and not p_is_active then 'user_disable'
      when not v_before.is_active and p_is_active then 'user_enable'
      else 'user_update' end;
  else
    insert into app_users (user_id, email, name, role, is_active, invited_by, invited_at)
    values (p_user_id, v_email, v_name, p_role, p_is_active, v_actor, now());
    v_action := 'user_create';
  end if;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (
    v_actor, v_action, 'app_users', p_user_id,
    case when v_before.user_id is null then null else jsonb_build_object(
      'email', v_before.email, 'name', v_before.name, 'role', v_before.role, 'is_active', v_before.is_active) end,
    jsonb_build_object('email', v_email, 'name', v_name, 'role', p_role, 'is_active', p_is_active)
  );
end;
$$;

-- create or replace keeps the grants, but re-assert them so this file stands on its own.
revoke all on function public.admin_set_user(uuid, text, text, app_role, bool) from public, anon, service_role;
grant execute on function public.admin_set_user(uuid, text, text, app_role, bool) to authenticated;
