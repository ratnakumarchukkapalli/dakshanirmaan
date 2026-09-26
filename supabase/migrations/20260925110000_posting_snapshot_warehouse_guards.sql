-- Review fixes (Opus review of change 10a): master snapshots and warehouse guards at post time.
--
-- 1. Hard rule 10 (tax / HSN / names snapshotted from masters at post time). Document lines are
--    client-writable while their header is a draft (RLS insert_draft / update_draft let any
--    active member write any column through PostgREST), and the posting functions computed tax
--    from the line's gst_rate without re-reading `items`. A counter user could PATCH gst_rate = 0
--    on a draft for 28% cement and post it with no output GST.
--
--    Design: every post function that owns a line table with master-derived columns now
--    overwrites those columns from `items` immediately after it has locked the item rows, and
--    before anything is computed from them. Chosen over BEFORE INSERT/UPDATE snapshot triggers
--    because it is the smaller change that cannot be bypassed: a line only matters once its
--    document is posted, posting only happens inside these SECURITY DEFINER functions, and
--    after posting RLS denies every line write. A trigger would snapshot at *save* time, which is
--    the wrong moment anyway (the master can change between saving a draft and posting it — the
--    rule says post time), so the post-time copy would still be needed; the trigger would only
--    make the draft preview agree with the tampered-with row, which moves no number.
--    Columns overwritten: item_name, hsn_code, uom (= items.base_uom, the unit every quantity is
--    stored in), gst_rate. User inputs (qty, rate, discount_pct) are not snapshots; the sales
--    invoice now range-checks them because no table CHECK does.
--
-- 2. The draft header's warehouse_id is client-writable. _post_sales_invoice and
--    post_purchase_invoice now refuse the hidden In Transit warehouse (DN_VALIDATION:
--    invalid_warehouse). post_delivery_challan, post_stock_transfer and post_stock_adjustment
--    already refused it (DN_VALIDATION:transit_warehouse) and keep their existing detail.
--
-- 3. Minor: a zero grand total raises DN_VALIDATION:zero_total instead of a raw journal CHECK
--    violation; record_invoice_ewb refuses an e-way-bill date before the invoice date; the
--    transport / e-way-bill columns on sales_invoices get table CHECKs mirroring
--    record_invoice_ewb, and e-way-bill facts cannot sit on a draft at all (they are only ever
--    recorded on a posted invoice, through record_invoice_ewb).
--
-- Every function is CREATE OR REPLACE on its existing signature with its body carried over
-- verbatim apart from the marked additions: same SECURITY DEFINER, SET search_path = public,
-- pg_temp, grants/revokes restated exactly as the originals. Lock order unchanged (document ->
-- challan -> party -> items ascending -> doc_sequences): the snapshot UPDATEs only touch this
-- document's own line rows, after the item locks.

-- ============================================================
-- 1. sales_invoices transport / e-way-bill CHECKs (same shapes record_invoice_ewb enforces)
-- ============================================================

