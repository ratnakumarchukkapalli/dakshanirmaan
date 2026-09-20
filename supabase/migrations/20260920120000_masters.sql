-- Change 09 (masters): the first data-entry tables open for writing.
--
-- Parties and their addresses may be written by any active member (a counter user adds a new
-- customer on the spot). Items and the organisation row are owner-only. Nothing can be deleted,
-- only disabled. The rules that protect the books from a mistake in a master record live HERE,
-- as checks and guard triggers, so they hold whatever code (or hand-made request) writes.
--
-- Deliberately still closed (no screen yet): warehouses, accounts, fiscal_periods, doc_sequences.

-- ============================================================
-- 1. New columns
-- ============================================================
alter table parties add column whatsapp_phone text;
alter table parties add column default_site_id uuid;

alter table organization add column upi_vpa text;
alter table organization add column invoice_bank_details text;
alter table organization add column invoice_footer text;

-- default_site_id must be one of THIS party's own addresses: a composite key makes that a
-- database fact rather than an app habit. (NULL = no default site; the FK is then not checked.)
alter table party_addresses add constraint party_addresses_party_id_id_key unique (party_id, id);
alter table parties add constraint parties_default_site_fk
  foreign key (id, default_site_id) references party_addresses (party_id, id);

-- ============================================================
-- 2. Validity checks
-- ============================================================
-- GST state / UT codes: 01-38, 97 (other territory), 99 (centre jurisdiction).
alter table parties add constraint parties_state_code_check
  check (state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');
alter table party_addresses add constraint party_addresses_state_code_check
  check (state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');
alter table organization add constraint organization_state_code_check
  check (state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');

-- A GSTIN's first two digits are the registration state. If they disagree with the party's
-- state, the invoice would silently switch between CGST+SGST and IGST — so refuse it here.
alter table parties add constraint parties_gstin_check
  check (gstin is null or (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' and left(gstin, 2) = state_code));
alter table organization add constraint organization_gstin_check
  check (gstin is null or (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' and left(gstin, 2) = state_code));
-- One GSTIN, one party (duplicate customers are the classic trading-book mess).
create unique index parties_gstin_key on parties (gstin) where gstin is not null;

alter table parties add constraint parties_name_check check (btrim(name) <> '');
alter table parties add constraint parties_phone_check check (phone is null or phone ~ '^[0-9]{6,13}$');
alter table parties add constraint parties_whatsapp_check
  check (whatsapp_phone is null or whatsapp_phone ~ '^[6-9][0-9]{9}$');
alter table parties add constraint parties_terms_check
  check (coalesce(credit_limit, 0) >= 0 and credit_days >= 0 and interest_rate_pm >= 0);

-- At most one billing address per party.
create unique index party_addresses_one_default on party_addresses (party_id) where is_default;

alter table items add constraint items_name_check check (btrim(name) <> '' and btrim(base_uom) <> '');
alter table items add constraint items_hsn_check check (hsn_code ~ '^[0-9]{4,8}$');
alter table items add constraint items_rates_check
  check (gst_rate between 0 and 100 and sale_rate >= 0 and reorder_level >= 0);
-- Pieces-per-kg style pair: both or neither, factor positive, second unit differs from the first.
-- (coalesce: a missing factor makes the comparison NULL, which a CHECK would otherwise accept.)
alter table items add constraint items_alt_uom_check
  check ((alt_uom is null and conversion_factor is null)
      or (alt_uom is not null and coalesce(conversion_factor > 0, false) and alt_uom <> base_uom));

alter table organization add constraint organization_upi_check
  check (upi_vpa is null or upi_vpa ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9]{1,63}$');
alter table organization add constraint organization_legal_name_check check (btrim(legal_name) <> '');

-- ============================================================
-- 3. Guard triggers
-- ============================================================
-- An "app session" is a request carrying a signed-in person (auth.uid() not null). Migrations,
-- the service key and tests running as the database owner have none and are left alone —
-- except where a rule protects the books themselves (balance, walk-in, units, org state).

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
  if old.is_walk_in and (new.type is distinct from old.type or new.is_active is distinct from old.is_active
                         or new.is_walk_in is distinct from old.is_walk_in or new.gstin is distinct from old.gstin) then
    raise exception 'DN_VALIDATION:walk_in_protected';
  end if;
  if new.is_walk_in is distinct from old.is_walk_in then
    raise exception 'DN_VALIDATION:walk_in_protected';
  end if;
  if new.type is distinct from old.type and (old.type = 'employee' or new.type = 'employee') then
    raise exception 'DN_VALIDATION:party_type_locked';
  end if;

  -- Owner-only on an existing party: the terms, the disable switch, and the three fields that
  -- decide how it is taxed and where it shows up — flipping the type could hide a receivable
  -- from the balance view, and gstin / state_code choose intra- vs inter-state tax.
  if v_app_session and not v_admin and (
       new.type is distinct from old.type
    or new.gstin is distinct from old.gstin
    or new.state_code is distinct from old.state_code
    or new.credit_limit is distinct from old.credit_limit
    or new.credit_days is distinct from old.credit_days
    or new.interest_rate_pm is distinct from old.interest_rate_pm
    or new.monthly_salary is distinct from old.monthly_salary
    or new.daily_wage is distinct from old.daily_wage
    or new.is_active is distinct from old.is_active) then
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

create trigger parties_guard before insert or update on parties
  for each row execute function public.parties_guard();

-- An address belongs to one party for life; default_site_id and every invoice snapshot assume it.
create or replace function public.party_addresses_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.party_id is distinct from old.party_id then
    raise exception 'DN_VALIDATION:address_party_locked';
  end if;
  return new;
end;
$$;

create trigger party_addresses_guard before update on party_addresses
  for each row execute function public.party_addresses_guard();

-- Quantities are stored in the base unit. Changing the unit, the pieces-per-kg factor, the
-- category or the stock flag once an item has history would silently rescale that history.
create or replace function public.items_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.base_uom is distinct from old.base_uom
      or new.alt_uom is distinct from old.alt_uom
      or new.conversion_factor is distinct from old.conversion_factor
      or new.category is distinct from old.category
      or new.is_stock is distinct from old.is_stock)
     and (exists (select 1 from stock_movements where item_id = old.id)
       or exists (select 1 from sales_invoice_lines where item_id = old.id)
       or exists (select 1 from purchase_invoice_lines where item_id = old.id)
       or exists (select 1 from credit_note_lines where item_id = old.id)
       or exists (select 1 from debit_note_lines where item_id = old.id)
       or exists (select 1 from delivery_challan_lines where item_id = old.id)
       or exists (select 1 from stock_transfer_lines where item_id = old.id)
       or exists (select 1 from stock_adjustment_lines where item_id = old.id)) then
    raise exception 'DN_VALIDATION:item_units_locked';
  end if;
  return new;
end;
$$;

create trigger items_guard before update on items
  for each row execute function public.items_guard();

-- The organisation's state decides intra- vs inter-state tax on every invoice; the financial
-- year start decides which period a date falls in. Neither may move once invoices exist.
create or replace function public.organization_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.state_code is distinct from old.state_code or new.fy_start_month is distinct from old.fy_start_month)
     and (exists (select 1 from sales_invoices where status <> 'draft')
       or exists (select 1 from purchase_invoices where status <> 'draft')) then
    raise exception 'DN_VALIDATION:org_state_locked';
  end if;
  return new;
end;
$$;

create trigger organization_guard before update on organization
  for each row execute function public.organization_guard();

revoke all on function public.parties_guard() from public, anon, authenticated, service_role;
revoke all on function public.party_addresses_guard() from public, anon, authenticated, service_role;
revoke all on function public.items_guard() from public, anon, authenticated, service_role;
revoke all on function public.organization_guard() from public, anon, authenticated, service_role;

-- ============================================================
-- 4. Write policies (RLS) and second-lock grants
-- ============================================================
-- Parties + addresses: any active member. Items + organisation: owners only.
create policy insert_member on parties for insert with check (is_active_member());
create policy update_member on parties for update using (is_active_member()) with check (is_active_member());
create policy insert_member on party_addresses for insert with check (is_active_member());
create policy update_member on party_addresses for update using (is_active_member()) with check (is_active_member());

create policy insert_admin on items for insert with check (current_app_role() = 'admin');
create policy update_admin on items for update using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
create policy update_admin on organization for update using (current_app_role() = 'admin') with check (current_app_role() = 'admin');

-- No DELETE anywhere (disable instead); the organisation is a single seeded row, never inserted.
-- RLS already has no such policy; take the privileges away too (same second lock as changes 05/08).
revoke delete on parties, party_addresses, items, organization from authenticated;
revoke insert on organization from authenticated;
