-- db-architecture spec: "Posting engine" + "Implementation clarifications" (Actor, Numbering,
-- Tax, Income accounts, Warehouse, COGS, Credit limit, Walk-in) + "Non-functional invariants"
-- (Concurrency and lock ordering, Idempotency, Cancellation edge cases, Time zone, Fiscal-year
-- rollover, Function exposure). next_doc_no, post_sales_invoice, cancel_document (sales_invoice
-- branch only), stock_on_hand. DESIGN.md §3 worked example is the reference for the sales-invoice
-- journal shape.
--
-- Scope: only the sales_invoice document type. post_purchase_invoice, post_payment, notes and
-- expense vouchers arrive in changes 04/05/20; those changes extend cancel_document with their
-- own IF branches rather than replacing this one.
--
-- Rebuilt against the pre-implementation + system-design audit (2026-09-16, Fable) that landed
-- on `main` mid-implementation: actor is now derived from auth.uid() inside every function, never
-- passed as a parameter (the exact bug a fresh Opus review of the first draft had separately
-- found and proven exploitable — REJECT verdict, see implementation-notes.md). This version also
-- adds the audit's lock-ordering protocol, IST-aware dates, non-stock items, warehouse_id on
-- documents, credit-limit enforcement, and locks down every function created by changes 01-02
-- that never got an explicit grant review.

-- ============================================================
-- Function exposure: lock down default privileges + every function created so far
-- ============================================================

alter default privileges in schema public revoke execute on functions from public;

-- Trigger functions: no role ever calls these directly (the trigger mechanism invokes them
-- under the table owner's context regardless of the DML-issuing role's own privileges —
-- verified live: revoking all roles here does not stop a normal UPDATE from firing them).
revoke all on function public.touch_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.check_journal_balanced() from public, anon, authenticated, service_role;
revoke all on function public.check_journal_entry_immutable() from public, anon, authenticated, service_role;
revoke all on function public.reject_mutation() from public, anon, authenticated, service_role;
revoke all on function public.check_period_not_locked() from public, anon, authenticated, service_role;
revoke all on function public.check_leaf_account() from public, anon, authenticated, service_role;
revoke all on function public.check_journal_has_lines() from public, anon, authenticated, service_role;
revoke all on function public.check_line_party() from public, anon, authenticated, service_role;

-- RLS helper functions: called directly inside USING() policy expressions for every table, so
-- `authenticated` keeps its grant (removing it would break every RLS-gated read for real
-- sessions — verified live before making this change). Only close the anon/public paths.
revoke all on function public.is_active_member() from public, anon;
revoke all on function public.current_app_role() from public, anon;

-- audit_log: same insert-only enforcement as the ledger, not just missing grants.
create trigger immutable_audit_log before update or delete on audit_log
  for each row execute function public.reject_mutation();

-- ============================================================
-- Schema additions (Implementation clarifications + Non-functional invariants)
-- ============================================================

alter table organization add column timezone text not null default 'Asia/Kolkata';
alter table organization add column allow_negative_stock bool not null default false;

alter table items add column is_stock bool not null default true;

alter table parties add column is_walk_in bool not null default false;

-- Sales lines had no warehouse selector at all; the document header now carries it, defaulted
-- by the application at draft creation (frontend-architecture, change 10), not by the DB — a
-- plain column DEFAULT can't hold a "the current default warehouse" subquery in Postgres.
alter table sales_invoices add column warehouse_id uuid not null references warehouses;
alter table purchase_invoices add column warehouse_id uuid not null references warehouses;

-- Exactly one default warehouse is the invariant change 10's draft-creation default relies on.
create unique index warehouses_one_default on warehouses (is_default) where is_default;

-- reversal_of marks a stock_movements row as itself the mirror of an earlier one, so
-- cancel_document's reversal-select can never pick up a row it already wrote (no double-reverse)
-- and a stock ledger can tell an original OUT from the IN that reversed it.
alter table stock_movements add column reversal_of uuid references stock_movements (id);

-- The app is never required to send a number it isn't trusted with (post_sales_invoice
-- overwrites this on every line at posting time regardless of what the draft held).
alter table sales_invoice_lines alter column taxable_value set default 0;

-- Income/COGS accounts by item category, now retroactively keyed (change 01's seed didn't
-- reference these three yet). Also seeds the other system_keys the audit named for later changes.
update accounts set system_key = 'sales_cement'       where code = '4100';
update accounts set system_key = 'sales_steel'        where code = '4200';
update accounts set system_key = 'sales_other'        where code = '4300';
update accounts set system_key = 'freight_recovered'  where code = '4400';
update accounts set system_key = 'discount_received'  where code = '4500';
update accounts set system_key = 'salaries'           where code = '5500';
update accounts set system_key = 'godown_rent'         where code = '5400';

