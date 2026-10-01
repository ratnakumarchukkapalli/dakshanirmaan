-- Change 20 (notes), database half: posting and cancelling credit notes (sales returns / rate
-- differences) and debit notes (purchase returns / rate differences).
--
-- What this migration adds or changes, in order:
--   1. Schema: credit_notes/debit_notes.stock_effect (goods return vs value-only adjustment) and
--      credit_note_lines/debit_note_lines.against_line_id (the invoice line a note line corrects),
--      plus the indexes the quantity/value caps read through.
--   2. RLS: note drafts (headers and lines) are owner-only (admin at aal2), draft-only.
--   3. post_credit_note(uuid), post_debit_note(uuid).
--   4. cancel_document: new credit_note / debit_note branches; the sales_invoice and
--      purchase_invoice branches additionally refuse while a posted note stands against the invoice
--      (DN_VALIDATION:has_notes). Every other branch is copied unchanged.
--   5. refuse_cancel_in_locked_period now also covers debit_notes.
--   6. GST reports: a value-only credit note reports no quantity in the HSN summary
--      (_gst_out_lines); GSTR-3B 4A5 / 4D are net of posted debit notes (gstr3b_summary), so
--      recon_input stays 0 once a debit note reverses ITC.
--   7. Grants: the two new functions to authenticated only; nothing to anon.
-- Numbering: the CN (credit_note) and DB (debit_note) series already exist (seed, spec "Seed data")
-- and next_doc_no creates later FYs' rows itself; nothing to add.
-- Decisions and deviations from the brief: openspec/changes/20-notes/implementation-notes.md.

-- ============================================================
-- 1. Schema
-- ============================================================

-- true  = goods come back (credit note) / go back to the supplier (debit note): quantity is capped by
--         the invoice line, stock moves at the invoice line's cost.
-- false = value-only adjustment (rate difference, after-the-fact discount): no stock movement, no
--         quantity cap, value capped by the invoice line's taxable value.
alter table credit_notes add column stock_effect boolean not null default true;
alter table debit_notes  add column stock_effect boolean not null default true;

-- The invoice line this note line corrects. Required when the note has against_invoice_id (checked
-- by the posting function). ON DELETE RESTRICT (review fix 4): the invoice line a note points at can
-- never disappear from under it (a posted invoice's lines cannot be deleted anyway; a draft note
-- pointing at a draft invoice's line blocks deleting that line until the note line is removed).
alter table credit_note_lines
  add column against_line_id uuid references sales_invoice_lines (id) on delete restrict;
alter table debit_note_lines
  add column against_line_id uuid references purchase_invoice_lines (id) on delete restrict;

-- Lines are writable only while their note is a draft, for EVERY writer, not just through RLS (review
-- fix 4). The header is locked FOR SHARE, so a line saved while post_*_note holds the header FOR
-- UPDATE waits for that post to finish and is then refused, instead of landing on a posted note that
-- GSTR-1 (_gst_out_lines) and the quantity/value caps read. The posting functions write the lines
-- while the header is still a draft, inside their own lock, so they pass. A header that no longer
-- exists (the cascade from deleting a draft note) lets its lines go. SECURITY DEFINER so RLS on the
-- header cannot hide a posted row from the check.
create or replace function public.note_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status doc_status;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if tg_table_name = 'credit_note_lines' then
      select status into v_status from credit_notes where id = old.note_id for share;
    else
      select status into v_status from debit_notes where id = old.note_id for share;
    end if;
    if found and v_status <> 'draft' then
      raise exception 'DN_NOT_DRAFT';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if tg_table_name = 'credit_note_lines' then
      select status into v_status from credit_notes where id = new.note_id for share;
    else
      select status into v_status from debit_notes where id = new.note_id for share;
    end if;
    if not found or v_status <> 'draft' then
      raise exception 'DN_NOT_DRAFT';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.note_lines_guard() from public, anon, authenticated, service_role;

create trigger note_lines_guard before insert or update or delete on credit_note_lines
  for each row execute function public.note_lines_guard();
create trigger note_lines_guard before insert or update or delete on debit_note_lines
  for each row execute function public.note_lines_guard();

create index credit_note_lines_against_line_id_idx on credit_note_lines (against_line_id);
create index debit_note_lines_against_line_id_idx  on debit_note_lines (against_line_id);
create index credit_notes_against_invoice_id_idx   on credit_notes (against_invoice_id);
create index debit_notes_against_invoice_id_idx    on debit_notes (against_invoice_id);
create index credit_note_lines_note_id_idx         on credit_note_lines (note_id);
create index debit_note_lines_note_id_idx          on debit_note_lines (note_id);

-- ============================================================
-- 2. RLS: note drafts are owner-only
-- ============================================================
-- Spec (RLS and roles): credit/debit notes are admin work; the api spec gates saveDraftNote to
-- admin. Until now any active member could write a note draft. Posting was never possible for a
-- `user`, but a counter-typed draft is still a document an owner can post without re-reading every
-- line, so the write itself is gated (brief default 4). SELECT stays open to members (the counter
-- sees a customer's returns on the invoice view).
drop policy insert_draft on credit_notes;
drop policy update_draft on credit_notes;
drop policy delete_draft on credit_notes;
create policy insert_draft on credit_notes for insert
  with check (is_active_member() and current_app_role() = 'admin' and status = 'draft');
create policy update_draft on credit_notes for update
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft')
  with check (current_app_role() = 'admin' and status = 'draft');
create policy delete_draft on credit_notes for delete
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft');

drop policy insert_draft on debit_notes;
drop policy update_draft on debit_notes;
drop policy delete_draft on debit_notes;
create policy insert_draft on debit_notes for insert
  with check (is_active_member() and current_app_role() = 'admin' and status = 'draft');
create policy update_draft on debit_notes for update
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft')
  with check (current_app_role() = 'admin' and status = 'draft');
create policy delete_draft on debit_notes for delete
  using (is_active_member() and current_app_role() = 'admin' and status = 'draft');

drop policy insert_draft on credit_note_lines;
drop policy update_draft on credit_note_lines;
drop policy delete_draft on credit_note_lines;
create policy insert_draft on credit_note_lines for insert
  with check (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from credit_notes h where h.id = credit_note_lines.note_id and h.status = 'draft'));
create policy update_draft on credit_note_lines for update
  using (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from credit_notes h where h.id = credit_note_lines.note_id and h.status = 'draft'))
  with check (current_app_role() = 'admin' and exists (
    select 1 from credit_notes h where h.id = credit_note_lines.note_id and h.status = 'draft'));
create policy delete_draft on credit_note_lines for delete
  using (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from credit_notes h where h.id = credit_note_lines.note_id and h.status = 'draft'));

drop policy insert_draft on debit_note_lines;
drop policy update_draft on debit_note_lines;
drop policy delete_draft on debit_note_lines;
create policy insert_draft on debit_note_lines for insert
  with check (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from debit_notes h where h.id = debit_note_lines.note_id and h.status = 'draft'));
create policy update_draft on debit_note_lines for update
  using (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from debit_notes h where h.id = debit_note_lines.note_id and h.status = 'draft'))
  with check (current_app_role() = 'admin' and exists (
    select 1 from debit_notes h where h.id = debit_note_lines.note_id and h.status = 'draft'));
create policy delete_draft on debit_note_lines for delete
  using (is_active_member() and current_app_role() = 'admin' and exists (
    select 1 from debit_notes h where h.id = debit_note_lines.note_id and h.status = 'draft'));

