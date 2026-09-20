-- Change 10b (invoice documents): record transport and e-way-bill details on a POSTED invoice.
--
-- A posted invoice is locked (row-level security only lets a draft be updated), but an e-way bill
-- is generated on the government portal after the invoice has its number. This function is the
-- one narrow door: it can change ONLY the transport / e-way-bill columns, never money, party,
-- lines, status or the journal, and it leaves an audit row.

create or replace function public.record_invoice_ewb(
  p_invoice_id uuid,
  p_transport_mode text,
  p_distance_km int,
  p_transporter_name text,
  p_transporter_gstin text,
  p_vehicle_no text,
  p_ewb_no text,
  p_ewb_date date,
  p_ewb_valid_until timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_before sales_invoices;
  v_mode text := nullif(btrim(coalesce(p_transport_mode, '')), '');
  v_tname text := nullif(btrim(coalesce(p_transporter_name, '')), '');
  v_tgstin text := nullif(upper(btrim(coalesce(p_transporter_gstin, ''))), '');
  v_vehicle text := nullif(upper(btrim(coalesce(p_vehicle_no, ''))), '');
  v_ewb text := nullif(btrim(coalesce(p_ewb_no, '')), '');
begin
  if v_actor is null or not is_active_member() then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_before from sales_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'DN_NOT_POSTED';
  end if;
  if v_before.status <> 'posted' then
    raise exception 'DN_NOT_POSTED';
  end if;

  if v_mode is not null and v_mode not in ('road', 'rail', 'air', 'ship') then
    raise exception 'DN_VALIDATION:transport_mode';
  end if;
  if p_distance_km is not null and (p_distance_km < 0 or p_distance_km > 5000) then
    raise exception 'DN_VALIDATION:distance';
  end if;
  if v_tgstin is not null and v_tgstin !~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' then
    raise exception 'DN_VALIDATION:transporter_gstin';
  end if;
  if v_tname is not null and length(v_tname) > 120 then
    raise exception 'DN_VALIDATION:transporter_name';
  end if;
  if v_vehicle is not null and v_vehicle !~ '^[A-Z0-9 -]{4,20}$' then
    raise exception 'DN_VALIDATION:vehicle_no';
  end if;
  if v_ewb is not null and v_ewb !~ '^[0-9]{12}$' then
    raise exception 'DN_VALIDATION:ewb_no';
  end if;
  -- The three e-way-bill facts go together: a number without its dates (or the reverse) is a typo.
  if (v_ewb is null) <> (p_ewb_date is null) or (v_ewb is null) <> (p_ewb_valid_until is null) then
    raise exception 'DN_VALIDATION:ewb_incomplete';
  end if;
  if p_ewb_date is not null and p_ewb_valid_until < p_ewb_date::timestamptz then
    raise exception 'DN_VALIDATION:ewb_dates';
  end if;

  update sales_invoices set
    transport_mode = v_mode,
    distance_km = p_distance_km,
    transporter_name = v_tname,
    transporter_gstin = v_tgstin,
    vehicle_no = v_vehicle,
    ewb_no = v_ewb,
    ewb_date = p_ewb_date,
    ewb_valid_until = p_ewb_valid_until,
    updated_at = now()
  where id = p_invoice_id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (
    v_actor, 'record_invoice_ewb', 'sales_invoices', p_invoice_id,
    (select to_jsonb(b) from (select v_before.transport_mode, v_before.distance_km, v_before.transporter_name,
       v_before.transporter_gstin, v_before.vehicle_no, v_before.ewb_no, v_before.ewb_date, v_before.ewb_valid_until) b),
    (select to_jsonb(a) from (select v_mode as transport_mode, p_distance_km as distance_km, v_tname as transporter_name,
       v_tgstin as transporter_gstin, v_vehicle as vehicle_no, v_ewb as ewb_no, p_ewb_date as ewb_date,
       p_ewb_valid_until as ewb_valid_until) a)
  );
end;
$$;

revoke all on function public.record_invoice_ewb(uuid, text, int, text, text, text, text, date, timestamptz) from public, anon;
grant execute on function public.record_invoice_ewb(uuid, text, int, text, text, text, text, date, timestamptz) to authenticated;
