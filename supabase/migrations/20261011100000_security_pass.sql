-- Security pass before go-live (2026-10-02): the database-layer findings of
-- docs/reviews/2026-10-final-security-pass.md (D1, T1, S1, A1, A2, D2, D3).
--
-- Functions that change are replaced with their CURRENT definition (as built by the earlier
-- migrations) plus only the lines this pass adds; every changed line is marked "Security pass".
-- Notes and the two-session race proof: openspec/changes/security-pass/implementation-notes.md.

-- ============================================================
-- D1. Document lines are writable only while their header is a draft — for EVERY writer
-- ============================================================
-- Until now the child line tables had only the RLS policy "header is draft". A policy is evaluated
-- against the snapshot the statement started with, so a line saved by a counter at the instant the
-- invoice posts could land on the now-posted invoice: a line in no journal entry, on the PDF and in
-- GSTR-1. Same approach as note_lines_guard (change 20): the trigger locks the HEADER row FOR SHARE.
-- A posting function holds that row FOR UPDATE from its first statement, so a racing line write
-- waits for the post to commit and is then refused; a post that starts after the line write waits
-- for the line's transaction instead and then reads the committed line. Deadlock-free: both sides
-- take the header first, and the line writer takes nothing else before it.
--
-- The posting functions write lines of their own document (post-time snapshot refresh and computed
-- tax columns) while it is still a draft, inside their own FOR UPDATE lock, and convert_quotation /
-- post_bank_expense insert lines into a draft they have just created, so all of them pass. A
-- header that no longer exists (the cascade from deleting a draft) lets its lines go.
-- SECURITY DEFINER so RLS on the header cannot hide a posted row from the check. Trigger arguments:
-- the line's header-id column, the header table (fixed by this migration, never user input).
create or replace function public.document_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_header uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_header := (to_jsonb(old) ->> tg_argv[0])::uuid;
    execute format('select status::text from public.%I where id = $1 for share', tg_argv[1])
      into v_status using v_header;
    if v_status is not null and v_status <> 'draft' then
      raise exception 'DN_NOT_DRAFT';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_header := (to_jsonb(new) ->> tg_argv[0])::uuid;
    v_status := null;
    execute format('select status::text from public.%I where id = $1 for share', tg_argv[1])
      into v_status using v_header;
    if v_status is distinct from 'draft' then
      raise exception 'DN_NOT_DRAFT';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.document_lines_guard() from public, anon, authenticated, service_role;

create trigger document_lines_guard before insert or update or delete on public.sales_invoice_lines
  for each row execute function public.document_lines_guard('invoice_id', 'sales_invoices');
create trigger document_lines_guard before insert or update or delete on public.purchase_invoice_lines
  for each row execute function public.document_lines_guard('invoice_id', 'purchase_invoices');
create trigger document_lines_guard before insert or update or delete on public.delivery_challan_lines
  for each row execute function public.document_lines_guard('challan_id', 'delivery_challans');
create trigger document_lines_guard before insert or update or delete on public.expense_voucher_lines
  for each row execute function public.document_lines_guard('voucher_id', 'expense_vouchers');
create trigger document_lines_guard before insert or update or delete on public.stock_adjustment_lines
  for each row execute function public.document_lines_guard('adjustment_id', 'stock_adjustments');
create trigger document_lines_guard before insert or update or delete on public.stock_transfer_lines
  for each row execute function public.document_lines_guard('transfer_id', 'stock_transfers');
-- credit_note_lines / debit_note_lines already have note_lines_guard (change 20). quotation_lines
-- are written only by save_quotation (definer; the table has no client DML) under quotations_guard.
-- opening_lines keep their own guard and error code; it now takes the same FOR SHARE header lock
-- (and runs as definer, because FOR SHARE needs a privilege the client does not hold on the batch).
CREATE OR REPLACE FUNCTION public.opening_lines_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_status doc_status;
begin
  select status into v_status from opening_batches
  where id = case when tg_op = 'DELETE' then old.batch_id else new.batch_id end
  for share;
  if v_status is distinct from 'draft' then
    raise exception 'DN_VALIDATION:opening_batch_not_draft';
  end if;
  if tg_op = 'UPDATE' and new.batch_id is distinct from old.batch_id then
    raise exception 'DN_VALIDATION:opening_batch_not_draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