-- ============================================================
-- 3a. post_credit_note
-- ============================================================
-- Journal (the sales invoice mirrored, proportionally to the note lines):
--   Dr Sales income per line (item category, or Freight Recovered for a non-stock line) taxable
--   Dr Output CGST/SGST or IGST
--   Cr AR (party) grand_total (rounded like the invoice; round-off Dr when positive, Cr when negative)
--   goods returned: Dr Inventory / Cr COGS at the ORIGINAL cost of the invoiced goods, with a stock
--   movement IN to the invoice's warehouse at that rate.
-- Lock order: note -> invoice -> party -> items (ascending id, one statement each) -> doc_sequences.
create or replace function public.post_credit_note(p_note_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_role           app_role;
  v_doc            record;
  v_inv            record;
  v_party          record;
  v_line           record;
  v_il             record;
  v_org_state      char(2);
  v_timezone       text;
  v_today          date;
  v_period_locked  bool;
  v_pos            text;
  v_intra          bool;
  v_linked         bool;
  v_item_ids       uuid[];
  v_item_id        uuid;
  v_entry_id       uuid;
  v_doc_no         text;
  v_line_no        int := 0;

  v_ar_id                uuid;
  v_cogs_id              uuid;
  v_inventory_id         uuid;
  v_output_cgst_id       uuid;
  v_output_sgst_id       uuid;
  v_output_igst_id       uuid;
  v_round_off_id         uuid;
  v_cement_id            uuid;
  v_steel_id             uuid;
  v_other_id             uuid;
  v_freight_recovered_id uuid;

  v_rate          numeric(14,4);
  v_taxable       numeric(14,2);
  v_cgst          numeric(14,2);
  v_sgst          numeric(14,2);
  v_igst          numeric(14,2);

  v_taxable_total numeric(14,2) := 0;
  v_cgst_total    numeric(14,2) := 0;
  v_sgst_total    numeric(14,2) := 0;
  v_igst_total    numeric(14,2) := 0;
  v_cement_total  numeric(14,2) := 0;
  v_steel_total   numeric(14,2) := 0;
  v_other_total   numeric(14,2) := 0;
  v_freight_total numeric(14,2) := 0;
  v_stock_total   numeric(14,2) := 0;

  v_raw_total     numeric(14,2);
  v_grand_total   numeric(14,2);
  v_round_off     numeric(14,2);
  v_prior_raw     numeric(14,2);
  v_prior_grand   numeric(14,2);

  v_prior_qty     numeric(12,3);
  v_prior_ret_val numeric(14,2);
  v_prior_all_val numeric(14,2);
  v_prior_cgst    numeric(14,2);
  v_prior_sgst    numeric(14,2);
  v_prior_igst    numeric(14,2);
  v_cum_taxable   numeric(14,2);
  v_ret_qty       numeric;
  v_ret_val       numeric;
  v_cost_qty      numeric;
  v_cost_val      numeric;
  v_cost_rate     numeric(14,4);
  v_line_value    numeric(14,2);
  v_allocated     numeric(14,2);
  v_noted         numeric(14,2);
  v_open          numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Lock order step 1: the document; drafts only.
  select * into v_doc from credit_notes where id = p_note_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Notes are owner work (spec: RLS and roles). NULL for a non-member or an admin below aal2.
  v_role := current_app_role();
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select state_code, timezone into v_org_state, v_timezone from organization limit 1;
  v_today := (now() at time zone coalesce(v_timezone, 'Asia/Kolkata'))::date;

  if v_doc.note_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  -- Missing period = locked (change 02's rule).
  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.note_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if nullif(btrim(coalesce(v_doc.reason, '')), '') is null then
    raise exception 'DN_VALIDATION:reason_required';
  end if;

  if not exists (select 1 from credit_note_lines where note_id = p_note_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  v_linked := v_doc.against_invoice_id is not null;

  if not v_linked then
    -- A return always needs the invoice (the goods' cost and the quantity cap come from it); only
    -- a value-only note may stand alone (brief default 3).
    if v_doc.stock_effect then
      raise exception 'DN_VALIDATION:note_needs_invoice';
    end if;
    if exists (select 1 from credit_note_lines where note_id = p_note_id and against_line_id is not null) then
      raise exception 'DN_VALIDATION:line_not_on_invoice';
    end if;
  else
    -- Lock order step 1b: the invoice (second document row, before the party, same as the challan
    -- in post_sales_invoice and the invoice in cancel_document). Every cap below is read under it.
    select * into v_inv from sales_invoices where id = v_doc.against_invoice_id for update;
    if not found or v_inv.status <> 'posted' then
      raise exception 'DN_VALIDATION:invoice_not_posted';
    end if;
    if v_inv.party_id <> v_doc.party_id then
      raise exception 'DN_VALIDATION:party_mismatch';
    end if;
    if v_doc.note_date < v_inv.invoice_date then
      raise exception 'DN_VALIDATION:note_before_invoice';
    end if;

    -- Every line names a line of this invoice, for the same item.
    if exists (
      select 1 from credit_note_lines l
      left join sales_invoice_lines il on il.id = l.against_line_id and il.invoice_id = v_inv.id
      where l.note_id = p_note_id and (il.id is null or il.item_id <> l.item_id)
    ) then
      raise exception 'DN_VALIDATION:line_not_on_invoice';
    end if;

    -- One note line per invoice line (keeps the cumulative caps below exact).
    if exists (
      select 1 from credit_note_lines where note_id = p_note_id
      group by against_line_id having count(*) > 1
    ) then
      raise exception 'DN_VALIDATION:duplicate_line';
    end if;
  end if;

  -- Lock order step 2: the party.
  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  -- Lock order step 3: items, ascending id, one statement at a time.
  select array(
    select distinct item_id from credit_note_lines where note_id = p_note_id order by item_id
  ) into v_item_ids;
  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Snapshots. A note against an invoice reverses what that invoice charged, so name, HSN, unit and
  -- GST rate are copied from the invoice line's own snapshot (never the master, which may have moved
  -- since). A stand-alone note takes the master, like an invoice. Draft columns are client-writable
  -- and never trusted.
  if v_linked then
    update credit_note_lines l
       set item_name = il.item_name, hsn_code = il.hsn_code, uom = il.uom, gst_rate = il.gst_rate
      from sales_invoice_lines il
     where il.id = l.against_line_id and l.note_id = p_note_id;
    -- The invoice's place of supply was derived by post_sales_invoice and is not client-writable
    -- once posted.
    v_pos := v_inv.place_of_supply;
  else
    update credit_note_lines l
       set item_name = i.name, hsn_code = i.hsn_code, uom = i.base_uom, gst_rate = i.gst_rate
      from items i
     where i.id = l.item_id and l.note_id = p_note_id;
    -- No invoice: the party rule (the customer's own state).
    v_pos := v_party.state_code;
  end if;
  v_intra := (v_pos = v_org_state);

  select id into v_ar_id                from accounts where system_key = 'ar';
  select id into v_cogs_id              from accounts where system_key = 'cogs';
  select id into v_inventory_id         from accounts where system_key = 'inventory';
  select id into v_output_cgst_id       from accounts where system_key = 'output_cgst';
  select id into v_output_sgst_id       from accounts where system_key = 'output_sgst';
  select id into v_output_igst_id       from accounts where system_key = 'output_igst';
  select id into v_round_off_id         from accounts where system_key = 'round_off';
  select id into v_cement_id            from accounts where system_key = 'sales_cement';
  select id into v_steel_id             from accounts where system_key = 'sales_steel';
  select id into v_other_id             from accounts where system_key = 'sales_other';
  select id into v_freight_recovered_id from accounts where system_key = 'freight_recovered';

  if v_ar_id is null or v_cogs_id is null or v_inventory_id is null
     or v_output_cgst_id is null or v_output_sgst_id is null or v_output_igst_id is null
     or v_round_off_id is null or v_cement_id is null or v_steel_id is null
     or v_other_id is null or v_freight_recovered_id is null
  then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.category, i.is_stock
    from credit_note_lines l
    join items i on i.id = l.item_id
    where l.note_id = p_note_id
    order by l.line_no
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;

    if v_linked then
      select * into v_il from sales_invoice_lines where id = v_line.against_line_id;

      -- Earlier posted, un-cancelled notes on this invoice line (this note is still a draft, so it
      -- is not counted). Read under the invoice lock taken above.
      select coalesce(sum(l.qty) filter (where n.stock_effect), 0),
             coalesce(sum(l.taxable_value) filter (where n.stock_effect), 0),
             coalesce(sum(l.taxable_value), 0),
             coalesce(sum(l.cgst_amt) filter (where n.stock_effect), 0),
             coalesce(sum(l.sgst_amt) filter (where n.stock_effect), 0),
             coalesce(sum(l.igst_amt) filter (where n.stock_effect), 0)
        into v_prior_qty, v_prior_ret_val, v_prior_all_val, v_prior_cgst, v_prior_sgst, v_prior_igst
      from credit_note_lines l
      join credit_notes n on n.id = l.note_id
      where l.against_line_id = v_il.id and n.status = 'posted';

      if v_doc.stock_effect then
        if v_prior_qty + v_line.qty > v_il.qty then
          raise exception 'DN_VALIDATION:qty_exceeds_invoice';
        end if;
        -- The returned share of the line's taxable value, computed cumulatively so that returns
        -- which together reach the invoiced quantity add up to exactly the invoiced value (no
        -- paisa lost or gained across partial returns). The client's rate is ignored.
        v_taxable := round(v_il.taxable_value * (v_prior_qty + v_line.qty) / v_il.qty, 2)
                     - v_prior_ret_val;
        v_rate := round(v_il.taxable_value / v_il.qty, 4);
      else
        if v_line.rate is null or v_line.rate <= 0 then
          raise exception 'DN_VALIDATION:invalid_rate';
        end if;
        v_rate := v_line.rate;
        v_taxable := round(v_line.qty * v_line.rate, 2);
      end if;

      if v_taxable < 0 then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;

      -- Never credit more than the line was billed at, across every kind of note.
      if v_prior_all_val + v_taxable > v_il.taxable_value then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;
    else
      if v_line.rate is null or v_line.rate <= 0 then
        raise exception 'DN_VALIDATION:invalid_rate';
      end if;
      v_rate := v_line.rate;
      v_taxable := round(v_line.qty * v_line.rate, 2);
    end if;

    -- Tax exactly like the invoice (Tax and rounding clarification), from the snapshot rate. A
    -- return against an invoice line is taxed CUMULATIVELY, like its taxable value: each component
    -- is round(returned-so-far taxable x rate) minus what earlier posted, un-cancelled returns on
    -- that line already reversed, so partial returns that reach the invoiced quantity reverse
    -- exactly the tax the invoice charged (review fix 1: 3 x 33.39 returned in thirds reversed
    -- 9.03 CGST against 9.02 charged when each note rounded its own share).
    if v_linked and v_doc.stock_effect then
      v_cum_taxable := v_prior_ret_val + v_taxable;
      if v_intra then
        v_cgst := round(v_cum_taxable * v_line.gst_rate / 2 / 100, 2) - v_prior_cgst;
        v_sgst := round(v_cum_taxable * v_line.gst_rate / 2 / 100, 2) - v_prior_sgst;
        v_igst := 0;
      else
        v_cgst := 0;
        v_sgst := 0;
        v_igst := round(v_cum_taxable * v_line.gst_rate / 100, 2) - v_prior_igst;
      end if;
      if v_cgst < 0 or v_sgst < 0 or v_igst < 0 then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;
    elsif v_intra then
      v_cgst := round(v_taxable * v_line.gst_rate / 2 / 100, 2);
      v_sgst := v_cgst;
      v_igst := 0;
    else
      v_cgst := 0;
      v_sgst := 0;
      v_igst := round(v_taxable * v_line.gst_rate / 100, 2);
    end if;

    update credit_note_lines
       set rate = v_rate, taxable_value = v_taxable, cgst_amt = v_cgst, sgst_amt = v_sgst, igst_amt = v_igst
     where id = v_line.id;

    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total    := v_cgst_total + v_cgst;
    v_sgst_total    := v_sgst_total + v_sgst;
    v_igst_total    := v_igst_total + v_igst;

    if not v_line.is_stock then
      v_freight_total := v_freight_total + v_taxable;
      continue;
    elsif v_line.category = 'cement' then
      v_cement_total := v_cement_total + v_taxable;
    elsif v_line.category = 'steel' then
      v_steel_total := v_steel_total + v_taxable;
    else
      v_other_total := v_other_total + v_taxable;
    end if;

    if not v_doc.stock_effect then
      continue;
    end if;

    -- Goods back IN at the cost they left with: the invoice's own (un-reversed) stock movements for
    -- this item, or the challan's when the invoice was converted from one (its goods left at
    -- challan time). Never the current average (spec: "stock back IN at original issue cost").
    if v_inv.challan_id is not null then
      select sum(-m.qty), sum(-m.value) into v_cost_qty, v_cost_val
      from stock_movements m
      where m.source_type = 'delivery_challan' and m.source_id = v_inv.challan_id
        and m.item_id = v_line.item_id and m.reversal_of is null;
    else
      select sum(-m.qty), sum(-m.value) into v_cost_qty, v_cost_val
      from stock_movements m
      where m.source_type = 'sales_invoice' and m.source_id = v_inv.id
        and m.item_id = v_line.item_id and m.reversal_of is null;
    end if;

    if coalesce(v_cost_qty, 0) <= 0 or coalesce(v_cost_val, 0) <= 0 then
      raise exception 'DN_VALIDATION:no_cost_basis';
    end if;

    -- Cumulative, per item on this invoice (review fix 1): what earlier posted, un-cancelled returns
    -- against this invoice (and earlier lines of this note) already brought back, by movement.
    -- Returns that together reach the invoiced quantity restore exactly the cost that left.
    select coalesce(sum(m.qty), 0), coalesce(sum(m.value), 0) into v_ret_qty, v_ret_val
    from stock_movements m
    where m.source_type = 'credit_note' and m.item_id = v_line.item_id and m.reversal_of is null
      and (m.source_id = p_note_id
           or m.source_id in (select n.id from credit_notes n
                              where n.against_invoice_id = v_inv.id and n.status = 'posted'));

    if v_ret_qty + v_line.qty > v_cost_qty then
      raise exception 'DN_VALIDATION:qty_exceeds_invoice';
    end if;

    v_line_value := round(v_cost_val * (v_ret_qty + v_line.qty) / v_cost_qty, 2) - v_ret_val;
    if v_line_value < 0 then
      raise exception 'DN_VALIDATION:no_cost_basis';
    end if;
    v_cost_rate  := round(v_line_value / v_line.qty, 4);
    v_stock_total := v_stock_total + v_line_value;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_inv.warehouse_id, v_doc.note_date, v_line.qty, v_cost_rate,
       v_line_value, 'credit_note', p_note_id);
  end loop;

  v_raw_total   := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total;

  if v_linked then
    -- Rounded CUMULATIVELY per invoice (round-2 review F1): the notes against one invoice together
    -- round like the invoice did. Each note rounding its own total let three thirds of a 149 invoice
    -- come to 50 + 50 + 50, so the last return was refused as over the open amount. Now: this
    -- note's grand total = round(raw of every posted, un-cancelled note on the invoice + this raw)
    -- - their grand totals. A full return therefore credits exactly the invoice's grand total.
    -- The per-note round-off can reach +/-1.00 (a carried residue plus its own); the journal takes
    -- it through round_off like any other.
    select coalesce(sum(taxable_total + cgst_total + sgst_total + igst_total), 0),
           coalesce(sum(grand_total), 0)
      into v_prior_raw, v_prior_grand
    from credit_notes where against_invoice_id = v_inv.id and status = 'posted';

    v_grand_total := round(v_prior_raw + v_raw_total) - v_prior_grand;
    v_round_off   := v_grand_total - v_raw_total;

    if abs(v_round_off) > 1.00 then
      raise exception 'DN_UNBALANCED';
    end if;

    -- The notes on an invoice can never add up to more than the invoice.
    if v_prior_grand + v_grand_total > v_inv.grand_total then
      raise exception 'DN_VALIDATION:value_exceeds_invoice';
    end if;
  else
    v_grand_total := round(v_raw_total);
    v_round_off   := v_grand_total - v_raw_total;

    if abs(v_round_off) > 0.50 then
      raise exception 'DN_UNBALANCED';
    end if;
  end if;

  if v_grand_total <= 0 then
    raise exception 'DN_VALIDATION:zero_total';
  end if;

  -- A note may not exceed what is still open on the invoice, unless nothing is open any more (fully
  -- paid): then the whole note becomes a credit balance on the customer's account (brief, Guards and
  -- default 2). Open amount per the "Only a posted payment's allocations count" clarification.
  if v_linked then
    select coalesce(sum(pa.amount), 0) into v_allocated
    from payment_allocations pa
    join payments p on p.id = pa.payment_id and p.status = 'posted'
    where pa.invoice_type = 'sales_invoice' and pa.invoice_id = v_inv.id;

    select coalesce(sum(grand_total), 0) into v_noted
    from credit_notes where against_invoice_id = v_inv.id and status = 'posted';

    v_open := v_inv.grand_total - v_allocated - v_noted;
    if v_open > 0 and v_grand_total > v_open then
      raise exception 'DN_VALIDATION:exceeds_open_amount';
    end if;
  end if;

  -- Lock order step 4: the number, last.
  v_doc_no := next_doc_no('CN', v_doc.note_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.note_date, 'Credit note ' || v_doc_no, 'credit_note', p_note_id, v_actor, now())
  returning id into v_entry_id;

  if v_cement_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cement_id, v_cement_total, 0);
  end if;
  if v_steel_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_steel_id, v_steel_total, 0);
  end if;
  if v_other_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_other_id, v_other_total, 0);
  end if;
  if v_freight_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_freight_recovered_id, v_freight_total, 0);
  end if;
  if v_cgst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_cgst_id, v_cgst_total, 0);
  end if;
  if v_sgst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_sgst_id, v_sgst_total, 0);
  end if;
  if v_igst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_igst_id, v_igst_total, 0);
  end if;

  -- The rounded total is CREDITED to AR here (mirror of the invoice), so a positive round-off is a
  -- debit and a negative one a credit.
  if v_round_off > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, v_round_off, 0);
  elsif v_round_off < 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, 0, -v_round_off);
  end if;

  v_line_no := v_line_no + 1;
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values (v_entry_id, v_line_no, v_ar_id, v_doc.party_id, 0, v_grand_total);

  if v_stock_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_inventory_id, v_stock_total, 0);
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cogs_id, 0, v_stock_total);
  end if;

  update credit_notes
     set status = 'posted',
         note_no = v_doc_no,
         place_of_supply = v_pos,
         journal_entry_id = v_entry_id,
         taxable_total = v_taxable_total,
         cgst_total = v_cgst_total,
         sgst_total = v_sgst_total,
         igst_total = v_igst_total,
         round_off = v_round_off,
         grand_total = v_grand_total
   where id = p_note_id;

  -- B2B or B2C is decided by the buyer's GSTIN as the INVOICE was filed (review fix 3). The
  -- snapshot_buyer_gstin trigger above copied today's party master; a note against an invoice
  -- takes the invoice's own snapshot instead, so a customer who registers after buying cannot
  -- move the note into CDNR against an invoice that was reported as B2C. (Not an UPDATE OF
  -- status, so the trigger does not fire again.) A stand-alone note keeps the party snapshot.
  if v_linked then
    update credit_notes set buyer_gstin = v_inv.buyer_gstin where id = p_note_id;
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'credit_notes', p_note_id,
          jsonb_build_object('note_no', v_doc_no, 'entry_id', v_entry_id,
            'grand_total', v_grand_total, 'against_invoice_id', v_doc.against_invoice_id,
            'stock_effect', v_doc.stock_effect, 'stock_value', v_stock_total));

  return v_entry_id;
