-- Change 04: posting-purchase-payment
--
-- db-architecture spec: "Posting engine (plpgsql, SECURITY DEFINER)" + "Schema extensions for
-- prototype-v2 features" -> payments (columns added) + "Implementation clarifications" ->
-- Actor and grants, Tax and rounding, COGS and weighted average, RCM freight, Payment
-- allocations, Payments: discount and cheques, Salaries/advances/wages + "Non-functional
-- invariants" -> Concurrency and lock ordering, Idempotency, Cancellation edge cases.
--
-- Adds the buy side and the money-movement side: post_purchase_invoice (ITC / non-ITC),
-- post_payment (+ the payment_allocations trigger), the cheque lifecycle (deposit / clear /
-- bounce), post_expense_voucher (generic expense, employee advance, salary, daily wages, RCM
-- freight), and three new cancel_document branches.
--
-- Every function copies change 03's patterns exactly: actor derived from auth.uid() inside the
-- function (never a parameter), lock order document -> party -> items ascending by id ->
-- doc_sequences, DN_* error codes, exactly one audit_log row, SECURITY DEFINER with
-- SET search_path = public, pg_temp, and no grant to anon/public/service_role.
--
-- cancel_document is extended with CREATE OR REPLACE on the same signature; change 03's
-- sales_invoice branch is carried over verbatim.

-- ============================================================
-- 1. Schema extensions
-- ============================================================

-- New enum type (not a new value on an existing enum), so it is usable in this same
-- transaction — unlike the source_type additions change 05 owns.
create type cheque_status as enum
  ('in_hand','deposited','cleared','bounced','issued','presented');

alter table payments add column cheque_status cheque_status;
alter table payments add column cheque_bank text;
alter table payments add column deposited_on date;
alter table payments add column cleared_on date;
alter table payments add column bounced_on date;
alter table payments add column bounce_reversal_entry_id uuid references journal_entries (id);

-- Expense vouchers: the base table carried only header/lines with no way to say what kind of
-- voucher it is or which ledger pays it, which the Salaries/advances/wages clarification
-- requires (an advance, a salary and a casual-hamali payout are three different journal shapes
-- from the same table).
alter table expense_vouchers add column voucher_type text not null default 'expense'
  check (voucher_type in ('expense','advance','salary','wages'));
-- Cash|bank leg. Nullable: NULL resolves to the 'cash' system account at posting time.
alter table expense_vouchers add column pay_account_id uuid references accounts (id);
-- "Recovered = min(advance balance, gross) unless the voucher specifies less" — NULL means
-- "recover the maximum".
alter table expense_vouchers add column advance_recovered numeric(14,2);
-- RCM freight: the purchase form's freight block creates a linked voucher rather than a
-- purchase-invoice line (Implementation clarifications -> RCM freight).
alter table expense_vouchers add column purchase_invoice_id uuid references purchase_invoices (id);
-- "Salary period" (Decisions from change 04 review): which month a salary or wage voucher is
-- for, as the first of that month, so v_employee_ledger (change 06) can group by it instead of
-- parsing the line narration. NULL on every other voucher type.
alter table expense_vouchers add column period_month date
  check (period_month is null or period_month = date_trunc('month', period_month)::date);

-- Cheques in hand: a receipt by cheque is not bank money until the bank says so.
insert into accounts (code, name, type, parent_id, system_key)
values ('1130', 'Cheques in Hand', 'asset',
        (select id from accounts where code = '1100'), 'cheques_in_hand');

-- The allocation trigger sums every row of a payment on each insert; the baseline index set
-- only covers the invoice side.
create index on payment_allocations (payment_id);
-- (A partial journal_entries(source_id) WHERE source_type = 'payment' index was dropped from
-- this migration in review: the baseline journal_entries(source_type, source_id) already serves
-- every lookup bounce_cheque and cancel_document make.)