alter table sales_invoices
  add constraint sales_invoices_transport_mode_check
    check (transport_mode is null or transport_mode in ('road', 'rail', 'air', 'ship')),
  add constraint sales_invoices_distance_check
    check (distance_km is null or distance_km between 0 and 5000),
  add constraint sales_invoices_transporter_name_check
    check (transporter_name is null or (btrim(transporter_name) <> '' and length(transporter_name) <= 120)),
  add constraint sales_invoices_transporter_gstin_check
    check (transporter_gstin is null or transporter_gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  add constraint sales_invoices_vehicle_no_check
    check (vehicle_no is null or vehicle_no ~ '^[A-Z0-9 -]{4,20}$'),
  add constraint sales_invoices_ewb_check
    check (
      (ewb_no is null and ewb_date is null and ewb_valid_until is null)
      or (ewb_no ~ '^[0-9]{12}$' and ewb_date is not null and ewb_valid_until is not null
          and ewb_date >= invoice_date and status <> 'draft')
    );

-- ============================================================
-- 2. _post_sales_invoice (full body carried over from 20260918140100; changes marked
--    "Opus review of 10a" / step 3b / zero_total)
-- ============================================================

create or replace function public._post_sales_invoice(
  p_invoice_id uuid,
  p_skip_credit bool,
  p_override_credit bool default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_doc            record;
  v_party          record;
  v_line           record;
  v_role           app_role;
  v_org_state      char(2);
  v_intra          bool;
  v_warehouse_id   uuid;
  v_entry_id       uuid;
  v_doc_no         text;
  v_line_no        int := 0;
  v_item_ids       uuid[];
  v_item_id        uuid;

  v_ar_id                uuid;
  v_cogs_id              uuid;
  v_inventory_id         uuid;
  v_git_id               uuid;
  v_output_cgst_id       uuid;
  v_output_sgst_id       uuid;
  v_output_igst_id       uuid;
  v_round_off_id         uuid;
  v_cement_id            uuid;
  v_steel_id             uuid;
  v_other_id             uuid;
  v_freight_recovered_id uuid;

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
  v_cogs_total    numeric(14,2) := 0;

  v_raw_total     numeric(14,2);
  v_grand_total   numeric(14,2);
  v_round_off     numeric(14,2);

  v_onhand_qty    numeric(12,3);
  v_onhand_rate   numeric(14,4);
  v_line_cogs     numeric(14,2);

  v_ar_balance         numeric(14,2);
  v_credit_overridden  bool := false;
  v_period_locked      bool;
  v_allow_negative     bool;

  v_challan            record;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- 1. Lock the document; drafts only
  select * into v_doc from sales_invoices where id = p_invoice_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- 1b. Challan conversion (Implementation clarifications -> Challan -> invoice). The challan
  --     is a second document row, locked immediately after the invoice and before the party,
  --     so post_sales_invoice and cancel_document agree on the order invoice -> challan ->
  --     party -> items.
  if v_doc.challan_id is not null then
    select * into v_challan from delivery_challans where id = v_doc.challan_id for update;
    if not found or v_challan.status <> 'posted' then
      raise exception 'DN_VALIDATION:challan_not_posted';
    end if;
    if v_challan.invoice_id is not null and v_challan.invoice_id <> p_invoice_id then
      raise exception 'DN_CONVERTED';
    end if;
    if v_challan.party_id <> v_doc.party_id
       or v_challan.warehouse_id <> v_doc.warehouse_id then
      raise exception 'DN_VALIDATION:challan_mismatch';
    end if;

    -- An invoice cannot predate the delivery it bills (review finding 7). Back-dating one puts
    -- the COGS entry in a period before the Goods-in-Transit balance it relieves exists, so the
    -- earlier period's books would show a credit to an account holding nothing — and a GST
    -- return for a month in which the goods had not yet moved.
    if v_doc.invoice_date < v_challan.challan_date then
      raise exception 'DN_VALIDATION:invoice_before_challan';
    end if;

    -- Items and quantities must match exactly. Non-stock invoice lines (freight, hamali) are
    -- excluded: nothing was delivered for them, so they never appear on a challan.
    if exists (
      select 1
      from (
        select l.item_id, sum(l.qty) as qty
        from sales_invoice_lines l
        join items i on i.id = l.item_id
        where l.invoice_id = p_invoice_id and i.is_stock
        group by l.item_id
      ) inv
      full outer join (
        select item_id, sum(qty) as qty
        from delivery_challan_lines
        where challan_id = v_doc.challan_id
        group by item_id
      ) ch on ch.item_id = inv.item_id
      where inv.item_id is null or ch.item_id is null or inv.qty <> ch.qty
    ) then
      raise exception 'DN_VALIDATION:challan_mismatch';
    end if;
  end if;

  -- 2. Role gate: both admin and user may post sales invoices (daily billing must not block)
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- 3. Period lock (explicit check for the canonical error code; the INSERT trigger from
  --    change 02 enforces this unconditionally as a backstop). A missing period is blocked,
  --    same as a locked one (change 02's rule: periods never auto-create) — otherwise this
  --    check silently passes and the trigger surfaces an unmapped message instead.
  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.invoice_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from sales_invoice_lines where invoice_id = p_invoice_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  -- The header's warehouse is client-writable on a draft (RLS update_draft). The hidden In
  -- Transit warehouse only ever holds stock between post_stock_transfer and
  -- receive_stock_transfer; selling out of it would credit Inventory for goods that are on a
  -- lorry, and leave the transfer unable to be received. A warehouse that does not exist is
  -- impossible (FK), so the only bad value is the transit one (Opus review of 10a, finding 2).
  if coalesce((select is_transit from warehouses where id = v_doc.warehouse_id), true) then
    raise exception 'DN_VALIDATION:invalid_warehouse';
  end if;

  -- Lock order step 2: the party row, before any item locks. Also the source of the
  -- is_active/type/credit_limit checks below.
  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  -- Lock order step 3: every item this invoice touches, locked in ascending id order via a
  -- PL/pgSQL loop (not a single ORDER BY ... FOR UPDATE — Postgres doesn't guarantee lock
  -- *acquisition* order matches a query's ORDER BY, only the result order; a loop of
  -- individual statements does). This is what actually serializes two concurrent sales of the
  -- same item's last stock — not the doc_sequences lock, which comes last.
  select array(
    select distinct item_id from sales_invoice_lines
    where invoice_id = p_invoice_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- 3b. Snapshot the master NOW (hard rule 10; Opus review of 10a, finding 1). The line's
  --     item_name / hsn_code / uom / gst_rate columns are client-writable on a draft (RLS
  --     insert_draft / update_draft), so the values the app wrote at save time prove nothing: a
  --     draft for 28% cement PATCHed to gst_rate = 0 would otherwise post with no output GST.
  --     The item rows are locked above, so what is copied here is exactly what the tax below is
  --     computed from and what the posted document will show forever after. Rate, discount and
  --     qty stay the user's inputs; they are range-checked in the loop.
  update sales_invoice_lines l
     set item_name = i.name, hsn_code = i.hsn_code, uom = i.base_uom, gst_rate = i.gst_rate
    from items i
   where i.id = l.item_id and l.invoice_id = p_invoice_id;

  -- 4. Recompute money from line snapshots (never trust client totals)
  select state_code, allow_negative_stock into v_org_state, v_allow_negative
  from organization limit 1;
  v_intra := (v_doc.place_of_supply = v_org_state);
  v_warehouse_id := v_doc.warehouse_id;

  select id into v_ar_id                from accounts where system_key = 'ar';
  select id into v_cogs_id              from accounts where system_key = 'cogs';
  select id into v_inventory_id         from accounts where system_key = 'inventory';
  select id into v_git_id               from accounts where system_key = 'goods_in_transit';
  select id into v_output_cgst_id       from accounts where system_key = 'output_cgst';
  select id into v_output_sgst_id       from accounts where system_key = 'output_sgst';
  select id into v_output_igst_id       from accounts where system_key = 'output_igst';
  select id into v_round_off_id         from accounts where system_key = 'round_off';
  select id into v_cement_id            from accounts where system_key = 'sales_cement';
  select id into v_steel_id             from accounts where system_key = 'sales_steel';
  select id into v_other_id             from accounts where system_key = 'sales_other';
  select id into v_freight_recovered_id from accounts where system_key = 'freight_recovered';

  if v_ar_id is null or v_cogs_id is null or v_inventory_id is null or v_git_id is null
     or v_output_cgst_id is null or v_output_sgst_id is null or v_output_igst_id is null
     or v_round_off_id is null or v_cement_id is null or v_steel_id is null
     or v_other_id is null or v_freight_recovered_id is null
  then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.category, i.is_stock
    from sales_invoice_lines l
    join items i on i.id = l.item_id
    where l.invoice_id = p_invoice_id
    order by l.line_no
  loop
    -- The same line columns are client-writable, and no table CHECK bounds them: a negative qty
    -- would turn the stock-out below into a stock-in with no Inventory debit, a discount over
    -- 100% a negative sale.
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;
    if v_line.rate is null or v_line.rate < 0 then
      raise exception 'DN_VALIDATION:invalid_rate';
    end if;
    if v_line.discount_pct is null or v_line.discount_pct < 0 or v_line.discount_pct > 100 then
      raise exception 'DN_VALIDATION:invalid_discount';
    end if;

    v_taxable := round(v_line.qty * v_line.rate * (1 - v_line.discount_pct / 100), 2);

    if v_intra then
      v_cgst := round(v_taxable * v_line.gst_rate / 2 / 100, 2);
      v_sgst := v_cgst;
      v_igst := 0;
    else
      v_cgst := 0;
      v_sgst := 0;
      v_igst := round(v_taxable * v_line.gst_rate / 100, 2);
    end if;

    update sales_invoice_lines
       set taxable_value = v_taxable, cgst_amt = v_cgst, sgst_amt = v_sgst, igst_amt = v_igst
     where id = v_line.id;

    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total    := v_cgst_total + v_cgst;
    v_sgst_total    := v_sgst_total + v_sgst;
    v_igst_total    := v_igst_total + v_igst;

    if not v_line.is_stock then
      -- Non-stock line (freight, loading charges billed to the customer): revenue only,
      -- no stock movement. Its GST rate is the freight item's own master rate, snapshotted in
      -- step 3b like every other line (composite supply = give the freight item the goods'
      -- rate in the item master).
      v_freight_total := v_freight_total + v_taxable;
      continue;
    end if;

    if v_line.category = 'cement' then
      v_cement_total := v_cement_total + v_taxable;
    elsif v_line.category = 'steel' then
      v_steel_total := v_steel_total + v_taxable;
    else
      v_other_total := v_other_total + v_taxable;
    end if;

    -- Converted from a challan: the stock already left at challan time and its cost is
    -- already parked in Goods in Transit, so this invoice writes no stock movement and does
    -- not re-check on-hand (the goods are gone, re-checking would double-count them).
    if v_doc.challan_id is not null then
      continue;
    end if;

    -- Weighted-average COGS + stock OUT, valued at on-hand average before this line's
    -- movement. Safe under concurrency: this item's row is already locked above.
    select qty, avg_rate into v_onhand_qty, v_onhand_rate
    from stock_on_hand(v_line.item_id, v_warehouse_id);

    if v_onhand_qty - v_line.qty < 0 and not (v_allow_negative and v_role = 'admin') then
      raise exception 'DN_NEGATIVE_STOCK';
    end if;

    -- Goods with no cost basis would post a sale at 100% margin: revenue recognised, COGS zero,
    -- Inventory untouched — silently, and only visible months later in the P&L (review finding
    -- B2). It happens when stock exists at a zero average, or when the admin oversells into
    -- negative stock the weighted average cannot price. Refuse; the fix is to enter the opening
    -- or purchase cost of that item first.
    if v_line.qty > 0 and coalesce(v_onhand_rate, 0) <= 0 then
      raise exception 'DN_VALIDATION:no_cost_basis';
    end if;

    v_line_cogs := round(v_line.qty * v_onhand_rate, 2);
    v_cogs_total := v_cogs_total + v_line_cogs;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_warehouse_id, v_doc.invoice_date, -v_line.qty, v_onhand_rate,
       -v_line_cogs, 'sales_invoice', p_invoice_id);
  end loop;

  -- COGS for a converted challan is the cost the challan actually carried out of Inventory,
  -- read back from its own (un-reversed) movements. Using today's weighted average instead
  -- would leave a residue in Goods in Transit whenever the average moved between the two
  -- documents.
  if v_doc.challan_id is not null then
    select coalesce(sum(-value), 0) into v_cogs_total
    from stock_movements
    where source_type = 'delivery_challan' and source_id = v_doc.challan_id
      and reversal_of is null;
  end if;

  v_raw_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total;
  v_grand_total := round(v_raw_total);
  v_round_off := v_grand_total - v_raw_total;

  if abs(v_round_off) > 0.50 then
    raise exception 'DN_UNBALANCED';
  end if;

  -- A zero total would otherwise fail on journal_lines' "amount > 0" CHECK with a raw 23514 when
  -- the AR line is inserted. Say it in the mapped vocabulary instead (the app keeps its
  -- journal_lines_check mapping as a backstop).
  if v_grand_total <= 0 then
    raise exception 'DN_VALIDATION:zero_total';
  end if;

  -- Credit limit: NULL means unlimited (nobody set one), 0 means no credit at all. Balance =
  -- net Dr on the party's AR control lines. Skipped entirely on the cash-sale path, where the
  -- receipt in the same transaction nets AR back to zero before commit.
  if not p_skip_credit and v_party.credit_limit is not null then
    select coalesce(sum(debit) - sum(credit), 0) into v_ar_balance
    from journal_lines where account_id = v_ar_id and party_id = v_doc.party_id;

    if v_ar_balance + v_grand_total > v_party.credit_limit then
      if p_override_credit and v_role = 'admin' then
        v_credit_overridden := true;
      else
        raise exception 'DN_CREDIT_LIMIT';
      end if;
    end if;
  end if;

  -- 5. Assign number now (gapless per FY series; doc_sequences is the last lock in the order)
  v_doc_no := next_doc_no('DN', v_doc.invoice_date);

  -- 6. Journal entry + lines (deferred trigger verifies balance)
  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.invoice_date, 'Sales invoice ' || v_doc_no, 'sales_invoice', p_invoice_id, v_actor, now())
  returning id into v_entry_id;

  v_line_no := v_line_no + 1;
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values (v_entry_id, v_line_no, v_ar_id, v_doc.party_id, v_grand_total, 0);

  if v_cement_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cement_id, 0, v_cement_total);
  end if;

  if v_steel_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_steel_id, 0, v_steel_total);
  end if;

  if v_other_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_other_id, 0, v_other_total);
  end if;

  if v_freight_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_freight_recovered_id, 0, v_freight_total);
  end if;

  if v_cgst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_cgst_id, 0, v_cgst_total);
  end if;

  if v_sgst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_sgst_id, 0, v_sgst_total);
  end if;

  if v_igst_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_output_igst_id, 0, v_igst_total);
  end if;

  if v_round_off > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, 0, v_round_off);
  elsif v_round_off < 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_round_off_id, -v_round_off, 0);
  end if;

  if v_cogs_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_cogs_id, v_cogs_total, 0);

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no,
            case when v_doc.challan_id is not null then v_git_id else v_inventory_id end,
            0, v_cogs_total);
  end if;

  -- 7. Finalize document
  update sales_invoices
     set status = 'posted',
         journal_entry_id = v_entry_id,
         invoice_no = v_doc_no,
         taxable_total = v_taxable_total,
         cgst_total = v_cgst_total,
         sgst_total = v_sgst_total,
         igst_total = v_igst_total,
         round_off = v_round_off,
         grand_total = v_grand_total
   where id = p_invoice_id;

  if v_doc.challan_id is not null then
    update delivery_challans set invoice_id = p_invoice_id where id = v_doc.challan_id;
  end if;

  -- 8. Audit
  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'sales_invoices', p_invoice_id,
          jsonb_build_object('invoice_no', v_doc_no, 'entry_id', v_entry_id,
            'grand_total', v_grand_total, 'override', v_credit_overridden,
            'challan_id', v_doc.challan_id));

  return v_entry_id;