-- ------------------------------------------------------------
-- D1. Payment allocations belong to the draft payment
-- ------------------------------------------------------------
-- INSERT/UPDATE: check_payment_allocation (which already locks the payment FOR UPDATE first) now
-- also refuses any payment that is not a draft. post_cash_sale writes its allocation while its
-- receipt is still a draft, so it passes.
CREATE OR REPLACE FUNCTION public.check_payment_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_payment        record;
  v_invoice_status doc_status;
  v_invoice_total  numeric(14,2);
  v_invoice_party  uuid;
  v_notes_total    numeric(14,2);
  v_prior_payment  numeric(14,2);
  v_prior_invoice  numeric(14,2);
  v_open           numeric(14,2);
begin
  if new.amount is null or new.amount <= 0 then
    raise exception 'DN_VALIDATION:allocation_amount';
  end if;

  if new.invoice_type not in ('sales_invoice', 'purchase_invoice') then
    raise exception 'DN_VALIDATION:allocation_invoice_type';
  end if;

  -- Lock order inside this trigger: payment, then the invoice. Nothing else in the codebase
  -- locks an invoice before a payment (cancel_document reads payment_allocations without
  -- locking payments), so there is no cycle to deadlock on.
  select * into v_payment from payments where id = new.payment_id for update;
  if not found then
    raise exception 'DN_VALIDATION:allocation_payment_missing';
  end if;

  -- A cancelled payment has been reversed; pointing it at an invoice would re-open nothing and
  -- would make the invoice look settled by money that came back. The RLS write policy says the
  -- same thing, but a policy only guards client writes — this guards every writer (M6).
  if v_payment.status = 'cancelled' then
    raise exception 'DN_VALIDATION:allocation_payment_cancelled';
  end if;

  -- Security pass D1: allocations are part of the draft. Once the payment is posted (or in any
  -- other non-draft state) its allocations are frozen for every writer; the payment row is
  -- locked FOR UPDATE above, so a write racing post_payment waits and is then refused here.
  if v_payment.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  -- Direction match: a receipt settles sales invoices, a payment settles purchase invoices.
  if (v_payment.direction = 'receipt' and new.invoice_type <> 'sales_invoice')
     or (v_payment.direction = 'payment' and new.invoice_type <> 'purchase_invoice')
  then
    raise exception 'DN_VALIDATION:allocation_direction';
  end if;

  -- Cap 1: sum of allocations per payment <= payments.amount + payments.discount. The journal
  -- credits AR (debits AP) by amount + discount, so the discount settles invoice value exactly
  -- like cash does and the invoice must be able to close fully (owner decision, change 06
  -- follow-up). The unallocated remainder is simply an on-account AR/AP balance with no
  -- allocation row.
  select coalesce(sum(amount), 0) into v_prior_payment
  from payment_allocations
  where payment_id = new.payment_id and id <> new.id;

  if v_prior_payment + new.amount > v_payment.amount + coalesce(v_payment.discount, 0) then
    raise exception 'DN_VALIDATION:allocation_exceeds_payment';
  end if;

  if new.invoice_type = 'sales_invoice' then
    select status, grand_total, party_id into v_invoice_status, v_invoice_total, v_invoice_party
    from sales_invoices where id = new.invoice_id for update;

    select coalesce(sum(grand_total), 0) into v_notes_total
    from credit_notes where against_invoice_id = new.invoice_id and status = 'posted';
  else
    select status, grand_total, party_id into v_invoice_status, v_invoice_total, v_invoice_party
    from purchase_invoices where id = new.invoice_id for update;

    select coalesce(sum(grand_total), 0) into v_notes_total
    from debit_notes where against_invoice_id = new.invoice_id and status = 'posted';
  end if;

  if v_invoice_status is null or v_invoice_status <> 'posted' then
    raise exception 'DN_VALIDATION:allocation_invoice_not_posted';
  end if;

  -- One party's money cannot settle another party's invoice: the journal credits AR for the
  -- payment's party, so a cross-party allocation would show one ledger paid while a different
  -- ledger actually moved (M3).
  if v_invoice_party is distinct from v_payment.party_id then
    raise exception 'DN_VALIDATION:allocation_party_mismatch';
  end if;

  -- Cap 2: the allocation plus everything already pointed at that invoice <= the invoice's open
  -- amount (grand_total - prior allocations - credit/debit notes against it).
  -- Two classes of row consume the open amount here:
  --   * allocations belonging to a *posted* payment — real money already applied;
  --   * this same payment's own sibling rows, posted or not (N1). Counting only posted rows let
  --     one draft receipt write two rows against one invoice and over-settle it: neither row saw
  --     the other, so 1,000 + 1,000 both passed against a 1,000 invoice.
  -- Other operators' *draft* allocations still reserve nothing (M7, owner decision): a draft
  -- receipt is a plan, not money, and two operators drafting against the same invoice must both
  -- be able to save. post_payment re-validates the per-invoice sum under lock at posting time,
  -- which is where that race is actually resolved.
  select coalesce(sum(pa.amount), 0) into v_prior_invoice
  from payment_allocations pa
  join payments p on p.id = pa.payment_id
  where pa.invoice_type = new.invoice_type and pa.invoice_id = new.invoice_id
    and pa.id <> new.id
    and (p.status = 'posted' or pa.payment_id = new.payment_id);

  v_open := v_invoice_total - v_prior_invoice - v_notes_total;

  if new.amount > v_open then
    raise exception 'DN_VALIDATION:allocation_exceeds_invoice';
  end if;

  return new;
