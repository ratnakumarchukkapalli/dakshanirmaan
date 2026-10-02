-- Change 24a (quotations) — DB half.
--
-- A quotation is a priced estimate for a customer, valid until a date, that can become a DRAFT
-- sales invoice at exactly the quoted qty / rate / discount. It never posts: no journal entry, no
-- stock movement, no GST liability, and it does not use the GST invoice series (it has its own
-- `QT` series). `source_type 'quotation'` already exists (change 05's enum migration).
--
--   1. quotations + quotation_lines  — read-only to the app (members SELECT); every write goes
--      through the three definer functions below, so snapshots are taken server-side
--   2. guards: a converted quote is immutable, a quote is never deleted, lines change only while
--      the quote is open; deleting the draft invoice a quote became re-opens the quote (accepted)
--   3. v_quotation_lines / v_quotations — display totals computed in the database with exactly
--      post_sales_invoice's per-line arithmetic and round-off rule; effective_status = 'expired'
--      once valid_until has passed (no scheduled job)
--   4. save_quotation(...)  -> {id, quote_no, updated_at}   (create or edit; DN_CONFLICT when stale)
--   5. mark_quotation(id, status) -> updated_at              (open <-> accepted, -> expired)
--   6. convert_quotation_to_invoice(id) -> sales invoice id  (draft only; idempotent)
--
-- post_sales_invoice is NOT changed: its tax arithmetic is interleaved with stock and COGS in one
-- loop, so it is not extracted. The view repeats the four expressions verbatim and pgTAP 00037
-- proves, intra- and inter-state, that a converted-then-posted invoice carries exactly the
-- totals the quote showed.

-- ============================================================
-- 1. Tables
-- ============================================================
create table quotations (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users,
  updated_at           timestamptz not null default now(),
  quote_no             text not null unique,
  quote_date           date not null,
  party_id             uuid not null references parties (id),
  warehouse_id         uuid not null references warehouses (id),
  -- Derived at every save by quote_supply (default delivery site, else billing address, else the
  -- party's state — the invoice form's rule). Conversion derives it again and refuses a mismatch.
  place_of_supply      char(2) not null check (place_of_supply ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$'),
  valid_until          date not null,
  status               text not null default 'open'
                         check (status in ('open', 'accepted', 'expired', 'converted')),
  -- ON DELETE SET NULL: a counter user may throw the draft away; the guard below then re-opens
  -- the quote as 'accepted' (and the CHECK keeps the pair consistent).
  converted_invoice_id uuid references sales_invoices (id) on delete set null,
  converted_at         timestamptz,
  note                 text check (note is null or char_length(note) <= 500),
  check (valid_until >= quote_date),
  check ((status = 'converted') = (converted_invoice_id is not null)),
  check ((converted_invoice_id is null) = (converted_at is null))
);

create index quotations_party_date_idx on quotations (party_id, quote_date desc);
create index quotations_live_idx on quotations (valid_until) where status in ('open', 'accepted');
create unique index quotations_converted_invoice_key on quotations (converted_invoice_id)
  where converted_invoice_id is not null;

create table quotation_lines (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  quote_id     uuid not null references quotations (id) on delete cascade,
  line_no      int not null check (line_no > 0),
  item_id      uuid not null references items (id),   -- NO ACTION: a quoted item cannot be deleted (00033)
  -- Snapshot columns, copied from items by save_quotation (never from the caller).
  item_name    text not null,
  hsn_code     text not null,
  uom          text not null,
  gst_rate     numeric(5,2) not null check (gst_rate >= 0 and gst_rate <= 100),
  qty          numeric(12,3) not null check (qty > 0),
  alt_qty      numeric(12,3) check (alt_qty is null or alt_qty > 0),
  rate         numeric(14,4) not null check (rate >= 0),
  discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  unique (quote_id, line_no)
);

create index quotation_lines_item_idx on quotation_lines (item_id);

create trigger set_created_by before insert or update on quotations
  for each row execute function public.set_created_by();
create trigger touch_updated_at before update on quotations
  for each row execute function public.touch_updated_at();

-- Read-only to the app: any active member reads (counter included; no cost or margin is stored
-- here). Writes only through the definer functions, which act as the function owner.
alter table quotations enable row level security;
alter table quotation_lines enable row level security;
create policy select_active_members on quotations for select using (is_active_member());
create policy select_active_members on quotation_lines for select using (is_active_member());
revoke all on public.quotations, public.quotation_lines from anon, authenticated;
grant select on public.quotations, public.quotation_lines to authenticated;
grant select, insert, update, delete on public.quotations, public.quotation_lines to service_role;

-- ============================================================
-- 2. Guards (apply to every writer, the definer functions and service_role included)
-- ============================================================
create or replace function public.quotations_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- An unwanted quote is marked expired; the row (and its number) stays.
    raise exception 'DN_VALIDATION:quote_no_delete';
  end if;

  if new.quote_no is distinct from old.quote_no or new.created_at is distinct from old.created_at then
    raise exception 'DN_VALIDATION:quote_immutable';
  end if;

  if old.status = 'converted' then
    -- The one change a converted quote accepts: its draft invoice was deleted (the FK's
    -- ON DELETE SET NULL is the only writer of this transition). Re-open it as accepted so the
    -- customer's yes is not lost and it can be converted again.
    if old.converted_invoice_id is not null and new.converted_invoice_id is null
       and not exists (select 1 from sales_invoices where id = old.converted_invoice_id)
       and (to_jsonb(new) - array['converted_invoice_id', 'converted_at', 'status', 'updated_at'])
           = (to_jsonb(old) - array['converted_invoice_id', 'converted_at', 'status', 'updated_at'])
    then
      new.status := 'accepted';
      new.converted_at := null;
      insert into audit_log (actor, action, entity, entity_id, before, after)
      values (auth.uid(), 'reopen', 'quotations', old.id,
              jsonb_build_object('status', 'converted', 'converted_invoice_id', old.converted_invoice_id),
              jsonb_build_object('status', 'accepted', 'reason', 'draft_invoice_deleted'));
      return new;
    end if;
    raise exception 'DN_VALIDATION:quote_converted';
  end if;

  return new;
end;
$$;

revoke all on function public.quotations_guard() from public, anon, authenticated, service_role;

create trigger quotations_guard before update or delete on quotations
  for each row execute function public.quotations_guard();

create or replace function public.quotation_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from quotations
   where id = case when tg_op = 'DELETE' then old.quote_id else new.quote_id end;
  if v_status is distinct from 'open' then
    raise exception 'DN_VALIDATION:quote_not_open';
  end if;
  if tg_op = 'UPDATE' and new.quote_id <> old.quote_id then
    raise exception 'DN_VALIDATION:quote_immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.quotation_lines_guard() from public, anon, authenticated, service_role;

create trigger quotation_lines_guard before insert or update or delete on quotation_lines
  for each row execute function public.quotation_lines_guard();

-- ============================================================
-- 3. Read model
-- ============================================================
-- Per-line amounts: the four expressions are post_sales_invoice's, verbatim
--   taxable = round(qty * rate * (1 - discount_pct / 100), 2)
--   intra:  cgst = sgst = round(taxable * gst_rate / 2 / 100, 2)
--   inter:  igst = round(taxable * gst_rate / 100, 2)
-- with intra = (place of supply = organisation state). Change one, change both (pgTAP 00037).
create view v_quotation_lines with (security_invoker = true) as
select
  ql.id, ql.quote_id, ql.line_no, ql.item_id, ql.item_name, ql.hsn_code, ql.uom, ql.gst_rate,
  ql.qty, ql.alt_qty, ql.rate, ql.discount_pct,
  x.taxable::numeric(14,2) as taxable_value,
  (case when y.intra then round(x.taxable * ql.gst_rate / 2 / 100, 2) else 0 end)::numeric(14,2) as cgst_amt,
  (case when y.intra then round(x.taxable * ql.gst_rate / 2 / 100, 2) else 0 end)::numeric(14,2) as sgst_amt,
  (case when y.intra then 0 else round(x.taxable * ql.gst_rate / 100, 2) end)::numeric(14,2) as igst_amt
from quotation_lines ql
join quotations q on q.id = ql.quote_id
cross join lateral (select round(ql.qty * ql.rate * (1 - ql.discount_pct / 100), 2) as taxable) x
cross join lateral (
  select q.place_of_supply = (select o.state_code from organization o limit 1) as intra
) y;

create view v_quotations with (security_invoker = true) as
with t as (
  select (now() at time zone o.timezone)::date as today, o.state_code as org_state
  from organization o limit 1
),
s as (
  select quote_id, count(*)::int as line_count,
         sum(taxable_value) as taxable_total, sum(cgst_amt) as cgst_total,
         sum(sgst_amt) as sgst_total, sum(igst_amt) as igst_total
  from v_quotation_lines
  group by quote_id
)
select
  q.id, q.quote_no, q.quote_date, q.valid_until, q.status,
  case when q.status in ('open', 'accepted') and q.valid_until < t.today then 'expired'
       else q.status end as effective_status,
  q.party_id, p.name as party_name, p.gstin as party_gstin,
  q.warehouse_id, q.place_of_supply, (q.place_of_supply = t.org_state) as is_intra,
  q.note, q.converted_invoice_id, q.converted_at,
  si.invoice_no as converted_invoice_no, si.status as converted_invoice_status,
  coalesce(s.line_count, 0) as line_count,
  coalesce(s.taxable_total, 0)::numeric(14,2) as taxable_total,
  coalesce(s.cgst_total, 0)::numeric(14,2)    as cgst_total,
  coalesce(s.sgst_total, 0)::numeric(14,2)    as sgst_total,
  coalesce(s.igst_total, 0)::numeric(14,2)    as igst_total,
  (round(r.raw) - r.raw)::numeric(6,2)        as round_off,
  round(r.raw)::numeric(14,2)                 as grand_total,
  q.created_by, q.created_at, q.updated_at
from quotations q
cross join t
join parties p on p.id = q.party_id
left join s on s.quote_id = q.id
left join sales_invoices si on si.id = q.converted_invoice_id
cross join lateral (
  select coalesce(s.taxable_total, 0) + coalesce(s.cgst_total, 0)
       + coalesce(s.sgst_total, 0) + coalesce(s.igst_total, 0) as raw
) r;

revoke all on public.v_quotation_lines, public.v_quotations from public, anon, authenticated, service_role;
grant select on public.v_quotation_lines, public.v_quotations to authenticated;

-- ============================================================
-- 3b. quote_supply: the invoice form's address rule, in one place
-- ============================================================
-- Mirrors src/lib/place-of-supply.ts + InvoiceForm.pickParty + saveDraftInvoice: the delivery site
-- is the party's default_site_id when it points at a NON-billing address; billing is the default
-- address; shipping = the site, else billing; place of supply = the site's state, else billing's,
-- else the party's own. Snapshots use the app's snapshot() keys and defaults. Internal: callable
-- only by the definer functions (owner), nobody else.
create or replace function public.quote_supply(p_party_id uuid,
  out place_of_supply char(2), out billing jsonb, out shipping jsonb)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_party record;
  v_bill  record;
  v_site  record;
begin
  select id, state_code, default_site_id into v_party from parties where id = p_party_id;
  select label, address, state_code into v_bill
  from party_addresses where party_id = p_party_id and is_default;
  if found then
    billing := jsonb_build_object(
      'label', v_bill.label,
      'line1', coalesce(v_bill.address -> 'line1', to_jsonb(''::text)),
      'line2', coalesce(v_bill.address -> 'line2', 'null'::jsonb),
      'city', coalesce(v_bill.address -> 'city', to_jsonb(''::text)),
      'district', coalesce(v_bill.address -> 'district', 'null'::jsonb),
      'pincode', coalesce(v_bill.address -> 'pincode', to_jsonb(''::text)),
      'state_code', v_bill.state_code);
  end if;
  select label, address, state_code into v_site
  from party_addresses
  where party_id = p_party_id and id = v_party.default_site_id and not is_default;
  if found then
    shipping := jsonb_build_object(
      'label', v_site.label,
      'line1', coalesce(v_site.address -> 'line1', to_jsonb(''::text)),
      'line2', coalesce(v_site.address -> 'line2', 'null'::jsonb),
      'city', coalesce(v_site.address -> 'city', to_jsonb(''::text)),
      'district', coalesce(v_site.address -> 'district', 'null'::jsonb),
      'pincode', coalesce(v_site.address -> 'pincode', to_jsonb(''::text)),
      'state_code', v_site.state_code);
    place_of_supply := v_site.state_code;
  else
    shipping := billing;
    place_of_supply := coalesce(v_bill.state_code, v_party.state_code);
  end if;
end;
$$;

revoke all on function public.quote_supply(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- 4. save_quotation
-- ============================================================
-- p_id NULL creates (number assigned now from the QT series); otherwise edits an OPEN quote whose
-- updated_at still equals p_expected_updated_at (else DN_CONFLICT). p_lines is a JSON array of
-- {item_id, qty, rate, discount_pct?, alt_qty?}; numbers as JSON numbers or decimal strings.
-- Name / HSN / UOM / GST rate are copied from items here; anything else the caller sends is ignored.
create or replace function public.save_quotation(
  p_id                  uuid,
  p_expected_updated_at timestamptz,
  p_party_id            uuid,
  p_quote_date          date,
  p_valid_until         date,
  p_note                text,
  p_lines               jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_today       date;
  v_fy_month    int;
  v_old         record;
  v_party       record;
  v_item        record;
  v_wh          uuid;
  v_pos         char(2);
  v_valid_until date;
  v_note        text := nullif(btrim(coalesce(p_note, '')), '');
  v_line        jsonb;
  v_n           int := 0;
  v_item_id     uuid;
  v_txt         text;
  v_qty         numeric;
  v_alt         numeric;
  v_rate        numeric;
  v_disc        numeric;
  v_taxable_sum numeric := 0;
  v_tax_sum     numeric := 0;
  v_intra       bool;
  v_line_tax    numeric;
  v_rows        jsonb := '[]'::jsonb;
  v_quote_id    uuid;
  v_quote_no    text;
  v_fy_start    int;
  v_fy_label    text;
  v_updated_at  timestamptz;
begin
  if v_actor is null or current_app_role() is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select (now() at time zone timezone)::date, fy_start_month into v_today, v_fy_month
  from organization limit 1;

  -- Header -----------------------------------------------------------------
  if p_quote_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if p_quote_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;
  -- Not more than a year back: an old date would otherwise open the QT series of an arbitrary FY
  -- (and the first QT number of any FY makes organization_guard lock the org state + FY start).
  if p_quote_date < v_today - 365 then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  v_valid_until := coalesce(p_valid_until, p_quote_date + 7);
  if v_valid_until < p_quote_date then
    raise exception 'DN_VALIDATION:valid_until_before_date';
  end if;
  if v_valid_until > p_quote_date + 365 then
    raise exception 'DN_VALIDATION:valid_until_too_far';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'DN_VALIDATION:note_too_long';
  end if;

  if p_id is not null then
    select * into v_old from quotations where id = p_id for update;
    if not found then
      raise exception 'DN_VALIDATION:no_such_quote';
    end if;
    if p_expected_updated_at is null or v_old.updated_at <> p_expected_updated_at then
      raise exception 'DN_CONFLICT';
    end if;
    if v_old.status <> 'open' then
      raise exception 'DN_VALIDATION:quote_not_open';
    end if;
    -- The number carries the FY (QT/26-27/0007); a date moved into another FY would contradict it.
    if (extract(year from v_old.quote_date)::int - case when extract(month from v_old.quote_date)::int < v_fy_month then 1 else 0 end)
       <> (extract(year from p_quote_date)::int - case when extract(month from p_quote_date)::int < v_fy_month then 1 else 0 end)
    then
      raise exception 'DN_VALIDATION:quote_fy_change';
    end if;
  end if;

  select * into v_party from parties where id = p_party_id;
  if not found or not v_party.is_active or v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party' using detail = coalesce(v_party.name, '');
  end if;

  -- The invoice form's rule (default delivery site, else billing address, else party state).
  select place_of_supply into v_pos from quote_supply(p_party_id);
  v_intra := (v_pos = (select state_code from organization limit 1));

  select id into v_wh from warehouses where is_default and not is_transit limit 1;
  if v_wh is null then
    raise exception 'DN_VALIDATION:no_default_warehouse';
  end if;

  -- Lines (validated in full before anything is written) ------------------
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'DN_VALIDATION:no_lines';
  end if;
  if jsonb_array_length(p_lines) > 100 then
    raise exception 'DN_VALIDATION:too_many_lines';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'DN_VALIDATION:invalid_line';
    end if;

    v_txt := v_line ->> 'item_id';
    if v_txt is null or v_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'DN_VALIDATION:no_such_item';
    end if;
    v_item_id := v_txt::uuid;
    select id, name, hsn_code, base_uom, gst_rate, alt_uom, is_active into v_item
    from items where id = v_item_id;
    if not found then
      raise exception 'DN_VALIDATION:no_such_item';
    end if;
    if not v_item.is_active then
      raise exception 'DN_VALIDATION:item_inactive' using detail = v_item.name;
    end if;

    v_txt := v_line ->> 'qty';
    if v_txt is null or v_txt !~ '^[0-9]{1,9}([.][0-9]{1,3})?$' then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;
    v_qty := v_txt::numeric;
    if v_qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;

    v_txt := v_line ->> 'rate';
    if v_txt is null or v_txt !~ '^[0-9]{1,10}([.][0-9]{1,4})?$' then
      raise exception 'DN_VALIDATION:invalid_rate';
    end if;
    v_rate := v_txt::numeric;

    v_txt := coalesce(v_line ->> 'discount_pct', '0');
    if v_txt !~ '^[0-9]{1,3}([.][0-9]{1,2})?$' or v_txt::numeric > 100 then
      raise exception 'DN_VALIDATION:invalid_discount';
    end if;
    v_disc := v_txt::numeric;

    -- Pieces only for an item that has an alternate unit (as the invoice form); else dropped.
    v_alt := null;
    v_txt := v_line ->> 'alt_qty';
    if v_txt is not null and v_item.alt_uom is not null then
      if v_txt !~ '^[0-9]{1,9}([.][0-9]{1,3})?$' or v_txt::numeric <= 0 then
        raise exception 'DN_VALIDATION:invalid_alt_qty';
      end if;
      v_alt := v_txt::numeric;
    end if;

    -- The view's arithmetic, exactly (v_quotation_lines). Bounded so the view's numeric(14,2)
    -- casts can never overflow for a reader.
    v_line_tax := round(v_qty * v_rate * (1 - v_disc / 100), 2);
    if v_line_tax >= 1000000000000 then
      raise exception 'DN_VALIDATION:amount_too_large';
    end if;
    v_taxable_sum := v_taxable_sum + v_line_tax;
    if v_intra then
      v_tax_sum := v_tax_sum + 2 * round(v_line_tax * v_item.gst_rate / 2 / 100, 2);
    else
      v_tax_sum := v_tax_sum + round(v_line_tax * v_item.gst_rate / 100, 2);
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'line_no', v_n, 'item_id', v_item.id, 'item_name', v_item.name, 'hsn_code', v_item.hsn_code,
      'uom', v_item.base_uom, 'gst_rate', v_item.gst_rate, 'qty', v_qty, 'alt_qty', v_alt,
      'rate', v_rate, 'discount_pct', v_disc));
  end loop;

  if round(v_taxable_sum + v_tax_sum) >= 1000000000000 then
    raise exception 'DN_VALIDATION:amount_too_large';
  end if;
  -- The invoice it would become refuses a zero grand total (after rounding to the rupee).
  if round(v_taxable_sum + v_tax_sum) <= 0 then
    raise exception 'DN_VALIDATION:zero_total';
  end if;

  -- Write ------------------------------------------------------------------
  if p_id is null then
    -- The QT series is created lazily per FY (doc_sequences stays at the ten seeded series;
    -- next_doc_no needs a row for the FY or any FY of the series, so ensure this FY's).
    v_fy_start := extract(year from p_quote_date)::int
                - case when extract(month from p_quote_date)::int < v_fy_month then 1 else 0 end;
    v_fy_label := lpad(v_fy_start::text, 4, '0') || '-' || lpad(((v_fy_start + 1) % 100)::text, 2, '0');
    insert into doc_sequences (series, doc_type, fy_label, prefix, next_no)
    values ('QT', 'quotation', v_fy_label,
            'QT/' || lpad((v_fy_start % 100)::text, 2, '0') || '-' || lpad(((v_fy_start + 1) % 100)::text, 2, '0') || '/', 1)
    on conflict (series, fy_label) do nothing;

    v_quote_no := next_doc_no('QT', p_quote_date);

    insert into quotations (quote_no, quote_date, party_id, warehouse_id, place_of_supply, valid_until, note)
    values (v_quote_no, p_quote_date, p_party_id, v_wh, v_pos, v_valid_until, v_note)
    returning id, updated_at into v_quote_id, v_updated_at;
  else
    v_quote_id := p_id;
    v_quote_no := v_old.quote_no;
    update quotations
       set quote_date = p_quote_date, party_id = p_party_id, place_of_supply = v_pos,
           valid_until = v_valid_until, note = v_note
     where id = p_id
    returning updated_at into v_updated_at;
    delete from quotation_lines where quote_id = p_id;
  end if;

  insert into quotation_lines
    (quote_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct)
  select v_quote_id, r.line_no, r.item_id, r.item_name, r.hsn_code, r.uom, r.gst_rate, r.qty, r.alt_qty,
         r.rate, r.discount_pct
  from jsonb_to_recordset(v_rows) as r(
    line_no int, item_id uuid, item_name text, hsn_code text, uom text, gst_rate numeric(5,2),
    qty numeric(12,3), alt_qty numeric(12,3), rate numeric(14,4), discount_pct numeric(5,2))
  order by r.line_no;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, case when p_id is null then 'create' else 'update' end, 'quotations', v_quote_id,
          jsonb_build_object('quote_no', v_quote_no, 'party_id', p_party_id, 'quote_date', p_quote_date,
                             'valid_until', v_valid_until, 'lines', v_n));

  return jsonb_build_object('id', v_quote_id, 'quote_no', v_quote_no, 'updated_at', v_updated_at);
end;
$$;

revoke all on function public.save_quotation(uuid, timestamptz, uuid, date, date, text, jsonb)
  from public, anon, service_role;
grant execute on function public.save_quotation(uuid, timestamptz, uuid, date, date, text, jsonb)
  to authenticated;

-- ============================================================
-- 5. mark_quotation
-- ============================================================
-- open -> accepted | expired ; accepted -> open | expired. Never to or from converted by hand;
-- expired is final. Accepting a quote whose valid_until has passed is refused; accepted -> open is
-- always allowed (edit it to extend the validity). The same status again is a no-op.
create or replace function public.mark_quotation(p_quote_id uuid, p_status text)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_q     record;
  v_today date;
  v_at    timestamptz;
begin
  if v_actor is null or current_app_role() is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_status is null or p_status not in ('open', 'accepted', 'expired') then
    raise exception 'DN_VALIDATION:invalid_status';
  end if;

  select * into v_q from quotations where id = p_quote_id for update;
  if not found then
    raise exception 'DN_VALIDATION:no_such_quote';
  end if;
  if v_q.status = 'converted' then
    raise exception 'DN_VALIDATION:quote_converted';
  end if;
  if v_q.status = p_status then
    return v_q.updated_at;
  end if;
  if v_q.status = 'expired' then
    raise exception 'DN_VALIDATION:invalid_transition';
  end if;

  select (now() at time zone timezone)::date into v_today from organization limit 1;
  -- Only accepting is date-checked; re-opening is how a quote gets edited (and the edit
  -- re-validates valid_until).
  if p_status = 'accepted' and v_q.valid_until < v_today then
    raise exception 'DN_VALIDATION:quote_expired';
  end if;

  update quotations set status = p_status where id = p_quote_id returning updated_at into v_at;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, 'mark', 'quotations', p_quote_id,
          jsonb_build_object('status', v_q.status), jsonb_build_object('status', p_status));
  return v_at;
end;
$$;

revoke all on function public.mark_quotation(uuid, text) from public, anon, service_role;
grant execute on function public.mark_quotation(uuid, text) to authenticated;

-- ============================================================
-- 6. convert_quotation_to_invoice
-- ============================================================
-- Creates a DRAFT sales invoice dated today (org time zone) with the columns and line shape the
-- app's saveDraftInvoice writes: party, billing = the default address, shipping = the party's
-- default delivery site (else billing), place of supply derived the same way (quote_supply), the quote's warehouse, and the quoted qty / pieces / rate /
-- discount. Name / HSN / UOM / GST rate are copied from the item master now (post_sales_invoice
-- re-copies them under the item lock at posting, as for every draft). Nothing posts.
-- Idempotent: the quote row lock serialises callers; a later call on a converted quote returns
-- the same invoice id, so two simultaneous conversions create exactly one invoice.
create or replace function public.convert_quotation_to_invoice(p_quote_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_q       record;
  v_party   record;
  v_sup     record;
  v_bad     text;
  v_today   date;
  v_inv_id  uuid;
begin
  if v_actor is null or current_app_role() is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_q from quotations where id = p_quote_id for update;
  if not found then
    raise exception 'DN_VALIDATION:no_such_quote';
  end if;
  if v_q.status = 'converted' then
    return v_q.converted_invoice_id;
  end if;

  select (now() at time zone timezone)::date into v_today from organization limit 1;
  if v_q.status = 'expired' or v_q.valid_until < v_today then
    raise exception 'DN_VALIDATION:quote_expired';
  end if;

  select * into v_party from parties where id = v_q.party_id;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party' using detail = coalesce(v_party.name, '');
  end if;

  if coalesce((select is_transit from warehouses where id = v_q.warehouse_id), true) then
    raise exception 'DN_VALIDATION:invalid_warehouse';
  end if;

  if not exists (select 1 from quotation_lines where quote_id = p_quote_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;
  select i.name into v_bad
  from quotation_lines l join items i on i.id = l.item_id
  where l.quote_id = p_quote_id and not i.is_active
  order by l.line_no limit 1;
  if v_bad is not null then
    raise exception 'DN_VALIDATION:item_inactive' using detail = v_bad;
  end if;

  -- Addresses and place of supply: the invoice form's rule, read now. If they no longer give
  -- the place of supply the quote was priced on (an address or the delivery site changed since),
  -- the quoted tax head would be wrong: refuse, the user re-saves the quote and sees new totals.
  select * into v_sup from quote_supply(v_q.party_id);
  if v_sup.place_of_supply is distinct from v_q.place_of_supply then
    raise exception 'DN_VALIDATION:quote_pos_changed';
  end if;

  insert into sales_invoices
    (invoice_date, party_id, warehouse_id, place_of_supply, billing_address, shipping_address, status)
  values
    (v_today, v_q.party_id, v_q.warehouse_id, v_sup.place_of_supply, v_sup.billing, v_sup.shipping, 'draft')
  returning id into v_inv_id;

  insert into sales_invoice_lines
    (invoice_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct)
  select v_inv_id, l.line_no, l.item_id, i.name, i.hsn_code, i.base_uom, i.gst_rate, l.qty,
         case when i.alt_uom is not null then l.alt_qty end, l.rate, l.discount_pct
  from quotation_lines l join items i on i.id = l.item_id
  where l.quote_id = p_quote_id
  order by l.line_no;

  update quotations
     set status = 'converted', converted_invoice_id = v_inv_id, converted_at = now()
   where id = p_quote_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, 'convert', 'quotations', p_quote_id,
          jsonb_build_object('status', v_q.status),
          jsonb_build_object('status', 'converted', 'invoice_id', v_inv_id, 'quote_no', v_q.quote_no));

  return v_inv_id;
end;
$$;

revoke all on function public.convert_quotation_to_invoice(uuid) from public, anon, service_role;
grant execute on function public.convert_quotation_to_invoice(uuid) to authenticated;
