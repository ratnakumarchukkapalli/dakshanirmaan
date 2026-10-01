-- Change 28 (stock-cost-owner-only): what stock costs the family is owner-only, in the database.
--
-- Owner decision 1 (2026-09-21, confirmed 2026-09-26, Phase 1 review M4). The screens already omit
-- cost for a counter user, but the API still returned it: stock_movements.rate/value, the cost
-- columns of v_stock_summary(_all) / v_stock_ledger(_all), and stock_on_hand().value/avg_rate.
-- Quantities stay visible to both roles (the counter needs on-hand qty to bill).
--
-- Admins and counter users are the same Postgres role (`authenticated`); the app role comes from
-- current_app_role(). So the shape is the change-13 pattern (parties.monthly_salary):
--   1. stock_movements: column-level SELECT for `authenticated` without rate/value (for everyone —
--      admins read cost through 2-4, never the table).
--   2. stock_movement_cost(): SECURITY DEFINER, the only reader of rate/value for an app session;
--      rows for an admin (aal2) only, nothing for anyone else.
--   3. The four stock views keep their names, columns, types, order, grants and security_invoker;
--      quantities come from stock_movements, cost from a LEFT JOIN to stock_movement_cost(). For a
--      counter user the cost columns are NULL (avg_rate too, also when qty = 0); for an admin every
--      figure is what it was. Dependents (v_stock_summary / v_stock_ledger select * from the _all
--      views, v_attention reads qty only) are unaffected.
--   4. stock_on_hand(): the posting engine's reader. post_* / cancel_* are SECURITY DEFINER and call
--      it as their owner, which still holds SELECT on the whole table: that path is the original
--      body, byte-for-byte the same maths, so weighted-average cost and COGS do not change. A direct
--      call by an app session (no SELECT on stock_movements.value) gets qty for everyone, cost for
--      an admin only (NULL otherwise).
--
-- Residuals (cost still derivable by a counter user from purchase documents, journal_lines on the
-- inventory/cogs accounts, v_day_book.total_debit, stock_adjustment_lines.rate) are logged in
-- openspec/changes/28-stock-cost-owner-only/implementation-notes.md and the spec; not closed here.

-- ============================================================
-- 1. stock_movements: column-level SELECT without the cost columns
-- ============================================================
-- Column privileges cannot be taken away from a table-level grant, so the table-level SELECT goes
-- and every other column is granted back by name. A column added later gets no SELECT until it is
-- granted on purpose. `select *` on the table is refused for app sessions (it names rate/value);
-- the app never reads the table directly (it reads the views below).
revoke select on public.stock_movements from authenticated;
grant select (id, created_at, item_id, warehouse_id, movement_date, qty, source_type, source_id, reversal_of)
  on public.stock_movements to authenticated;

-- ============================================================
-- 2. stock_movement_cost(): the owner-only way back to rate/value
-- ============================================================
-- One-time filter: for anyone but an admin at aal2 the plan never touches stock_movements. Runs as
-- the owner (RLS bypassed); the admin gate is stricter than the table's is_active_member() policy.
create or replace function public.stock_movement_cost()
returns table (movement_id uuid, rate numeric(14,4), value numeric(14,2))
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.rate, m.value
  from stock_movements m
  where (select current_app_role()) = 'admin';
$$;

revoke all on function public.stock_movement_cost() from public, anon, service_role;
grant execute on function public.stock_movement_cost() to authenticated;

-- ============================================================
-- 3. The stock views: same columns, cost through stock_movement_cost()
-- ============================================================
-- Summary: sum(c.value) over the LEFT JOIN is the old sum(m.value) for an admin (every movement has
-- its cost row) and NULL for anyone else. avg_rate keeps the old 0-when-qty-is-0 rule for an admin
-- only, so a counter user never gets a non-NULL cost figure.
create or replace view public.v_stock_summary_all with (security_invoker = true) as
select
  m.item_id,
  i.name as item_name,
  i.category,
  i.base_uom,
  m.warehouse_id,
  w.name as warehouse_name,
  w.is_transit,
  sum(m.qty)::numeric(12,3) as qty,
  (case when (select current_app_role()) is distinct from 'admin' then null
        when sum(m.qty) = 0 then 0
        else round(sum(c.value) / sum(m.qty), 4) end)::numeric(14,4) as avg_rate,
  sum(c.value)::numeric(14,2) as value