-- Which ledgers real money can sit in. A flag rather than a system_key list, so the day the
-- business opens a second bank account it is one UPDATE and every money-handling function
-- follows — review finding M4. Cheques in Hand is deliberately NOT a money account: a cheque in
-- the drawer is not cash, which is the entire reason that ledger exists.
alter table accounts add column is_money bool not null default false;
update accounts set is_money = true where system_key in ('cash', 'bank');

create or replace function public.is_money_account(p_account_id uuid)
returns bool
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select a.is_money and not a.is_group and not a.is_control and a.type = 'asset'
     from accounts a where a.id = p_account_id),
    false);
$$;

revoke all on function public.is_money_account(uuid)
  from public, anon, authenticated, service_role;

-- ============================================================
-- 2. payment_allocations: cap trigger + the write policies the app needs
-- ============================================================

-- One payment settles a given invoice once, for one amount (N1). Two rows for the same pair are
-- never a business fact — they are a double-submit or a retry — and they were the cheapest way
-- to over-settle an invoice, because each row was validated against the invoice on its own.
-- Every internal writer (post_cash_sale, change 12's AllocationGrid) already writes one row per
-- pair and adjusts it by UPDATE, so nothing legitimate loses a capability here; the constraint
-- just makes the arithmetic in the cap trigger and post_payment impossible to sidestep by
-- splitting an amount across rows.
alter table payment_allocations
  add constraint payment_allocations_payment_invoice_key
  unique (payment_id, invoice_type, invoice_id);

-- SECURITY DEFINER (review finding B1): the trigger fires as the role doing the INSERT, and
-- every table it reads to enforce the caps — payments, sales_invoices, purchase_invoices,
-- credit_notes — is RLS-protected. Under an ordinary authenticated session a row the policy
-- hides reads as "not found" or as zero, so an invisible prior allocation would silently pass
-- the cap it exists to enforce. Running as the owner makes the cap arithmetic see every row,
-- which is the only way a cap can mean anything. Still revoked from every role: only the
-- trigger mechanism invokes it.
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

  -- Cap 1: sum of allocations per payment <= payments.amount. The unallocated remainder is
  -- simply an on-account AR/AP balance with no allocation row.
  select coalesce(sum(amount), 0) into v_prior_payment
  from payment_allocations
  where payment_id = new.payment_id and id <> new.id;

  if v_prior_payment + new.amount > v_payment.amount then
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

create trigger check_allocation before insert or update on payment_allocations
  for each row execute function public.check_payment_allocation();

-- Allocations are the one ledger-adjacent table a client writes directly, and re-pointing which
-- invoice a receipt settles changes what the ageing report says a party owes. That needs the
-- same paper trail as a posting (m13). SECURITY DEFINER because audit_log takes no client
-- INSERT — its only policy is SELECT.
create or replace function public.audit_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    record;
  v_action text;
begin
  v_row := coalesce(new, old);
  v_action := case tg_op when 'INSERT' then 'allocate'
                         when 'UPDATE' then 'reallocate'
                         else 'unallocate' end;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (
    auth.uid(), v_action, 'payment_allocations', v_row.id,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );

  return null; -- AFTER trigger
end;
$$;

revoke all on function public.audit_payment_allocation()
  from public, anon, authenticated, service_role;

create trigger audit_allocation after insert or update or delete on payment_allocations
  for each row execute function public.audit_payment_allocation();

-- Change 01 left payment_allocations with SELECT only, on the assumption that post_payment
-- would write the rows. It does not: which invoices a receipt settles is the operator's choice
-- (change 12's AllocationGrid), made before posting and adjustable afterwards. Allocation is
-- not a ledger fact — it never moves money, it only points at which invoice a party's payment
-- settles — so allowing it on a posted (not cancelled) payment is safe, and it is what
-- DN_HAS_ALLOCATIONS's "the receipt must be re-allocated or reversed first" presumes. Both
-- caps are enforced by the trigger above regardless of who writes the row.
create policy write_allocation on payment_allocations for insert
  with check (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status <> 'cancelled'
  ));
create policy update_allocation on payment_allocations for update
  using (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status <> 'cancelled'
  ));
