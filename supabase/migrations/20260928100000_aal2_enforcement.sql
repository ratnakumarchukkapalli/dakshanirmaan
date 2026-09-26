-- Change 19 aal2-enforcement.
-- security-deployment spec: "Non-functional clarifications" (Sessions: admin actions require aal2);
-- change 08 implementation-notes, KNOWN GAPS 1.
--
-- An owner (role 'admin') whose session has not passed the authenticator step (JWT claim
-- aal <> 'aal2') is treated by the database as no-one: not a member, no role. The rule lives in
-- current_app_role() only; is_active_member() and every posting function go through it.
--
--   * 'user' role: unaffected (the claim is not looked at).
--   * No JWT (migrations, service_role, postgres): auth.uid() is null, so nothing matches, as before.
--   * A step-1 owner can still read their own app_users row (policy select_own_or_admin tests
--     user_id = auth.uid() directly), which the proxy and /login/mfa need.
--
-- The 15 function redefinitions below are the latest definitions, copied verbatim from the
-- database (pg_get_functiondef) with one line changed in each:
--     select role into v_role from app_users where user_id = v_actor and is_active;
--  -> v_role := current_app_role();
-- (v_actor is auth.uid() in every one of them, so the lookup is the same row.) The guard at the end
-- fails the migration if any public function still carries the direct lookup.