end;
$function$;

-- UPDATE/DELETE (the OLD side): the allocations of a payment that is no longer a draft can only be
-- removed by the two paths that reverse its money in the same transaction — bounce_cheque and
-- cancel_document('payment') — which set a transaction-local marker naming the payment just
-- around their DELETE. A client cannot set it (PostgREST runs no free SQL, and no exposed function
-- calls set_config with caller input). FOR UPDATE, the same lock check_payment_allocation takes,
-- so the two triggers never hold the row at different strengths.
create or replace function public.payment_allocations_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status doc_status;
begin
  select status into v_status from payments where id = old.payment_id for update;
  if found and v_status <> 'draft' then
    if tg_op = 'DELETE'
       and coalesce(current_setting('dn.release_allocations', true), '') = old.payment_id::text then
      return old;
    end if;
    raise exception 'DN_NOT_DRAFT';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.payment_allocations_guard() from public, anon, authenticated, service_role;

create trigger payment_allocations_guard before update or delete on public.payment_allocations
  for each row execute function public.payment_allocations_guard();

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
  -- Security pass D1: the one sanctioned release of a posted payment's allocations
  -- (payment_allocations_guard checks this transaction-local marker).
  perform set_config('dn.release_allocations', p_payment_id::text, true);
  delete from payment_allocations where payment_id = p_payment_id;
  perform set_config('dn.release_allocations', '', true);

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
$function$;

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
    -- Security pass D1: the one sanctioned release of a posted payment's allocations
    -- (payment_allocations_guard checks this transaction-local marker).
    perform set_config('dn.release_allocations', p_source_id::text, true);
    delete from payment_allocations where payment_id = p_source_id;
    perform set_config('dn.release_allocations', '', true);

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

  elsif p_source_type = 'cash_deposit' then
    -- Change 23. Reversal is dated on the deposit's own date, like a day close: day_close_preview
    -- derives `expected` per day, so the pair of entries must cancel inside the day they belong to.
    -- That day (and everything after it) must therefore not be closed, and its month must be open.
    select * into v_doc from cash_deposits where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
    end if;

    select is_locked into v_period_locked
    from fiscal_periods where month = date_trunc('month', v_doc.deposit_date)::date;
    if coalesce(v_period_locked, true) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;

    if exists (select 1 from day_closes where status = 'posted' and close_date >= v_doc.deposit_date) then
      raise exception 'DN_VALIDATION:day_closed';
    end if;

    insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
    values (v_doc.deposit_date, 'Reversal of cash deposit ' || to_char(v_doc.deposit_date, 'DD-MM-YYYY'),
            'cash_deposit', p_source_id, v_actor, now())
    returning id into v_entry_id;

    insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
    select v_entry_id, row_number() over (order by line_no), account_id, party_id, credit, debit
    from journal_lines
    where entry_id = v_doc.journal_entry_id;

    update journal_entries set reversed_by = v_entry_id where id = v_doc.journal_entry_id;

    update cash_deposits set status = 'cancelled' where id = p_source_id;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'cancel', 'cash_deposits', p_source_id,
            jsonb_build_object('reversal_entry_id', v_entry_id, 'reason', p_reason));

  else
    raise exception 'DN_VALIDATION:unsupported_source';
  end if;

  return v_entry_id;