from stock_movements m
join items i on i.id = m.item_id
join warehouses w on w.id = m.warehouse_id
left join stock_movement_cost() c on c.movement_id = m.id
group by m.item_id, i.name, i.category, i.base_uom, m.warehouse_id, w.name, w.is_transit;

-- Ledger: rate/value per movement and the running value come from the cost rows; NULL for a
-- counter user (sum() over all-NULL inputs is NULL). Ordering and seq are unchanged.
create or replace view public.v_stock_ledger_all with (security_invoker = true) as
select
  m.item_id,
  i.name as item_name,
  m.warehouse_id,
  w.name as warehouse_name,
  w.is_transit,
  m.id as movement_id,
  m.movement_date,
  m.source_type,
  m.source_id,
  d.doc_no,
  (m.reversal_of is not null) as is_reversal,
  m.qty,
  c.rate::numeric(14,4) as rate,
  c.value::numeric(14,2) as value,
  (row_number() over (partition by m.item_id, m.warehouse_id
                      order by m.movement_date, m.created_at, m.id))::int as seq,
  (sum(m.qty) over (partition by m.item_id, m.warehouse_id
                    order by m.movement_date, m.created_at, m.id))::numeric(12,3) as running_qty,
  (sum(c.value) over (partition by m.item_id, m.warehouse_id
                      order by m.movement_date, m.created_at, m.id))::numeric(14,2) as running_value
from stock_movements m
join items i on i.id = m.item_id
join warehouses w on w.id = m.warehouse_id
left join stock_movement_cost() c on c.movement_id = m.id
left join v_document_refs d on d.source_type = m.source_type and d.source_id = m.source_id;

-- ============================================================
-- 4. stock_on_hand(): unchanged for the posting engine, cost owner-only for an app session
-- ============================================================
-- security invoker, as before: current_user is the function owner inside post_* / cancel_* /
-- go_live_readiness (SECURITY DEFINER), and the session role (`authenticated`) on a direct call.
-- has_column_privilege() tells the two apart without trusting any argument.
create or replace function public.stock_on_hand(p_item uuid, p_warehouse uuid)
returns table(qty numeric, value numeric, avg_rate numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if has_column_privilege('public.stock_movements', 'value', 'SELECT') then
    -- Posting engine path: the original body (change 01), unchanged.
    return query
    select
      coalesce(sum(m.qty), 0)::numeric(12,3) as qty,
      coalesce(sum(m.value), 0)::numeric(14,2) as value,
      case when coalesce(sum(m.qty), 0) = 0 then 0::numeric(14,4)
           else round(coalesce(sum(m.value), 0) / sum(m.qty), 4)
      end as avg_rate
    from stock_movements m
    where m.item_id = p_item and m.warehouse_id = p_warehouse;
  elsif (select current_app_role()) = 'admin' then
    -- An owner's direct call: the same figures, cost through stock_movement_cost().
    return query
    select
      coalesce(sum(m.qty), 0)::numeric(12,3),
      coalesce(sum(c.value), 0)::numeric(14,2),
      case when coalesce(sum(m.qty), 0) = 0 then 0::numeric(14,4)
           else round(coalesce(sum(c.value), 0) / sum(m.qty), 4)
      end
    from stock_movements m
    left join stock_movement_cost() c on c.movement_id = m.id
    where m.item_id = p_item and m.warehouse_id = p_warehouse;
  else
    -- Anyone else: quantity only (RLS still decides which rows; a non-member gets 0).
    return query
    select coalesce(sum(m.qty), 0)::numeric(12,3), null::numeric, null::numeric
    from stock_movements m
    where m.item_id = p_item and m.warehouse_id = p_warehouse;
  end if;
end;
$$;

revoke all on function public.stock_on_hand(uuid, uuid) from public, anon;
grant execute on function public.stock_on_hand(uuid, uuid) to authenticated, service_role;