end;
$$;

-- Internal: no grant to any role, including authenticated. Only the two wrappers below reach it.
revoke all on function public._post_sales_invoice(uuid, bool, bool)
  from public, anon, authenticated, service_role;

-- ============================================================
-- 3. post_delivery_challan (carried over; + master snapshot at post time)
-- ============================================================

create or replace function public.post_delivery_challan(p_challan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_doc            record;
  v_party          record;
  v_line           record;
  v_role           app_role;
  v_entry_id       uuid;
  v_doc_no         text;
  v_item_ids       uuid[];
  v_item_id        uuid;
  v_period_locked  bool;
  v_allow_negative bool;
  v_is_transit     bool;

  v_git_id         uuid;
  v_inventory_id   uuid;

  v_onhand_qty     numeric(12,3);
  v_onhand_rate    numeric(14,4);
  v_line_cost      numeric(14,2);
  v_cost_total     numeric(14,2) := 0;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Lock order step 1: the document.
  select * into v_doc from delivery_challans where id = p_challan_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Role gate: both roles, same as the sales invoice this challan is the first half of.
  -- A challan grants strictly less authority than the invoice that follows it (it moves stock
  -- between two asset accounts, recognises no revenue and no COGS, and is fully reversible
  -- while un-invoiced), so gating it above the invoice would block counter deliveries for no
  -- gain. See implementation-notes.md (open question for the owners).
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- A missing fiscal period is blocked exactly like a locked one (change 02's rule).
  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.challan_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from delivery_challan_lines where challan_id = p_challan_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  select is_transit into v_is_transit from warehouses where id = v_doc.warehouse_id;
  if coalesce(v_is_transit, false) then
    raise exception 'DN_VALIDATION:transit_warehouse';
  end if;

  -- Lock order step 2: the party.
  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  -- Lock order step 3: every item touched, ascending id, one statement at a time.
  select array(
    select distinct item_id from delivery_challan_lines
    where challan_id = p_challan_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Snapshot the master now (hard rule 10): the challan is a GST document (Rule 55) that prints
  -- name, HSN and rate, and its lines are client-writable while it is a draft.
  update delivery_challan_lines l
     set item_name = i.name, hsn_code = i.hsn_code, uom = i.base_uom, gst_rate = i.gst_rate
    from items i
   where i.id = l.item_id and l.challan_id = p_challan_id;

  select allow_negative_stock into v_allow_negative from organization limit 1;

  select id into v_git_id       from accounts where system_key = 'goods_in_transit';
  select id into v_inventory_id from accounts where system_key = 'inventory';
  if v_git_id is null or v_inventory_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.is_stock
    from delivery_challan_lines l
    join items i on i.id = l.item_id
    where l.challan_id = p_challan_id
    order by l.line_no
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;

    -- A challan is a goods-out note. A non-stock item (freight, loading charges) has nothing
    -- to deliver and would carry no cost into Goods in Transit; it belongs on the invoice.
    if not v_line.is_stock then
      raise exception 'DN_VALIDATION:non_stock_line';
    end if;

    select qty, avg_rate into v_onhand_qty, v_onhand_rate
    from stock_on_hand(v_line.item_id, v_doc.warehouse_id);

    if v_onhand_qty - v_line.qty < 0 and not (v_allow_negative and v_role = 'admin') then
      raise exception 'DN_NEGATIVE_STOCK';
    end if;

    v_line_cost := round(v_line.qty * v_onhand_rate, 2);
    v_cost_total := v_cost_total + v_line_cost;

    -- Line value snapshot for the e-way-bill threshold: the sale value of the goods being
    -- moved, not their cost.
    update delivery_challan_lines
       set value = round(v_line.qty * v_line.rate * (1 - v_line.discount_pct / 100), 2)
     where id = v_line.id;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_doc.warehouse_id, v_doc.challan_date, -v_line.qty, v_onhand_rate,
       -v_line_cost, 'delivery_challan', p_challan_id);
  end loop;

  -- Goods with no cost basis at all would make a zero-amount journal entry (rejected by
  -- journal_lines' CHECK) and would silently park nothing in Goods in Transit for the invoice
  -- to relieve. Refusing is the conservative option; the fix is to enter the opening/purchase
  -- cost of those items first.
  if v_cost_total <= 0 then
    raise exception 'DN_VALIDATION:zero_cost';
  end if;

  -- Lock order step 4: doc_sequences, last.
  v_doc_no := next_doc_no('DC', v_doc.challan_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.challan_date, 'Delivery challan ' || v_doc_no, 'delivery_challan', p_challan_id,
          v_actor, now())
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, v_git_id, v_cost_total, 0);
  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 2, v_inventory_id, 0, v_cost_total);

  update delivery_challans
     set status = 'posted', challan_no = v_doc_no, journal_entry_id = v_entry_id
   where id = p_challan_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'delivery_challans', p_challan_id,
          jsonb_build_object('challan_no', v_doc_no, 'entry_id', v_entry_id,
            'goods_in_transit', v_cost_total));

  return v_entry_id;
