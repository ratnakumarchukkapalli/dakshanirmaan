-- Change 25 (exports-portability): every export that leaves the system is written to the audit trail.
--
-- The export routes read the books through the signed-in owner's own session, so there is nothing
-- of theirs to hook a trigger on. The route calls this function BEFORE it starts streaming the file
-- and refuses to send anything if the call fails: no audit row, no file.
--
--   p_kind  'books' (full-books workbook) | 'tally' (Tally XML) | 'archive' (year archive ZIP)
--   p_fy    the financial year's starting calendar year (2026 = April 2026 to March 2027)
--
-- Owner at aal2 only (current_app_role() is 'admin' only at aal2). Writes exactly one audit_log row:
-- action 'export', entity = the kind, after = {"fy": <year>}. Nothing else is read or changed.

create or replace function public.log_export(p_kind text, p_fy int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_kind is null or p_kind not in ('books', 'tally', 'archive') then
    raise exception 'DN_VALIDATION:invalid_export_kind';
  end if;
  -- A real year, not a typo: the business cannot predate 2000 nor be exported for a year that has not begun.
  if p_fy is null or p_fy < 2000 or p_fy > extract(year from now())::int + 1 then
    raise exception 'DN_VALIDATION:invalid_financial_year';
  end if;

  insert into audit_log (actor, action, entity, after)
  values (v_actor, 'export', p_kind, jsonb_build_object('fy', p_fy));
end;
$$;

revoke all on function public.log_export(text, int) from public, anon, service_role;
grant execute on function public.log_export(text, int) to authenticated;

-- Who exported what, when, is for owners (like master edits and period locks): a counter session
-- reads the rest of the audit trail as before but not the export rows.
drop policy select_active_members on public.audit_log;
create policy select_active_members on public.audit_log for select
  using (is_active_member()
         and (entity <> 'expense_vouchers' or entity_id is null
              or entity_id not in (select public.hidden_payroll_voucher_ids()))
         and (entity not in ('parties', 'party_addresses', 'items', 'organization', 'accounts', 'fiscal_periods',
                             'books', 'tally', 'archive')
              or current_app_role() = 'admin'));
