-- Change 06: read-views.
--
-- db-architecture spec: "Requirement: Views (read model)", "Implementation clarifications ->
-- Views (change 06)", "bank_statements + bank_statement_lines", "parties (columns added)",
-- "interest on overdue", "v_attention (dashboard feed)", "Fiscal-year rollover".
--
-- Plain SQL views over the posted ledger. Nothing here writes, stores a derivable number, or is
-- materialised. Every view is `WITH (security_invoker = true)`, so the caller's own RLS applies to
-- the base tables (a non-member reads nothing); the three admin-only views add
-- `(select current_app_role()) = 'admin'` so a `user` gets zero rows rather than an error.
--
-- Deferred (see implementation-notes.md): GSTR views (change 18), v_rebate_tracker (Phase 2).
--
-- Sections:
--   1. Schema: parties.interest_rate_pm, bank_statements, bank_statement_lines (+ RLS)
--   2. Internal helper views: v_document_refs, v_open_sales_invoices
--   3. Ledger views: v_trial_balance, v_pnl, v_balance_sheet, v_day_book
--   4. Party views: v_party_ledger, v_party_balances, v_party_interest, v_party_aging
--   5. Stock views: v_stock_summary(_all), v_stock_ledger(_all)
--   6. v_employee_ledger, v_bank_recon
--   7. v_attention
--   8. Grants

-- ============================================================
-- 1. Schema
-- ============================================================

-- "% per month on overdue". 0 = this party is never charged interest. whatsapp_phone and
-- default_site_id from the same spec paragraph belong to change 09 (masters) and are NOT added.
alter table parties
  add column interest_rate_pm numeric(5,2) not null default 0 check (interest_rate_pm >= 0);

-- Phase 2 owns import and matching; nothing writes these tables yet. They exist so v_bank_recon
-- can. RLS: active members read, admin writes.
create table bank_statements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_id uuid not null references accounts (id),
  period_from date not null,
  period_to date not null,
  imported_by uuid references auth.users (id),
  imported_at timestamptz not null default now(),
  source_file text,
  check (period_to >= period_from)
);

create table bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  statement_id uuid not null references bank_statements (id) on delete cascade,
  txn_date date not null,
  narration text,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  -- Running balance the bank printed after this line; NULL when the statement has none.
  balance numeric(14,2),
  matched_payment_id uuid references payments (id),
  matched_entry_id uuid references journal_entries (id),
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','auto','manual','ignored'))
);

create index on bank_statements (account_id, period_to desc);
create index on bank_statement_lines (statement_id, match_status);

alter table bank_statements enable row level security;
alter table bank_statement_lines enable row level security;

create policy select_active_members on bank_statements for select using (is_active_member());
create policy select_active_members on bank_statement_lines for select using (is_active_member());

create policy admin_insert on bank_statements for insert
  with check (current_app_role() = 'admin');
create policy admin_update on bank_statements for update
  using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
create policy admin_delete on bank_statements for delete
  using (current_app_role() = 'admin');

create policy admin_insert on bank_statement_lines for insert
  with check (current_app_role() = 'admin');
create policy admin_update on bank_statement_lines for update
  using (current_app_role() = 'admin') with check (current_app_role() = 'admin');
create policy admin_delete on bank_statement_lines for delete
  using (current_app_role() = 'admin');

-- TRUNCATE ignores RLS and Supabase's default privileges hand it to authenticated and
-- service_role on every new table. Nothing legitimate truncates a bank statement; take it (and
-- REFERENCES/TRIGGER) away. INSERT/UPDATE/DELETE stay, because the admin-only write policies above
-- are how Phase 2's importer will work; RLS gates them.
revoke truncate, references, trigger on bank_statements, bank_statement_lines
  from authenticated, service_role;

-- ============================================================
-- 2. Internal helper views (not part of the app contract; shared by several views below)
-- ============================================================

-- One row per document that can be a journal/stock source, so ledgers can show a human reference
-- without each view repeating a ten-way join. Reads the live document header: `doc_no` is the
-- number assigned at posting and never changes afterwards.
create view v_document_refs with (security_invoker = true) as
select 'sales_invoice'::source_type as source_type, id as source_id,
       invoice_no as doc_no, invoice_date as doc_date
from sales_invoices
union all
select 'purchase_invoice'::source_type, id, invoice_no, invoice_date from purchase_invoices
union all
select 'credit_note'::source_type, id, note_no, note_date from credit_notes
union all
select 'debit_note'::source_type, id, note_no, note_date from debit_notes
union all
select 'payment'::source_type, id, voucher_no, payment_date from payments
union all
select 'expense_voucher'::source_type, id, voucher_no, voucher_date from expense_vouchers
union all
select 'delivery_challan'::source_type, id, challan_no, challan_date from delivery_challans
union all
select 'stock_transfer'::source_type, id, transfer_no, transfer_date from stock_transfers
union all
select 'stock_adjustment'::source_type, id, adj_no, adj_date from stock_adjustments
union all
-- A day close has no number series; its reference is the date it closed.
select 'day_close'::source_type, id, 'Day close ' || to_char(close_date, 'DD-MM-YYYY'), close_date
from day_closes;