end;
$$;

revoke all on function public.post_delivery_challan(uuid) from public, anon, service_role;
grant execute on function public.post_delivery_challan(uuid) to authenticated;

-- ============================================================
-- 4. post_purchase_invoice (carried over from 20260918120000; + transit guard, master snapshot)
-- ============================================================

create or replace function public.post_purchase_invoice(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_doc          record;
  v_party        record;
  v_line         record;
  v_role         app_role;
  v_org_state    char(2);
  v_intra        bool;
  v_entry_id     uuid;
  v_doc_no       text;
  v_line_no      int := 0;
  v_item_ids     uuid[];
  v_item_id      uuid;
  v_period_locked bool;

  v_ap_id         uuid;
  v_inventory_id  uuid;
  v_in_cgst_id    uuid;
  v_in_sgst_id    uuid;
  v_in_igst_id    uuid;
  v_round_off_id  uuid;

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

  v_raw_total     numeric(14,2);
  v_grand_total   numeric(14,2);
  v_round_off     numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Lock order step 1: the document.
  select * into v_doc from purchase_invoices where id = p_invoice_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Role gate: purchases are admin-only (spec: 'user' has "no purchases/expenses posting").
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- A missing fiscal period is blocked exactly like a locked one (change 02's rule).
  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.invoice_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from purchase_invoice_lines where invoice_id = p_invoice_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  -- purchase_invoices.rcm exists in the schema but this function has no reverse-charge path:
  -- it would have to credit rcm_payable and debit input tax instead of crediting AP for the
  -- tax, and the RCM clarification routes the one RCM case Phase 1 has (GTA freight) to a
  -- linked expense voucher instead. Posting the flag as if it were an ordinary bill would
  -- overstate AP and understate the RCM liability, silently. Refuse it (M8).
  if v_doc.rcm then
    raise exception 'DN_VALIDATION:rcm_purchase_unsupported';
  end if;

  -- Goods are received into a real godown, never into the hidden In Transit warehouse
  -- (same rule as the sales invoice; the header is client-writable on a draft).
  if coalesce((select is_transit from warehouses where id = v_doc.warehouse_id), true) then
    raise exception 'DN_VALIDATION:invalid_warehouse';
  end if;

  -- Lock order step 2: the party.
  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) or v_party.type not in ('supplier', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  -- Lock order step 3: every item touched, ascending id, one statement at a time (a single
  -- ORDER BY ... FOR UPDATE does not guarantee lock *acquisition* order — see change 03).
  select array(
    select distinct item_id from purchase_invoice_lines
    where invoice_id = p_invoice_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Snapshot the master now (hard rule 10). Rate and discount are the supplier's bill and stay
  -- the user's input; name, HSN, unit and GST rate are master facts and are overwritten, so a
  -- tampered gst_rate cannot inflate the input-tax credit.
  update purchase_invoice_lines l
     set item_name = i.name, hsn_code = i.hsn_code, uom = i.base_uom, gst_rate = i.gst_rate
    from items i
   where i.id = l.item_id and l.invoice_id = p_invoice_id;

  select state_code into v_org_state from organization limit 1;

  -- On a purchase the tax split follows the *supplier's* state, not the header's
  -- place_of_supply: place_of_supply on an inward bill is our own state in both the
  -- intra- and the inter-state case, so it cannot tell CGST+SGST from IGST. The spec's
  -- Tax clarification wording is "party/place-of-supply state = org state".
  v_intra := (v_party.state_code = v_org_state);

  select id into v_ap_id        from accounts where system_key = 'ap';
  select id into v_inventory_id from accounts where system_key = 'inventory';
  select id into v_in_cgst_id   from accounts where system_key = 'input_cgst';
  select id into v_in_sgst_id   from accounts where system_key = 'input_sgst';
  select id into v_in_igst_id   from accounts where system_key = 'input_igst';
  select id into v_round_off_id from accounts where system_key = 'round_off';

  if v_ap_id is null or v_inventory_id is null or v_in_cgst_id is null
     or v_in_sgst_id is null or v_in_igst_id is null or v_round_off_id is null
  then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.is_stock
    from purchase_invoice_lines l
    join items i on i.id = l.item_id
    where l.invoice_id = p_invoice_id
    order by l.line_no
  loop
    if v_line.qty is null or v_line.qty <= 0 then
      raise exception 'DN_VALIDATION:invalid_qty';
    end if;

    -- Services on an inward bill (freight, hamali) are not purchase-invoice lines: the RCM
    -- freight clarification routes them to a linked expense voucher. Capitalising a service
    -- into Inventory would silently corrupt every later weighted average.
    if not v_line.is_stock then
      raise exception 'DN_VALIDATION:non_stock_line';
    end if;

    v_taxable := round(v_line.qty * v_line.rate * (1 - v_line.discount_pct / 100), 2);

    if v_intra then
      v_cgst := round(v_taxable * v_line.gst_rate / 2 / 100, 2);
      v_sgst := v_cgst;
      v_igst := 0;
    else
      v_cgst := 0;
      v_sgst := 0;
      v_igst := round(v_taxable * v_line.gst_rate / 100, 2);
    end if;

    update purchase_invoice_lines
       set taxable_value = v_taxable, cgst_amt = v_cgst, sgst_amt = v_sgst, igst_amt = v_igst
     where id = v_line.id;

    v_taxable_total := v_taxable_total + v_taxable;
    v_cgst_total    := v_cgst_total + v_cgst;
    v_sgst_total    := v_sgst_total + v_sgst;
    v_igst_total    := v_igst_total + v_igst;

    -- Landed cost: tax is part of the stock value only when the credit cannot be claimed.
    if v_doc.itc_eligible then
      v_line_cost := v_taxable;
    else
      v_line_cost := v_taxable + v_cgst + v_sgst + v_igst;
    end if;

    v_inventory_tot := v_inventory_tot + v_line_cost;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_doc.warehouse_id, v_doc.invoice_date, v_line.qty,
       round(v_line_cost / v_line.qty, 4), v_line_cost, 'purchase_invoice', p_invoice_id);
  end loop;

  v_raw_total   := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total;
  v_grand_total := round(v_raw_total);
  v_round_off   := v_grand_total - v_raw_total;

  if abs(v_round_off) > 0.50 then
    raise exception 'DN_UNBALANCED';
  end if;

  -- Lock order step 4: doc_sequences, last, once the money is fully known.
  v_doc_no := next_doc_no('PB', v_doc.invoice_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.invoice_date, 'Purchase invoice ' || v_doc_no, 'purchase_invoice', p_invoice_id,
          v_actor, now())
  returning id into v_entry_id;

  v_line_no := v_line_no + 1;
  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, v_line_no, v_inventory_id, v_inventory_tot, 0);

  if v_doc.itc_eligible then
    if v_cgst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_cgst_id, v_cgst_total, 0);
    end if;
    if v_sgst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_sgst_id, v_sgst_total, 0);
    end if;
    if v_igst_total > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_igst_id, v_igst_total, 0);
    end if;
  end if;

  -- Mirror of the sales side: here the credit carries the rounded grand total, so a positive
  -- round-off (we pay up to the rupee) is an expense -> Dr round_off.
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
  values (v_entry_id, v_line_no, v_ap_id, v_doc.party_id, 0, v_grand_total);

  update purchase_invoices
     set status = 'posted',
         journal_entry_id = v_entry_id,
         invoice_no = v_doc_no,
         taxable_total = v_taxable_total,
         cgst_total = v_cgst_total,
         sgst_total = v_sgst_total,
         igst_total = v_igst_total,
         round_off = v_round_off,
         grand_total = v_grand_total
   where id = p_invoice_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'purchase_invoices', p_invoice_id,
          jsonb_build_object('invoice_no', v_doc_no, 'entry_id', v_entry_id,
            'grand_total', v_grand_total, 'itc_eligible', v_doc.itc_eligible));

  return v_entry_id;