create policy delete_allocation on payment_allocations for delete
  using (is_active_member() and exists (
    select 1 from payments p where p.id = payment_id and p.status <> 'cancelled'
  ));

-- ============================================================
-- 3. post_purchase_invoice
--    Dr Inventory taxable (+ tax when itc_eligible = false) - Dr input CGST/SGST or IGST when
--    eligible - Cr AP(party) grand total - round-off; stock IN at cost, weighted average
--    recomputed from movements after the item lock.
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
-- 4. post_payment
--    receipt: Dr cash/bank (or Cheques in hand for a cheque) - Dr discount_allowed -
--             Cr AR(party); payment: mirrored, discount -> Cr discount_received,
--             cheque -> Cr bank at issue with cheque_status = 'issued'.
-- ============================================================

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
  if v_alloc_total > v_doc.amount then
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

-- ============================================================
-- 5. post_expense_voucher
--    Generic expense / employee advance / salary / daily wages, plus RCM freight lines.
--    One voucher, one entry; the employee ledger runs through control accounts only, because
--    change 02's party rule forbids party_id on a plain expense account.
-- ============================================================

create or replace function public.post_expense_voucher(p_voucher_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.post_expense_voucher(uuid) from public, anon, service_role;
grant execute on function public.post_expense_voucher(uuid) to authenticated;

-- ============================================================
-- 6. Cheque lifecycle: deposit -> clear, or bounce back to the invoices.
-- ============================================================

create or replace function public.deposit_cheque(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.deposit_cheque(uuid) from public, anon, service_role;
grant execute on function public.deposit_cheque(uuid) to authenticated;

-- Status transition only: no money moves when the bank confirms what it already holds.
create or replace function public.mark_cheque_cleared(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.mark_cheque_cleared(uuid) from public, anon, service_role;
grant execute on function public.mark_cheque_cleared(uuid) to authenticated;

-- bounce_cheque: one reversal entry mirroring every un-reversed entry of this receipt (the
-- receipt itself, plus the deposit when there was one), allocations deleted so the invoices
-- re-open, cheque_status = 'bounced'.
--
-- NOTE: the older spec text reads bounce_cheque(p_payment_id, p_actor). The pre-implementation
-- audit superseded that for every post_*/cancel_* function: the actor is auth.uid(), never a
-- parameter, because a caller-supplied uuid lets a 'user' act as the admin.
create or replace function public.bounce_cheque(p_payment_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.bounce_cheque(uuid, text) from public, anon, service_role;
grant execute on function public.bounce_cheque(uuid, text) to authenticated;

-- ============================================================
-- 7. cancel_document: change 03's sales_invoice branch, carried over verbatim, plus the
--    purchase_invoice, payment and expense_voucher branches this change owns.
-- ============================================================

create or replace function public.cancel_document(p_source_type source_type, p_source_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select role into v_role from app_users where user_id = v_actor and is_active;
  if v_role is null or v_role <> 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  if p_source_type = 'sales_invoice' then
    -- Lock order (same fixed order post_sales_invoice uses): (1) document, (2) party,
    -- (3) every item touched, ascending id.
    select * into v_doc from sales_invoices where id = p_source_id for update;
    if not found or v_doc.status <> 'posted' then
      raise exception 'DN_NOT_POSTED';
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
      -- negative value. (The second arm of this test used to repeat the first one verbatim under
      -- an extra quantity condition, so it could never fire on its own.)
      if coalesce(v_onhand_value, 0) - v_mv.value < 0 then
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

  else
    raise exception 'DN_VALIDATION:unsupported_source';
  end if;

  return v_entry_id;
end;
$$;

-- service_role deliberately not granted (change 03's decision #9): auth.uid() is NULL under a
-- service-role session, so the grant would be a dead path that always fails DN_FORBIDDEN.
revoke all on function public.cancel_document(source_type, uuid, text) from public, anon, service_role;
grant execute on function public.cancel_document(source_type, uuid, text) to authenticated;