-- Open sales invoices as of today (organization timezone, never CURRENT_DATE):
--   open = grand_total - allocations of *posted* payments - posted credit notes against the invoice.
-- A draft receipt's allocations do not count (change 04 owner decision); a bounced or cancelled
-- receipt has status 'cancelled' and its allocations are deleted, so it never counts either.
-- v_party_aging and v_party_interest are both built on this, so they cannot disagree.
create view v_open_sales_invoices with (security_invoker = true) as
select
  x.invoice_id, x.party_id, x.invoice_no, x.invoice_date, x.credit_days,
  x.due_date, x.grand_total, x.allocated, x.credit_noted, x.open_amount,
  x.interest_rate_pm, x.as_of,
  (x.as_of - x.invoice_date) as age_days,
  greatest(x.as_of - x.due_date, 0) as overdue_days
from (
  select
    si.id as invoice_id,
    si.party_id,
    si.invoice_no,
    si.invoice_date,
    p.credit_days,
    (si.invoice_date + p.credit_days) as due_date,
    si.grand_total,
    coalesce(al.amount, 0)::numeric(14,2) as allocated,
    -- Join point for change 20: credit_notes exists already but nothing posts one before then.
    coalesce(cn.amount, 0)::numeric(14,2) as credit_noted,
    (si.grand_total - coalesce(al.amount, 0) - coalesce(cn.amount, 0))::numeric(14,2) as open_amount,
    p.interest_rate_pm,
    (now() at time zone (select o.timezone from organization o limit 1))::date as as_of
  from sales_invoices si
  join parties p on p.id = si.party_id
  left join (
    select pa.invoice_id, sum(pa.amount) as amount
    from payment_allocations pa
    join payments pay on pay.id = pa.payment_id and pay.status = 'posted'
    where pa.invoice_type = 'sales_invoice'
    group by pa.invoice_id
  ) al on al.invoice_id = si.id
  left join (
    select c.against_invoice_id, sum(c.grand_total) as amount
    from credit_notes c
    where c.status = 'posted' and c.against_invoice_id is not null
    group by c.against_invoice_id
  ) cn on cn.against_invoice_id = si.id
  where si.status = 'posted'
) x
where x.open_amount > 0;

-- ============================================================
-- 3. Ledger views
-- ============================================================

-- Trial balance, all-time, one row per leaf account (zero-balance accounts included).
-- closing = total_debit - total_credit; `side` is the side that closing falls on, `natural_side`
-- the side the account type normally carries. Admin-only.
create view v_trial_balance with (security_invoker = true) as
select
  a.id as account_id,
  a.code,
  a.name,
  a.type as account_type,
  a.system_key,
  coalesce(t.total_debit, 0)::numeric(14,2) as total_debit,
  coalesce(t.total_credit, 0)::numeric(14,2) as total_credit,
  (coalesce(t.total_debit, 0) - coalesce(t.total_credit, 0))::numeric(14,2) as closing,
  case
    when coalesce(t.total_debit, 0) > coalesce(t.total_credit, 0) then 'debit'
    when coalesce(t.total_debit, 0) < coalesce(t.total_credit, 0) then 'credit'
  end as side,
  case when a.type in ('asset', 'expense') then 'debit' else 'credit' end as natural_side
from accounts a
left join (
  select jl.account_id, sum(jl.debit) as total_debit, sum(jl.credit) as total_credit
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  group by jl.account_id
) t on t.account_id = a.id
where not a.is_group
  and (select current_app_role()) = 'admin';

-- Profit and loss: income and expense accounts by entry_date. The view takes no parameters; the
-- app sums over whatever range it wants (`entry_date`, `month`, `fy_label` are all exposed).
--   amount        = the account's own natural-side movement (income: credit-debit; expense: debit-credit)
--   profit_effect = credit - debit, i.e. + raises profit, - lowers it, for either type
-- Reversals are ordinary lines, so a cancelled invoice nets to nothing here. Admin-only.
create view v_pnl with (security_invoker = true) as
select
  g.account_id, g.code, g.name, g.account_type, g.system_key,
  g.entry_date,
  date_trunc('month', g.entry_date)::date as month,
  (g.fy_start || '-' || right((g.fy_start + 1)::text, 2)) as fy_label,
  g.total_debit, g.total_credit,
  (case when g.account_type = 'income' then g.total_credit - g.total_debit
        else g.total_debit - g.total_credit end)::numeric(14,2) as amount,
  (g.total_credit - g.total_debit)::numeric(14,2) as profit_effect