create or replace function public.current_app_role()
returns app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from app_users
   where user_id = auth.uid()
     and is_active
     and (role <> 'admin' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2');
$$;

create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.current_app_role() is not null;
$$;

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
$function$
;

CREATE OR REPLACE FUNCTION public.bounce_cheque(p_payment_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_doc           record;
  v_entry_id      uuid;
  v_today         date;
  v_period_locked bool;
  v_src_entries   uuid[];
  v_src_entry     uuid;
  v_line_no       int := 0;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  v_role := current_app_role();
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from payments where id = p_payment_id for update;
  if not found then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  -- Only a received cheque can bounce back to us. A cheque we issued that the bank returns is
  -- a different correction (change 20's debit-note path), not this one.
  if v_doc.status <> 'posted' or v_doc.mode <> 'cheque' or v_doc.direction <> 'receipt'
     or v_doc.cheque_status is null
     or v_doc.cheque_status not in ('in_hand', 'deposited')
  then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  perform 1 from parties where id = v_doc.party_id for update;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_today)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  -- Mirror every entry this payment still has standing — the receipt, and the deposit when the
  -- cheque had already been banked. Snapshotted into an array before the reversal entry exists,
  -- so the loop can never pick up its own lines and the reversed_by updates inside it cannot
  -- disturb the set being iterated.
  select array(
    select id from journal_entries
    where source_type = 'payment' and source_id = p_payment_id and reversed_by is null
    order by entry_no
  ) into v_src_entries;

  if array_length(v_src_entries, 1) is null then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_today, 'Cheque bounced: ' || coalesce(v_doc.voucher_no, ''), 'payment',
          p_payment_id, v_actor, now())
  returning id into v_entry_id;

  foreach v_src_entry in array v_src_entries loop
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, v_line_no + row_number() over (order by line_no),
           account_id, party_id, credit, debit
    from journal_lines where entry_id = v_src_entry;

    select coalesce(max(line_no), 0) into v_line_no
    from journal_lines where entry_id = v_entry_id;

    update journal_entries set reversed_by = v_entry_id where id = v_src_entry;
  end loop;

  -- The invoices this receipt settled are open again.
  delete from payment_allocations where payment_id = p_payment_id;

  -- status = 'cancelled' as well as cheque_status = 'bounced': the receipt has been fully
  -- reversed, so cancel_document must not be able to reverse it a second time (it raises
  -- DN_NOT_POSTED off this status). The bounce is still visible as a bounce via cheque_status.
  update payments
     set cheque_status = 'bounced',
         bounced_on = v_today,
         bounce_reversal_entry_id = v_entry_id,
         status = 'cancelled'
   where id = p_payment_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'bounce_cheque', 'payments', p_payment_id,
          jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason,
            'bounced_on', v_today));

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_document(p_source_type source_type, p_source_id uuid, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  else
    raise exception 'DN_VALIDATION:unsupported_source';
  end if;

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.day_close_preview(p_date date)
 RETURNS TABLE(close_date date, opening_cash numeric, cash_in numeric, cash_out numeric, deposited numeric, expected numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor     uuid := auth.uid();
  v_role      app_role;
  v_cash_id   uuid;
  v_bank_id   uuid;
  v_opening   numeric(14,2);
  v_cash_in   numeric(14,2);
  v_gross_out numeric(14,2);
  v_deposited numeric(14,2);
  v_cash_out  numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if p_date > (now() at time zone (select timezone from organization limit 1))::date then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  select id into v_cash_id from accounts where system_key = 'cash';
  select id into v_bank_id from accounts where system_key = 'bank';
  if v_cash_id is null or v_bank_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  select coalesce(sum(jl.debit) - sum(jl.credit), 0) into v_opening
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date < p_date;

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_cash_in, v_gross_out
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date = p_date;

  select coalesce(sum(jl.credit), 0) into v_deposited
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id
    and je.entry_date = p_date
    and jl.credit > 0
    and exists (
      select 1 from journal_lines b
      where b.entry_id = jl.entry_id and b.account_id = v_bank_id and b.debit > 0
    );

  v_cash_out := v_gross_out - v_deposited;

  return query select p_date, v_opening, v_cash_in, v_cash_out, v_deposited,
                      (v_opening + v_cash_in - v_cash_out - v_deposited)::numeric(14,2);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.deposit_cheque(p_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_doc           record;
  v_entry_id      uuid;
  v_today         date;
  v_period_locked bool;
  v_chq_id        uuid;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Both roles: "Cheque banking is counter work" (Decisions from change 04 review). Depositing
  -- moves money between two of our own accounts and creates no new obligation; the counter staff
  -- is who physically walks the cheque to the bank. Only bounce_cheque, which reverses a
  -- receipt, stays admin.
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from payments where id = p_payment_id for update;
  if not found then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  if v_doc.status <> 'posted' or v_doc.mode <> 'cheque'
     or v_doc.direction <> 'receipt' or v_doc.cheque_status is distinct from 'in_hand'
  then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  select id into v_chq_id from accounts where system_key = 'cheques_in_hand';
  if v_chq_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  -- payments.account_id names the bank the cheque is banked into; the receipt itself debited
  -- cheques_in_hand instead. It must be a real money ledger (M4) — and never Cheques in Hand
  -- itself, which is_money_account already excludes, since that would net to nothing.
  if v_doc.account_id = v_chq_id or not is_money_account(v_doc.account_id) then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_today)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_today, 'Cheque deposited: ' || coalesce(v_doc.voucher_no, ''), 'payment',
          p_payment_id, v_actor, now())
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, v_doc.account_id, v_doc.amount, 0);

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 2, v_chq_id, 0, v_doc.amount);

  update payments
     set cheque_status = 'deposited', deposited_on = v_today
   where id = p_payment_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'deposit_cheque', 'payments', p_payment_id,
          jsonb_build_object('entry_id', v_entry_id, 'deposited_on', v_today));

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.mark_cheque_cleared(p_payment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_role  app_role;
  v_doc   record;
  v_today date;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Both roles, same reasoning as deposit_cheque: this changes a status and moves nothing.
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_doc from payments where id = p_payment_id for update;
  if not found or v_doc.status <> 'posted' or v_doc.mode <> 'cheque' then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  -- A received cheque clears only after it has been deposited; our own issued cheque clears
  -- when the bank debits it ('presented' is informational and may be skipped).
  if not (
    (v_doc.direction = 'receipt' and v_doc.cheque_status = 'deposited')
    or (v_doc.direction = 'payment' and v_doc.cheque_status in ('issued', 'presented'))
  ) then
    raise exception 'DN_CHEQUE_STATE';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  update payments set cheque_status = 'cleared', cleared_on = v_today where id = p_payment_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'clear_cheque', 'payments', p_payment_id,
          jsonb_build_object('cleared_on', v_today));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_cash_sale(p_invoice_id uuid, p_account_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_role       app_role;
  v_entry_id   uuid;
  v_doc        record;
  v_account    record;
  v_payment_id uuid;
  v_mode       payment_mode;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Both roles: a cash sale is exactly the sales invoice + receipt a 'user' may already post,
  -- and this path is strictly weaker than the two calls done separately (the money is collected
  -- in full in the same transaction).
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- The money must land in a real money ledger — the same `is_money_account` helper every other
  -- money-handling function uses (review finding M4), so a second bank account is one UPDATE on
  -- accounts.is_money away rather than a code change here.
  if not is_money_account(p_account_id) then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  select * into v_account from accounts where id = p_account_id;
  v_mode := case when v_account.system_key = 'cash' then 'cash' else 'bank' end;

  -- Leg 1: the invoice, credit check skipped.
  v_entry_id := _post_sales_invoice(p_invoice_id, true, false);

  select * into v_doc from sales_invoices where id = p_invoice_id;

  -- Leg 2: a receipt for the whole invoice, allocated to it. The allocation is written before
  -- the receipt posts so change 04's cap trigger validates it against the just-posted invoice,
  -- and post_payment re-checks the total.
  insert into payments
    (direction, payment_date, party_id, mode, amount, account_id, status, created_by)
  values
    ('receipt', v_doc.invoice_date, v_doc.party_id, v_mode, v_doc.grand_total, p_account_id,
     'draft', v_actor)
  returning id into v_payment_id;

  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
  values (v_payment_id, 'sales_invoice', p_invoice_id, v_doc.grand_total);

  perform post_payment(v_payment_id);

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post_cash_sale', 'sales_invoices', p_invoice_id,
          jsonb_build_object('invoice_no', v_doc.invoice_no, 'entry_id', v_entry_id,
            'payment_id', v_payment_id, 'amount', v_doc.grand_total,
            'account_id', p_account_id));

  -- The invoice's own journal entry, matching post_sales_invoice's contract.
  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_day_close(p_date date, p_counted numeric, p_note text DEFAULT NULL::text, p_expected_seen numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_today         date;
  v_period_locked bool;
  v_close_id      uuid;
  v_entry_id      uuid;

  v_cash_id       uuid;
  v_bank_id       uuid;
  v_over_short_id uuid;

  v_counted       numeric(14,2);
  v_opening       numeric(14,2);
  v_cash_in       numeric(14,2);
  v_gross_out     numeric(14,2);
  v_deposited     numeric(14,2);
  v_cash_out      numeric(14,2);
  v_expected      numeric(14,2);
  v_difference    numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Both roles: the spec singles out *reopening* as admin-only, which reads as the close
  -- itself being part of the counter's daily work. Reopening goes through cancel_document,
  -- which is admin-only for every document type.
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  if p_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'DN_VALIDATION:invalid_counted';
  end if;
  v_counted := round(p_counted, 2);

  -- "today" in the org's timezone, never current_date (Non-functional invariants -> Time zone).
  select (now() at time zone (select timezone from organization limit 1))::date into v_today;
  if p_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', p_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  select id into v_cash_id       from accounts where system_key = 'cash';
  select id into v_bank_id       from accounts where system_key = 'bank';
  select id into v_over_short_id from accounts where system_key = 'cash_over_short';
  if v_cash_id is null or v_bank_id is null or v_over_short_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  if exists (select 1 from day_closes where close_date = p_date and status <> 'cancelled') then
    raise exception 'DN_VALIDATION:already_closed';
  end if;

  -- Counter staff close days in order. Closing an earlier day after a later one is closed would
  -- book the drawer's current cash against a past date's ledger (an owner may, and reopens first).
  if v_role = 'user' and exists (select 1 from day_closes where close_date > p_date and status <> 'cancelled') then
    raise exception 'DN_VALIDATION:later_close_exists';
  end if;

  -- Opening = the cash ledger's closing balance the day before.
  select coalesce(sum(jl.debit) - sum(jl.credit), 0) into v_opening
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date < p_date;

  select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
    into v_cash_in, v_gross_out
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id and je.entry_date = p_date;

  -- Deposits are cash credits whose contra is the bank ledger. They are reported separately
  -- from cash_out so the close reads as "took in X, paid out Y, banked Z" — and so they are
  -- subtracted exactly once: cash_out below excludes them.
  select coalesce(sum(jl.credit), 0) into v_deposited
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id
  where jl.account_id = v_cash_id
    and je.entry_date = p_date
    and jl.credit > 0
    and exists (
      select 1 from journal_lines b
      where b.entry_id = jl.entry_id and b.account_id = v_bank_id and b.debit > 0
    );

  v_cash_out   := v_gross_out - v_deposited;
  v_expected   := v_opening + v_cash_in - v_cash_out - v_deposited;
  v_difference := v_counted - v_expected;

  -- The counter compared their count with the expected figure the screen showed. If the ledger
  -- moved since (another sale, a receipt), that comparison is stale: refuse and let them recount.
  if p_expected_seen is not null and round(p_expected_seen, 2) <> v_expected then
    raise exception 'DN_VALIDATION:expected_changed';
  end if;

  begin
    insert into day_closes
      (close_date, opening_cash, cash_in, cash_out, deposited, expected, counted, difference,
       note, closed_by, closed_at)
    values
      (p_date, v_opening, v_cash_in, v_cash_out, v_deposited, v_expected, v_counted,
       v_difference, p_note, v_actor, now())
    returning id into v_close_id;
  exception when unique_violation then
    -- Two counters closing the same date at the same moment: the partial unique index is the
    -- serialization point, and the loser gets the mapped code rather than a raw constraint.
    raise exception 'DN_VALIDATION:already_closed';
  end;

  -- A difference of exactly zero has nothing to post; the close still exists as the record
  -- that the count was done (journal_entry_id stays NULL).
  if v_difference <> 0 then
    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (p_date, 'Day close ' || to_char(p_date, 'DD-MM-YYYY'), 'day_close', v_close_id,
            v_actor, now())
    returning id into v_entry_id;

    if v_difference < 0 then
      -- Short: the drawer holds less than the books say.
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 1, v_over_short_id, -v_difference, 0);
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 2, v_cash_id, 0, -v_difference);
    else
      -- Over: more cash than the books say.
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 1, v_cash_id, v_difference, 0);
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, 2, v_over_short_id, 0, v_difference);
    end if;

    update day_closes set journal_entry_id = v_entry_id where id = v_close_id;
  end if;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'day_closes', v_close_id,
          jsonb_build_object('close_date', p_date, 'expected', v_expected,
            'counted', v_counted, 'difference', v_difference, 'entry_id', v_entry_id));

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_delivery_challan(p_challan_id uuid)
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
  v_role := current_app_role();
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
$function$
;