end;
$$;

-- ============================================================
-- 3b. post_debit_note
-- ============================================================
-- Journal (the purchase invoice mirrored):
--   Dr AP (party) grand_total (rounded; round-off Cr when positive, Dr when negative)
--   Cr Inventory, goods returned: the returned share of the purchase line's cost (taxable, plus
--      tax when the bill was not ITC-eligible), with a stock movement OUT at that rate
--   Cr Discount Received, value-only note: the same amount, no stock movement
--   Cr Input CGST/SGST or IGST (ITC reversed) when the bill was ITC-eligible
-- Lock order: note -> purchase invoice -> party -> items (ascending id) -> doc_sequences.
create or replace function public.post_debit_note(p_note_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_role           app_role;
  v_doc            record;
  v_inv            record;
  v_party          record;
  v_line           record;
  v_il             record;
  v_org_state      char(2);
  v_timezone       text;
  v_today          date;
  v_period_locked  bool;
  v_intra          bool;
  v_itc            bool;
  v_linked         bool;
  v_item_ids       uuid[];
  v_item_id        uuid;
  v_entry_id       uuid;
  v_doc_no         text;
  v_line_no        int := 0;

  v_ap_id          uuid;
  v_inventory_id   uuid;
  v_disc_recd_id   uuid;
  v_cogs_id        uuid;
  v_in_cgst_id     uuid;
  v_in_sgst_id     uuid;
  v_in_igst_id     uuid;
  v_round_off_id   uuid;

  v_rate          numeric(14,4);
  v_taxable       numeric(14,2);
  v_cgst          numeric(14,2);
  v_sgst          numeric(14,2);
  v_igst          numeric(14,2);
  v_line_cost     numeric(14,2);

  v_taxable_total numeric(14,2) := 0;
  v_cgst_total    numeric(14,2) := 0;
  v_sgst_total    numeric(14,2) := 0;
  v_igst_total    numeric(14,2) := 0;
  v_inventory_tot numeric(14,2) := 0;
  v_discount_tot  numeric(14,2) := 0;

  v_raw_total     numeric(14,2);
  v_grand_total   numeric(14,2);
  v_round_off     numeric(14,2);
  v_prior_raw     numeric(14,2);
  v_prior_grand   numeric(14,2);

  v_prior_qty     numeric(12,3);
  v_prior_ret_val numeric(14,2);
  v_prior_all_val numeric(14,2);
  v_prior_cgst    numeric(14,2);
  v_prior_sgst    numeric(14,2);
  v_prior_igst    numeric(14,2);
  v_cum_taxable   numeric(14,2);
  v_mv_value      numeric(14,2);
  v_cogs_adj      numeric(14,2) := 0;
  v_onhand_qty    numeric(12,3);
  v_onhand_value  numeric(14,2);
  v_allocated     numeric(14,2);
  v_noted         numeric(14,2);
  v_open          numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from debit_notes where id = p_note_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  v_role := current_app_role();
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select state_code, timezone into v_org_state, v_timezone from organization limit 1;
  v_today := (now() at time zone coalesce(v_timezone, 'Asia/Kolkata'))::date;

  if v_doc.note_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.note_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if nullif(btrim(coalesce(v_doc.reason, '')), '') is null then
    raise exception 'DN_VALIDATION:reason_required';
  end if;

  if not exists (select 1 from debit_note_lines where note_id = p_note_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  v_linked := v_doc.against_invoice_id is not null;

  if not v_linked then
    if v_doc.stock_effect then
      raise exception 'DN_VALIDATION:note_needs_invoice';
    end if;
    if exists (select 1 from debit_note_lines where note_id = p_note_id and against_line_id is not null) then
      raise exception 'DN_VALIDATION:line_not_on_invoice';
    end if;
  else
    select * into v_inv from purchase_invoices where id = v_doc.against_invoice_id for update;
    if not found or v_inv.status <> 'posted' then
      raise exception 'DN_VALIDATION:invoice_not_posted';
    end if;
    if v_inv.party_id <> v_doc.party_id then
      raise exception 'DN_VALIDATION:party_mismatch';
    end if;
    if v_doc.note_date < v_inv.invoice_date then
      raise exception 'DN_VALIDATION:note_before_invoice';
    end if;

    if exists (
      select 1 from debit_note_lines l
      left join purchase_invoice_lines il on il.id = l.against_line_id and il.invoice_id = v_inv.id
      where l.note_id = p_note_id and (il.id is null or il.item_id <> l.item_id)
    ) then
      raise exception 'DN_VALIDATION:line_not_on_invoice';
    end if;

    if exists (
      select 1 from debit_note_lines where note_id = p_note_id
      group by against_line_id having count(*) > 1
    ) then
      raise exception 'DN_VALIDATION:duplicate_line';
    end if;
  end if;

  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('supplier', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  select array(
    select distinct item_id from debit_note_lines where note_id = p_note_id order by item_id
  ) into v_item_ids;
  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  if v_linked then
    update debit_note_lines l
       set item_name = il.item_name, hsn_code = il.hsn_code, uom = il.uom, gst_rate = il.gst_rate
      from purchase_invoice_lines il
     where il.id = l.against_line_id and l.note_id = p_note_id;
    -- The bill's own split decides (it was taken from the supplier's state when it posted); a bill
    -- with IGST is reversed as IGST even if the supplier master has moved state since.
    v_intra := (v_inv.igst_total = 0);
    v_itc   := v_inv.itc_eligible;
  else
    update debit_note_lines l
       set item_name = i.name, hsn_code = i.hsn_code, uom = i.base_uom, gst_rate = i.gst_rate
      from items i
     where i.id = l.item_id and l.note_id = p_note_id;
    -- Supplier's state vs ours, as post_purchase_invoice. With no bill to say otherwise the credit is
    -- treated as claimed, so it is reversed: the direction that can only raise the tax payable.
    v_intra := (v_party.state_code = v_org_state);
    v_itc   := true;
  end if;

  select id into v_ap_id        from accounts where system_key = 'ap';
  select id into v_inventory_id from accounts where system_key = 'inventory';
  select id into v_disc_recd_id from accounts where system_key = 'discount_received';
  select id into v_cogs_id      from accounts where system_key = 'cogs';
  select id into v_in_cgst_id   from accounts where system_key = 'input_cgst';
  select id into v_in_sgst_id   from accounts where system_key = 'input_sgst';
  select id into v_in_igst_id   from accounts where system_key = 'input_igst';
  select id into v_round_off_id from accounts where system_key = 'round_off';

  if v_ap_id is null or v_inventory_id is null or v_disc_recd_id is null or v_cogs_id is null
     or v_in_cgst_id is null
     or v_in_sgst_id is null or v_in_igst_id is null or v_round_off_id is null
  then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.is_stock
    from debit_note_lines l
    join items i on i.id = l.item_id
    where l.note_id = p_note_id
    order by l.line_no
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;

    -- Purchase lines are always stock items (post_purchase_invoice refuses services); a stand-alone
    -- value-only note on a service item has no stock to move either, so only a return needs this.
    if v_doc.stock_effect and not v_line.is_stock then
      raise exception 'DN_VALIDATION:non_stock_line';
    end if;

    if v_linked then
      select * into v_il from purchase_invoice_lines where id = v_line.against_line_id;

      select coalesce(sum(l.qty) filter (where n.stock_effect), 0),
             coalesce(sum(l.taxable_value) filter (where n.stock_effect), 0),
             coalesce(sum(l.taxable_value), 0),
             coalesce(sum(l.cgst_amt) filter (where n.stock_effect), 0),
             coalesce(sum(l.sgst_amt) filter (where n.stock_effect), 0),
             coalesce(sum(l.igst_amt) filter (where n.stock_effect), 0)
        into v_prior_qty, v_prior_ret_val, v_prior_all_val, v_prior_cgst, v_prior_sgst, v_prior_igst
      from debit_note_lines l
      join debit_notes n on n.id = l.note_id
      where l.against_line_id = v_il.id and n.status = 'posted';

      if v_doc.stock_effect then
        if v_prior_qty + v_line.qty > v_il.qty then
          raise exception 'DN_VALIDATION:qty_exceeds_invoice';
        end if;
        v_taxable := round(v_il.taxable_value * (v_prior_qty + v_line.qty) / v_il.qty, 2)
                     - v_prior_ret_val;
        v_rate := round(v_il.taxable_value / v_il.qty, 4);
      else
        if v_line.rate is null or v_line.rate <= 0 then
          raise exception 'DN_VALIDATION:invalid_rate';
        end if;
        v_rate := v_line.rate;
        v_taxable := round(v_line.qty * v_line.rate, 2);
      end if;

      if v_taxable < 0 then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;
      if v_prior_all_val + v_taxable > v_il.taxable_value then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;
    else
      if v_line.rate is null or v_line.rate <= 0 then
        raise exception 'DN_VALIDATION:invalid_rate';
      end if;
      v_rate := v_line.rate;
      v_taxable := round(v_line.qty * v_line.rate, 2);
    end if;

    -- Tax exactly like the invoice (Tax and rounding clarification), from the snapshot rate. A
    -- return against an invoice line is taxed CUMULATIVELY, like its taxable value: each component
    -- is round(returned-so-far taxable x rate) minus what earlier posted, un-cancelled returns on
    -- that line already reversed, so partial returns that reach the invoiced quantity reverse
    -- exactly the tax the invoice charged (review fix 1: 3 x 33.39 returned in thirds reversed
    -- 9.03 CGST against 9.02 charged when each note rounded its own share).
    if v_linked and v_doc.stock_effect then
      v_cum_taxable := v_prior_ret_val + v_taxable;
      if v_intra then
        v_cgst := round(v_cum_taxable * v_line.gst_rate / 2 / 100, 2) - v_prior_cgst;
        v_sgst := round(v_cum_taxable * v_line.gst_rate / 2 / 100, 2) - v_prior_sgst;
        v_igst := 0;
      else
        v_cgst := 0;
        v_sgst := 0;
        v_igst := round(v_cum_taxable * v_line.gst_rate / 100, 2) - v_prior_igst;
      end if;
      if v_cgst < 0 or v_sgst < 0 or v_igst < 0 then
        raise exception 'DN_VALIDATION:value_exceeds_invoice';
      end if;
    elsif v_intra then
      v_cgst := round(v_taxable * v_line.gst_rate / 2 / 100, 2);
      v_sgst := v_cgst;
      v_igst := 0;
    else
      v_cgst := 0;
      v_sgst := 0;
      v_igst := round(v_taxable * v_line.gst_rate / 100, 2);
    end if;

    update debit_note_lines
       set rate = v_rate, taxable_value = v_taxable, cgst_amt = v_cgst, sgst_amt = v_sgst, igst_amt = v_igst
     where id = v_line.id;

    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total    := v_cgst_total + v_cgst;
    v_sgst_total    := v_sgst_total + v_sgst;
    v_igst_total    := v_igst_total + v_igst;

    -- Cost basis exactly as the bill put it into stock: tax is part of it only when no credit was
    -- claimed.
    if v_itc then
      v_line_cost := v_taxable;
    else
      v_line_cost := v_taxable + v_cgst + v_sgst + v_igst;
    end if;

    if not v_doc.stock_effect then
      v_discount_tot := v_discount_tot + v_line_cost;
      continue;
    end if;

    -- Goods leave at the purchase's own rate. Checked after the item lock; no admin override (a
    -- debit note that takes out stock we do not hold would corrupt the average, and it is itself
    -- the documented remedy, not a thing to force).
    select qty, value into v_onhand_qty, v_onhand_value
    from stock_on_hand(v_line.item_id, v_inv.warehouse_id);

    if coalesce(v_onhand_qty, 0) - v_line.qty < 0 then
      raise exception 'DN_NEGATIVE_STOCK';
    end if;

    if coalesce(v_onhand_qty, 0) - v_line.qty = 0 then
      -- The note empties this godown (review fix 2). Stock must not be left at zero quantity still
      -- carrying value (it would sit in Inventory for goods that do not exist and inflate the next
      -- purchase's average). Take out the WHOLE remaining value; the difference from the bill's
      -- cost is the weighted-average error already booked through COGS on earlier sales, so it is
      -- trued up there (Dr COGS when more value remained than the bill's cost, Cr when less).
      -- Example: 100 @ 300 + 100 @ 320, sell 100 at 310, return the first bill's 100: the stock
      -- holds 31,000, the bill's cost is 30,000 -> Cr Inventory 31,000, Dr COGS 1,000.
      if coalesce(v_onhand_value, 0) < 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
      v_mv_value := coalesce(v_onhand_value, 0);
    else
      -- Never leave the ledger with negative value, or a positive quantity carrying no value.
      if coalesce(v_onhand_value, 0) - v_line_cost <= 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
      v_mv_value := v_line_cost;
    end if;

    v_inventory_tot := v_inventory_tot + v_mv_value;
    v_cogs_adj      := v_cogs_adj + (v_mv_value - v_line_cost);

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_inv.warehouse_id, v_doc.note_date, -v_line.qty,
       round(v_mv_value / v_line.qty, 4), -v_mv_value, 'debit_note', p_note_id);
  end loop;

  v_raw_total   := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total;

  if v_linked then
    -- Rounded CUMULATIVELY per invoice (round-2 review F1): the notes against one invoice together
    -- round like the invoice did. Each note rounding its own total let three thirds of a 149 invoice
    -- come to 50 + 50 + 50, so the last return was refused as over the open amount. Now: this
    -- note's grand total = round(raw of every posted, un-cancelled note on the invoice + this raw)
    -- - their grand totals. A full return therefore credits exactly the invoice's grand total.
    -- The per-note round-off can reach +/-1.00 (a carried residue plus its own); the journal takes
    -- it through round_off like any other.
    select coalesce(sum(taxable_total + cgst_total + sgst_total + igst_total), 0),
           coalesce(sum(grand_total), 0)
      into v_prior_raw, v_prior_grand
    from debit_notes where against_invoice_id = v_inv.id and status = 'posted';

    v_grand_total := round(v_prior_raw + v_raw_total) - v_prior_grand;
    v_round_off   := v_grand_total - v_raw_total;

    if abs(v_round_off) > 1.00 then
      raise exception 'DN_UNBALANCED';
    end if;

    -- The notes on an invoice can never add up to more than the invoice.
    if v_prior_grand + v_grand_total > v_inv.grand_total then
      raise exception 'DN_VALIDATION:value_exceeds_invoice';
    end if;
  else
    v_grand_total := round(v_raw_total);
    v_round_off   := v_grand_total - v_raw_total;

    if abs(v_round_off) > 0.50 then
      raise exception 'DN_UNBALANCED';
    end if;
  end if;

  if v_grand_total <= 0 then
    raise exception 'DN_VALIDATION:zero_total';
  end if;

  if v_linked then
    select coalesce(sum(pa.amount), 0) into v_allocated
    from payment_allocations pa
    join payments p on p.id = pa.payment_id and p.status = 'posted'
    where pa.invoice_type = 'purchase_invoice' and pa.invoice_id = v_inv.id;

    select coalesce(sum(grand_total), 0) into v_noted
    from debit_notes where against_invoice_id = v_inv.id and status = 'posted';

    v_open := v_inv.grand_total - v_allocated - v_noted;
    if v_open > 0 and v_grand_total > v_open then
      raise exception 'DN_VALIDATION:exceeds_open_amount';
    end if;
  end if;

  v_doc_no := next_doc_no('DB', v_doc.note_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.note_date, 'Debit note ' || v_doc_no, 'debit_note', p_note_id, v_actor, now())
  returning id into v_entry_id;

  v_line_no := v_line_no + 1;
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values (v_entry_id, v_line_no, v_ap_id, v_doc.party_id, v_grand_total, 0);

  if v_inventory_tot > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_inventory_id, 0, v_inventory_tot);
  end if;
  if v_discount_tot > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_disc_recd_id, 0, v_discount_tot);
  end if;
  -- Weighted-average true-up when a return empties the godown (see the stock loop).
  if v_cogs_adj > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cogs_id, v_cogs_adj, 0);
  elsif v_cogs_adj < 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cogs_id, 0, -v_cogs_adj);
  end if;

  if v_itc then
    if v_cgst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_cgst_id, 0, v_cgst_total);
    end if;
    if v_sgst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_sgst_id, 0, v_sgst_total);
    end if;
    if v_igst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_igst_id, 0, v_igst_total);
    end if;
  end if;

  -- The rounded total is DEBITED to AP here (mirror of the purchase), so a positive round-off is a
  -- credit and a negative one a debit.
  if v_round_off > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, 0, v_round_off);
  elsif v_round_off < 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, -v_round_off, 0);
  end if;

  update debit_notes
     set status = 'posted',
         note_no = v_doc_no,
         -- An inward supply's place of supply is our own state (Tax clarification); informational.
         place_of_supply = v_org_state,
         journal_entry_id = v_entry_id,
         taxable_total = v_taxable_total,
         cgst_total = v_cgst_total,
         sgst_total = v_sgst_total,
         igst_total = v_igst_total,
         round_off = v_round_off,
         grand_total = v_grand_total
   where id = p_note_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'debit_notes', p_note_id,
          jsonb_build_object('note_no', v_doc_no, 'entry_id', v_entry_id,
            'grand_total', v_grand_total, 'against_invoice_id', v_doc.against_invoice_id,
            'stock_effect', v_doc.stock_effect, 'itc_reversed', v_itc, 'cogs_true_up', v_cogs_adj));

  return v_entry_id;