from (
  select
    a.id as account_id, a.code, a.name, a.type as account_type, a.system_key,
    je.entry_date,
    case when extract(month from je.entry_date) >= 4
         then extract(year from je.entry_date)::int
         else extract(year from je.entry_date)::int - 1 end as fy_start,
    sum(jl.debit)::numeric(14,2) as total_debit,
    sum(jl.credit)::numeric(14,2) as total_credit
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where a.type in ('income', 'expense')
  group by a.id, a.code, a.name, a.type, a.system_key, je.entry_date
) g
where (select current_app_role()) = 'admin';

-- Balance sheet: asset/liability/equity accounts by entry_date, `amount` on the account's natural
-- side (assets debit-credit; liabilities and equity credit-debit), plus one synthetic equity row
-- per entry_date carrying the P&L profit so the sheet balances:
--   sum(asset) = sum(liability) + sum(equity incl. the profit rows)
-- as of any date, by filtering entry_date <= that date. Phase 1 never posts a year-end closing
-- entry, so the profit rows are cumulative since the books began, not just the current year.
-- Admin-only.
create view v_balance_sheet with (security_invoker = true) as
select
  b.section, b.account_id, b.code, b.name, b.entry_date,
  date_trunc('month', b.entry_date)::date as month,
  b.amount, b.is_current_profit
from (
  select
    a.type::text as section,
    a.id as account_id,
    a.code,
    a.name,
    je.entry_date,
    (case when a.type = 'asset' then sum(jl.debit) - sum(jl.credit)
          else sum(jl.credit) - sum(jl.debit) end)::numeric(14,2) as amount,
    false as is_current_profit
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where a.type in ('asset', 'liability', 'equity')
  group by a.type, a.id, a.code, a.name, je.entry_date
  union all
  select
    'equity'::text,
    null::uuid,
    null::text,
    'Profit / (loss) not yet closed to equity'::text,
    je.entry_date,
    (sum(jl.credit) - sum(jl.debit))::numeric(14,2),
    true
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where a.type in ('income', 'expense')
  group by je.entry_date
) b
where (select current_app_role()) = 'admin';

-- Day book: every posted entry, newest-agnostic (the app orders and filters by entry_date).
-- A reversal (cancellation, cheque bounce) is its own row, flagged is_reversal; the entry it
-- reversed is flagged is_reversed. total_debit = total_credit (entries are balanced).
create view v_day_book with (security_invoker = true) as
select
  je.entry_date,
  je.entry_no,
  je.id as entry_id,
  je.source_type,
  je.source_id,
  d.doc_no,
  je.narration,
  t.total_debit,
  t.line_count,
  (je.id in (select r.reversed_by from journal_entries r where r.reversed_by is not null)) as is_reversal,
  (je.reversed_by is not null) as is_reversed,
  je.reversed_by,
  je.posted_by,
  je.posted_at
from journal_entries je
join (
  select entry_id, sum(debit)::numeric(14,2) as total_debit, count(*)::int as line_count
  from journal_lines
  group by entry_id
) t on t.entry_id = je.id
left join v_document_refs d on d.source_type = je.source_type and d.source_id = je.source_id
where je.status = 'posted';

-- ============================================================
-- 4. Party views
-- ============================================================

-- Party ledger: lines on the AR / AP control accounts only (employee accounts belong to
-- v_employee_ledger). `account_key` says which. running_balance is per (party, account) in the
-- "owed" sense: AR = debit - credit (positive = party owes us), AP = credit - debit (positive =
-- we owe them). Reversals are their own rows.
create view v_party_ledger with (security_invoker = true) as
select
  jl.party_id,
  p.name as party_name,
  p.type as party_type,
  a.system_key as account_key,
  je.entry_date,
  je.id as entry_id,
  je.entry_no,
  jl.id as line_id,
  jl.line_no,
  je.source_type,
  je.source_id,
  d.doc_no,
  je.narration,
  (je.id in (select r.reversed_by from journal_entries r where r.reversed_by is not null)) as is_reversal,
  jl.debit,
  jl.credit,
  (sum(case when a.system_key = 'ar' then jl.debit - jl.credit else jl.credit - jl.debit end)
     over (partition by jl.party_id, a.system_key
           order by je.entry_date, je.entry_no, jl.line_no, jl.id))::numeric(14,2) as running_balance
from journal_lines jl
join accounts a on a.id = jl.account_id and a.system_key in ('ar', 'ap')
join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
join parties p on p.id = jl.party_id
left join v_document_refs d on d.source_type = je.source_type and d.source_id = je.source_id
where jl.party_id is not null;