CREATE OR REPLACE FUNCTION public.post_expense_voucher(p_voucher_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_doc           record;
  v_line          record;
  v_role          app_role;
  v_entry_id      uuid;
  v_doc_no        text;
  v_line_no       int := 0;
  v_period_locked bool;

  v_party         record;
  v_pay_account   uuid;
  v_cash_id       uuid;
  v_advance_id    uuid;
  v_payable_id    uuid;
  v_rcm_id        uuid;
  v_in_cgst_id    uuid;
  v_in_sgst_id    uuid;

  v_gross         numeric(14,2) := 0;
  v_rcm_cgst      numeric(14,2);
  v_rcm_sgst      numeric(14,2);
  v_line_party    uuid;
  v_is_control    bool;
  v_is_group      bool;
  v_through_payable bool;
  v_adv_balance   numeric(14,2);
  v_recovered     numeric(14,2);
  v_net           numeric(14,2);
  v_period_month  date;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Lock order step 1: the document.
  select * into v_doc from expense_vouchers where id = p_voucher_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.voucher_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if not exists (select 1 from expense_voucher_lines where voucher_id = p_voucher_id) then
    raise exception 'DN_VALIDATION:no_lines';
  end if;

  select coalesce(sum(amount), 0) into v_gross
  from expense_voucher_lines where voucher_id = p_voucher_id;

  if v_gross <= 0 then
    raise exception 'DN_VALIDATION:invalid_amount';
  end if;

  -- Role gate: 'user' may record employee advances only, capped at Rs 5,000 per voucher.
  -- Everything else (expenses, salaries, wages) is admin.
  if v_role <> 'admin' then
    if v_doc.voucher_type <> 'advance' or v_gross > 5000 then
      raise exception 'DN_FORBIDDEN';
    end if;
  end if;

  -- Lock order step 2: the party (an expense voucher has no items).
  if v_doc.party_id is not null then
    select * into v_party from parties where id = v_doc.party_id for update;
    -- A voucher against a deactivated party is almost always a stale draft picked up weeks
    -- later; posting it would write a ledger nobody is watching any more (m11).
    if not coalesce(v_party.is_active, false) then
      raise exception 'DN_VALIDATION:invalid_party';
    end if;
    -- An advance, a salary and a wage are all employee ledgers; a supplier or customer on one
    -- would land on the employee_advance / salary_payable control accounts under a party that
    -- has no business being there (m10).
    if v_doc.voucher_type in ('advance', 'salary', 'wages') and v_party.type <> 'employee' then
      raise exception 'DN_VALIDATION:invalid_party';
    end if;
  end if;

  -- A salary is always somebody's salary: without a party it silently skips salary_payable and
  -- the employee ledger, leaving a bare Dr Salaries / Cr cash that no payslip can ever explain
  -- (m12). Wages are different — the spec models unnamed casual hamali as exactly that, a wage
  -- voucher with no party — so only 'salary' is refused here.
  if v_doc.voucher_type = 'salary' and v_doc.party_id is null then
    raise exception 'DN_VALIDATION:missing_party';
  end if;

  select id into v_cash_id    from accounts where system_key = 'cash';
  select id into v_advance_id from accounts where system_key = 'employee_advance';
  select id into v_payable_id from accounts where system_key = 'salary_payable';
  select id into v_rcm_id     from accounts where system_key = 'rcm_payable';
  select id into v_in_cgst_id from accounts where system_key = 'input_cgst';
  select id into v_in_sgst_id from accounts where system_key = 'input_sgst';

  if v_cash_id is null or v_advance_id is null or v_payable_id is null
     or v_rcm_id is null or v_in_cgst_id is null or v_in_sgst_id is null
  then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  -- The paying leg must be a real cash or bank ledger (M4), same rule as post_payment.
  v_pay_account := coalesce(v_doc.pay_account_id, v_cash_id);
  if not is_money_account(v_pay_account) then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  -- Salary and named-worker wages settle through salary_payable so the employee ledger is
  -- readable from control-account lines. An unnamed casual hamali has no party at all and is
  -- therefore a plain expense voucher.
  v_through_payable := (v_doc.voucher_type in ('salary', 'wages') and v_doc.party_id is not null);

  -- Salary period: a salary or wage voucher always ends up with a period_month. The app sets it
  -- on the draft; when it did not, the voucher's own month is the only defensible reading, and
  -- leaving it NULL would silently drop the row out of v_employee_ledger's grouping. Any other
  -- voucher type carrying one is a UI bug, not a fact to store.
  if v_doc.voucher_type in ('salary', 'wages') then
    v_period_month := coalesce(v_doc.period_month, date_trunc('month', v_doc.voucher_date)::date);
  elsif v_doc.period_month is not null then
    raise exception 'DN_VALIDATION:period_month_not_allowed';
  end if;

  v_doc_no := next_doc_no('EXP', v_doc.voucher_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.voucher_date, 'Expense voucher ' || v_doc_no, 'expense_voucher', p_voucher_id,
          v_actor, now())
  returning id into v_entry_id;

  for v_line in
    select * from expense_voucher_lines where voucher_id = p_voucher_id order by line_no
  loop
    if v_line.amount is null or v_line.amount <= 0 then
      raise exception 'DN_VALIDATION:invalid_amount';
    end if;

    select is_control, is_group into v_is_control, v_is_group
    from accounts where id = v_line.account_id;
    if v_is_control is null or v_is_group then
      raise exception 'DN_VALIDATION:invalid_account';
    end if;

    if v_doc.voucher_type = 'advance' and v_line.account_id <> v_advance_id then
      raise exception 'DN_VALIDATION:advance_account';
    end if;

    if v_line.rcm and v_through_payable then
      raise exception 'DN_VALIDATION:rcm_not_allowed';
    end if;

    -- The RCM rates below are the intra-state GTA split (CGST 2.5 + SGST 2.5). An inter-state
    -- GTA service is IGST 5% against input_igst, which this function does not post, and a
    -- transporter with no party on the voucher cannot be proven intra-state at all. Both would
    -- produce a wrong GSTR-3B, so both are refused (M9).
    if v_line.rcm then
      if v_party.state_code is null
         or v_party.state_code is distinct from (select state_code from organization limit 1)
      then
        raise exception 'DN_VALIDATION:rcm_interstate';
      end if;
    end if;

    -- Party rule (change 02): required on a control account, forbidden elsewhere. The line may
    -- name its own party; otherwise the header's party is used.
    if v_is_control then
      v_line_party := coalesce(v_line.party_id, v_doc.party_id);
      if v_line_party is null then
        raise exception 'DN_VALIDATION:missing_party';
      end if;
    else
      v_line_party := null;
    end if;

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_line.account_id, v_line_party, v_line.amount, 0);

    -- RCM freight (GTA 5%, intra-state): the tax is ours to pay and ours to claim.
    -- rcm_payable is credited with exactly cgst + sgst rather than a separately rounded 5%,
    -- so a paisa of rounding can never unbalance the entry.
    if v_line.rcm then
      v_rcm_cgst := round(v_line.amount * 2.5 / 100, 2);
      v_rcm_sgst := v_rcm_cgst;

      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_cgst_id, v_rcm_cgst, 0);

      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_in_sgst_id, v_rcm_sgst, 0);

      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_rcm_id, 0, v_rcm_cgst + v_rcm_sgst);
    end if;
  end loop;

  if v_through_payable then
    -- Cr salary_payable gross / Dr salary_payable gross: the payable is raised and settled in
    -- the same entry, which is what makes v_employee_ledger readable per month.
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_payable_id, v_doc.party_id, 0, v_gross);

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_payable_id, v_doc.party_id, v_gross, 0);

    select coalesce(sum(debit) - sum(credit), 0) into v_adv_balance
    from journal_lines
    where account_id = v_advance_id and party_id = v_doc.party_id;

    v_adv_balance := greatest(coalesce(v_adv_balance, 0), 0);
    v_recovered := least(v_adv_balance, v_gross);

    if v_doc.advance_recovered is not null then
      if v_doc.advance_recovered < 0 or v_doc.advance_recovered > v_recovered then
        raise exception 'DN_VALIDATION:recovery_exceeds_advance';
      end if;
      v_recovered := v_doc.advance_recovered;
    end if;

    v_net := v_gross - v_recovered;

    if v_recovered > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
      values (v_entry_id, v_line_no, v_advance_id, v_doc.party_id, 0, v_recovered);
    end if;

    if v_net > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_pay_account, 0, v_net);
    end if;
  else
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_pay_account, 0, v_gross);
  end if;

  update expense_vouchers
     set status = 'posted',
         journal_entry_id = v_entry_id,
         voucher_no = v_doc_no,
         period_month = v_period_month
   where id = p_voucher_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'expense_vouchers', p_voucher_id,
          jsonb_build_object('voucher_no', v_doc_no, 'entry_id', v_entry_id,
            'voucher_type', v_doc.voucher_type, 'gross', v_gross,
            'recovered', coalesce(v_recovered, 0), 'period_month', v_period_month));

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_payment(p_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_doc           record;
  v_party         record;
  v_role          app_role;
  v_entry_id      uuid;
  v_doc_no        text;
  v_series        text;
  v_line_no       int := 0;
  v_period_locked bool;
  v_money_account uuid;
  v_cash_id       uuid;
  v_control_id    uuid;
  v_discount_id   uuid;
  v_cheque_state  cheque_status;
  v_alloc_total   numeric(14,2);
  v_settled       numeric(14,2);

  v_alloc           record;
  v_alloc_status    doc_status;
  v_alloc_total_inv numeric(14,2);
  v_alloc_party     uuid;
  v_alloc_notes     numeric(14,2);
  v_alloc_prior     numeric(14,2);
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Lock order step 1: the document.
  select * into v_doc from payments where id = p_payment_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Role gate: 'user' may post receipts (daily counter collections) but not outgoing payments.
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;
  if v_doc.direction <> 'receipt' and v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  -- A discount is admin-only (owner decision 2026-09-19): with allocations now allowed up to
  -- amount + discount, a discount can close an invoice, so counter staff may save a draft that
  -- carries one but only an admin may post it. Both directions (receipt discount allowed,
  -- payment discount received). Zero/NULL discount is unaffected for every role. Checked before
  -- anything is locked or written.
  if coalesce(v_doc.discount, 0) > 0 and v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_doc.payment_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  if v_doc.amount is null or v_doc.amount <= 0 then
    raise exception 'DN_VALIDATION:invalid_amount';
  end if;
  if coalesce(v_doc.discount, 0) < 0 then
    raise exception 'DN_VALIDATION:invalid_discount';
  end if;

  -- Lock order step 2: the party. (No items on a payment, so doc_sequences is next.)
  select * into v_party from parties where id = v_doc.party_id for update;
  if not coalesce(v_party.is_active, false) then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;
  if v_doc.direction = 'receipt' and v_party.type not in ('customer', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;
  if v_doc.direction = 'payment' and v_party.type not in ('supplier', 'both') then
    raise exception 'DN_VALIDATION:invalid_party';
  end if;

  -- The money leg must be a real cash or bank ledger (M4). The old check only excluded group
  -- and control accounts, which let a receipt "into" Sales or Round Off post a balanced but
  -- meaningless entry.
  if not is_money_account(v_doc.account_id) then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  select id into v_cash_id from accounts where system_key = 'cash';
  select id into v_discount_id from accounts
  where system_key = case when v_doc.direction = 'receipt'
                          then 'discount_allowed' else 'discount_received' end;
  select id into v_control_id from accounts
  where system_key = case when v_doc.direction = 'receipt' then 'ar' else 'ap' end;

  if v_cash_id is null or v_discount_id is null or v_control_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  v_money_account := v_doc.account_id;

  if v_doc.mode = 'cheque' then
    if v_doc.instrument_no is null or btrim(v_doc.instrument_no) = '' then
      raise exception 'DN_VALIDATION:cheque_details';
    end if;

    if v_doc.direction = 'receipt' then
      -- account_id on a cheque receipt names the bank the cheque will eventually be deposited
      -- into, so it can never be the cash box (M4) — deposit_cheque would then move money from
      -- Cheques in Hand into cash that nobody ever counted.
      if v_doc.account_id = v_cash_id then
        raise exception 'DN_VALIDATION:invalid_account';
      end if;

      -- A cheque in the drawer is not bank money until the bank clears it.
      select id into v_money_account from accounts where system_key = 'cheques_in_hand';
      if v_money_account is null then
        raise exception 'DN_VALIDATION:missing_account';
      end if;
      v_cheque_state := 'in_hand';
    else
      -- Our own cheque: Cr bank at issue. A cheque can never move the cash box.
      if v_doc.account_id = v_cash_id then
        raise exception 'DN_VALIDATION:invalid_account';
      end if;
      v_cheque_state := 'issued';
    end if;
  end if;

  -- Re-validate every allocation under the payment's lock (M7). The trigger checked each row
  -- when it was written, but between then and now the invoice may have been cancelled, a credit
  -- note may have eaten the open amount, the payment's own amount may have been edited on the
  -- draft, or a *different* draft receipt may have posted first and consumed what this one
  -- planned to settle. Draft allocations deliberately do not reserve open amount, so this is
  -- the point where two drafts racing for one invoice are resolved — the loser fails here
  -- rather than over-settling the invoice.
  select coalesce(sum(amount), 0) into v_alloc_total
  from payment_allocations where payment_id = p_payment_id;
  -- Allocations may total amount + discount: the journal settles amount + discount of the
  -- party's ledger, so the discount is allocatable value too (see check_payment_allocation).
  if v_alloc_total > v_doc.amount + coalesce(v_doc.discount, 0) then
    raise exception 'DN_VALIDATION:allocation_exceeds_payment';
  end if;

  -- Grouped by invoice, not row by row (N1): what an invoice can absorb is a property of the
  -- invoice, so the thing to compare against its open amount is the SUM of this payment's
  -- allocations to it, never each row on its own. The unique constraint on
  -- (payment_id, invoice_type, invoice_id) means this is one row per group today; grouping keeps
  -- the check correct if that ever relaxes. Ordering by (invoice_type, invoice_id) also makes the
  -- invoice locks below deterministic across concurrent payments, which ordering by allocation id
  -- (a random uuid) was not.
  for v_alloc in
    select invoice_type, invoice_id, sum(amount) as amount
    from payment_allocations where payment_id = p_payment_id
    group by invoice_type, invoice_id
    order by invoice_type, invoice_id
  loop
    if v_alloc.invoice_type = 'sales_invoice' then
      select status, grand_total, party_id
        into v_alloc_status, v_alloc_total_inv, v_alloc_party
      from sales_invoices where id = v_alloc.invoice_id for update;

      select coalesce(sum(grand_total), 0) into v_alloc_notes
      from credit_notes where against_invoice_id = v_alloc.invoice_id and status = 'posted';
    else
      select status, grand_total, party_id
        into v_alloc_status, v_alloc_total_inv, v_alloc_party
      from purchase_invoices where id = v_alloc.invoice_id for update;

      select coalesce(sum(grand_total), 0) into v_alloc_notes
      from debit_notes where against_invoice_id = v_alloc.invoice_id and status = 'posted';
    end if;

    if v_alloc_status is null or v_alloc_status <> 'posted' then
      raise exception 'DN_VALIDATION:allocation_invoice_not_posted';
    end if;

    if v_alloc_party is distinct from v_doc.party_id then
      raise exception 'DN_VALIDATION:allocation_party_mismatch';
    end if;

    select coalesce(sum(pa.amount), 0) into v_alloc_prior
    from payment_allocations pa
    join payments p on p.id = pa.payment_id
    where pa.invoice_type = v_alloc.invoice_type and pa.invoice_id = v_alloc.invoice_id
      and pa.payment_id <> p_payment_id and p.status = 'posted';

    -- v_alloc.amount is this payment's whole claim on the invoice; v_alloc_prior is every other
    -- posted payment's. Their sum may not exceed the open amount.
    if v_alloc.amount > v_alloc_total_inv - v_alloc_prior - v_alloc_notes then
      raise exception 'DN_VALIDATION:allocation_exceeds_invoice';
    end if;
  end loop;

  v_settled := v_doc.amount + coalesce(v_doc.discount, 0);

  -- Lock order step 4: doc_sequences. Receipts and outgoing payments are separate series.
  v_series := case when v_doc.direction = 'receipt' then 'RCPT' else 'PAY' end;
  v_doc_no := next_doc_no(v_series, v_doc.payment_date);

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (v_doc.payment_date,
          case when v_doc.direction = 'receipt' then 'Receipt ' else 'Payment ' end || v_doc_no,
          'payment', p_payment_id, v_actor, now())
  returning id into v_entry_id;

  if v_doc.direction = 'receipt' then
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_money_account, v_doc.amount, 0);

    if coalesce(v_doc.discount, 0) > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_discount_id, v_doc.discount, 0);
    end if;

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_control_id, v_doc.party_id, 0, v_settled);
  else
    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    values (v_entry_id, v_line_no, v_control_id, v_doc.party_id, v_settled, 0);

    if coalesce(v_doc.discount, 0) > 0 then
      v_line_no := v_line_no + 1;
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (v_entry_id, v_line_no, v_discount_id, 0, v_doc.discount);
    end if;

    v_line_no := v_line_no + 1;
    insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    values (v_entry_id, v_line_no, v_money_account, 0, v_doc.amount);
  end if;

  update payments
     set status = 'posted',
         journal_entry_id = v_entry_id,
         voucher_no = v_doc_no,
         cheque_status = v_cheque_state
   where id = p_payment_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'payments', p_payment_id,
          jsonb_build_object('voucher_no', v_doc_no, 'entry_id', v_entry_id,
            'direction', v_doc.direction, 'amount', v_doc.amount,
            'discount', coalesce(v_doc.discount, 0), 'cheque_status', v_cheque_state));

  return v_entry_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.post_purchase_invoice(p_invoice_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_role := current_app_role();
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
$function$
;

CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_adjustment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_role := current_app_role();
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
$function$
;

CREATE OR REPLACE FUNCTION public.post_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_role := current_app_role();
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
$function$
;

CREATE OR REPLACE FUNCTION public.receive_stock_transfer(p_transfer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_doc           record;
  v_mv            record;
  v_role          app_role;
  v_item_ids      uuid[];
  v_item_id       uuid;
  v_period_locked bool;
  v_today         date;
  v_transit_id    uuid;
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- The FOR UPDATE + state check is what makes a concurrent double-receive safe: the second
  -- session blocks here, then sees 'received' and raises (Non-functional invariants ->
  -- Idempotency: "an invalid transition raises DN_TRANSFER_STATE").
  select * into v_doc from stock_transfers where id = p_transfer_id for update;
  if not found or v_doc.status <> 'in_transit' then
    raise exception 'DN_TRANSFER_STATE';
  end if;

  v_role := current_app_role();
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Receipt happens now, not on the transfer date: the goods arrive when the destination
  -- godown says so. Date in the org's timezone, never current_date.
  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', v_today)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  select id into v_transit_id from warehouses where is_transit limit 1;
  if v_transit_id is null then
    raise exception 'DN_VALIDATION:no_transit_warehouse';
  end if;

  select array(
    select distinct item_id from stock_transfer_lines
    where transfer_id = p_transfer_id order by item_id
  ) into v_item_ids;

  foreach v_item_id in array v_item_ids loop
    perform 1 from items where id = v_item_id for update;
  end loop;

  -- Same rate the transfer carried into transit: a transfer never revalues stock, so the
  -- destination godown receives the source's weighted average, not its own.
  for v_mv in
    select item_id, qty, rate, value
    from stock_movements
    where source_type = 'stock_transfer' and source_id = p_transfer_id
      and warehouse_id = v_transit_id and qty > 0 and reversal_of is null
    order by item_id
  loop
    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_mv.item_id, v_transit_id, v_today, -v_mv.qty, v_mv.rate, -v_mv.value,
       'stock_transfer', p_transfer_id);

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_mv.item_id, v_doc.to_warehouse_id, v_today, v_mv.qty, v_mv.rate, v_mv.value,
       'stock_transfer', p_transfer_id);
  end loop;

  update stock_transfers
     set status = 'received', received_at = now(), received_by = v_actor
   where id = p_transfer_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'receive', 'stock_transfers', p_transfer_id,
          jsonb_build_object('status', 'received', 'received_on', v_today));
end;
$function$
;


-- Guard: no public function may keep the direct role lookup.
do $$
declare
  v_left text;
begin
  select string_agg(p.proname, ', ') into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc ~ 'from\s+app_users\s+where\s+user_id\s*=\s*v_actor';
  if v_left is not null then
    raise exception 'aal2_enforcement: direct app_users role lookup left in: %', v_left;
  end if;
end;
$$;