end;
$$;

revoke all on function public.post_purchase_invoice(uuid) from public, anon, service_role;
grant execute on function public.post_purchase_invoice(uuid) to authenticated;

-- ============================================================
-- 5. post_stock_transfer / post_stock_adjustment (carried over; + master snapshot)
-- ============================================================

create or replace function public.post_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_doc            record;
  v_line           record;
  v_role           app_role;
  v_doc_no         text;
  v_item_ids       uuid[];
  v_item_id        uuid;
  v_period_locked  bool;
  v_allow_negative bool;
  v_transit_id     uuid;

  v_onhand_qty     numeric(12,3);
  v_onhand_rate    numeric(14,4);
  v_line_value     numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from stock_transfers where id = p_transfer_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Admin only: the role matrix enumerates what 'user' may post and inter-godown movement is
  -- not in it. Flagged as an owner question in implementation-notes.md.
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.transfer_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from stock_transfer_lines where transfer_id = p_transfer_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  select id into v_transit_id from warehouses where is_transit limit 1;
  if v_transit_id is null then
    raise exception 'DN_VALIDATION:no_transit_warehouse';
  end if;
  if v_doc.from_warehouse_id = v_transit_id or v_doc.to_warehouse_id = v_transit_id then
    raise exception 'DN_VALIDATION:transit_warehouse';
  end if;

  -- No party on a transfer; lock order goes document -> items ascending -> doc_sequences.
  select array(
    select distinct item_id from stock_transfer_lines
    where transfer_id = p_transfer_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Snapshot the master now (hard rule 10); no money depends on these, but the transfer slip does.
  update stock_transfer_lines l
     set item_name = i.name, uom = i.base_uom
    from items i
   where i.id = l.item_id and l.transfer_id = p_transfer_id;

  select allow_negative_stock into v_allow_negative from organization limit 1;

  for v_line in
    select * from stock_transfer_lines
    where transfer_id = p_transfer_id order by line_no
  loop
    select qty, avg_rate into v_onhand_qty, v_onhand_rate
    from stock_on_hand(v_line.item_id, v_doc.from_warehouse_id);

    if v_onhand_qty - v_line.qty < 0 and not v_allow_negative then
      raise exception 'DN_NEGATIVE_STOCK';
    end if;

    v_line_value := round(v_line.qty * v_onhand_rate, 2);

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_doc.from_warehouse_id, v_doc.transfer_date, -v_line.qty,
       v_onhand_rate, -v_line_value, 'stock_transfer', p_transfer_id);

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_transit_id, v_doc.transfer_date, v_line.qty,
       v_onhand_rate, v_line_value, 'stock_transfer', p_transfer_id);
  end loop;

  v_doc_no := next_doc_no('TR', v_doc.transfer_date);

  update stock_transfers
     set status = 'in_transit', transfer_no = v_doc_no
   where id = p_transfer_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'stock_transfers', p_transfer_id,
          jsonb_build_object('transfer_no', v_doc_no, 'status', 'in_transit'));