-- One row per customer/supplier/both party. ar_balance = what they owe us, ap_balance = what we
-- owe them, both from the control-account lines. `balance` follows the party type: customer ->
-- ar_balance, supplier -> ap_balance, both -> ar_balance - ap_balance (positive = they owe us).
-- Employee parties are not here (v_employee_ledger).
create view v_party_balances with (security_invoker = true) as
select
  p.id as party_id,
  p.name as party_name,
  p.type as party_type,
  p.is_active,
  coalesce(b.ar_balance, 0)::numeric(14,2) as ar_balance,
  coalesce(b.ap_balance, 0)::numeric(14,2) as ap_balance,
  (coalesce(b.ar_balance, 0) - coalesce(b.ap_balance, 0))::numeric(14,2) as net_balance,
  (case p.type
     when 'customer' then coalesce(b.ar_balance, 0)
     when 'supplier' then coalesce(b.ap_balance, 0)
     else coalesce(b.ar_balance, 0) - coalesce(b.ap_balance, 0)
   end)::numeric(14,2) as balance
from parties p
left join (
  select
    jl.party_id,
    sum(jl.debit - jl.credit) filter (where a.system_key = 'ar') as ar_balance,
    sum(jl.credit - jl.debit) filter (where a.system_key = 'ap') as ap_balance
  from journal_lines jl
  join accounts a on a.id = jl.account_id and a.system_key in ('ar', 'ap')
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  where jl.party_id is not null
  group by jl.party_id
) b on b.party_id = p.id
where p.type in ('customer', 'supplier', 'both');

-- Interest on overdue, per open invoice past its credit days. Computed, never posted; posting is
-- a manual admin debit note against interest_income. rate 0 -> interest 0.
--   interest = open_amount x interest_rate_pm/100 x (overdue_days/30), rounded to 2.
create view v_party_interest with (security_invoker = true) as
select
  o.party_id,
  p.name as party_name,
  o.invoice_id,
  o.invoice_no,
  o.invoice_date,
  o.credit_days,
  o.due_date,
  o.open_amount,
  o.overdue_days,
  round(o.overdue_days::numeric / 30, 4)::numeric(10,4) as overdue_months,
  o.interest_rate_pm,
  round(o.open_amount * o.interest_rate_pm / 100 * o.overdue_days / 30, 2)::numeric(14,2) as interest
from v_open_sales_invoices o
join parties p on p.id = o.party_id
where o.overdue_days > 0;

-- Ageing of open sales invoices per party. Buckets are days since the *invoice date* (not the due
-- date): 0-30 / 31-60 / 61-90 / 90+. On-account receipts are not netted into the buckets:
--   unallocated      = posted receipt cash (amount) not tied to any invoice
--   unapplied_discount = the part of a posted receipt's cash discount not tied to any invoice.
--                      A receipt's allocations may total amount + discount (migration
--                      20260919130000), and they consume the cash first, so a receipt of 900 + 100
--                      discount allocated 1,000 to an invoice leaves unallocated = 0 and
--                      unapplied_discount = 0; allocated only 900 it leaves unapplied_discount =
--                      100. Per receipt: unallocated = max(amount - allocated, 0),
--                      unapplied_discount = discount - max(allocated - amount, 0).
--   other_ar         = whatever the AR control account holds that invoices and receipts don't
--                      explain (opening balances, manual journals, credit notes not tied to an
--                      invoice). For a party with only posted documents it is 0, i.e.
--                      open_total - unallocated - unapplied_discount + other_ar = ar_balance.
-- interest = accrued interest on the overdue part (from v_party_interest).
create view v_party_aging with (security_invoker = true) as
select
  p.id as party_id,
  p.name as party_name,
  p.type as party_type,
  coalesce(o.bucket_0_30, 0)::numeric(14,2) as bucket_0_30,
  coalesce(o.bucket_31_60, 0)::numeric(14,2) as bucket_31_60,
  coalesce(o.bucket_61_90, 0)::numeric(14,2) as bucket_61_90,
  coalesce(o.bucket_90_plus, 0)::numeric(14,2) as bucket_90_plus,
  coalesce(o.open_total, 0)::numeric(14,2) as open_total,
  coalesce(r.unallocated, 0)::numeric(14,2) as unallocated,
  coalesce(r.unapplied_discount, 0)::numeric(14,2) as unapplied_discount,
  coalesce(i.interest, 0)::numeric(14,2) as interest,
  coalesce(l.ar_balance, 0)::numeric(14,2) as ar_balance,
  (coalesce(l.ar_balance, 0)
     - (coalesce(o.open_total, 0) - coalesce(r.unallocated, 0) - coalesce(r.unapplied_discount, 0))
  )::numeric(14,2) as other_ar