-- Walk-in customer: cash sales are a normal invoice to this party followed by a receipt.
insert into parties (name, type, state_code, gstin, credit_limit, is_walk_in)
select 'Cash / Walk-in customer', 'customer', state_code, null, 0, true
from organization limit 1;

-- ============================================================
-- stock_on_hand: weighted-average read. SECURITY INVOKER (not DEFINER): a direct RPC call is
-- subject to stock_movements' own "active members only" RLS policy instead of always bypassing
-- it as the table owner. Calls from inside a SECURITY DEFINER post_*/cancel_* function are
-- unaffected — they already run as that function's owner.
-- ============================================================

create or replace function public.stock_on_hand(p_item uuid, p_warehouse uuid)
returns table(qty numeric, value numeric, avg_rate numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(m.qty), 0)::numeric(12,3) as qty,
    coalesce(sum(m.value), 0)::numeric(14,2) as value,
    case when coalesce(sum(m.qty), 0) = 0 then 0::numeric(14,4)
         else round(coalesce(sum(m.value), 0) / sum(m.qty), 4)
    end as avg_rate
  from stock_movements m
  where m.item_id = p_item and m.warehouse_id = p_warehouse;
$$;

-- ============================================================
-- next_doc_no: row-locked, gapless per (series, fy_label). Auto-creates the next FY's row for
-- a series that already exists (fiscal-year rollover), inheriting that series' doc_type from
-- its most recent prior-FY row — so 1 April never needs a manual seed step for numbering.
-- ============================================================

create or replace function public.next_doc_no(p_series text, p_date date)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fy_start_month int;
  v_fy_start_year  int;
  v_fy_label       text;
  v_yy_yy          text;
  v_next_no        int;
  v_prefix         text;
  v_doc_type       source_type;
begin
  select fy_start_month into v_fy_start_month from organization limit 1;

  if extract(month from p_date)::int >= v_fy_start_month then
    v_fy_start_year := extract(year from p_date)::int;
  else
    v_fy_start_year := extract(year from p_date)::int - 1;
  end if;

  v_fy_label := lpad(v_fy_start_year::text, 4, '0') || '-'
             || lpad(((v_fy_start_year + 1) % 100)::text, 2, '0');
  v_yy_yy := lpad((v_fy_start_year % 100)::text, 2, '0') || '-'
          || lpad(((v_fy_start_year + 1) % 100)::text, 2, '0');

  select next_no, prefix into v_next_no, v_prefix
  from doc_sequences
  where series = p_series and fy_label = v_fy_label
  for update;

  if found then
    update doc_sequences
       set next_no = next_no + 1
     where series = p_series and fy_label = v_fy_label;
    return v_prefix || lpad(v_next_no::text, 4, '0');
  end if;

  select doc_type into v_doc_type from doc_sequences where series = p_series limit 1;
  if v_doc_type is null then
    raise exception 'DN_VALIDATION:no_sequence';
  end if;

  v_prefix := p_series || '/' || v_yy_yy || '/';

  -- Two concurrent first-invoices-of-a-new-FY could both see "no row" above; the loser hits
  -- doc_sequences' UNIQUE(series, fy_label) instead of serializing. Numbering stays correct
  -- either way (still gapless, no duplicate), but without this handler the loser would surface
  -- a raw constraint error instead of a document number, on the entirely predictable morning of
  -- 1 April. A nested block gives PL/pgSQL an implicit savepoint to recover into.
  begin
    insert into doc_sequences (series, doc_type, fy_label, prefix, next_no)
    values (p_series, v_doc_type, v_fy_label, v_prefix, 2);
    return v_prefix || lpad('1', 4, '0');
  exception when unique_violation then
    select next_no, prefix into v_next_no, v_prefix
    from doc_sequences
    where series = p_series and fy_label = v_fy_label
    for update;

    update doc_sequences
       set next_no = next_no + 1
     where series = p_series and fy_label = v_fy_label;

    return v_prefix || lpad(v_next_no::text, 4, '0');
  end;
end;
$$;

revoke all on function public.next_doc_no(text, date) from public, anon, authenticated, service_role;
-- No grant to anyone: only ever called from inside a SECURITY DEFINER post_* function, which
-- executes as that function's owner (postgres) regardless of grants — the owner's own right to
-- call a function it owns isn't a grant and can't be revoked this way.

-- ============================================================
-- post_sales_invoice: see references/post-function-skeleton.sql in the daksh-posting skill for
-- the numbered-step shape, updated by the audit to derive the actor from auth.uid().
-- Lock order (Non-functional invariants → Concurrency and lock ordering): (1) document,
-- (2) party, (3) every item touched ordered by id, (4) doc_sequences (inside next_doc_no).
-- ============================================================