end;
$function$;

-- ============================================================
-- S1. Posted documents are immutable for every writer
-- ============================================================
-- Once a header leaves 'draft' the only changes allowed are the ones the definer functions make,
-- each checked against the data rather than against who is asking:
--   * status posted -> cancelled (every table), and for stock transfers in_transit -> received /
--     cancelled; a cancel must come after the document's journal entry has been reversed
--     (cancel_document, bounce_cheque and cancel_opening_balances all reverse first);
--   * payments: the cheque life-cycle columns (deposit_cheque, mark_cheque_cleared, bounce_cheque);
--   * sales invoices: the e-way-bill / transport columns (record_invoice_ewb);
--   * stock transfers: received_at / received_by (receive_stock_transfer);
--   * credit notes: buyer_gstin, only to the GSTIN its invoice was filed with (post_credit_note's
--     second update);
--   * day closes: journal_entry_id from empty to the day close's own entry (post_day_close);
--   * delivery challans: invoice_id to the posted invoice made from this challan, or back to empty
--     once that invoice is cancelled (_post_sales_invoice / cancel_document);
--   * updated_at (touch_updated_at).
-- The column changes apply only while the document is live (posted / in transit); a cancelled or
-- received document accepts nothing. Anything else on a non-draft row, and any DELETE of one,
-- raises DN_NOT_DRAFT. Named zz_ so it runs
-- after every other BEFORE trigger and sees the final row. quotations are not covered: they carry
-- no ledger effect and quotations_guard already freezes converted quotes.
create or replace function public.posted_document_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old  jsonb := to_jsonb(old);
  v_new  jsonb;
  v_from text := v_old ->> 'status';
  v_to   text;
  v_free text[] := array['updated_at'];