from parties p
left join (
  select
    party_id,
    sum(open_amount) filter (where age_days <= 30) as bucket_0_30,
    sum(open_amount) filter (where age_days between 31 and 60) as bucket_31_60,
    sum(open_amount) filter (where age_days between 61 and 90) as bucket_61_90,
    sum(open_amount) filter (where age_days > 90) as bucket_90_plus,
    sum(open_amount) as open_total
  from v_open_sales_invoices
  group by party_id
) o on o.party_id = p.id
left join (
  select
    pay.party_id,
    sum(greatest(pay.amount - coalesce(al.amount, 0), 0)) as unallocated,
    sum(pay.discount - greatest(coalesce(al.amount, 0) - pay.amount, 0)) as unapplied_discount
  from payments pay
  left join (
    select payment_id, sum(amount) as amount from payment_allocations group by payment_id
  ) al on al.payment_id = pay.id
  where pay.direction = 'receipt' and pay.status = 'posted'
  group by pay.party_id
) r on r.party_id = p.id
left join (
  select party_id, sum(interest) as interest from v_party_interest group by party_id
) i on i.party_id = p.id
left join (
  select jl.party_id, sum(jl.debit - jl.credit) as ar_balance
  from journal_lines jl
  join accounts a on a.id = jl.account_id and a.system_key = 'ar'
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  where jl.party_id is not null
  group by jl.party_id
) l on l.party_id = p.id
where coalesce(o.open_total, 0) <> 0
   or coalesce(r.unallocated, 0) <> 0
   or coalesce(r.unapplied_discount, 0) <> 0
   or coalesce(l.ar_balance, 0) <> 0;

-- ============================================================
-- 5. Stock views
-- ============================================================

-- The `_all` variants include the hidden In Transit warehouse (is_transit = true); the plain
-- variants exclude it. Value in transit is still in the Inventory account (a transfer posts no
-- journal entry), so it is the `_all` total that reconciles with the Inventory GL balance.
create view v_stock_summary_all with (security_invoker = true) as
select
  m.item_id,
  i.name as item_name,
  i.category,
  i.base_uom,
  m.warehouse_id,
  w.name as warehouse_name,
  w.is_transit,
  sum(m.qty)::numeric(12,3) as qty,
  (case when sum(m.qty) = 0 then 0 else round(sum(m.value) / sum(m.qty), 4) end)::numeric(14,4) as avg_rate,
  sum(m.value)::numeric(14,2) as value
from stock_movements m
join items i on i.id = m.item_id
join warehouses w on w.id = m.warehouse_id
group by m.item_id, i.name, i.category, i.base_uom, m.warehouse_id, w.name, w.is_transit;

create view v_stock_summary with (security_invoker = true) as
select * from v_stock_summary_all where not is_transit;

-- Every movement with running qty/value per item x warehouse. Movements share a created_at when
-- posted in one transaction, so the id breaks the tie; the *final* running figures are exact
-- either way, intermediate ones within one posting are not meaningful.
create view v_stock_ledger_all with (security_invoker = true) as
select
  m.item_id,
  i.name as item_name,
  m.warehouse_id,
  w.name as warehouse_name,
  w.is_transit,
  m.id as movement_id,
  m.movement_date,
  m.source_type,
  m.source_id,
  d.doc_no,
  (m.reversal_of is not null) as is_reversal,
  m.qty,
  m.rate,
  m.value,
  (row_number() over (partition by m.item_id, m.warehouse_id
                      order by m.movement_date, m.created_at, m.id))::int as seq,
  (sum(m.qty) over (partition by m.item_id, m.warehouse_id
                    order by m.movement_date, m.created_at, m.id))::numeric(12,3) as running_qty,
  (sum(m.value) over (partition by m.item_id, m.warehouse_id
                      order by m.movement_date, m.created_at, m.id))::numeric(14,2) as running_value
from stock_movements m
join items i on i.id = m.item_id
join warehouses w on w.id = m.warehouse_id
left join v_document_refs d on d.source_type = m.source_type and d.source_id = m.source_id;

create view v_stock_ledger with (security_invoker = true) as
select * from v_stock_ledger_all where not is_transit;

-- ============================================================
-- 6. Employee ledger, bank reconciliation
-- ============================================================

-- Lines on employee_advance and salary_payable, per employee, with running balances:
--   advance_balance = Σ(debit - credit) on employee_advance  (positive = employee owes us)
--   payable_balance = Σ(credit - debit) on salary_payable    (positive = we owe the employee)
-- Lines that come from an expense voucher carry its voucher_type and period_month (the month a
-- salary/wage is for), so the app can group by pay period.
create view v_employee_ledger with (security_invoker = true) as
select
  jl.party_id,
  p.name as party_name,
  a.system_key as account_key,
  je.entry_date,
  je.id as entry_id,
  je.entry_no,
  jl.id as line_id,
  jl.line_no,
  je.source_type,
  je.source_id,
  d.doc_no,
  ev.voucher_type,
  ev.period_month,
  je.narration,
  jl.debit,
  jl.credit,
  -- coalesce: a filtered window sum is NULL until the first matching line, but "no advance yet"
  -- is a balance of 0, not unknown.
  coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'employee_advance')
     over (partition by jl.party_id
           order by je.entry_date, je.entry_no, jl.line_no, jl.id), 0)::numeric(14,2) as advance_balance,
  coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'salary_payable')
     over (partition by jl.party_id
           order by je.entry_date, je.entry_no, jl.line_no, jl.id), 0)::numeric(14,2) as payable_balance
