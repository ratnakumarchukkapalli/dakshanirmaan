-- Change 26 (delete-unused-items): an owner may delete an item that was never used.
--
-- "Never used" is enforced by the database, not by this migration: all nine tables that point at
-- items(id) (stock_movements, opening_lines and the seven document-line tables) use plain
-- NO ACTION foreign keys, so deleting an item with any history fails with 23503
-- (foreign_key_violation) and the statement rolls back, audit row included. Nothing cascades.
-- Parties, accounts, warehouses and organisation keep no DELETE (unchanged).

-- ============================================================
-- 1. Audit trigger function: record the old row on DELETE
-- ============================================================
-- Same function as change 18 with a DELETE branch first; the INSERT and UPDATE paths are as before
-- (v_new is computed only after the DELETE branch, because NEW is null on DELETE).
create or replace function public.audit_master_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_skip   text[] := array['created_at', 'updated_at', 'monthly_salary', 'daily_wage'];
  v_new    jsonb;
  v_old    jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
  v_key    text;
begin
  if tg_op = 'DELETE' then
    insert into audit_log (actor, action, entity, entity_id, before)
    values (auth.uid(), 'delete', tg_table_name, old.id, to_jsonb(old) - v_skip);
    return old;
  end if;

  v_new := to_jsonb(new) - v_skip;

  if tg_op = 'INSERT' then
    insert into audit_log (actor, action, entity, entity_id, after)
    values (auth.uid(), 'insert', tg_table_name, new.id, v_new);
    return new;
  end if;

  v_old := to_jsonb(old) - v_skip;
  for v_key in select key from jsonb_each(v_new) loop
    if v_new -> v_key is distinct from v_old -> v_key then
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    end if;
  end loop;

  -- Only the pay columns (or nothing) changed: nothing to record.
  if v_after = '{}'::jsonb then
    return new;
  end if;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', tg_table_name, new.id, v_before, v_after);
  return new;
end;
$$;

revoke all on function public.audit_master_change() from public, anon, authenticated, service_role;

-- Items only: the other masters still have no DELETE at all.
drop trigger audit_master_items on public.items;
create trigger audit_master_items after insert or update or delete on public.items
  for each row execute function public.audit_master_change();

-- ============================================================
-- 2. DELETE on items: owners only (current_app_role() is 'admin' only at aal2, change 19)
-- ============================================================
create policy delete_admin on public.items for delete using (current_app_role() = 'admin');

grant delete on public.items to authenticated;

-- ============================================================
-- 3. Second lock: accounts and warehouses held a DELETE privilege (explicit_grants) with no policy.
--    RLS already refused every delete; the revoke makes it two locks like parties/organisation.
-- ============================================================
revoke delete on public.accounts, public.warehouses from authenticated;