create or replace function public.post_sales_invoice(p_invoice_id uuid, p_override_credit bool default false)
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
begin
  if v_actor is null then
    raise exception 'DN_FORBIDDEN';
  end if;

  -- 1. Lock the document; drafts only
  select * into v_doc from sales_invoices where id = p_invoice_id for update;
  if not found or v_doc.status <> 'draft' then
    raise exception 'DN_NOT_DRAFT';
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

  -- 4. Recompute money from line snapshots (never trust client totals)
  select state_code, allow_negative_stock into v_org_state, v_allow_negative
  from organization limit 1;
  v_intra := (v_doc.place_of_supply = v_org_state);
  v_warehouse_id := v_doc.warehouse_id;

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
    from sales_invoice_lines l
    join items i on i.id = l.item_id
    where l.invoice_id = p_invoice_id
    order by l.line_no
  loop
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
      -- no stock movement. Carries the goods' GST rate (composite supply) via the line
      -- snapshot the app already set; the function trusts it, same as every other line.
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

    -- Weighted-average COGS + stock OUT, valued at on-hand average before this line's
    -- movement. Safe under concurrency: this item's row is already locked above.
    select qty, avg_rate into v_onhand_qty, v_onhand_rate
    from stock_on_hand(v_line.item_id, v_warehouse_id);

    if v_onhand_qty - v_line.qty < 0 and not (v_allow_negative and v_role = 'admin') then
      raise exception 'DN_NEGATIVE_STOCK';
    end if;

    v_line_cogs := round(v_line.qty * v_onhand_rate, 2);
    v_cogs_total := v_cogs_total + v_line_cogs;

    insert into stock_movements
      (item_id, warehouse_id, movement_date, qty, rate, value, source_type, source_id)
    values
      (v_line.item_id, v_warehouse_id, v_doc.invoice_date, -v_line.qty, v_onhand_rate,
       -v_line_cogs, 'sales_invoice', p_invoice_id);
  end loop;

  v_raw_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total;
  v_grand_total := round(v_raw_total);
  v_round_off := v_grand_total - v_raw_total;

  if abs(v_round_off) > 0.50 then
    raise exception 'DN_UNBALANCED';
  end if;

  -- Credit limit: 0 means unlimited (unset). Balance = net Dr on the party's AR control lines.
  if v_party.credit_limit > 0 then
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
    values (v_entry_id, v_line_no, v_inventory_id, 0, v_cogs_total);
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

  -- 8. Audit
  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'post', 'sales_invoices', p_invoice_id,
          jsonb_build_object('invoice_no', v_doc_no, 'entry_id', v_entry_id,
            'grand_total', v_grand_total, 'override', v_credit_overridden));

  return v_entry_id;
end;
$$;

-- service_role is deliberately not granted here: verified live that under a service-role
-- session auth.uid() is NULL, so this grant would be a dead path that can never succeed —
-- misleading rather than harmless (a change-07 server action reaching for the service client
-- here, the instinct for a "trusted" call, would get an opaque DN_FORBIDDEN that looks like an
-- auth bug rather than a client-choice bug). Every caller of this function must be a
-- user-scoped session carrying the actor's own JWT — see the daksh-api skill.
revoke all on function public.post_sales_invoice(uuid, bool) from public, anon, service_role;
grant execute on function public.post_sales_invoice(uuid, bool) to authenticated;

-- ============================================================
-- cancel_document: admin-only (spec: general/counter staff "no cancellations"). This change
-- implements the sales_invoice branch only; changes 04/05/20 add their own document types as
-- further IF branches in the same function (CREATE OR REPLACE), not a rewrite.
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
    -- Lock order (same fixed order post_sales_invoice uses — required of "every posting
    -- function", and this branch is the body change 04 extends with a purchase_invoice branch
    -- that decrements stock on reversal, so the protocol has to be right here now):
    -- (1) document, (2) party, (3) every item touched, ascending id.
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

    if exists (
      select 1 from payment_allocations
      where invoice_type = 'sales_invoice' and invoice_id = p_source_id
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
  else
    raise exception 'DN_VALIDATION:unsupported_source';
  end if;

  return v_entry_id;
end;
$$;

-- service_role not granted here either — same dead-path reasoning as post_sales_invoice above.
revoke all on function public.cancel_document(source_type, uuid, text) from public, anon, service_role;
grant execute on function public.cancel_document(source_type, uuid, text) to authenticated;

revoke all on function public.stock_on_hand(uuid, uuid) from public, anon;
grant execute on function public.stock_on_hand(uuid, uuid) to authenticated, service_role;
