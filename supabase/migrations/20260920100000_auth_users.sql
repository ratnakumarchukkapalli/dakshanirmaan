-- Change 08 (auth-users): who may sign in, and who may add or disable people.
--
-- 1. app_users gains the columns the spec reserved for this change (email, locale, invited_by,
--    invited_at).
-- 2. A guard trigger keeps three rules true no matter which code path touches the table:
--    at most 10 active users, at least one active admin, and rows are deactivated, never deleted.
-- 3. admin_set_user() is the only way an app session changes app_users. It insists on an admin
--    whose session has passed the authenticator-app (TOTP) step, and cannot be used to lock
--    yourself out.
-- 4. set_my_locale() lets any active member store their own language.
--
-- Known limit (logged in implementation-notes.md): the TOTP requirement is enforced here and in
-- the app, but the posting functions from changes 03-06 still identify an admin by app_users
-- alone. Closing that needs aal-aware role lookups in all of them — a separate change.

-- ============================================================
-- 1. Columns
-- ============================================================
alter table app_users
  add column email text,
  add column locale text not null default 'en' check (locale in ('en', 'te')),
  add column invited_by uuid references auth.users (id),
  add column invited_at timestamptz;

-- One person per email, ignoring case. Nullable so rows written before this change survive.
create unique index app_users_email_key on app_users (lower(email));

-- ============================================================
-- 2. Guard trigger
-- ============================================================
create or replace function public.app_users_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_others_active int;
  v_other_admins int;
begin
  if tg_op = 'DELETE' then
    raise exception 'DN_VALIDATION:users_are_deactivated_not_deleted';
  end if;

  -- Two admins acting at once must not both pass the counts below.
  perform pg_advisory_xact_lock(hashtext('app_users_guard'));

  -- Active-user cap: only when this write makes someone active.
  if new.is_active and (tg_op = 'INSERT' or not old.is_active) then
    select count(*) into v_others_active
      from app_users where is_active and user_id <> new.user_id;
    if v_others_active >= 10 then
      raise exception 'DN_VALIDATION:max_active_users';
    end if;
  end if;

  -- Never leave the business without an active admin.
  if tg_op = 'UPDATE' and old.is_active and old.role = 'admin'
     and not (new.is_active and new.role = 'admin') then
    select count(*) into v_other_admins
      from app_users where is_active and role = 'admin' and user_id <> old.user_id;
    if v_other_admins = 0 then
      raise exception 'DN_VALIDATION:last_admin';
    end if;
  end if;

  return new;
end;
$$;

create trigger app_users_guard
  before insert or update or delete on app_users
  for each row execute function public.app_users_guard();

-- ============================================================
-- 3. admin_set_user
-- ============================================================
-- Creates the app_users row for an existing Supabase Auth account, or updates it. The server
-- action creates the Auth account first (service key), then calls this AS THE ADMIN, so the
-- database — not just the action — checks who is asking.
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

-- ============================================================
-- 4. set_my_locale
-- ============================================================
create or replace function public.set_my_locale(p_locale text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_locale is null or p_locale not in ('en', 'te') then
    raise exception 'DN_VALIDATION:locale';
  end if;
  -- Own row only; a non-member simply matches nothing.
  update app_users set locale = p_locale where user_id = auth.uid() and is_active;
end;
$$;

-- ============================================================
-- 5. Grants
-- ============================================================
-- Supabase's default grants hand anon/service_role execute on every new function, so revoke
-- them by name (same pattern as change 03). The trigger function is never called by a role.
revoke all on function public.app_users_guard() from public, anon, authenticated, service_role;
revoke all on function public.admin_set_user(uuid, text, text, app_role, bool) from public, anon, service_role;
revoke all on function public.set_my_locale(text) from public, anon, service_role;
grant execute on function public.admin_set_user(uuid, text, text, app_role, bool) to authenticated;
grant execute on function public.set_my_locale(text) to authenticated;

-- RLS already has no write policy on app_users; take the table privileges away too (same
-- second-lock reasoning as the ledger tables in change 05). service_role keeps write access:
-- the create-admin bootstrap script runs with it.
revoke insert, update, delete on app_users from authenticated;