from journal_lines jl
join accounts a on a.id = jl.account_id and a.system_key in ('employee_advance', 'salary_payable')
join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
join parties p on p.id = jl.party_id
left join v_document_refs d on d.source_type = je.source_type and d.source_id = je.source_id
left join expense_vouchers ev on je.source_type = 'expense_voucher' and ev.id = je.source_id
where jl.party_id is not null;

-- Book balance of each bank ledger (an is_money account that is not the cash box) against the
-- closing balance of its latest statement. bank_balance is NULL until a statement with a printed
-- balance exists; difference is NULL with it. closing_balance_ambiguous = true when the lines on
-- the statement's last day carry different balances that the running order cannot settle (see the
-- comment inside). book_balance is the ledger as of the statement's period_to (entry_date <=
-- period_to) so it is comparable with bank_balance and later postings cannot move `difference`;
-- with no statement it is the balance as of today. book_balance_today is always the balance as of
-- today.
create view v_bank_recon with (security_invoker = true) as
select
  a.id as account_id,
  a.code,
  a.name,
  (case when ls.statement_id is null then ba.book_today else ba.book_asof end)::numeric(14,2) as book_balance,
  ba.book_today::numeric(14,2) as book_balance_today,
  ls.statement_id,
  ls.period_to as statement_period_to,
  ls.closing_balance as bank_balance,
  coalesce(ls.closing_balance_ambiguous, false) as closing_balance_ambiguous,
  (case when ls.closing_balance is null then null
        else ba.book_asof - ls.closing_balance end)::numeric(14,2) as difference,
  coalesce(u.unmatched_lines, 0)::int as unmatched_lines
from accounts a
left join lateral (
  select
    s.id as statement_id,
    s.period_to,
    c.closing_balance,
    c.closing_balance_ambiguous
  from bank_statements s
  cross join lateral (
    -- Closing balance of the statement. Normally the balance on the line with the greatest
    -- (txn_date, created_at, id). That is only trustworthy when the lines on the last txn_date
    -- agree, because a bank statement carries no line sequence: two lines on the last day tie on
    -- txn_date and, imported in one batch, on created_at. So:
    --   * one distinct balance on the last day            -> that balance, not ambiguous;
    --   * several, exactly one of which is "terminal"     -> the terminal one, not ambiguous.
    --     A line is terminal when the running order supports it as the last line of the day:
    --     some other line's balance - this.debit + this.credit = this.balance (something
    --     precedes it), and no other last-day line follows it the same way;
    --   * several, no unique terminal line                -> ambiguous; the (created_at, id)
    --     pick is shown but closing_balance_ambiguous = true so the app flags it.
    with last_day as (
      select l.*
      from bank_statement_lines l
      where l.statement_id = s.id and l.balance is not null
        and l.txn_date = (select max(l2.txn_date) from bank_statement_lines l2
                          where l2.statement_id = s.id and l2.balance is not null)
    ),
    terminal as (
      select d.*
      from last_day d
      where exists (select 1 from bank_statement_lines p
                    where p.statement_id = s.id and p.balance is not null and p.id <> d.id
                      and p.balance - d.debit + d.credit = d.balance)
        and not exists (select 1 from last_day q
                        where q.id <> d.id and d.balance - q.debit + q.credit = q.balance)
    )
    select
      (case
         when (select count(distinct balance) from last_day) <= 1
           then (select max(balance) from last_day)
         when (select count(distinct balance) from terminal) = 1
           then (select max(balance) from terminal)
         else (select balance from last_day order by created_at desc, id desc limit 1)
       end) as closing_balance,
      ((select count(distinct balance) from last_day) > 1
        and (select count(distinct balance) from terminal) <> 1) as closing_balance_ambiguous
  ) c
  where s.account_id = a.id
  order by s.period_to desc, s.imported_at desc, s.id desc
  limit 1
) ls on true
left join lateral (
  select
    coalesce(sum(jl.debit - jl.credit), 0) as book_today,
    coalesce(sum(jl.debit - jl.credit) filter (where je.entry_date <= ls.period_to), 0) as book_asof
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  where jl.account_id = a.id
) ba on true
left join (
  select s.account_id, count(*) as unmatched_lines
  from bank_statement_lines l
  join bank_statements s on s.id = l.statement_id
  where l.match_status = 'unmatched'
  group by s.account_id
) u on u.account_id = a.id
where a.is_money and not a.is_group and a.system_key is distinct from 'cash';

