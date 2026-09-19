-- Change 06 follow-up: a receipt's (or outgoing payment's) allocations may total
-- amount + discount.
--
-- Why: post_payment credits AR (debits AP) by amount + discount, but change 04 capped the sum of a
-- payment's allocations at `amount` alone. A customer who paid 900 against a 1,000 invoice with a
-- 100 settlement discount therefore left the invoice open by exactly the discount forever, and
-- ageing could never show it settled. Owner decision: allocations may total amount + discount.
--
-- Only the per-payment total cap changes, in the two places that compare the sum of allocations to
-- the payment: the check_payment_allocation trigger (Cap 1) and the re-validation at the top of
-- post_payment. Everything else in both functions - per-invoice open-amount cap, the N1 per-invoice
-- sum and unique constraint, direction and party matching, SECURITY DEFINER, search_path, locking
-- order, grants - is carried over verbatim from 20260918120000. The column applies to both
-- directions (receipt discount -> Discount Allowed, payment discount -> Discount Received), so
-- the cap is direction-agnostic.
--
-- It also gates posting a payment with discount > 0 to admin (owner decision 2026-09-19): a `user`
-- may save such a draft, only an admin may post it.
--
-- The change-04 migration is committed and is not edited.

create or replace function public.check_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

revoke all on function public.check_payment_allocation()
  from public, anon, authenticated, service_role;

create or replace function public.post_payment(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.post_payment(uuid) from public, anon, service_role;
grant execute on function public.post_payment(uuid) to authenticated;
