-- Second independent review of changes 08 + 09 (database half). New file only: the earlier
-- migrations stay as they were applied.
--
-- 1. Walk-in customer: credit terms and state can no longer be changed by anyone.
-- 2. Counter-user updates on parties are a WHITELIST, not a list of forbidden columns.
-- 3. Organisation state / FY start lock once ANY entry has been posted or any number issued.
-- 4. GSTIN check digit enforced in the database; HSN is 4, 6 or 8 digits; second unit not blank.
--
-- (Owner-at-step-1 on the masters policies is closed by change 19, which makes
-- current_app_role() / is_active_member() aal-aware for every table at once.)

-- ============================================================
-- 1. GSTIN check digit (same mod-36 rule as src/lib/gst.ts)
-- ============================================================
-- Pure and immutable, so a CHECK can use it. Execute stays with PUBLIC on purpose: a CHECK runs
-- with the caller's privileges, and the function reads nothing.
create or replace function public.gstin_checksum_ok(g text)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_sum int := 0;
  v_prod int;
begin
  if g !~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' then
    return false;
  end if;
  for i in 1..14 loop
    v_prod := (strpos(alphabet, substr(g, i, 1)) - 1) * case when i % 2 = 1 then 1 else 2 end;
    v_sum := v_sum + v_prod / 36 + v_prod % 36;
  end loop;
  return substr(alphabet, ((36 - v_sum % 36) % 36) + 1, 1) = substr(g, 15, 1);
end;
$$;

alter table parties drop constraint parties_gstin_check;
alter table parties add constraint parties_gstin_check
  check (gstin is null or (gstin_checksum_ok(gstin) and left(gstin, 2) = state_code));
alter table organization drop constraint organization_gstin_check;
alter table organization add constraint organization_gstin_check
  check (gstin is null or (gstin_checksum_ok(gstin) and left(gstin, 2) = state_code));

-- ============================================================
-- 2. Item checks
-- ============================================================
-- HSN codes exist at 4, 6 and 8 digits only.
alter table items drop constraint items_hsn_check;
alter table items add constraint items_hsn_check check (hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$');

-- The second unit must be a real, different unit: not blank, and 'KG' is the same as 'kg'.
alter table items drop constraint items_alt_uom_check;
alter table items add constraint items_alt_uom_check
  check ((alt_uom is null and conversion_factor is null)
      or (alt_uom is not null
          and btrim(alt_uom) <> ''
          and coalesce(conversion_factor > 0, false)
          and lower(btrim(alt_uom)) <> lower(btrim(base_uom))));

-- 1..12 only; anything else breaks the financial-year label in next_doc_no.
alter table organization add constraint organization_fy_start_check check (fy_start_month between 1 and 12);

-- ============================================================
-- 3. parties_guard: walk-in fully protected, counter updates whitelisted
-- ============================================================
create or replace function public.parties_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app_session bool := auth.uid() is not null;
  -- coalesce: a signed-in person with no active membership has no role (NULL) — that must count
  -- as "not an admin", never as "unknown, so allow".
  v_admin bool := coalesce(current_app_role() = 'admin', false);
  v_has_balance bool := false;
  -- The ONLY columns a counter user may change on an existing party. Anything else — including
  -- a column added in a later change — is owner-only until this list is extended on purpose.
  v_counter_cols constant text[] := array['name', 'phone', 'whatsapp_phone', 'default_site_id'];
begin
  if tg_op = 'INSERT' then
    if new.is_walk_in then
      -- Only the seed makes the walk-in party.
      if v_app_session then raise exception 'DN_VALIDATION:walk_in_protected'; end if;
    end if;
    if v_app_session and not v_admin then
      -- A counter user may add a customer or supplier, but on no credit and with no salary.
      if new.type = 'employee' then raise exception 'DN_VALIDATION:admin_only_field'; end if;
      new.credit_limit := 0;
      new.credit_days := 0;
      new.interest_rate_pm := 0;
      new.monthly_salary := null;
      new.daily_wage := null;
      -- A new party is always born active; disabling is an owner decision.
      new.is_active := true;
    end if;
    return new;
  end if;

  -- UPDATE
  -- The walk-in party takes cash sales only: it may never get credit terms (NULL credit_limit
  -- means unlimited credit to the posting engine), a GSTIN, another type, or be disabled.
  if old.is_walk_in and (new.type is distinct from old.type
                         or new.is_active is distinct from old.is_active
                         or new.is_walk_in is distinct from old.is_walk_in
                         or new.gstin is distinct from old.gstin
                         or new.state_code is distinct from old.state_code
                         or new.credit_limit is distinct from old.credit_limit
                         or new.credit_days is distinct from old.credit_days
                         or new.interest_rate_pm is distinct from old.interest_rate_pm) then
    raise exception 'DN_VALIDATION:walk_in_protected';
  end if;
  if new.is_walk_in is distinct from old.is_walk_in then
    raise exception 'DN_VALIDATION:walk_in_protected';
  end if;
  if new.type is distinct from old.type and (old.type = 'employee' or new.type = 'employee') then
    raise exception 'DN_VALIDATION:party_type_locked';
  end if;

  -- Owner-only on an existing party: everything except the whitelisted contact columns.
  if v_app_session and not v_admin
     and (to_jsonb(new) - v_counter_cols) is distinct from (to_jsonb(old) - v_counter_cols) then
    raise exception 'DN_VALIDATION:admin_only_field';
  end if;

  -- Journal lines carry party_id only on control accounts, so a non-zero net on any of them
  -- means an open balance.
  if (old.is_active and not new.is_active) or new.type is distinct from old.type then
    v_has_balance := exists (
      select 1 from journal_lines where party_id = old.id
       group by account_id having sum(debit) - sum(credit) <> 0);
  end if;

  -- Disabling a party that still owes or is owed money would hide a receivable / payable from
  -- every picker.
  if old.is_active and not new.is_active and v_has_balance then
    raise exception 'DN_VALIDATION:party_has_balance';
  end if;

  -- Changing the type while money is open could drop the party out of the receivable or payable
  -- view. Widening to 'both' keeps every role, so it is harmless; anything else is refused —
  -- for owners too.
  if new.type is distinct from old.type and new.type <> 'both' and v_has_balance then
    raise exception 'DN_VALIDATION:party_type_has_balance';
  end if;
  return new;
end;
$$;

-- ============================================================
-- 4. organization_guard: lock once ANY entry exists or any number was issued
-- ============================================================
-- The state decides intra- vs inter-state tax on every document (expenses, notes, purchases too),
-- and the FY start decides the label in every number series (receipts and vouchers included) —
-- so "no posted sales/purchase invoice" was too narrow.
create or replace function public.organization_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.state_code is distinct from old.state_code or new.fy_start_month is distinct from old.fy_start_month)
     and (exists (select 1 from journal_entries)
       or exists (select 1 from doc_sequences where next_no > 1)
       or exists (select 1 from sales_invoices where status <> 'draft')
       or exists (select 1 from purchase_invoices where status <> 'draft')) then
    raise exception 'DN_VALIDATION:org_state_locked';
  end if;
  return new;
end;
$$;

-- create or replace keeps the existing revokes; re-assert so this file stands on its own.
revoke all on function public.parties_guard() from public, anon, authenticated, service_role;
revoke all on function public.organization_guard() from public, anon, authenticated, service_role;
