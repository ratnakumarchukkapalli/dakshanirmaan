-- Fixes for the 2026-09 adversarial permission test (docs/reviews/2026-09-attack-test.md):
--   F2  place_of_supply is derived at post time, not trusted from the draft column
--   F1  allocations of a posted receipt are immutable through the API
--   F4  gstin_checksum_ok() is no longer executable by signed-out callers
--   F3  created_by is stamped from auth.uid() and cannot be changed by a session
--   F5  the payroll-id helpers and set_my_locale answer a member only
-- The catalog guard for L1 lives in supabase/tests/database/00026_attack_test_fixes.test.sql.

-- ============================================================
-- 1. F2 — place of supply
-- ============================================================
-- The tax head (CGST+SGST vs IGST) follows the place of supply, and the draft column was
-- client-writable: a counter user could PATCH it and post. The column stays a display value on
-- a draft; post_sales_invoice now derives the real one from what the database can vouch for:
-- the delivery state on the invoice's shipping snapshot when it is one of THIS party's own
-- addresses, else the party's state. A shipping state that is neither is a forgery (or an
-- address edited since the draft was saved) and is refused, so the operator re-saves the draft.
-- The derived value is written back, so the posted document, the PDF and GSTR-1 all show it.
--
-- Debit/credit notes have no posting function yet (Phase 2); whoever adds them must derive it
-- the same way. The CHECKs below already stop a non-existent code on every document.
CREATE OR REPLACE FUNCTION public._post_sales_invoice(p_invoice_id uuid, p_skip_credit boolean, p_override_credit boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor          uuid := auth.uid();
  v_doc            record;
  v_party          record;
  v_line           record;
  v_role           app_role;
  v_org_state      char(2);
  v_intra          bool;
  v_pos            text;
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
  v_role := current_app_role();
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
  v_pos := coalesce(nullif(v_doc.shipping_address ->> 'state_code', ''), v_party.state_code);
  if v_pos <> v_party.state_code and not exists (
    select 1 from party_addresses pa where pa.party_id = v_doc.party_id and pa.state_code = v_pos
  ) then
    raise exception 'DN_VALIDATION:place_of_supply';
  end if;
  v_intra := (v_pos = v_org_state);
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
         place_of_supply = v_pos,
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
$function$;

-- A code that is not a GST state / UT is never a fact (same pattern as parties and addresses).
alter table sales_invoices    add constraint sales_invoices_place_of_supply_check
  check (place_of_supply ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');
alter table purchase_invoices add constraint purchase_invoices_place_of_supply_check
  check (place_of_supply ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');
alter table credit_notes      add constraint credit_notes_place_of_supply_check
  check (place_of_supply ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');
alter table debit_notes       add constraint debit_notes_place_of_supply_check
  check (place_of_supply ~ '^(0[1-9]|[12][0-9]|3[0-8]|97|99)$');

-- ============================================================
-- 2. F1 — allocations of a posted receipt are immutable
-- ============================================================
-- Re-pointing a posted receipt at another invoice changes what ageing, statements and interest
-- say is owed, so it needs the paper trail and the caps of a posting, not a bare PATCH. The app
-- only writes allocations while saving a DRAFT payment (savePayment is gated on status = 'draft');
-- post_payment, cash sales and cancel_document write them as the function owner and bypass RLS.
-- Re-allocating a posted receipt, if it is wanted, is a later change: a function that reverses
-- and re-applies with its own audit row.
drop policy write_allocation on payment_allocations;
drop policy update_allocation on payment_allocations;
drop policy delete_allocation on payment_allocations;

create policy write_allocation on payment_allocations for insert
  with check (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status = 'draft'
  ));
create policy update_allocation on payment_allocations for update
  using (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status = 'draft'
  ));
create policy delete_allocation on payment_allocations for delete
  using (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status = 'draft'
  ));

-- ============================================================
-- 3. F4 — gstin_checksum_ok is not for signed-out callers
-- ============================================================
-- Created without a revoke, so it kept PUBLIC's default EXECUTE plus the explicit anon grant.
-- authenticated (CHECK constraints run as the writer) and service_role keep theirs.
revoke all on function public.gstin_checksum_ok(text) from public, anon;

-- L1 (default ACL): NOT changed here. New functions are open to anon through PUBLIC's implicit
-- default EXECUTE, which only a database-wide `alter default privileges for role postgres revoke
-- execute on functions from public` removes (the schema-scoped form cannot). That also strips
-- authenticated from every pg_temp helper the pgTAP files call as `authenticated`, so instead a
-- catalog test (00026) fails the build when any public function is executable by anon.

-- ============================================================
-- 4. F3 — created_by is the session's own id
-- ============================================================
-- A session (auth.uid() not null) cannot name someone else as the creator of a document, nor
-- rewrite it later. Migrations, the service key and tests running as the owner have no session
-- and are left alone.
create or replace function public.set_created_by()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.set_created_by() from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'created_by'
       and tb.table_type = 'BASE TABLE'
  loop
    execute format(
      'create trigger set_created_by before insert or update on public.%I
         for each row execute function public.set_created_by()', t);
  end loop;
end;
$$;

-- ============================================================
-- 5. F5 — helpers answer members only
-- ============================================================
-- Both returned every hidden id to anyone whose role was not 'admin' — including an admin who
-- has not passed the authenticator step and a deactivated user, who are meant to be no-one.
-- Only a counter user (role 'user') is ever shown the ids; an admin sees nothing hidden, a
-- non-member sees nothing at all.
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
    and current_app_role() = 'user';
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
    and current_app_role() = 'user';
$$;

-- Own row only, and only for a member: a deactivated user, or an admin still at aal1, matches
-- nothing (still a no-op rather than an error: 00010 asserts a disabled member's call does not raise).
create or replace function public.set_my_locale(p_locale text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_locale is null or p_locale not in ('en', 'te') then
    raise exception 'DN_VALIDATION:locale';
  end if;
  update app_users set locale = p_locale where user_id = auth.uid() and is_active_member();
end;
$$;
