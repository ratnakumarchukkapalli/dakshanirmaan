-- db-architecture spec: "Integrity triggers"
-- Item 4 ("No negative stock") is explicitly not a trigger per spec — it's checked inside the
-- post_* functions (change 03+). Nothing to add here for it.

-- 1. Balanced entries — deferred constraint trigger on journal_lines: at transaction end, for
--    each touched entry_id, SUM(debit) = SUM(credit) else RAISE.
create or replace function public.check_journal_balanced()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_entry_id uuid;
  v_sum_debit numeric(14,2);
  v_sum_credit numeric(14,2);
begin
  v_entry_id := coalesce(new.entry_id, old.entry_id);

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_sum_debit, v_sum_credit
  from journal_lines
  where entry_id = v_entry_id;

  if v_sum_debit <> v_sum_credit then
    raise exception 'journal entry % is not balanced: debit % <> credit %',
      v_entry_id, v_sum_debit, v_sum_credit;
  end if;

  return null; -- AFTER trigger return value is ignored
end;
$$;

create constraint trigger journal_lines_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function public.check_journal_balanced();

-- 2. Immutability — journal_entries: RAISE on DELETE always; on UPDATE, RAISE unless the only
--    change is setting reversed_by on a previously-NULL value.
create or replace function public.check_journal_entry_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'journal_entries rows are immutable: DELETE is not allowed (id=%)', old.id;
  end if;

  if old.reversed_by is not null then
    raise exception 'journal_entries.reversed_by can only be set once (id=%)', old.id;
  end if;

  if new.reversed_by is null
     or old.id is distinct from new.id
     or old.entry_no is distinct from new.entry_no
     or old.entry_date is distinct from new.entry_date
     or old.narration is distinct from new.narration
     or old.source_type is distinct from new.source_type
     or old.source_id is distinct from new.source_id
     or old.status is distinct from new.status
     or old.posted_by is distinct from new.posted_by
     or old.posted_at is distinct from new.posted_at
     or old.created_at is distinct from new.created_at
  then
    raise exception
      'journal_entries rows are immutable except setting reversed_by once (id=%)', old.id;
  end if;

  return new;
end;
$$;

create trigger immutable_journal_entries
  before update or delete on journal_entries
  for each row execute function public.check_journal_entry_immutable();

-- Immutability — journal_lines and stock_movements: RAISE on UPDATE or DELETE, no exceptions.
create or replace function public.reject_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% on % is not allowed: rows are immutable (id=%)',
    tg_op, tg_table_name, old.id;
end;
$$;

create trigger immutable_journal_lines
  before update or delete on journal_lines
  for each row execute function public.reject_mutation();

create trigger immutable_stock_movements
  before update or delete on stock_movements
  for each row execute function public.reject_mutation();

-- 3. Period lock — BEFORE INSERT on journal_entries and stock_movements: RAISE if the date's
--    fiscal_periods.is_locked. No matching fiscal_periods row is treated as blocked: the period
--    must be created before postings can land in it.
create or replace function public.check_period_not_locked()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_locked bool;
begin
  if tg_table_name = 'stock_movements' then
    v_date := new.movement_date;
  else
    v_date := new.entry_date;
  end if;

  select is_locked into v_locked
  from fiscal_periods
  where month = date_trunc('month', v_date)::date;

  if v_locked is null then
    raise exception 'no fiscal period defined for %; create the period before posting', v_date;
  end if;

  if v_locked then
    raise exception 'fiscal period for % is locked', v_date;
  end if;

  return new;
end;
$$;

create trigger period_lock_journal_entries
  before insert on journal_entries
  for each row execute function public.check_period_not_locked();

create trigger period_lock_stock_movements
  before insert on stock_movements
  for each row execute function public.check_period_not_locked();

-- 5. Leaf-only postings — BEFORE INSERT on journal_lines: RAISE if accounts.is_group.
create or replace function public.check_leaf_account()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_group bool;
begin
  select is_group into v_is_group from accounts where id = new.account_id;

  if v_is_group then
    raise exception 'account % is a group account; postings are leaf-only', new.account_id;
  end if;

  return new;
end;
$$;

create trigger leaf_only_journal_lines
  before insert on journal_lines
  for each row execute function public.check_leaf_account();

-- 6. Minimum lines — deferred constraint trigger on journal_entries: at transaction end, an
--    entry must have at least 2 journal_lines rows.
create or replace function public.check_journal_has_lines()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_line_count int;
begin
  select count(*) into v_line_count
  from journal_lines
  where entry_id = new.id;

  if v_line_count < 2 then
    raise exception 'journal entry % has fewer than 2 lines', new.id;
  end if;

  return null; -- AFTER trigger return value is ignored
end;
$$;

create constraint trigger journal_entries_have_lines
  after insert on journal_entries
  deferrable initially deferred
  for each row execute function public.check_journal_has_lines();

-- 7. Party rule — BEFORE INSERT on journal_lines: party_id required when the posted account is
--    a control account, forbidden otherwise.
create or replace function public.check_line_party()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_is_control bool;
begin
  select is_control into v_is_control from accounts where id = new.account_id;

  if v_is_control and new.party_id is null then
    raise exception 'control account % requires party_id', new.account_id;
  end if;

  if not v_is_control and new.party_id is not null then
    raise exception 'party_id is only allowed on control accounts (account %)', new.account_id;
  end if;

  return new;
end;
$$;

create trigger line_party_rule_journal_lines
  before insert on journal_lines
  for each row execute function public.check_line_party();
