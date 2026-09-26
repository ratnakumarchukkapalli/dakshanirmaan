-- Change 15 (reports-p1): the day-close preview and the cash / bank book.
--
-- Also here (Opus review of 14 + 15, 2026-09-26): post_day_close gains `p_expected_seen` (refuses a
-- close whose expected figure moved since the screen showed it) and counter staff cannot close a day
-- earlier than an existing live close (an owner still may, as the change 05 spec allows), and
-- day_close_preview refuses a future date like post_day_close does.
--
-- Everything else the reports read already exists (v_day_book, v_party_aging, v_stock_summary,
-- v_trial_balance, day_closes). Two things did not:
--
--  * The day-close screen has to show the counter the cash figures BEFORE the close is posted. A
--    counter cannot read the cash ledger completely (payroll entries are hidden from them, change
--    13), so a preview built from journal_lines in the app would disagree with what post_day_close
--    then stores. day_close_preview() is SECURITY DEFINER for that reason and repeats
--    post_day_close's arithmetic exactly (a pgTAP drift guard compares the two).
--  * The cash and bank book needs one running balance per money account. v_money_ledger is that
--    view, admin-gated like v_money_balances.

-- ============================================================
-- day_close_preview: what post_day_close(p_date, …) would store as opening / in / out / banked /
-- expected. Any active member (both roles close the day); no side effects.
-- ============================================================
create or replace function public.day_close_preview(p_date date)
returns table (
  close_date   date,
  opening_cash numeric(14,2),
  cash_in      numeric(14,2),
  cash_out     numeric(14,2),
  deposited    numeric(14,2),
  expected     numeric(14,2)
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_role      app_role;
  v_cash_id   uuid;
  v_bank_id   uuid;
  v_opening   numeric(14,2);
  v_cash_in   numeric(14,2);
  v_gross_out numeric(14,2);
  v_deposited numeric(14,2);
  v_cash_out  numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if p_date > (now() at time zone (select timezone from organization limit 1))::date then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  select id into v_cash_id from accounts where system_key = 'cash';
  select id into v_bank_id from accounts where system_key = 'bank';
  if v_cash_id is null or v_bank_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  select coalesce(sum(jl.debit) - sum(jl.credit), 0) into v_opening
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date < p_date;

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_cash_in, v_gross_out
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date = p_date;

  select coalesce(sum(jl.credit), 0) into v_deposited
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id
    and je.entry_date = p_date
    and jl.credit > 0
    and exists (
      select 1 from journal_lines b
      where b.entry_id = jl.entry_id and b.account_id = v_bank_id and b.debit > 0
    );

  v_cash_out := v_gross_out - v_deposited;

  return query select p_date, v_opening, v_cash_in, v_cash_out, v_deposited,
                      (v_opening + v_cash_in - v_cash_out - v_deposited)::numeric(14,2);
end;
$$;

revoke all on function public.day_close_preview(date) from public, anon, service_role;
grant execute on function public.day_close_preview(date) to authenticated;

-- ============================================================
-- Cash and bank book: every posted line on a money account with the account's running balance
-- (debit - credit, all-time, inclusive of the row), like v_party_ledger. The app reads a date
-- range of rows; the opening balance of a range is the running_balance of the last row before it.
-- Reversals are their own rows. Admin-only (bank balances and payroll cash are not counter data).
-- ============================================================
create view v_money_ledger with (security_invoker = true) as
select
  a.id as account_id,
  a.code as account_code,
  a.name as account_name,
  a.system_key as account_key,
  je.entry_date,
  je.id as entry_id,
  je.entry_no,
  jl.id as line_id,
  jl.line_no,
  je.source_type,
  je.source_id,
  d.doc_no,
  je.narration,
  (je.id in (select r.reversed_by from journal_entries r where r.reversed_by is not null)) as is_reversal,
  jl.debit,
  jl.credit,
  (sum(jl.debit - jl.credit)
     over (partition by jl.account_id
           order by je.entry_date, je.entry_no, jl.line_no, jl.id))::numeric(14,2) as running_balance
from journal_lines jl
join accounts a on a.id = jl.account_id and a.is_money and not a.is_group
join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
left join v_document_refs d on d.source_type = je.source_type and d.source_id = je.source_id
where (select current_app_role()) = 'admin';

revoke all on public.v_money_ledger from public, anon, authenticated, service_role;
grant select on public.v_money_ledger to authenticated;

-- ============================================================
-- post_day_close: + p_expected_seen, + counter closes in order. Body otherwise identical to the
-- change 05 definition (same arithmetic, same locks, same audit row); the old 3-argument function is
-- dropped so a 3-argument call resolves to this one (p_expected_seen defaults to NULL = no check).
-- ============================================================
drop function public.post_day_close(date, numeric, text);

create function public.post_day_close(p_date date, p_counted numeric, p_note text default null, p_expected_seen numeric default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_today         date;
  v_period_locked bool;
  v_close_id      uuid;
  v_entry_id      uuid;

  v_cash_id       uuid;
  v_bank_id       uuid;
  v_over_short_id uuid;

  v_counted       numeric(14,2);
  v_opening       numeric(14,2);
  v_cash_in       numeric(14,2);
  v_gross_out     numeric(14,2);
  v_deposited     numeric(14,2);
  v_cash_out      numeric(14,2);
  v_expected      numeric(14,2);
  v_difference    numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Both roles: the spec singles out *reopening* as admin-only, which reads as the close
  -- itself being part of the counter's daily work. Reopening goes through cancel_document,
  -- which is admin-only for every document type.
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  if p_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'DN_VALIDATION:invalid_counted';
  end if;
  v_counted := round(p_counted, 2);

  -- "today" in the org's timezone, never current_date (Non-functional invariants -> Time zone).
  select (now() at time zone (select timezone from organization limit 1))::date into v_today;
  if p_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', p_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  select id into v_cash_id       from accounts where system_key = 'cash';
  select id into v_bank_id       from accounts where system_key = 'bank';
  select id into v_over_short_id from accounts where system_key = 'cash_over_short';
  if v_cash_id is null or v_bank_id is null or v_over_short_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  if exists (select 1 from day_closes where close_date = p_date and status <> 'cancelled') then
    raise exception 'DN_VALIDATION:already_closed';
  end if;

  -- Counter staff close days in order. Closing an earlier day after a later one is closed would
  -- book the drawer's current cash against a past date's ledger (an owner may, and reopens first).
  if v_role = 'user' and exists (select 1 from day_closes where close_date > p_date and status <> 'cancelled') then
    raise exception 'DN_VALIDATION:later_close_exists';
  end if;

  -- Opening = the cash ledger's closing balance the day before.
  select coalesce(sum(jl.debit) - sum(jl.credit), 0) into v_opening
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date < p_date;

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_cash_in, v_gross_out
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date = p_date;

  -- Deposits are cash credits whose contra is the bank ledger. They are reported separately
  -- from cash_out so the close reads as "took in X, paid out Y, banked Z" — and so they are
  -- subtracted exactly once: cash_out below excludes them.
  select coalesce(sum(jl.credit), 0) into v_deposited
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id
    and je.entry_date = p_date
    and jl.credit > 0
    and exists (
      select 1 from journal_lines b
      where b.entry_id = jl.entry_id and b.account_id = v_bank_id and b.debit > 0
    );

  v_cash_out   := v_gross_out - v_deposited;
  v_expected   := v_opening + v_cash_in - v_cash_out - v_deposited;
  v_difference := v_counted - v_expected;

  -- The counter compared their count with the expected figure the screen showed. If the ledger
  -- moved since (another sale, a receipt), that comparison is stale: refuse and let them recount.
  if p_expected_seen is not null and round(p_expected_seen, 2) <> v_expected then
    raise exception 'DN_VALIDATION:expected_changed';
  end if;

  begin
    insert into day_closes
      (close_date, opening_cash, cash_in, cash_out, deposited, expected, counted, difference,
       note, closed_by, closed_at)
    values
      (p_date, v_opening, v_cash_in, v_cash_out, v_deposited, v_expected, v_counted,
       v_difference, p_note, v_actor, now())
    returning id into v_close_id;
  exception when unique_violation then
    -- Two counters closing the same date at the same moment: the partial unique index is the
    -- serialization point, and the loser gets the mapped code rather than a raw constraint.
    raise exception 'DN_VALIDATION:already_closed';
  end;

  -- A difference of exactly zero has nothing to post; the close still exists as the record
  -- that the count was done (journal_entry_id stays NULL).
  if v_difference <> 0 then
    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (p_date, 'Day close ' || to_char(p_date, 'DD-MM-YYYY'), 'day_close', v_close_id,
            v_actor, now())
    returning id into v_entry_id;

    if v_difference < 0 then
      -- Short: the drawer holds less than the books say.
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 1, v_over_short_id, -v_difference, 0);
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 2, v_cash_id, 0, -v_difference);
    else
      -- Over: more cash than the books say.
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 1, v_cash_id, v_difference, 0);
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 2, v_over_short_id, 0, v_difference);
    end if;

    update day_closes set journal_entry_id = v_entry_id where id = v_close_id;
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'day_closes', v_close_id,
          jsonb_build_object('close_date', p_date, 'expected', v_expected,
            'counted', v_counted, 'difference', v_difference, 'entry_id', v_entry_id));

  return v_entry_id;
end;
$$;

revoke all on function public.post_day_close(date, numeric, text, numeric) from public, anon, service_role;
grant execute on function public.post_day_close(date, numeric, text, numeric) to authenticated;