begin
  if v_from = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'DN_NOT_DRAFT';
  end if;

  v_new := to_jsonb(new);
  v_to := v_new ->> 'status';

  if v_to is distinct from v_from then
    if not ((v_from = 'posted' and v_to = 'cancelled')
            or (tg_table_name = 'stock_transfers' and v_from = 'in_transit' and v_to in ('received', 'cancelled')))
    then
      raise exception 'DN_NOT_DRAFT';
    end if;
    if v_to = 'cancelled' and v_old ->> 'journal_entry_id' is not null
       and not exists (select 1 from journal_entries
                        where id = (v_old ->> 'journal_entry_id')::uuid and reversed_by is not null)
    then
      raise exception 'DN_NOT_DRAFT';
    end if;
    v_free := v_free || array['status'];
  end if;

  -- The column changes below belong to live documents only; a cancelled or received one is final.
  if v_from not in ('posted', 'in_transit') then
    null;
  elsif tg_table_name = 'payments' then
    v_free := v_free || array['cheque_status', 'deposited_on', 'cleared_on', 'bounced_on', 'bounce_reversal_entry_id'];
  elsif tg_table_name = 'sales_invoices' then
    v_free := v_free || array['transport_mode', 'distance_km', 'transporter_name', 'transporter_gstin',
                              'vehicle_no', 'ewb_no', 'ewb_date', 'ewb_valid_until'];
  elsif tg_table_name = 'stock_transfers' then
    v_free := v_free || array['received_at', 'received_by'];
  elsif tg_table_name = 'credit_notes' then
    if v_new ->> 'buyer_gstin' is distinct from v_old ->> 'buyer_gstin'
       and v_new ->> 'against_invoice_id' is not null
       and v_new ->> 'buyer_gstin' is not distinct from
           (select buyer_gstin from sales_invoices where id = (v_new ->> 'against_invoice_id')::uuid)
    then
      v_free := v_free || array['buyer_gstin'];
    end if;
  elsif tg_table_name = 'day_closes' then
    if v_old ->> 'journal_entry_id' is null and v_new ->> 'journal_entry_id' is not null
       and exists (select 1 from journal_entries
                    where id = (v_new ->> 'journal_entry_id')::uuid
                      and source_type = 'day_close' and source_id = (v_old ->> 'id')::uuid)
    then
      v_free := v_free || array['journal_entry_id'];
    end if;
  elsif tg_table_name = 'delivery_challans' then
    if v_new ->> 'invoice_id' is distinct from v_old ->> 'invoice_id'
       and ((v_old ->> 'invoice_id' is null
             and exists (select 1 from sales_invoices
                          where id = (v_new ->> 'invoice_id')::uuid
                            and challan_id = (v_old ->> 'id')::uuid and status = 'posted'))
         or (v_new ->> 'invoice_id' is null
             and not exists (select 1 from sales_invoices
                              where id = (v_old ->> 'invoice_id')::uuid and status <> 'cancelled')))
    then
      v_free := v_free || array['invoice_id'];
    end if;
  end if;

  if (v_new - v_free) is distinct from (v_old - v_free) then
    raise exception 'DN_NOT_DRAFT';
  end if;
  return new;
end;
$$;
revoke all on function public.posted_document_guard() from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['sales_invoices', 'purchase_invoices', 'credit_notes', 'debit_notes', 'payments',
                           'expense_vouchers', 'delivery_challans', 'stock_adjustments', 'stock_transfers',
                           'cash_deposits', 'day_closes', 'opening_batches']
  loop
    execute format('create trigger zz_posted_document_guard before update or delete on public.%I '
                   'for each row execute function public.posted_document_guard()', t);
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- S1. service_role writes nothing but app_users
-- ------------------------------------------------------------
-- The secret key is used by the app only for auth admin calls and app_users (actions/admin.ts,
-- scripts/create-admin.mjs, the attack-test setup/cleanup) and to READ one invoice for the signed
-- PDF link. It keeps SELECT everywhere and INSERT/UPDATE/DELETE on app_users only; everything else
-- goes through the definer functions, which run as the owner and need no grant. TRUNCATE (ignores
-- RLS and triggers), REFERENCES, TRIGGER and MAINTAIN are not needed by any client role.
do $$
declare
  r record;
begin
  for r in select c.oid::regclass as tbl, c.relname
             from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    if r.relname = 'app_users' then
      execute format('revoke truncate, references, trigger, maintain on %s from service_role', r.tbl);
    else
      execute format('revoke insert, update, delete, truncate, references, trigger, maintain on %s from service_role', r.tbl);
    end if;
    -- D3: authenticated never needs these either.
    execute format('revoke references, trigger, maintain on %s from authenticated', r.tbl);
  end loop;
end;
$$;

-- Tables created by later migrations (owned by postgres) start the same way.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger, maintain on tables from service_role;
alter default privileges for role postgres in schema public
  revoke references, trigger, maintain on tables from authenticated;

-- ============================================================
-- D3. Hosted-only helper rls_auto_enable() is not callable by any client role
-- ============================================================
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role;
  end if;
end;
$$;