end;
$$;

-- Not to service_role either (round-3 review; project convention: post functions run only as a
-- signed-in owner, auth.uid() is the actor).
revoke all on function public.post_credit_note(uuid) from public, anon, service_role;
revoke all on function public.post_debit_note(uuid) from public, anon, service_role;
grant execute on function public.post_credit_note(uuid) to authenticated;
grant execute on function public.post_debit_note(uuid) to authenticated;

-- ============================================================
-- 4. cancel_document: credit_note / debit_note branches; invoices refuse while a posted note stands
-- ============================================================
-- Copied from the live definition (last replaced in 20260928100000_aal2_enforcement.sql); the only
-- edits are the two has_notes guards and the new branch before the final ELSE. Grants are kept by
-- CREATE OR REPLACE.
create or replace function public.cancel_document(p_source_type source_type, p_source_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_doc           record;
  v_entry_id      uuid;
  v_today         date;
  v_period_locked bool;
  v_item_ids      uuid[];
  v_item_id       uuid;
  v_mv            record;
  v_onhand_qty    numeric(12,3);
  v_onhand_value  numeric(14,2);
  v_adv_balance   numeric(14,2);
  v_gross         numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  v_role := current_app_role();
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  if p_source_type = 'sales_invoice' then
    -- Lock order (same fixed order post_sales_invoice uses): (1) document, (1b) the challan
    -- it was converted from, (2) party, (3) every item touched, ascending id.
    select * into v_doc from sales_invoices where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    if v_doc.challan_id is not null then
      perform 1 from delivery_challans where id = v_doc.challan_id for update;
    end if;

    perform 1 from parties where id = v_doc.party_id for update;

    select array(
      select distinct item_id from stock_movements
      where source_type = 'sales_invoice' and source_id = p_source_id and reversal_of is null
      order by item_id
    ) into v_item_ids;

    foreach v_item_id in array v_item_ids loop
      perform 1 from items where id = v_item_id for update;
    end loop;

    -- Only a *posted* payment's allocation blocks a cancellation (M7, owner decision): a
    -- draft receipt someone is still typing is a plan, not money, and must not freeze the
    -- invoice it points at.
    if exists (
      select 1 from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.invoice_type = 'sales_invoice' and pa.invoice_id = p_source_id
        and p.status = 'posted'
    ) then
      raise exception 'DN_HAS_ALLOCATIONS';
    end if;

    -- Change 20: a posted credit note already reversed part of this invoice (and, for a return,
    -- already brought the goods back). Reversing the whole invoice on top would credit the
    -- customer and restock the goods twice. Cancel the note(s) first.
    if exists (select 1 from credit_notes where against_invoice_id = p_source_id and status = 'posted') then
      raise exception 'DN_VALIDATION:has_notes';
    end if;

    -- Missing period is blocked, same as a locked one (change 02's rule: periods never
    -- auto-create) — otherwise this check silently passes and the trigger below surfaces an
    -- unmapped message instead of the canonical code.
    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- Mirror-image journal entry, dated today (IST): the original period may since have been
    -- locked, and a correction must still be postable in the currently open period.
    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || v_doc.invoice_no, 'sales_invoice', p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    -- reversal_of is null: only mirror original movements, never a movement that is itself
    -- already a reversal (guards against a re-entrant cancel of the same source_id).
    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
    select item_id, warehouse_id, v_today, -qty, rate, -value, source_type, source_id, id
    from stock_movements
    where source_type = 'sales_invoice' and source_id = p_source_id and reversal_of is null;

    -- One-time reversed_by transition: the only UPDATE the immutability trigger allows.
    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update sales_invoices set status = 'cancelled' where id = p_source_id;

    -- Reopen the challan this invoice was converted from. The reversal above has already put
    -- the cost back into Goods in Transit (Dr GIT / Cr COGS), which is exactly the state the
    -- challan left behind, so the challan can be invoiced again.
    update delivery_challans set invoice_id = null where invoice_id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'sales_invoices', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'purchase_invoice' then
    select * into v_doc from purchase_invoices where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    perform 1 from parties where id = v_doc.party_id for update;

    select array(
      select distinct item_id from stock_movements
      where source_type = 'purchase_invoice' and source_id = p_source_id and reversal_of is null
      order by item_id
    ) into v_item_ids;

    foreach v_item_id in array v_item_ids loop
      perform 1 from items where id = v_item_id for update;
    end loop;

    -- Only a *posted* payment's allocation blocks a cancellation (M7, owner decision): a
    -- draft receipt someone is still typing is a plan, not money, and must not freeze the
    -- invoice it points at.
    if exists (
      select 1 from payment_allocations pa
      join payments p on p.id = pa.payment_id
      where pa.invoice_type = 'purchase_invoice' and pa.invoice_id = p_source_id
        and p.status = 'posted'
    ) then
      raise exception 'DN_HAS_ALLOCATIONS';
    end if;

    -- Change 20: same for a posted debit note (the goods already went back to the supplier).
    if exists (select 1 from debit_notes where against_invoice_id = p_source_id and status = 'posted') then
      raise exception 'DN_VALIDATION:has_notes';
    end if;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- Cancelling a purchase whose stock has since been sold would drive on-hand below zero.
    -- No admin override here (unlike a sale): the spec's fix is a debit note for the quantity
    -- still on hand, never a forced reversal. Checked after the item locks, so two concurrent
    -- operations on the same item cannot both pass.
    for v_mv in
      select item_id, warehouse_id, sum(qty) as qty, sum(value) as value,
             min(movement_date) as movement_date
      from stock_movements
      where source_type = 'purchase_invoice' and source_id = p_source_id and reversal_of is null
      group by item_id, warehouse_id
    loop
      select qty, value into v_onhand_qty, v_onhand_value
      from stock_on_hand(v_mv.item_id, v_mv.warehouse_id);

      if coalesce(v_onhand_qty, 0) - v_mv.qty < 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;

      -- Quantity alone is not enough (review finding B2). Weighted average is a running
      -- average: once *any* later movement has consumed stock at the blended rate, pulling the
      -- purchase's qty and value back out re-prices whatever is left at a rate it never had.
      -- Worked example from the review: opening 10 @ 100, purchase 10 @ 200 (avg 150), sell 5
      -- at 150. On hand is 15, so the quantity check passes — but the reversal leaves 5 units
      -- carrying Rs 250 (avg 50) instead of the Rs 500 they actually cost. The spec's remedy is
      -- a debit note for the quantity still on hand, never a forced reversal, so refuse as soon
      -- as the stock is no longer the untouched stock this bill brought in. Dates are the only
      -- ordering the ledger has (created_at is frozen inside a transaction), so "on or after the
      -- purchase's own movement date, from any other document" is the test.
      if exists (
        select 1 from stock_movements m
        where m.item_id = v_mv.item_id
          and m.warehouse_id = v_mv.warehouse_id
          and m.reversal_of is null
          and m.source_type <> 'opening'
          and not (m.source_type = 'purchase_invoice' and m.source_id = p_source_id)
          and m.movement_date >= v_mv.movement_date
      ) then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;

      -- Defence in depth for the same class of corruption: never leave the ledger holding a
      -- negative value, or a negative average on a positive quantity.
      if coalesce(v_onhand_value, 0) - v_mv.value < 0
         or (coalesce(v_onhand_qty, 0) - v_mv.qty > 0
             and coalesce(v_onhand_value, 0) - v_mv.value < 0)
      then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
    end loop;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || v_doc.invoice_no, 'purchase_invoice', p_source_id,
            v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
    select item_id, warehouse_id, v_today, -qty, rate, -value, source_type, source_id, id
    from stock_movements
    where source_type = 'purchase_invoice' and source_id = p_source_id and reversal_of is null;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update purchase_invoices set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'purchase_invoices', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'payment' then
    select * into v_doc from payments where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    perform 1 from parties where id = v_doc.party_id for update;

    -- A cheque that has reached the bank cannot be un-done by a book entry: the money either
    -- arrived (deposited/cleared) or came back (bounced, already reversed by bounce_cheque).
    -- The correct path past 'in_hand'/'issued' is bounce_cheque or a bank-reconciliation
    -- correction, not a silent reversal that would desynchronise the bank ledger.
    if v_doc.mode = 'cheque'
       and coalesce(v_doc.cheque_status, 'in_hand') in ('deposited', 'cleared', 'bounced', 'presented')
    then
      raise exception 'DN_CHEQUE_STATE';
    end if;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || coalesce(v_doc.voucher_no, ''), 'payment', p_source_id,
            v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    -- Same rule as a bounce: reversing the money re-opens whatever it had settled.
    delete from payment_allocations where payment_id = p_source_id;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update payments set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'payments', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'expense_voucher' then
    select * into v_doc from expense_vouchers where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    if v_doc.party_id is not null then
      perform 1 from parties where id = v_doc.party_id for update;
    end if;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- Reversing an advance credits employee_advance back out. If a salary voucher has since
    -- recovered that advance, the credit lands on a balance that is already zero and drives the
    -- employee's advance ledger negative — the business would be showing that it owes the
    -- employee money it actually paid him (M5). The correct order is to cancel the salary first,
    -- which restores the advance, and then cancel the advance.
    if v_doc.voucher_type = 'advance' then
      select coalesce(sum(amount), 0) into v_gross
      from expense_voucher_lines where voucher_id = p_source_id;

      select coalesce(sum(debit) - sum(credit), 0) into v_adv_balance
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where a.system_key = 'employee_advance' and jl.party_id = v_doc.party_id;

      if coalesce(v_adv_balance, 0) - v_gross < 0 then
        raise exception 'DN_VALIDATION:advance_already_recovered';
      end if;
    end if;
    -- No mirror guard is needed for cancelling a *salary* voucher: its reversal debits
    -- employee_advance (putting the recovered advance back), which can only raise that balance.
    -- The two guards together force the only safe order — salary first, then advance.

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || coalesce(v_doc.voucher_no, ''), 'expense_voucher',
            p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update expense_vouchers set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'expense_vouchers', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'delivery_challan' then
    select * into v_doc from delivery_challans where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    -- "Cancelling a challan already converted to an invoice raises DN_CONVERTED; cancel the
    -- invoice first (which reopens the challan)."
    if v_doc.invoice_id is not null then
      raise exception 'DN_CONVERTED';
    end if;

    perform 1 from parties where id = v_doc.party_id for update;

    select array(
      select distinct item_id from stock_movements
      where source_type = 'delivery_challan' and source_id = p_source_id and reversal_of is null
      order by item_id
    ) into v_item_ids;

    foreach v_item_id in array v_item_ids loop
      perform 1 from items where id = v_item_id for update;
    end loop;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || coalesce(v_doc.challan_no, ''), 'delivery_challan',
            p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    -- The goods come back into the godown at the cost they left with. No negative-stock risk:
    -- a challan reversal only adds stock.
    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
    select item_id, warehouse_id, v_today, -qty, rate, -value, source_type, source_id, id
    from stock_movements
    where source_type = 'delivery_challan' and source_id = p_source_id and reversal_of is null;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update delivery_challans set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'delivery_challans', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'stock_adjustment' then
    select * into v_doc from stock_adjustments where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    select array(
      select distinct item_id from stock_movements
      where source_type = 'stock_adjustment' and source_id = p_source_id and reversal_of is null
      order by item_id
    ) into v_item_ids;

    foreach v_item_id in array v_item_ids loop
      perform 1 from items where id = v_item_id for update;
    end loop;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_today)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- Reversing a found-stock adjustment removes stock again; if it has since been sold the
    -- reversal would go negative. Same unconditional rule as a purchase cancellation.
    for v_mv in
      select item_id, warehouse_id, sum(qty) as qty
      from stock_movements
      where source_type = 'stock_adjustment' and source_id = p_source_id and reversal_of is null
      group by item_id, warehouse_id
    loop
      select qty into v_onhand_qty from stock_on_hand(v_mv.item_id, v_mv.warehouse_id);
      if coalesce(v_onhand_qty, 0) - v_mv.qty < 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
    end loop;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_today, 'Reversal of ' || coalesce(v_doc.adj_no, ''), 'stock_adjustment',
            p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
    select item_id, warehouse_id, v_today, -qty, rate, -value, source_type, source_id, id
    from stock_movements
    where source_type = 'stock_adjustment' and source_id = p_source_id and reversal_of is null;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update stock_adjustments set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'stock_adjustments', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  elsif p_source_type = 'stock_transfer' then
    -- State machine, not doc_status: a transfer can be cancelled from 'draft' (nothing has
    -- moved) or from 'in_transit' (goods come back to the source godown). Once 'received' the
    -- stock is in the destination godown and the correction is a new transfer the other way,
    -- not a reversal. Returns NULL: a transfer never has a journal entry.
    select * into v_doc from stock_transfers where id = p_source_id for update;
    if not found or v_doc.status not in ('draft', 'in_transit') then
      raise exception 'DN_TRANSFER_STATE';
    end if;

    if v_doc.status = 'in_transit' then
      select array(
        select distinct item_id from stock_movements
        where source_type = 'stock_transfer' and source_id = p_source_id and reversal_of is null
        order by item_id
      ) into v_item_ids;

      foreach v_item_id in array v_item_ids loop
        perform 1 from items where id = v_item_id for update;
      end loop;

      select is_locked into v_period_locked
      from fiscal_periods where month = date_trunc('month', v_today)::date;
      if coalesce(v_period_locked, true) then
        raise exception 'DN_PERIOD_LOCKED';
      end if;

      insert into stock_movements
        (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
      select item_id, warehouse_id, v_today, -qty, rate, -value, source_type, source_id, id
      from stock_movements
      where source_type = 'stock_transfer' and source_id = p_source_id and reversal_of is null;
    end if;

    update stock_transfers set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'stock_transfers', p_source_id,
            jsonb_build_object('from_status', v_doc.status, 'reason', p_reason));

  elsif p_source_type = 'day_close' then
    -- Reopening a day close: admin-only (the gate at the top of this function) and
    -- audit-logged, per the day_closes spec paragraph. The row is kept as 'cancelled' rather
    -- than deleted so the reopen leaves a trail; the date can then be closed again.
    select * into v_doc from day_closes where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    -- The reversal is dated on the day being reopened, not today (review blocker). Every other
    -- reversal in this engine is dated today on purpose — the original period may since have
    -- been locked and a correction must stay postable. A day close is the one document where
    -- that is wrong: post_day_close derives `expected` from the cash ledger *as at close_date*,
    -- so a reversal dated later would leave the over/short entry sitting inside the very day it
    -- was cancelling. Re-closing that date would then read its own cancelled adjustment as real
    -- cash movement and compute an expected balance that never existed. Dating the reversal on
    -- close_date makes the two entries cancel exactly, inside the day they belong to.
    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_doc.close_date)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- A zero-difference close has no journal entry to reverse; the reopen is then status +
    -- audit only and returns NULL.
    if v_doc.journal_entry_id is not null then
      insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
      values (v_doc.close_date, 'Reversal of day close ' || to_char(v_doc.close_date, 'DD-MM-YYYY'),
              'day_close', p_source_id, v_actor, now())
      returning id into v_entry_id;

      insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
      select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
      from journal_lines
      where entry_id = v_doc.journal_entry_id;

      update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;
    end if;

    update day_closes set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'day_closes', p_source_id,
            jsonb_build_object('close_date', v_doc.close_date, 'reversal_entry_id', v_entry_id,
              'reason', p_reason));

  elsif p_source_type in ('credit_note', 'debit_note') then
    -- Change 20. Lock order as the posting functions: note -> invoice -> party -> items.
    if p_source_type = 'credit_note' then
      select * into v_doc from credit_notes where id = p_source_id for update;
    else
      select * into v_doc from debit_notes where id = p_source_id for update;
    end if;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    if v_doc.against_invoice_id is not null then
      if p_source_type = 'credit_note' then
        perform 1 from sales_invoices where id = v_doc.against_invoice_id for update;
      else
        perform 1 from purchase_invoices where id = v_doc.against_invoice_id for update;
      end if;
    end if;

    perform 1 from parties where id = v_doc.party_id for update;

    select array(
      select distinct item_id from stock_movements
      where source_type = p_source_type and source_id = p_source_id and reversal_of is null
      order by item_id
    ) into v_item_ids;

    foreach v_item_id in array v_item_ids loop
      perform 1 from items where id = v_item_id for update;
    end loop;

    -- The reversal is dated on the note's own date (brief: a cancelled note must leave the month it
    -- was reported in exactly as if it had never posted, so GSTR-1/3B and the ledger for that month
    -- agree). That month must therefore still be open; a missing period is blocked like a locked one.
    -- refuse_cancel_in_locked_period says the same for both note tables as a backstop.
    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_doc.note_date)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    -- Notes on one invoice are cancelled last-posted-first (round-3 review). Their grand totals are
    -- rounded cumulatively (post_*_note), which only stays exact while the posted notes are an
    -- unbroken prefix of the posting order: cancelling one in the middle would leave a later note's
    -- rounding carried on a residue that no longer exists, and could make the next return
    -- unpostable (round-off beyond 1.00). Posting order = the notes' journal entry numbers, which
    -- are strictly increasing and unique.
    if v_doc.against_invoice_id is not null and exists (
      select 1
      from (select n.id, n.journal_entry_id from credit_notes n
             where p_source_type = 'credit_note' and n.against_invoice_id = v_doc.against_invoice_id
               and n.status = 'posted'
            union all
            select n.id, n.journal_entry_id from debit_notes n
             where p_source_type = 'debit_note' and n.against_invoice_id = v_doc.against_invoice_id
               and n.status = 'posted') o
      join journal_entries je on je.id = o.journal_entry_id
      where o.id <> p_source_id
        and je.entry_no > (select entry_no from journal_entries where id = v_doc.journal_entry_id)
    ) then
      raise exception 'DN_VALIDATION:later_notes';
    end if;

    -- Same rule as cancelling a purchase: backdating a stock reversal is only safe while nothing
    -- else has touched that item/godown since the note moved it. Once another document has moved
    -- stock on or after the note's date the weighted average has been carried forward from it, and
    -- pulling the note out re-prices history (and, for a credit note, may take out goods that were
    -- sold again). Refuse; the correction is then a new document.
    for v_mv in
      select item_id, warehouse_id, sum(qty) as qty, sum(value) as value,
             min(movement_date) as movement_date
      from stock_movements
      where source_type = p_source_type and source_id = p_source_id and reversal_of is null
      group by item_id, warehouse_id
    loop
      select qty, value into v_onhand_qty, v_onhand_value
      from stock_on_hand(v_mv.item_id, v_mv.warehouse_id);

      if coalesce(v_onhand_qty, 0) - v_mv.qty < 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;

      if exists (
        select 1 from stock_movements m
        where m.item_id = v_mv.item_id
          and m.warehouse_id = v_mv.warehouse_id
          and m.reversal_of is null
          and m.source_type <> 'opening'
          and not (m.source_type = p_source_type and m.source_id = p_source_id)
          and m.movement_date >= v_mv.movement_date
      ) then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;

      if coalesce(v_onhand_value, 0) - v_mv.value < 0 then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
    end loop;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_doc.note_date, 'Reversal of ' || coalesce(v_doc.note_no, ''), p_source_type,
            p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id, reversal_of)
    select item_id, warehouse_id, v_doc.note_date, -qty, rate, -value, source_type, source_id, id
    from stock_movements
    where source_type = p_source_type and source_id = p_source_id and reversal_of is null;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    if p_source_type = 'credit_note' then
      update credit_notes set status = 'cancelled' where id = p_source_id;
    else
      update debit_notes set status = 'cancelled' where id = p_source_id;
    end if;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel',
            case when p_source_type = 'credit_note' then 'credit_notes' else 'debit_notes' end,
            p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  else
    raise exception 'DN_VALIDATION:unsupported_source';
  end if;

  return v_entry_id;
