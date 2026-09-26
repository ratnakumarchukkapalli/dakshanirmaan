-- Change 17 (cutover): opening balances, opening stock, fiscal-year creation, go-live readiness.
--
-- Spec: db-architecture -> "Opening balances (change 17)". The books start empty; the dues owed to
-- and by the family, the cash and bank balances and the godown stock go in as ONE balanced
-- 'opening' journal entry (plus one 'opening' stock movement per item/warehouse) through
-- post_opening_balances — the same rule as every other document: nothing writes the ledger except
-- a post_* function.
--
-- Staging is a draft batch of lines the owner edits freely; posting freezes it. Cancelling is only
-- possible while nothing else has ever posted (books empty apart from the opening) and hands the
-- lines back as a fresh draft so a wrong figure can be corrected and posted again.

-- ============================================================
-- 1. Owner decision 3: the financial year starts in April, always
-- ============================================================
-- next_doc_no, the report date pickers and ensure_fiscal_year all assume it; the column stays
-- (the spec's organization shape) but can only hold 4.
alter table organization drop constraint if exists organization_fy_start_check;
alter table organization add constraint organization_fy_start_check check (fy_start_month = 4);

-- ============================================================
-- 2. Opening Balance Equity
-- ============================================================
insert into accounts (code, name, type, parent_id, system_key)
values ('3900', 'Opening Balance Equity', 'equity',
        (select id from accounts where code = '3000'), 'opening_balance_equity');

-- ============================================================
-- 3. Staging tables (owner only)
-- ============================================================
create table opening_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) default auth.uid(),
  status doc_status not null default 'draft',
  as_of date,
  journal_entry_id uuid references journal_entries (id),
  posted_by uuid references auth.users (id),
  posted_at timestamptz,
  constraint opening_batches_posted_shape check (
    (status = 'draft' and journal_entry_id is null and as_of is null and posted_at is null)
    or (status <> 'draft' and journal_entry_id is not null and as_of is not null)
  )
);

-- One live batch at a time: a draft being edited, or the posted opening. A cancelled batch is
-- history and does not count.
create unique index opening_batches_one_live on opening_batches ((true)) where status <> 'cancelled';

create table opening_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  batch_id uuid not null references opening_batches (id),
  kind text not null check (kind in ('party', 'money', 'stock')),
  party_id uuid references parties (id),
  side text check (side in ('receivable', 'payable')),
  account_id uuid references accounts (id),
  item_id uuid references items (id),
  warehouse_id uuid references warehouses (id),
  qty numeric(12,3),
  rate numeric(14,4),
  amount numeric(14,2),
  constraint opening_lines_shape check (
    (kind = 'party' and party_id is not null and side is not null and amount > 0
       and account_id is null and item_id is null and warehouse_id is null and qty is null and rate is null)
    or (kind = 'money' and account_id is not null and amount > 0
       and party_id is null and side is null and item_id is null and warehouse_id is null and qty is null and rate is null)
    or (kind = 'stock' and item_id is not null and warehouse_id is not null and qty > 0 and rate > 0
       and amount is null and party_id is null and side is null and account_id is null)
  )
);

create unique index opening_lines_party_once on opening_lines (batch_id, party_id, side) where kind = 'party';
create unique index opening_lines_money_once on opening_lines (batch_id, account_id) where kind = 'money';
create unique index opening_lines_stock_once on opening_lines (batch_id, item_id, warehouse_id) where kind = 'stock';
create index opening_lines_batch on opening_lines (batch_id);

-- Lines are editable only while their batch is a draft (a posted batch is the record of what
-- went into the books). Runs for every role, including the post/cancel functions, which never
-- touch a posted batch's lines.
create or replace function public.opening_lines_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status doc_status;
begin
  select status into v_status from opening_batches
  where id = case when tg_op = 'DELETE' then old.batch_id else new.batch_id end;
  if v_status is distinct from 'draft' then
    raise exception 'DN_VALIDATION:opening_batch_not_draft';
  end if;
  if tg_op = 'UPDATE' and new.batch_id is distinct from old.batch_id then
    raise exception 'DN_VALIDATION:opening_batch_not_draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger opening_lines_guard
  before insert or update or delete on opening_lines
  for each row execute function public.opening_lines_guard();