-- ============================================================
-- 7. v_attention: one row per thing that needs a person
-- ============================================================
-- Columns: kind, severity (critical|warning|info), subject_type, subject_id, title, detail,
-- due_date (the date the thing became/becomes due), amount, interest (overdue_party only).
-- Kinds: overdue_party, low_stock, cheque_due, stale_challan, challan_possible_duplicate,
-- transfer_in_transit, day_close_difference, gst_due, create_fy_periods.
-- "Today" is (now() AT TIME ZONE organization.timezone)::date, never CURRENT_DATE.
-- Admin-only kinds (gst_due, create_fy_periods) are filtered by current_app_role().

create view v_attention with (security_invoker = true) as
with t as (
  select (now() at time zone o.timezone)::date as today from organization o limit 1
)
-- Overdue parties: any open invoice past its credit days, with the interest accrued so far.
select
  'overdue_party'::text as kind,
  (case when max(i.overdue_days) > 30 then 'critical' else 'warning' end)::text as severity,
  'party'::text as subject_type,
  i.party_id as subject_id,
  ('Overdue: ' || i.party_name)::text as title,
  (count(*) || ' invoice(s) overdue, oldest ' || max(i.overdue_days) || ' days past due')::text as detail,
  min(i.due_date) as due_date,
  sum(i.open_amount)::numeric(14,2) as amount,
  sum(i.interest)::numeric(14,2) as interest
from v_party_interest i
group by i.party_id, i.party_name

union all
-- Items below their reorder level (on-hand summed over real godowns; goods in the lorry are not
-- sellable).
select
  'low_stock', (case when coalesce(s.qty, 0) <= 0 then 'critical' else 'warning' end),
  'item', it.id,
  'Low stock: ' || it.name,
  'On hand ' || coalesce(s.qty, 0)::text || ' ' || it.base_uom
    || ', reorder level ' || it.reorder_level::text,
  null::date, null::numeric(14,2), null::numeric(14,2)
from items it
left join (
  select m.item_id, sum(m.qty) as qty
  from stock_movements m
  join warehouses w on w.id = m.warehouse_id and not w.is_transit
  group by m.item_id
) s on s.item_id = it.id
where it.is_active and it.is_stock and it.reorder_level > 0
  and coalesce(s.qty, 0) < it.reorder_level

union all
-- Cheques falling due within 3 days (or already past): received and not yet deposited, or issued
-- and not yet presented. A cheque with no instrument_date has no due date and is not listed.
select
  'cheque_due', (case when p.instrument_date < t.today then 'critical' else 'warning' end),
  'payment', p.id,
  (case p.cheque_status when 'in_hand' then 'Cheque to deposit: ' else 'Cheque we issued falls due: ' end
     || pt.name),
  'Cheque ' || coalesce(p.instrument_no, '(no number)') || ' dated '
    || to_char(p.instrument_date, 'DD-MM-YYYY'),
  p.instrument_date, p.amount, null::numeric(14,2)
from payments p
join parties pt on pt.id = p.party_id
cross join t
where p.status = 'posted' and p.mode = 'cheque'
  and p.cheque_status in ('in_hand', 'issued')
  and p.instrument_date is not null
  and p.instrument_date <= t.today + 3

union all
-- Posted challans not invoiced 7+ days on (due = challan date + 7).
select
  'stale_challan', 'warning',
  'delivery_challan', dc.id,
  'Challan not invoiced: ' || dc.challan_no,
  pt.name || ', ' || (t.today - dc.challan_date) || ' days since dispatch',
  dc.challan_date + 7,
  coalesce((select sum(l.value) from delivery_challan_lines l where l.challan_id = dc.id), 0)::numeric(14,2),
  null::numeric(14,2)
from delivery_challans dc
join parties pt on pt.id = dc.party_id
cross join t
where dc.status = 'posted' and dc.invoice_id is null
  and t.today - dc.challan_date > 7