-- ============================================================
-- T1. The database enforces the 8-hour session time-box
-- ============================================================
-- current_app_role() (and with it is_active_member(), every RLS policy and every definer function)
-- now returns NULL when the session is older than 8 hours, measured from the EARLIEST timestamp in
-- the signed token's `amr` claim (the first sign-in step; refreshes keep it, a TOTP step-up does not
-- reset it). A copied owner cookie can be refreshed, but after 8 hours it no longer has a role.
-- Every access token Supabase Auth issues carries `amr`; a token WITHOUT the claim cannot come from
-- a client (tokens are signed with the project secret) — only from someone who holds that secret,
-- who could also write any timestamp. Such a token is therefore treated as not time-boxed, which
-- keeps the test suites' fabricated claims ({"sub","role","aal"}) working. An `amr` that is present
-- but empty, not an array, or without a usable timestamp fails closed. Same rule as the app's
-- src/lib/auth/session-age.ts.
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
     and (role <> 'admin' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
     and (auth.jwt() -> 'amr' is null
          or (jsonb_typeof(auth.jwt() -> 'amr') = 'array'
              and coalesce((select min((e ->> 'timestamp')::numeric)
                              from jsonb_array_elements(auth.jwt() -> 'amr') e
                             where jsonb_typeof(e) = 'object'
                               and e ->> 'timestamp' ~ '^[0-9]{1,12}(\.[0-9]+)?$'), 0)
                  > extract(epoch from now()) - 8 * 3600));
$$;

-- ============================================================
-- A1. Owners must have an authenticator app before go-live
-- ============================================================
CREATE OR REPLACE FUNCTION public.go_live_readiness()
 RETURNS TABLE(check_key text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_org         organization%rowtype;
  v_today       date;
  v_admins      int;
  v_counters    int;
  v_debits      numeric;
  v_credits     numeric;
  v_inv_gl      numeric;
  v_inv_stock   numeric;
  v_this_month  bool;
  v_next_month  bool;
  v_bank_name   text;
  v_no_totp     int;
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select * into v_org from organization limit 1;
  v_today := (now() at time zone v_org.timezone)::date;

  check_key := 'organisation';
  ok := btrim(coalesce(v_org.legal_name, '')) <> '' and v_org.gstin is not null and length(v_org.gstin) = 15
        and v_org.address is not null and coalesce(btrim(v_org.address ->> 'line1'), '') <> '';
  detail := case when ok then v_org.legal_name || ' · ' || v_org.gstin else 'legal name, GSTIN and address must be filled in' end;
  return next;

  select count(*) filter (where role = 'admin'), count(*) filter (where role = 'user')
    into v_admins, v_counters from app_users where is_active;
  check_key := 'owners';
  ok := v_admins >= 2;
  detail := v_admins || ' active owner(s), ' || v_counters || ' counter user(s); at least 2 owners so one can always sign in';
  return next;

  select coalesce(bool_or(not is_locked) filter (where month = date_trunc('month', v_today)::date), false),
         coalesce(bool_or(not is_locked) filter (where month = (date_trunc('month', v_today) + interval '1 month')::date), false)
    into v_this_month, v_next_month from fiscal_periods;
  check_key := 'periods';
  ok := v_this_month and v_next_month;
  detail := case when ok then 'this month and next month are open'
                 else 'this month and next month must exist and be unlocked' end;
  return next;

  check_key := 'opening_posted';
  ok := exists (select 1 from opening_batches where status = 'posted');
  detail := case when ok then 'opening balances are in the books' else 'opening balances not posted yet' end;
  return next;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_debits, v_credits from journal_lines;
  check_key := 'ledger_balanced';
  ok := v_debits = v_credits;
  detail := 'debits ' || v_debits || ' · credits ' || v_credits;
  return next;

  select coalesce(sum(jl.debit - jl.credit), 0) into v_inv_gl
  from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'inventory';
  select coalesce(sum(value), 0) into v_inv_stock from stock_movements;
  check_key := 'inventory_ties';
  ok := v_inv_gl = v_inv_stock;
  detail := 'Inventory account ' || v_inv_gl || ' · stock ledger ' || v_inv_stock;
  return next;

  -- Change 23: the UPI id printed on invoices is set, and the bank ledger carries the bank's name
  -- rather than the seed's generic "Bank".
  select name into v_bank_name from accounts where system_key = 'bank';
  check_key := 'bank_set_up';
  ok := btrim(coalesce(v_org.upi_vpa, '')) <> '' and coalesce(btrim(v_bank_name), '') not in ('', 'Bank');
  detail := case when ok then 'UPI ' || v_org.upi_vpa || ' · ledger ' || v_bank_name
                 else 'set the UPI id (Settings) and name the bank ledger (currently "' || coalesce(v_bank_name, '') || '")' end;
  return next;

  -- Security pass A1: every active owner has a verified authenticator (TOTP) factor. Until
  -- then the account is protected by its password alone and whoever enrols first owns it.
  check_key := 'owners_have_totp';
  begin
    select count(*) into v_no_totp from app_users u
     where u.is_active and u.role = 'admin'
       and not exists (select 1 from auth.mfa_factors f
                        where f.user_id = u.user_id and f.factor_type = 'totp' and f.status = 'verified');
    ok := v_admins > 0 and v_no_totp = 0;
    detail := case when ok then 'every active owner has an authenticator app set up'
                   else v_no_totp || ' active owner(s) without an authenticator app' end;
  exception when insufficient_privilege then
    ok := false;
    detail := 'authenticator factors cannot be read (database permission)';
  end;
  return next;
end;
$function$;

-- Per-person "authenticator set up" for the Users screen. Owner at aal2 only; active members only.
create or replace function public.owner_totp_status()
returns table (user_id uuid, has_totp boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  return query
    select u.user_id,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = u.user_id and f.factor_type = 'totp' and f.status = 'verified')
      from app_users u
     where u.is_active
     order by u.user_id;
end;
$$;
revoke all on function public.owner_totp_status() from public, anon, authenticated, service_role;
grant execute on function public.owner_totp_status() to authenticated;

-- ============================================================
-- A2. Audit trail: bank rows owner-only; no stock cost in note payloads; no bank narration on vouchers
-- ============================================================
drop policy select_active_members on public.audit_log;
create policy select_active_members on public.audit_log for select
  using (is_active_member()
         and (entity <> 'expense_vouchers' or entity_id is null
              or entity_id not in (select public.hidden_payroll_voucher_ids()))
         and (entity not in ('parties', 'party_addresses', 'items', 'organization', 'accounts', 'fiscal_periods',
                             'books', 'tally', 'archive', 'bank_statements', 'bank_statement_lines')
              or current_app_role() = 'admin'));

-- post_credit_note: 'stock_value' dropped from the audit payload (the counter reads note audit rows).
CREATE OR REPLACE FUNCTION public.post_credit_note(p_note_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
            'stock_effect', v_doc.stock_effect));

  return v_entry_id;
end;
$function$;

-- post_debit_note: 'cogs_true_up' dropped from the audit payload.
CREATE OR REPLACE FUNCTION public.post_debit_note(p_note_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
            'stock_effect', v_doc.stock_effect, 'itc_reversed', v_itc));

  return v_entry_id;
