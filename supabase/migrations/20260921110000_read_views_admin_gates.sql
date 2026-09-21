-- Second review of change 06 (read views): salary and bank data are owner-only, like P&L.
--
-- Until now only v_trial_balance / v_pnl / v_balance_sheet returned nothing to a counter user.
-- v_employee_ledger (every employee's salary and advance history) and v_bank_recon (book and bank
-- balances) were readable by any active member, and so were the imported bank statements.
--
-- The two views are wrapped, not rewritten: the existing definition becomes a sub-select, so the
-- columns, their order and their types cannot drift, and the grants survive.

do $$
declare
  v text;
  d text;
begin
  foreach v in array array['v_employee_ledger', 'v_bank_recon'] loop
    d := regexp_replace(pg_get_viewdef(('public.' || v)::regclass, true), ';\s*$', '');
    execute format(
      'create or replace view public.%I with (security_invoker = true) as '
      'select * from (%s) gated where (select current_app_role()) = ''admin''', v, d);
  end loop;
end
$$;

-- The statements themselves: owner-only to read as well as to write.
drop policy select_active_members on bank_statements;
drop policy select_active_members on bank_statement_lines;
create policy select_admin on bank_statements for select using (current_app_role() = 'admin');
create policy select_admin on bank_statement_lines for select using (current_app_role() = 'admin');