end;
$$;

revoke all on function public.post_stock_transfer(uuid) from public, anon, service_role;
grant execute on function public.post_stock_transfer(uuid) to authenticated;

create or replace function public.post_stock_adjustment(p_adjustment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor          uuid := auth.uid();
  v_doc            record;
  v_line           record;
  v_role           app_role;
  v_entry_id       uuid;
  v_doc_no         text;
  v_line_no        int := 0;
  v_item_ids       uuid[];
  v_item_id        uuid;
  v_period_locked  bool;
  v_allow_negative bool;
  v_is_transit     bool;

  v_inventory_id   uuid;
  v_stock_loss_id  uuid;

  v_onhand_qty     numeric(12,3);
  v_onhand_rate    numeric(14,4);
  v_rate           numeric(14,4);
  v_value          numeric(14,2);
  v_increase_total numeric(14,2) := 0;
  v_decrease_total numeric(14,2) := 0;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from stock_adjustments where id = p_adjustment_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Admin only, explicitly (Implementation clarifications -> Stock adjustments).
  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.adj_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from stock_adjustment_lines where adjustment_id = p_adjustment_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  select is_transit into v_is_transit from warehouses where id = v_doc.warehouse_id;
  if coalesce(v_is_transit, false) then
    raise exception 'DN_VALIDATION:transit_warehouse';
  end if;

  select array(
    select distinct item_id from stock_adjustment_lines
    where adjustment_id = p_adjustment_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Snapshot the master now (hard rule 10).
  update stock_adjustment_lines l
     set item_name = i.name
    from items i
   where i.id = l.item_id and l.adjustment_id = p_adjustment_id;

  select allow_negative_stock into v_allow_negative from organization limit 1;

  select id into v_inventory_id  from accounts where system_key = 'inventory';
  select id into v_stock_loss_id from accounts where system_key = 'stock_loss';
  if v_inventory_id is null or v_stock_loss_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  for v_line in
    select l.*, i.is_stock
    from stock_adjustment_lines l
    join items i on i.id = l.item_id
    where l.adjustment_id = p_adjustment_id
    order by l.line_no
  loop
    if not v_line.is_stock then
      raise exception 'DN_VALIDATION:non_stock_line';
    end if;

    select qty, avg_rate into v_onhand_qty, v_onhand_rate
    from stock_on_hand(v_line.item_id, v_doc.warehouse_id);

    if v_line.qty < 0 then
      -- Shrinkage is always valued at the average the stock is carried at. A supplied rate
      -- would be ambiguous input, so it is refused rather than silently ignored.
      if v_line.rate is not null then
        raise exception 'DN_VALIDATION:rate_on_decrease';
      end if;
      v_rate := v_onhand_rate;

      if v_onhand_qty + v_line.qty < 0 and not v_allow_negative then
        raise exception 'DN_NEGATIVE_STOCK';
      end if;
    else
      v_rate := coalesce(v_line.rate, v_onhand_rate);
      -- Found stock valued at nothing adds quantity to the ledger without adding value, which
      -- drags that item's weighted average down for every sale afterwards — the same silent
      -- corruption as a zero-cost sale (review finding 2). It happens whenever the line omits a
      -- rate for an item that currently has no stock, i.e. exactly the "found some old bags in
      -- the corner" case this document type exists for.
      if coalesce(v_rate, 0) <= 0 then
        raise exception 'DN_VALIDATION:zero_rate';
      end if;
    end if;

    v_value := round(abs(v_line.qty) * v_rate, 2);

    if v_line.qty < 0 then
      v_decrease_total := v_decrease_total + v_value;
    else
      v_increase_total := v_increase_total + v_value;
    end if;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_doc.warehouse_id, v_doc.adj_date, v_line.qty, v_rate,
       case when v_line.qty < 0 then -v_value else v_value end,
       'stock_adjustment', p_adjustment_id);
  end loop;

  -- Nothing to post: every line valued at zero (an item with no cost basis at all). Same
  -- reasoning as post_delivery_challan's zero_cost guard.
  if v_increase_total = 0 and v_decrease_total = 0 then
    raise exception 'DN_VALIDATION:zero_value';
  end if;

  v_doc_no := next_doc_no('ADJ', v_doc.adj_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.adj_date, 'Stock adjustment ' || v_doc_no, 'stock_adjustment', p_adjustment_id,
          v_actor, now())
  returning id into v_entry_id;

  if v_decrease_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_stock_loss_id, v_decrease_total, 0);

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_inventory_id, 0, v_decrease_total);
  end if;

  if v_increase_total > 0 then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_inventory_id, v_increase_total, 0);

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_stock_loss_id, 0, v_increase_total);
  end if;

  update stock_adjustments
     set status = 'posted', adj_no = v_doc_no, journal_entry_id = v_entry_id
   where id = p_adjustment_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'stock_adjustments', p_adjustment_id,
          jsonb_build_object('adj_no', v_doc_no, 'entry_id', v_entry_id,
            'increase', v_increase_total, 'decrease', v_decrease_total));

  return v_entry_id;
end;
$$;

revoke all on function public.post_stock_adjustment(uuid) from public, anon, service_role;
grant execute on function public.post_stock_adjustment(uuid) to authenticated;

-- ============================================================
-- 6. record_invoice_ewb (carried over from 20260920140000; + e-way bill not before the invoice)
-- ============================================================

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
  -- An e-way bill is generated for an invoice that already exists: it cannot predate it.
  if p_ewb_date is not null and p_ewb_date < v_before.invoice_date then
    raise exception 'DN_VALIDATION:ewb_before_invoice';
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