revoke all on function public.opening_lines_guard() from public, anon, authenticated, service_role;

alter table opening_batches enable row level security;
alter table opening_lines enable row level security;

create policy select_admin on opening_batches for select using (current_app_role() = 'admin');
create policy insert_admin on opening_batches for insert
  with check (current_app_role() = 'admin' and status = 'draft' and journal_entry_id is null);
create policy select_admin on opening_lines for select using (current_app_role() = 'admin');
create policy insert_admin on opening_lines for insert with check (current_app_role() = 'admin');
create policy update_admin on opening_lines for update
  using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
create policy delete_admin on opening_lines for delete using (current_app_role() = 'admin');

-- A batch's status only ever changes inside post/cancel_opening_balances.
revoke update, delete on opening_batches from authenticated;
revoke all on opening_batches, opening_lines from anon;

-- ============================================================
-- 4. post_opening_balances
-- ============================================================
-- p_expected_equity is the balancing figure the screen showed (positive = the family's net worth,
-- credited to Opening Balance Equity). A different figure means the lines changed after the
-- preview; refuse rather than post something nobody looked at. NULL skips the check (tests).
create or replace function public.post_opening_balances(p_date date, p_expected_equity numeric default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_batch        record;
  v_line         record;
  v_entry_id     uuid;
  v_line_no      int := 0;
  v_debit_total  numeric(14,2) := 0;
  v_credit_total numeric(14,2) := 0;
  v_stock_total  numeric(14,2) := 0;
  v_value        numeric(14,2);
  v_equity       numeric(14,2);
  v_locked       bool;
  v_inventory_id uuid;
  v_equity_id    uuid;
  v_ar_id        uuid;
  v_ap_id        uuid;
  v_party_type   party_type;
  v_party_active bool;
  v_is_stock     bool;
  v_is_transit   bool;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_date is null then
    raise exception 'DN_VALIDATION:date_required';
  end if;

  select * into v_batch from opening_batches where status = 'draft' for update;
  if not found then
    raise exception 'DN_NOT_DRAFT';
  end if;

  select is_locked into v_locked
  from fiscal_periods where month = date_trunc('month', p_date)::date;
  if coalesce(v_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  -- The opening must come before every other document: dated on or after one, the cash book and
  -- ageing before the opening date would be wrong. Ambiguity is blocked, not allowed.
  if exists (select 1 from journal_entries where source_type <> 'opening' and entry_date <= p_date)
     or exists (select 1 from stock_movements where source_type <> 'opening' and movement_date <= p_date) then
    raise exception 'DN_VALIDATION:opening_after_documents';
  end if;

  if not exists (select 1 from opening_lines where batch_id = v_batch.id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  -- Lock order (spec): document, parties, items — each ordered by id.
  perform 1 from parties
   where id in (select party_id from opening_lines where batch_id = v_batch.id and kind = 'party')
   order by id for update;
  perform 1 from items
   where id in (select item_id from opening_lines where batch_id = v_batch.id and kind = 'stock')
   order by id for update;

  select id into v_inventory_id from accounts where system_key = 'inventory';
  select id into v_equity_id    from accounts where system_key = 'opening_balance_equity';
  select id into v_ar_id        from accounts where system_key = 'ar';
  select id into v_ap_id        from accounts where system_key = 'ap';
  if v_inventory_id is null or v_equity_id is null or v_ar_id is null or v_ap_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  -- Validate every line and total it before anything is written.
  for v_line in
    select * from opening_lines where batch_id = v_batch.id order by kind, created_at, id
  loop
    if v_line.kind = 'party' then
      select type, is_active into v_party_type, v_party_active from parties where id = v_line.party_id;
      if not coalesce(v_party_active, false) then
        raise exception 'DN_VALIDATION:party_inactive';
      end if;
      if v_line.side = 'receivable' and v_party_type not in ('customer', 'both') then
        raise exception 'DN_VALIDATION:party_type';
      end if;
      if v_line.side = 'payable' and v_party_type not in ('supplier', 'both') then
        raise exception 'DN_VALIDATION:party_type';
      end if;
      if v_line.side = 'receivable' then
        v_debit_total := v_debit_total + v_line.amount;
      else
        v_credit_total := v_credit_total + v_line.amount;
      end if;

    elsif v_line.kind = 'money' then
      if not is_money_account(v_line.account_id) then
        raise exception 'DN_VALIDATION:not_money_account';
      end if;
      v_debit_total := v_debit_total + v_line.amount;

    else
      select is_stock into v_is_stock from items where id = v_line.item_id;
      if not coalesce(v_is_stock, false) then
        raise exception 'DN_VALIDATION:non_stock_line';
      end if;
      select is_transit into v_is_transit from warehouses where id = v_line.warehouse_id;
      if coalesce(v_is_transit, true) then
        raise exception 'DN_VALIDATION:transit_warehouse';
      end if;
      -- Opening stock into a place that already has movements would silently re-average it.
      -- A cancelled opening (its movements plus their reversals, netting to zero) does not count,
      -- so a corrected batch can be posted again.
      if exists (select 1 from stock_movements
                 where item_id = v_line.item_id and warehouse_id = v_line.warehouse_id
                   and source_type <> 'opening')
         or (select coalesce(sum(qty), 0) from stock_movements
             where item_id = v_line.item_id and warehouse_id = v_line.warehouse_id) <> 0 then
        raise exception 'DN_VALIDATION:stock_exists';
      end if;
      v_value := round(v_line.qty * v_line.rate, 2);
      if v_value <= 0 then
        raise exception 'DN_VALIDATION:zero_value';
      end if;
      v_stock_total := v_stock_total + v_value;
    end if;
  end loop;

  v_debit_total := v_debit_total + v_stock_total;
  v_equity := v_debit_total - v_credit_total;   -- credit to equity when positive

  if p_expected_equity is not null and p_expected_equity is distinct from v_equity then
    raise exception 'DN_VALIDATION:stale_preview';
  end if;

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (p_date, 'Opening balances as at ' || to_char(p_date, 'DD-MM-YYYY'), 'opening',
          v_batch.id, v_actor, now())
  returning id into v_entry_id;

  for v_line in
    select * from opening_lines where batch_id = v_batch.id and kind = 'party' and side = 'receivable'
    order by created_at, id
  loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_ar_id, v_line.party_id, v_line.amount, 0);
  end loop;

  for v_line in
    select * from opening_lines where batch_id = v_batch.id and kind = 'money' order by created_at, id
  loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_line.account_id, v_line.amount, 0);
  end loop;

  if v_stock_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_inventory_id, v_stock_total, 0);

    for v_line in
      select * from opening_lines where batch_id = v_batch.id and kind = 'stock' order by created_at, id
    loop
      insert into stock_movements
        (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
      values
        (v_line.item_id, v_line.warehouse_id, p_date, v_line.qty, v_line.rate,
         round(v_line.qty * v_line.rate, 2), 'opening', v_batch.id);
    end loop;
  end if;

  for v_line in
    select * from opening_lines where batch_id = v_batch.id and kind = 'party' and side = 'payable'
    order by created_at, id
  loop
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_ap_id, v_line.party_id, 0, v_line.amount);
  end loop;

  if v_equity <> 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_equity_id,
            case when v_equity < 0 then -v_equity else 0 end,
            case when v_equity > 0 then v_equity else 0 end);
  end if;

  update opening_batches
     set status = 'posted', as_of = p_date, journal_entry_id = v_entry_id,
         posted_by = v_actor, posted_at = now()
   where id = v_batch.id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'opening_batches', v_batch.id,
          jsonb_build_object('as_of', p_date, 'entry_id', v_entry_id, 'debits', v_debit_total,
                             'credits', v_credit_total, 'stock', v_stock_total, 'equity', v_equity));

  return v_entry_id;