end;
$$;

-- ============================================================
-- 5. A filed month stays as filed: debit notes too
-- ============================================================
create or replace function public.refuse_cancel_in_locked_period()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_date date;
begin
  if old.status = 'posted' and new.status = 'cancelled' then
    -- (the record's shape differs per table, so its date column is read by name)
    v_date := (to_jsonb(new) ->> case tg_table_name
      when 'sales_invoices' then 'invoice_date'
      when 'purchase_invoices' then 'invoice_date'
      when 'credit_notes' then 'note_date'
      when 'debit_notes' then 'note_date'
      when 'delivery_challans' then 'challan_date'
      when 'expense_vouchers' then 'voucher_date'
    end)::date;
    if exists (select 1 from fiscal_periods where month = date_trunc('month', v_date)::date and is_locked) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;
  end if;
  return new;
end;
$$;

create trigger refuse_cancel_in_locked_period before update of status on debit_notes
  for each row execute function public.refuse_cancel_in_locked_period();

-- ============================================================
-- 6. GST reports
-- ============================================================
-- (a) A value-only credit note (rate difference) returns no goods: it lowers the taxable value in
-- the HSN summary but not the quantity. Only the qty column of the credit-note half changes.
create or replace function public._gst_out_lines(p_from date, p_to date)
returns table (
  kind text, sgn int, doc_id uuid, doc_no text, doc_date date, doc_value numeric, pos text, ctin text,
  inter boolean, hsn text, item_name text, uom text, qty numeric, rt numeric,
  txval numeric, iamt numeric, camt numeric, samt numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with org as (select state_code from organization limit 1)
  select 'inv', 1, si.id, si.invoice_no, si.invoice_date, si.grand_total, si.place_of_supply::text,
         si.buyer_gstin, si.place_of_supply <> org.state_code,
         l.hsn_code, l.item_name, l.uom, l.qty, l.gst_rate,
         l.taxable_value, l.igst_amt, l.cgst_amt, l.sgst_amt
  from sales_invoices si
  join sales_invoice_lines l on l.invoice_id = si.id
  cross join org
  where si.status = 'posted' and si.invoice_date >= p_from and si.invoice_date < p_to
  union all
  select 'cn', -1, cn.id, cn.note_no, cn.note_date, cn.grand_total, cn.place_of_supply::text,
         cn.buyer_gstin, cn.place_of_supply <> org.state_code,
         l.hsn_code, l.item_name, l.uom, case when cn.stock_effect then l.qty else 0 end, l.gst_rate,
         l.taxable_value, l.igst_amt, l.cgst_amt, l.sgst_amt
  from credit_notes cn
  join credit_note_lines l on l.note_id = cn.id
  cross join org
  where cn.status = 'posted' and cn.note_date >= p_from and cn.note_date < p_to;
$$;
revoke all on function public._gst_out_lines(date, date) from public, anon, authenticated, service_role;

-- (b) GSTR-3B: 4A5 (ITC available) and 4D (ineligible) are net of posted debit notes dated in the
-- month, against an ITC-eligible bill (or with no bill: post_debit_note treats that credit as
-- claimed and reverses it) and against a non-eligible bill respectively. Before this, a debit note
-- would lower books_input (its entry credits input tax) while 4A5 did not move, so recon_input would
-- show a false difference. Everything else is unchanged from 20260930100000.
create or replace function public.gstr3b_summary(p_month date)
returns table (row_key text, taxable numeric, igst numeric, cgst numeric, sgst numeric, cess numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to   date;
  v_o    record;   -- 3.1a
  v_n    record;   -- 3.1c
  v_r    record;   -- 3.1d
  v_i5   record;   -- 4A5
  v_id   record;   -- 4D
  v_bo   record;   -- books output
  v_bi   record;   -- books input
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_month is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  v_from := date_trunc('month', p_month)::date;
  v_to := (v_from + interval '1 month')::date;

  select coalesce(sum(sgn * txval), 0) t, coalesce(sum(sgn * iamt), 0) i, coalesce(sum(sgn * camt), 0) c, coalesce(sum(sgn * samt), 0) s
    into v_o from _gst_out_lines(v_from, v_to) where rt > 0;
  select coalesce(sum(sgn * txval), 0) t into v_n from _gst_out_lines(v_from, v_to) where rt = 0;

  select coalesce(sum(vl.amount), 0) as t into v_r
  from expense_vouchers v join expense_voucher_lines vl on vl.voucher_id = v.id
  where v.status = 'posted' and vl.rcm and v.voucher_date >= v_from and v.voucher_date < v_to;
  -- The tax on reverse-charge freight is what its entry credits to RCM payable (an expense line posted straight
  -- to an input-tax account on the same voucher is not RCM tax). Phase 1 refuses inter-state RCM, so it is
  -- always CGST + SGST, split half and half.
  select v_r.t as t,
         0::numeric as i,
         round(x.tax / 2, 2) as c,
         x.tax - round(x.tax / 2, 2) as s
    into v_r
  from (
    select coalesce(sum(jl.credit), 0) as tax
    from journal_lines jl
    join accounts a on a.id = jl.account_id and a.system_key = 'rcm_payable'
    where jl.entry_id in (
      select v.journal_entry_id from expense_vouchers v
      where v.status = 'posted' and v.voucher_date >= v_from and v.voucher_date < v_to
        and exists (select 1 from expense_voucher_lines vl where vl.voucher_id = v.id and vl.rcm))
  ) x;

  select coalesce(sum(t), 0) t, coalesce(sum(i), 0) i, coalesce(sum(c), 0) c, coalesce(sum(s), 0) s
    into v_i5
  from (
    select l.taxable_value t, l.igst_amt i, l.cgst_amt c, l.sgst_amt s
    from purchase_invoices pi join purchase_invoice_lines l on l.invoice_id = pi.id
    where pi.status = 'posted' and pi.itc_eligible and pi.invoice_date >= v_from and pi.invoice_date < v_to
    union all
    select -l.taxable_value, -l.igst_amt, -l.cgst_amt, -l.sgst_amt
    from debit_notes dn join debit_note_lines l on l.note_id = dn.id
    left join purchase_invoices pi on pi.id = dn.against_invoice_id
    where dn.status = 'posted' and coalesce(pi.itc_eligible, true)
      and dn.note_date >= v_from and dn.note_date < v_to
  ) x;
  select coalesce(sum(t), 0) t, coalesce(sum(i), 0) i, coalesce(sum(c), 0) c, coalesce(sum(s), 0) s
    into v_id
  from (
    select l.taxable_value t, l.igst_amt i, l.cgst_amt c, l.sgst_amt s
    from purchase_invoices pi join purchase_invoice_lines l on l.invoice_id = pi.id
    where pi.status = 'posted' and not pi.itc_eligible and pi.invoice_date >= v_from and pi.invoice_date < v_to
    union all
    select -l.taxable_value, -l.igst_amt, -l.cgst_amt, -l.sgst_amt
    from debit_notes dn join debit_note_lines l on l.note_id = dn.id
    join purchase_invoices pi on pi.id = dn.against_invoice_id
    where dn.status = 'posted' and not pi.itc_eligible
      and dn.note_date >= v_from and dn.note_date < v_to
  ) x;

  select coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_igst'), 0) i,
         coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_cgst'), 0) c,
         coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_sgst'), 0) s
    into v_bo
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where je.source_type in ('sales_invoice', 'credit_note') and je.entry_date >= v_from and je.entry_date < v_to;

  select coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_igst'), 0) i,
         coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_cgst'), 0) c,
         coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_sgst'), 0) s
    into v_bi
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where je.source_type in ('purchase_invoice', 'debit_note', 'expense_voucher') and je.entry_date >= v_from and je.entry_date < v_to;

  return query select '3.1a', v_o.t, v_o.i, v_o.c, v_o.s, 0::numeric;
  return query select '3.1c', v_n.t, 0::numeric, 0::numeric, 0::numeric, 0::numeric;
  return query select '3.1d', v_r.t, v_r.i, v_r.c, v_r.s, 0::numeric;
  return query
    select '3.2:' || x.pos, sum(x.sgn * x.txval), sum(x.sgn * x.iamt), 0::numeric, 0::numeric, 0::numeric
    from _gst_out_lines(v_from, v_to) x
    where x.ctin is null and x.inter and x.rt > 0
    group by x.pos
    having sum(x.sgn * x.txval) <> 0 or sum(x.sgn * x.iamt) <> 0
    order by x.pos;
  return query select '4A3', v_r.t, v_r.i, v_r.c, v_r.s, 0::numeric;
  return query select '4A5', v_i5.t, v_i5.i, v_i5.c, v_i5.s, 0::numeric;
  return query select '4D', v_id.t, v_id.i, v_id.c, v_id.s, 0::numeric;
  return query select 'books_output', 0::numeric, v_bo.i, v_bo.c, v_bo.s, 0::numeric;
  return query select 'books_input', 0::numeric, v_bi.i, v_bi.c, v_bi.s, 0::numeric;
  return query select 'recon_output', 0::numeric, v_o.i - v_bo.i, v_o.c - v_bo.c, v_o.s - v_bo.s, 0::numeric;
  return query select 'recon_input', 0::numeric,
    (v_i5.i + v_r.i) - v_bi.i, (v_i5.c + v_r.c) - v_bi.c, (v_i5.s + v_r.s) - v_bi.s, 0::numeric;
end;
$$;

revoke all on function public.gstr3b_summary(date) from public, anon;
grant execute on function public.gstr3b_summary(date) to authenticated;
grant execute on function public.gstr3b_summary(date) to service_role;