union all
-- A posted, un-invoiced challan whose goods may have been dispatched or billed a second time:
-- for the same party and one of its items, a later-or-same-day posted challan, or a posted sales
-- invoice that is not linked to any challan, covers at least that quantity. Deliberately simple
-- and conservative (same party + same item + on/after the challan date + quantity >= the
-- challan's); a warning only, never a block. It cannot see a resale split over several smaller
-- documents. It clears itself when the challan is invoiced or cancelled, or when the other
-- document is cancelled.
select
  'challan_possible_duplicate', 'warning',
  'delivery_challan', dc.id,
  'Challan may be double-counted: ' || dc.challan_no,
  pt.name || ': a later challan or an invoice not linked to a challan covers the same goods; '
    || 'check they were not dispatched or billed twice',
  dc.challan_date,
  coalesce((select sum(l.value) from delivery_challan_lines l where l.challan_id = dc.id), 0)::numeric(14,2),
  null::numeric(14,2)
from delivery_challans dc
join parties pt on pt.id = dc.party_id
where dc.status = 'posted' and dc.invoice_id is null
  and exists (
    select 1 from delivery_challan_lines cl
    where cl.challan_id = dc.id
      and (
        exists (select 1
                from delivery_challans c2
                join delivery_challan_lines l2 on l2.challan_id = c2.id
                where c2.id <> dc.id and c2.status = 'posted' and c2.party_id = dc.party_id
                  and c2.challan_date >= dc.challan_date
                  and l2.item_id = cl.item_id and l2.qty >= cl.qty)
        or exists (select 1
                   from sales_invoices si
                   join sales_invoice_lines sl on sl.invoice_id = si.id
                   where si.status = 'posted' and si.challan_id is null
                     and si.party_id = dc.party_id
                     and si.invoice_date >= dc.challan_date
                     and sl.item_id = cl.item_id and sl.qty >= cl.qty)
      )
  )

union all
-- Stock transfers still in transit more than 2 days after dispatch (due = dispatch date + 2).
select
  'transfer_in_transit', 'warning',
  'stock_transfer', tr.id,
  'Transfer in transit: ' || tr.transfer_no,
  fw.name || ' to ' || tw.name || ', ' || (t.today - tr.transfer_date) || ' days on the road',
  tr.transfer_date + 2, null::numeric(14,2), null::numeric(14,2)
from stock_transfers tr
join warehouses fw on fw.id = tr.from_warehouse_id
join warehouses tw on tw.id = tr.to_warehouse_id
cross join t
where tr.status = 'in_transit' and t.today - tr.transfer_date > 2

union all
-- Yesterday's day close was short or over.
select
  'day_close_difference', 'warning',
  'day_close', dcl.id,
  'Day close difference on ' || to_char(dcl.close_date, 'DD-MM-YYYY'),
  'Counted vs expected cash differs',
  dcl.close_date, dcl.difference, null::numeric(14,2)
from day_closes dcl
cross join t
where dcl.status = 'posted' and dcl.close_date = t.today - 1 and dcl.difference <> 0

union all
-- GST return due dates (admin). No "filed" flag exists in Phase 1, so this shows the next
-- GSTR-1 (11th) / GSTR-3B (20th) falling within 7 days, and only when the month being reported
-- had posted sales.
select
  'gst_due',
  (case when f.due_date - t.today <= 3 then 'warning' else 'info' end),
  'gst_return', null::uuid,
  f.form || ' due ' || to_char(f.due_date, 'DD-MM-YYYY'),
  'For ' || to_char(f.return_month, 'Mon YYYY') || ' sales',
  f.due_date, null::numeric(14,2), null::numeric(14,2)
from t
cross join lateral (
  select fm.form, d.due_date, (date_trunc('month', d.due_date) - interval '1 month')::date as return_month
  from (values ('GSTR-1', 11), ('GSTR-3B', 20)) as fm(form, due_day)
  cross join lateral (
    values ((date_trunc('month', t.today))::date + fm.due_day - 1),
           ((date_trunc('month', t.today) + interval '1 month')::date + fm.due_day - 1)
  ) as d(due_date)
) f
where (select current_app_role()) = 'admin'
  and f.due_date between t.today and t.today + 7
  and exists (
    select 1 from sales_invoices si
    where si.status = 'posted'
      and si.invoice_date >= f.return_month
      and si.invoice_date < (f.return_month + interval '1 month')::date
  )

union all
-- From 1 March: next April's fiscal period is missing, so posting would block on 1 April (admin).
select
  'create_fy_periods',
  (case when t.today >= x.april - 7 then 'critical' else 'warning' end),
  'fiscal_period', null::uuid,
  'Create FY ' || extract(year from x.april)::int || '-'
    || right((extract(year from x.april)::int + 1)::text, 2) || ' periods',
  'No fiscal period exists for April ' || extract(year from x.april)::int
    || '; posting is blocked in any month without one',
  x.april, null::numeric(14,2), null::numeric(14,2)
from t
cross join lateral (
  select (case when extract(month from t.today) >= 4
               then make_date(extract(year from t.today)::int + 1, 4, 1)
               else make_date(extract(year from t.today)::int, 4, 1) end) as april
) x
where (select current_app_role()) = 'admin'
  and t.today >= (x.april - interval '1 month')::date
  and not exists (select 1 from fiscal_periods fp where fp.month = x.april);

-- ============================================================
-- 8. Grants: SELECT to authenticated only. Default privileges hand every role ALL on a new view
--    (and simple views are auto-updatable), so start from nothing.
-- ============================================================

do $$
declare
  v text;
begin
  foreach v in array array[
    'v_document_refs', 'v_open_sales_invoices',
    'v_trial_balance', 'v_pnl', 'v_balance_sheet', 'v_day_book',
    'v_party_ledger', 'v_party_balances', 'v_party_interest', 'v_party_aging',
    'v_stock_summary_all', 'v_stock_summary', 'v_stock_ledger_all', 'v_stock_ledger',
    'v_employee_ledger', 'v_bank_recon', 'v_attention'
  ] loop
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;