end;
$$;

revoke all on function public.post_opening_balances(date, numeric) from public, anon;
grant execute on function public.post_opening_balances(date, numeric) to authenticated;

-- The figures the screen shows before posting, computed here so no arithmetic lives in TypeScript.
-- Security invoker: the owner-only RLS on opening_lines applies, everyone else gets a row of zeros.
-- equity is what post_opening_balances credits to Opening Balance Equity (negative = debit).
create or replace function public.opening_preview()
returns table (line_count int, receivable numeric, payable numeric, money numeric, stock numeric, equity numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    count(*)::int,
    coalesce(sum(l.amount) filter (where l.kind = 'party' and l.side = 'receivable'), 0)::numeric(14,2),
    coalesce(sum(l.amount) filter (where l.kind = 'party' and l.side = 'payable'), 0)::numeric(14,2),
    coalesce(sum(l.amount) filter (where l.kind = 'money'), 0)::numeric(14,2),
    coalesce(sum(round(l.qty * l.rate, 2)) filter (where l.kind = 'stock'), 0)::numeric(14,2),
    (coalesce(sum(l.amount) filter (where l.kind = 'party' and l.side = 'receivable'), 0)
     + coalesce(sum(l.amount) filter (where l.kind = 'money'), 0)
     + coalesce(sum(round(l.qty * l.rate, 2)) filter (where l.kind = 'stock'), 0)
     - coalesce(sum(l.amount) filter (where l.kind = 'party' and l.side = 'payable'), 0))::numeric(14,2)
  from opening_lines l
  join opening_batches b on b.id = l.batch_id and b.status = 'draft';
$$;

revoke all on function public.opening_preview() from public, anon;
grant execute on function public.opening_preview() to authenticated;

-- ============================================================
-- 5. cancel_opening_balances
-- ============================================================
-- Only while the books hold nothing but the opening. The reversal is dated on the opening date
-- (like a day-close reopen) so the net effect on every date is zero. The lines are copied into a
-- new draft batch and the function returns that batch's id.
create or replace function public.cancel_opening_balances(p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_batch    record;
  v_new      uuid;
  v_entry_id uuid;
  v_locked   bool;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'DN_VALIDATION:reason_required';
  end if;

  select * into v_batch from opening_batches where status = 'posted' for update;
  if not found then
    raise exception 'DN_NOT_POSTED';
  end if;

  -- Hold off every other writer of the ledger while "nothing else has posted" is checked and acted on:
  -- otherwise a sale committing in between could be left standing on stock this reverses. Rare, owner-only.
  lock table journal_entries, stock_movements in share row exclusive mode;

  if exists (select 1 from journal_entries where source_type <> 'opening')
     or exists (select 1 from stock_movements where source_type <> 'opening') then
    raise exception 'DN_VALIDATION:books_in_use';
  end if;

  select is_locked into v_locked
  from fiscal_periods where month = date_trunc('month', v_batch.as_of)::date;
  if coalesce(v_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  perform 1 from items
   where id in (select item_id from opening_lines where batch_id = v_batch.id and kind = 'stock')
   order by id for update;

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_batch.as_of, 'Reversal of opening balances as at ' || to_char(v_batch.as_of, 'DD-MM-YYYY'),
          'opening', v_batch.id, v_actor, now())
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
  from journal_lines where entry_id = v_batch.journal_entry_id;

  insert into stock_movements
    (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
  select item_id, warehouse_id, v_batch.as_of, -qty, rate, -value, source_type, source_id, id
  from stock_movements
  where source_type = 'opening' and source_id = v_batch.id and reversal_of is null;

  update journal_entries set reversed_by = v_entry_id where id = v_batch.journal_entry_id;
  update opening_batches set status = 'cancelled' where id = v_batch.id;

  insert into opening_batches default values returning id into v_new;
  insert into opening_lines (batch_id, kind, party_id, side, account_id, item_id, warehouse_id, qty, rate, amount)
  select v_new, kind, party_id, side, account_id, item_id, warehouse_id, qty, rate, amount
  from opening_lines where batch_id = v_batch.id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, 'cancel', 'opening_batches', v_batch.id,
          jsonb_build_object('as_of', v_batch.as_of, 'entry_id', v_batch.journal_entry_id),
          jsonb_build_object('reason', p_reason, 'reversal_entry_id', v_entry_id, 'new_draft_batch', v_new));

  return v_new;
end;
$$;

revoke all on function public.cancel_opening_balances(text) from public, anon;
grant execute on function public.cancel_opening_balances(text) to authenticated;

-- ============================================================
-- 6. ensure_fiscal_year (spec: Fiscal-year rollover) — never built until now
-- ============================================================
create or replace function public.ensure_fiscal_year(p_label text)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_year  int;
  v_added int;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_label is null or p_label !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'DN_VALIDATION:bad_year_label';
  end if;
  v_year := left(p_label, 4)::int;
  if v_year < 2020 or v_year > 2100 or right(p_label, 2)::int <> (v_year + 1) % 100 then
    raise exception 'DN_VALIDATION:bad_year_label';
  end if;

  insert into fiscal_periods (year_label, month)
  select p_label, d::date
  from generate_series(make_date(v_year, 4, 1), make_date(v_year + 1, 3, 1), interval '1 month') d
  on conflict (month) do nothing;
  get diagnostics v_added = row_count;

  insert into audit_log (actor, action, entity, after)
  values (v_actor, 'ensure_fiscal_year', 'fiscal_periods',
          jsonb_build_object('year_label', p_label, 'months_added', v_added));
  return v_added;
end;
$$;

revoke all on function public.ensure_fiscal_year(text) from public, anon;
grant execute on function public.ensure_fiscal_year(text) to authenticated;

-- ============================================================
-- 7. go_live_readiness — what the database can answer for the go-live checklist
-- ============================================================
create or replace function public.go_live_readiness()
returns table (check_key text, ok bool, detail text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org         organization%rowtype;
  v_today       date;
  v_admins      int;
  v_counters    int;
  v_debits      numeric;
  v_credits     numeric;
  v_inv_gl      numeric;
  v_inv_stock   numeric;
  v_this_month  bool;
  v_next_month  bool;
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_org from organization limit 1;
  v_today := (now() at time zone v_org.timezone)::date;

  check_key := 'organisation';
  ok := btrim(coalesce(v_org.legal_name, '')) <> '' and v_org.gstin is not null and length(v_org.gstin) = 15
        and v_org.address is not null and coalesce(btrim(v_org.address ->> 'line1'), '') <> '';
  detail := case when ok then v_org.legal_name || ' · ' || v_org.gstin else 'legal name, GSTIN and address must be filled in' end;
  return next;

  select count(*) filter (where role = 'admin'), count(*) filter (where role = 'user')
    into v_admins, v_counters from app_users where is_active;
  check_key := 'owners';
  ok := v_admins >= 2;
  detail := v_admins || ' active owner(s), ' || v_counters || ' counter user(s); at least 2 owners so one can always sign in';
  return next;

  select coalesce(bool_or(not is_locked) filter (where month = date_trunc('month', v_today)::date), false),
         coalesce(bool_or(not is_locked) filter (where month = (date_trunc('month', v_today) + interval '1 month')::date), false)
    into v_this_month, v_next_month from fiscal_periods;
  check_key := 'periods';
  ok := v_this_month and v_next_month;
  detail := case when ok then 'this month and next month are open'
                 else 'this month and next month must exist and be unlocked' end;
  return next;

  check_key := 'opening_posted';
  ok := exists (select 1 from opening_batches where status = 'posted');
  detail := case when ok then 'opening balances are in the books' else 'opening balances not posted yet' end;
  return next;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_debits, v_credits from journal_lines;
  check_key := 'ledger_balanced';
  ok := v_debits = v_credits;
  detail := 'debits ' || v_debits || ' · credits ' || v_credits;
  return next;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_inv_gl
  from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'inventory';
  select coalesce(sum(value), 0) into v_inv_stock from stock_movements;
  check_key := 'inventory_ties';
  ok := v_inv_gl = v_inv_stock;
  detail := 'Inventory account ' || v_inv_gl || ' · stock ledger ' || v_inv_stock;
  return next;
end;
$$;

revoke all on function public.go_live_readiness() from public, anon;
grant execute on function public.go_live_readiness() to authenticated;
