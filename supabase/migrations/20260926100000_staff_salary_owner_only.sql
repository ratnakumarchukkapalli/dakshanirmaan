-- Change 13 (parties / stock / staff UI): salary and wage data are owner-only, in the database.
--
-- Owner decision (docs/STATUS.md, 2026-09-21): employee salary/wages are visible to the owners only.
-- Change 06's second review already made v_employee_ledger owner-only, but two other doors stood
-- open to any active member through the API:
--   1. parties.monthly_salary / parties.daily_wage  (the pay rates)
--   2. expense_vouchers / expense_voucher_lines rows of type salary and wages (what was paid)
-- Closed here. The journal narrations / v_day_book copy of the same facts is NOT closed here (it
-- needs journal_lines row-level rules that touch every read view): it is logged for change 19.
--
--   1. parties: SELECT without the two salary columns for `authenticated`
--   2. employee_pay_rates(): the owner-only way back to the rates (SECURITY DEFINER, admin-gated)
--   3. expense_vouchers + lines: salary/wage vouchers visible to admins only
--   4. v_employees: the staff list read model (security_invoker like every other v_* view)

-- ============================================================
-- 1. parties: column-level SELECT
-- ============================================================
-- Column privileges cannot be taken away from a table that has a table-level grant, so the
-- table-level SELECT goes and every other column is granted back by name. A column added to
-- `parties` later gets no SELECT until someone grants it on purpose (the failure is loud:
-- "permission denied for table parties"), which is the safe direction for a table that holds pay.
revoke select on public.parties from authenticated;
grant select (
  id, created_at, name, type, gstin, state_code, phone, credit_limit, credit_days, is_active,
  is_walk_in, interest_rate_pm, whatsapp_phone, default_site_id
) on public.parties to authenticated;

-- ============================================================
-- 2. employee_pay_rates(): the only reader of the two columns
-- ============================================================
create or replace function public.employee_pay_rates()
returns table (party_id uuid, monthly_salary numeric(14,2), daily_wage numeric(14,2))
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.monthly_salary, p.daily_wage
  from parties p
  where p.type = 'employee' and current_app_role() = 'admin';
$$;

revoke all on function public.employee_pay_rates() from public, anon, service_role;
grant execute on function public.employee_pay_rates() to authenticated;

-- ============================================================
-- 3. expense vouchers: salary and wages are owner-only to read
-- ============================================================
-- A counter user still sees expense and advance vouchers (they may record advances up to Rs 5,000).
drop policy select_active_members on public.expense_vouchers;
create policy select_active_members on public.expense_vouchers for select
  using (is_active_member() and (voucher_type not in ('salary', 'wages') or current_app_role() = 'admin'));

-- The lines follow their header: the sub-select runs under the caller's own row-level security,
-- so a header the caller cannot see hides its lines too.
drop policy select_active_members on public.expense_voucher_lines;
create policy select_active_members on public.expense_voucher_lines for select
  using (is_active_member() and exists (select 1 from public.expense_vouchers h where h.id = voucher_id));

-- ============================================================
-- 4. v_employees: one row per employee for the staff list
-- ============================================================
-- Owner-only (zero rows for anyone else, like v_employee_ledger). The pay rates come through
-- employee_pay_rates(); the balances are Σ over the employee's posted control-account lines:
--   advance_balance = Σ(debit - credit) on employee_advance  (positive = the employee owes us)
--   payable_balance = Σ(credit - debit) on salary_payable    (positive = we owe the employee)
create view v_employees with (security_invoker = true) as
select
  p.id as party_id,
  p.name,
  p.phone,
  p.whatsapp_phone,
  p.is_active,
  r.monthly_salary,
  r.daily_wage,
  coalesce(b.advance_balance, 0)::numeric(14,2) as advance_balance,
  coalesce(b.payable_balance, 0)::numeric(14,2) as payable_balance
from parties p
join employee_pay_rates() r on r.party_id = p.id
left join (
  select
    jl.party_id,
    sum(jl.debit - jl.credit) filter (where a.system_key = 'employee_advance') as advance_balance,
    sum(jl.credit - jl.debit) filter (where a.system_key = 'salary_payable') as payable_balance
  from journal_lines jl
  join accounts a on a.id = jl.account_id and a.system_key in ('employee_advance', 'salary_payable')
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  where jl.party_id is not null
  group by jl.party_id
) b on b.party_id = p.id
where p.type = 'employee' and (select current_app_role()) = 'admin';

revoke all on public.v_employees from public, anon, authenticated, service_role;
grant select on public.v_employees to authenticated;
