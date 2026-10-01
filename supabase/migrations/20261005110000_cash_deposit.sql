-- Change 23: cash-deposit (and HDFC bank set-up) — migration B of two.
--
-- Money moved from the cash drawer into the bank had no entry: day close subtracts a `deposited`
-- figure that only a "Dr bank / Cr cash" entry can create. This adds that entry.
--   1. cash_deposits  — the document (written only by post_cash_deposit)
--   2. post_cash_deposit(date, amount, reference, note) -> the deposit's id
--   3. cancel_document gains a 'cash_deposit' branch (admin; reversal dated on the deposit's date)
--   4. bank ledger (system_key 'bank') renamed "HDFC Bank"
--   5. go_live_readiness gains 'bank_set_up' (UPI id set, bank ledger named)

-- ============================================================
-- 1. cash_deposits
-- ============================================================
create table cash_deposits (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users,
  deposit_date     date not null,
  amount           numeric(14,2) not null check (amount > 0),
  reference        text check (reference is null or char_length(reference) <= 60),
  note             text check (note is null or char_length(note) <= 500),
  status           doc_status not null default 'posted' check (status <> 'draft'),
  journal_entry_id uuid not null references journal_entries (id)
);

create index cash_deposits_date_idx on cash_deposits (deposit_date desc);

create trigger set_created_by before insert or update on cash_deposits
  for each row execute function public.set_created_by();

-- Read-only to the app: members see deposits (Payments + Day close lists); only the posting
-- function (definer) writes, only cancel_document changes the status.
alter table cash_deposits enable row level security;
create policy select_active_members on cash_deposits for select using (is_active_member());
revoke all on public.cash_deposits from anon, authenticated;
grant select on public.cash_deposits to authenticated;
grant select, insert, update, delete on public.cash_deposits to service_role;

-- ============================================================
-- 2. post_cash_deposit
-- ============================================================
create or replace function public.post_cash_deposit(
  p_date      date,
  p_amount    numeric,
  p_reference text,
  p_note      text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke all on function public.post_cash_deposit(date, numeric, text, text) from public, anon, service_role;
grant execute on function public.post_cash_deposit(date, numeric, text, text) to authenticated;

-- ============================================================
-- 3. cancel_document: + 'cash_deposit' (rest of the function is change 20's, unchanged)
-- ============================================================
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
$$;

-- ============================================================
-- 4. HDFC set-up: the one bank ledger carries the bank's name
-- ============================================================
update accounts set name = 'HDFC Bank' where system_key = 'bank' and name = 'Bank';

-- ============================================================
-- 5. go_live_readiness: + bank_set_up (body otherwise identical to change 17's)
-- ============================================================
create or replace function public.go_live_readiness()
returns table (check_key text, ok bool, detail text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
end;
$$;

revoke all on function public.go_live_readiness() from public, anon;
grant execute on function public.go_live_readiness() to authenticated;
