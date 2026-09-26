-- Change 13, review fixes (Opus review, database): salary and wages are owner-only everywhere.
--
-- Owner decision (docs/STATUS.md): employee salary/wages are visible to the owners only.
-- 20260926100000 hid the pay RATES and the salary/wage voucher headers, but the review found two
-- doors still open to a counter (`user`) session:
--
--   1. An UPDATE oracle on the pay rates. parties_guard refuses a counter's change to a non-
--      whitelisted column only when the value DIFFERS from the stored one, so
--      `update parties set monthly_salary = 18000` succeeded exactly when 18000 was right.
--      A few hundred PATCH requests recovered any salary.
--   2. The AMOUNTS. Every salary/wage voucher posts a journal entry whose lines name the employee
--      (salary_payable / employee_advance carry party_id = the employee, gross and recovery in
--      plain figures), v_day_book shows its total, and audit_log carries
--      {"voucher_type":"salary","gross":...} for every post and cancel.
--
-- Closed here:
--   1. parties_pay_guard: BEFORE UPDATE OF monthly_salary, daily_wage — any app session that is
--      not an admin is refused even when the value is unchanged. (INSERT needs nothing new:
--      parties_guard already nulls both columns on a counter's insert and refuses type employee.)
--   2. Row-level security on journal_entries, journal_lines and audit_log: a non-admin does not
--      see the entries of salary and wage vouchers (the original and its cancellation share the
--      voucher as source), their lines, or the audit rows of those vouchers. The WHOLE entry is
--      hidden, never some of its lines, so every view a counter reads stays balanced.
--   3. check_journal_balanced / check_journal_has_lines become SECURITY DEFINER: both are
--      deferred constraint triggers that run at COMMIT as the session role, i.e. under that role's
--      row-level security. A check that can be blinded by RLS is not a check.
--
-- Deliberately NOT hidden: advance vouchers and their entries (a counter may post an advance up to
-- Rs 5,000 and 20260926100000 kept advance vouchers visible to them); ordinary expense vouchers
-- even when they post to the Salaries account (5500) — only the salary/wages voucher types are
-- payroll by rule.

-- ============================================================
-- 1. Pay rates: no UPDATE of the two columns by a non-admin, same value or not
-- ============================================================
-- UPDATE OF fires whenever a column is in the SET list (PostgREST PATCH sends exactly the
-- columns in the body), so the refusal no longer depends on the value and reveals nothing.
-- SECURITY DEFINER paths keep auth.uid(), so an admin's employee edit still passes and a
-- counter cannot reach the columns through any function either. No app session (seed,
-- migrations, the database owner) is unaffected.
create or replace function public.parties_pay_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not coalesce(current_app_role() = 'admin', false) then
    raise exception 'DN_VALIDATION:admin_only_field';
  end if;
  return new;
end;
$$;

revoke all on function public.parties_pay_guard() from public, anon, authenticated, service_role;

create trigger parties_pay_guard before update of monthly_salary, daily_wage on parties
for each row execute function public.parties_pay_guard();

-- ============================================================
-- 2. Payroll entries: owner-only rows
-- ============================================================
-- The two helpers return the ids a NON-admin must not see, and nothing at all to an admin, so an
-- admin's policies reduce to what they were. They are SECURITY DEFINER because the voucher
-- headers they look at are themselves invisible to a counter (a policy sub-select under the
-- caller's own RLS would find no salary voucher and hide nothing). The database owner bypasses
-- RLS, so reading journal_entries from inside a journal_entries policy does not recurse.
--
-- Policies use them as `x not in (select f())`: an uncorrelated sub-select that Postgres runs
-- once per query and probes as a hash, not once per row. Neither function ever returns NULL
-- (primary keys), so NOT IN has no NULL trap.
create or replace function public.hidden_payroll_voucher_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ev.id
  from expense_vouchers ev
  where ev.voucher_type in ('salary', 'wages')
    and not coalesce(current_app_role() = 'admin', false);
$$;

create or replace function public.hidden_payroll_entry_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- A cancellation's reversal entry carries the same source as the original, so both go.
  select je.id
  from expense_vouchers ev
  join journal_entries je on je.source_type = 'expense_voucher' and je.source_id = ev.id
  where ev.voucher_type in ('salary', 'wages')
    and not coalesce(current_app_role() = 'admin', false);
$$;

-- Policies are evaluated as the caller, so the caller needs EXECUTE. Calling either one directly
-- tells a counter only which ids exist and are hidden — never an amount, a name or a date.
revoke all on function public.hidden_payroll_voucher_ids() from public, anon, service_role;
revoke all on function public.hidden_payroll_entry_ids() from public, anon, service_role;
grant execute on function public.hidden_payroll_voucher_ids() to authenticated;
grant execute on function public.hidden_payroll_entry_ids() to authenticated;

drop policy select_active_members on public.journal_entries;
create policy select_active_members on public.journal_entries for select
  using (is_active_member() and id not in (select public.hidden_payroll_entry_ids()));

-- Lines are decided by their entry, never by their party: the Dr Salaries and Cr Cash lines of a
-- salary carry no party but are the same amounts.
drop policy select_active_members on public.journal_lines;
create policy select_active_members on public.journal_lines for select
  using (is_active_member() and entry_id not in (select public.hidden_payroll_entry_ids()));

-- Posting and cancelling a salary/wage voucher writes entity 'expense_vouchers' rows with the
-- gross and the recovery in `after`. (No audit row ever names parties or their pay columns.)
drop policy select_active_members on public.audit_log;
create policy select_active_members on public.audit_log for select
  using (is_active_member()
         and (entity <> 'expense_vouchers' or entity_id is null
              or entity_id not in (select public.hidden_payroll_voucher_ids())));

-- ============================================================
-- 3. Deferred ledger checks must not be blinded by row-level security
-- ============================================================
-- A deferred constraint trigger fires at COMMIT as the session role (not as the SECURITY DEFINER
-- posting function that wrote the rows), so it reads journal_lines under that role's policies.
-- Today only an admin can write a payroll entry, so nothing is blinded; this makes it true by
-- construction rather than by the role matrix.
alter function public.check_journal_balanced() security definer;
alter function public.check_journal_has_lines() security definer;
revoke all on function public.check_journal_balanced() from public, anon, authenticated, service_role;
revoke all on function public.check_journal_has_lines() from public, anon, authenticated, service_role;