end;
$function$;

-- post_bank_expense: the voucher line says 'Bank charge' (or the owner's note), never the bank's
-- narration, which can carry account numbers and counterparties.
CREATE OR REPLACE FUNCTION public.post_bank_expense(p_line_id uuid, p_account_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor   uuid := auth.uid();
  v_line    record;
  v_acct    record;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_today   date;
  v_voucher uuid := gen_random_uuid();
  v_entry   uuid;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then
    raise exception 'DN_VALIDATION:note_too_long';
  end if;

  select * into v_line from bank_statement_lines where id = p_line_id for update;
  if not found then
    raise exception 'DN_VALIDATION:line_not_found';
  end if;
  if v_line.match_status <> 'unmatched' then
    raise exception 'DN_VALIDATION:line_not_unmatched';
  end if;
  if v_line.debit <= 0 then
    raise exception 'DN_VALIDATION:line_not_debit';
  end if;

  select * into v_acct from accounts
  where id = coalesce(p_account_id, (select id from accounts where system_key = 'bank_charges'));
  if not found or v_acct.type <> 'expense' or v_acct.is_group or v_acct.is_control or v_acct.is_money
     or coalesce(v_acct.system_key, '') in
        ('cogs', 'round_off', 'stock_loss', 'cash_over_short', 'discount_allowed', 'salaries') then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;
  if v_line.txn_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  insert into expense_vouchers (id, voucher_date, status, voucher_type, pay_account_id)
  values (v_voucher, v_line.txn_date, 'draft', 'expense', v_line.account_id);
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
  values (v_voucher, 1, v_acct.id, v_line.debit,
          coalesce(v_note, 'Bank charge'));

  v_entry := post_expense_voucher(v_voucher);
  perform match_bank_line(p_line_id, v_entry, 'manual');

  return jsonb_build_object('voucher_id', v_voucher, 'entry_id', v_entry, 'line_id', p_line_id);
end;
$function$;

-- ============================================================
-- D2. Cash deposit and day close serialise
-- ============================================================
CREATE OR REPLACE FUNCTION public.post_cash_deposit(p_date date, p_amount numeric, p_reference text, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor         uuid := auth.uid();
  v_role          app_role;
  v_today         date;
  v_cash_id       uuid;
  v_bank_id       uuid;
  v_period_locked bool;
  v_ref           text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note          text := nullif(btrim(coalesce(p_note, '')), '');
  v_entry_id      uuid;
  v_dep_id        uuid := gen_random_uuid();
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Any active member (the counter walks the cash to the bank, like deposit_cheque). An owner
  -- below aal2 has no role here, so is refused.
  v_role := current_app_role();
  if v_role is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- Security pass D2: deposits and day closes serialise on one lock, so a deposit can never slip
  -- into a day while that day is being closed (each reads what the other writes).
  perform pg_advisory_xact_lock(hashtext('cash_day'));

  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'DN_VALIDATION:invalid_amount';
  end if;
  if p_date is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  select (now() at time zone (select timezone from organization limit 1))::date into v_today;
  if p_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;
  if char_length(coalesce(v_ref, '')) > 60 then
    raise exception 'DN_VALIDATION:reference_too_long';
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    raise exception 'DN_VALIDATION:note_too_long';
  end if;

  select id into v_cash_id from accounts where system_key = 'cash';
  select id into v_bank_id from accounts where system_key = 'bank';
  if v_cash_id is null or v_bank_id is null then
    raise exception 'DN_VALIDATION:missing_account';
  end if;

  -- A missing period is blocked like a locked one (periods never auto-create).
  select is_locked into v_period_locked
  from fiscal_periods where month = date_trunc('month', p_date)::date;
  if coalesce(v_period_locked, true) then
    raise exception 'DN_PERIOD_LOCKED';
  end if;

  -- A deposit moves that day's `expected` cash and every later day's opening cash, so it cannot
  -- be slipped into a day that has already been counted and closed (reopen the day first).
  if exists (select 1 from day_closes where status = 'posted' and close_date >= p_date) then
    raise exception 'DN_VALIDATION:day_closed';
  end if;

  insert into journal_entries (entry_date, narration, source_type, source_id, posted_by, posted_at)
  values (p_date, 'Cash deposited to bank' || coalesce(' · ' || v_ref, ''), 'cash_deposit',
          v_dep_id, v_actor, now())
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, v_bank_id, p_amount, 0),
         (v_entry_id, 2, v_cash_id, 0, p_amount);

  insert into cash_deposits (id, deposit_date, amount, reference, note, journal_entry_id)
  values (v_dep_id, p_date, p_amount, v_ref, v_note, v_entry_id);

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'cash_deposits', v_dep_id,
          jsonb_build_object('entry_id', v_entry_id, 'deposit_date', p_date, 'amount', p_amount,
                             'reference', v_ref));

  return v_dep_id;
end;
$function$;

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

  -- Security pass D2: deposits and day closes serialise on one lock, so a deposit can never slip
  -- into a day while that day is being closed (each reads what the other writes).
  perform pg_advisory_xact_lock(hashtext('cash_day'));

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
$function$;
