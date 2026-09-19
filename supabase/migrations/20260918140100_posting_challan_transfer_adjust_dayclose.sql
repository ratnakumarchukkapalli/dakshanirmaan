-- Change 05: posting-challan-transfer-adjust-dayclose — migration B of two.
--
-- db-architecture spec: "Schema extensions for prototype-v2 features" -> delivery_challans +
-- delivery_challan_lines, stock_transfers + stock_transfer_lines, day_closes +
-- "Implementation clarifications" -> Stock adjustments, Enum extensions, Transit for transfers,
-- Challan -> invoice, Actor and grants + "Non-functional invariants" -> Concurrency and lock
-- ordering, Idempotency, Cancellation edge cases, Time zone.
--
-- Completes the Phase-1 posting engine: delivery challans (goods leave before the invoice
-- exists, value parks in Goods in Transit), the challan -> invoice conversion hook inside
-- post_sales_invoice, warehouse-to-warehouse transfers through a seeded transit warehouse,
-- stock adjustments (shrinkage / gain), and the daily cash-count close.
--
-- Every function copies changes 03/04 exactly: actor derived from auth.uid() inside the
-- function (never a parameter), SECURITY DEFINER + SET search_path = public, pg_temp, lock
-- order document -> party -> items ascending by id -> doc_sequences, a missing fiscal period
-- blocked the same as a locked one, DN_* error codes, exactly one audit_log row,
-- REVOKE ... FROM public, anon, service_role + GRANT EXECUTE ... TO authenticated.
--
-- post_sales_invoice (change 03) and cancel_document (changes 03 + 04) are extended by
-- CREATE OR REPLACE on the same signatures; every pre-existing branch is carried over
-- unchanged apart from the one challan-reopen statement documented in implementation-notes.md.

-- ============================================================
-- 1. Schema: transit warehouse flag, challan/transfer/adjustment/day-close tables
-- ============================================================

-- Credit-limit semantics, fixed by the change-04 review: NULL = unlimited (the default for a new
-- party), 0 = no credit at all. Change 01 had the column NOT NULL DEFAULT 0 and change 03 read 0
-- as "unlimited", which made the one strictly cash-only party — the walk-in customer — the only
-- party that could never trip the check. Existing 0 rows therefore mean "nobody set a limit" and
-- migrate to NULL; the walk-in party keeps its 0, which now means what it says.
alter table parties alter column credit_limit drop not null;
alter table parties alter column credit_limit drop default;
update parties set credit_limit = null where credit_limit = 0 and not is_walk_in;

-- Transit stock is modelled as a seeded system warehouse rather than a per-transfer bucket
-- (Implementation clarifications -> Transit for transfers, which supersedes the extension
-- paragraph's "per-transfer transit bucket" wording). Hidden from pickers by this flag; change
-- 06's v_stock_summary / v_stock_ledger exclude it unless asked.
alter table warehouses add column is_transit bool not null default false;

create table delivery_challans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  challan_no text unique,
  challan_date date not null,
  party_id uuid not null references parties (id),
  -- Challans, transfers and adjustments carry their own warehouse (Implementation
  -- clarifications -> Warehouse on documents).
  warehouse_id uuid not null references warehouses (id),
  site_address jsonb,
  vehicle_no text,
  driver_party_id uuid references parties (id),
  status doc_status not null default 'draft',
  -- Set when the challan is converted; NULLed again if that invoice is cancelled.
  invoice_id uuid,
  journal_entry_id uuid references journal_entries (id)
);

-- Same snapshot shape as sales_invoice_lines minus the tax amounts; `value` is carried for the
-- e-way-bill threshold, which is assessed on the challan before any invoice exists.
create table delivery_challan_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  challan_id uuid not null references delivery_challans (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  hsn_code text not null,
  uom text not null,
  qty numeric(12,3) not null check (qty > 0),
  alt_qty numeric(12,3),
  rate numeric(14,4) not null,
  discount_pct numeric(5,2) not null default 0,
  gst_rate numeric(5,2) not null,
  value numeric(14,2) not null default 0
);

-- Circular reference with sales_invoices, so the FKs are added once both tables exist.
alter table sales_invoices add column challan_id uuid references delivery_challans (id);
alter table delivery_challans
  add constraint delivery_challans_invoice_id_fkey
  foreign key (invoice_id) references sales_invoices (id);

create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  transfer_no text unique,
  transfer_date date not null,
  from_warehouse_id uuid not null references warehouses (id),
  to_warehouse_id uuid not null references warehouses (id),
  vehicle_no text,
  -- Own state machine, not doc_status: a transfer is never "posted", it is in_transit until
  -- the destination godown confirms receipt.
  status text not null default 'draft'
    check (status in ('draft','in_transit','received','cancelled')),
  received_at timestamptz,
  received_by uuid references auth.users (id),
  check (from_warehouse_id <> to_warehouse_id)
);

create table stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  transfer_id uuid not null references stock_transfers (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  uom text not null,
  qty numeric(12,3) not null check (qty > 0)
);

create table stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  adj_no text unique,
  adj_date date not null,
  warehouse_id uuid not null references warehouses (id),
  status doc_status not null default 'draft',
  reason text,
  journal_entry_id uuid references journal_entries (id)
);

create table stock_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  adjustment_id uuid not null references stock_adjustments (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  -- Signed: negative = shrinkage, positive = found stock. NULL rate = value at the current
  -- weighted average (decreases are always valued at the average; see post_stock_adjustment).
  qty numeric(12,3) not null check (qty <> 0),
  rate numeric(14,4)
);

create table day_closes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  close_date date not null,
  opening_cash numeric(14,2) not null default 0,
  cash_in numeric(14,2) not null default 0,
  cash_out numeric(14,2) not null default 0,
  deposited numeric(14,2) not null default 0,
  expected numeric(14,2) not null default 0,
  counted numeric(14,2) not null check (counted >= 0),
  difference numeric(14,2) not null default 0,
  note text,
  closed_by uuid references auth.users (id),
  closed_at timestamptz,
  journal_entry_id uuid references journal_entries (id),
  -- Not in the spec's column list. Reopening a close is specced as admin-only and audit-logged,
  -- which means the row has to survive the reopen (deleting it would destroy the audit trail
  -- the spec asks for). 'cancelled' rows are excluded from the one-per-date uniqueness below so
  -- the date can be closed again after a reopen.
  status doc_status not null default 'posted'
);

-- "close_date date UNIQUE" in the spec, relaxed to exclude reopened (cancelled) closes.
create unique index day_closes_one_per_date
  on day_closes (close_date) where status <> 'cancelled';

-- Indexes for the query paths these tables introduce (see "Indexes (baseline, Phase 1)").
create index on delivery_challans (party_id, challan_date desc);
create index on delivery_challans (status) where status = 'draft';
-- v_attention (change 06): un-invoiced challans older than 7 days.
create index on delivery_challans (challan_date) where invoice_id is null;
create index on delivery_challan_lines (challan_id);
create index on sales_invoices (challan_id) where challan_id is not null;
-- v_attention: transfers in transit for more than 2 days.
create index on stock_transfers (status, transfer_date);
create index on stock_transfer_lines (transfer_id);
create index on stock_adjustments (warehouse_id, adj_date desc);
create index on stock_adjustment_lines (adjustment_id);
create index on day_closes (close_date desc);

-- Draft conflict detection, same as every other document header (change 01).
create trigger touch_updated_at before update on delivery_challans
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on stock_transfers
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on stock_adjustments
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 2. Seeds: transit warehouse + the three new numbering series
-- ============================================================

insert into warehouses (name, is_default, is_transit) values ('In Transit', false, true);

-- Exactly one transit warehouse, ever (review finding 6). post_stock_transfer and
-- receive_stock_transfer both resolve it with `where is_transit limit 1`; a second row would
-- make which bucket a transfer used depend on plan order, and stock could be posted into one
-- and received out of the other. Mirrors change 03's warehouses_one_default index.
create unique index warehouses_one_transit on warehouses (is_transit) where is_transit;

-- Every system_key this change needs — 'inventory' (1300), 'goods_in_transit' (1310),
-- 'stock_loss' (5800), 'cash_over_short' (5900), 'cash' (1110), 'bank' (1120) — was already
-- seeded by change 01's foundation seed. Nothing to add; the posting functions below raise
-- DN_VALIDATION:missing_account if any of them is ever removed.

insert into doc_sequences (series, doc_type, fy_label, prefix, next_no) values
  ('DC',  'delivery_challan',  '2026-27', 'DC/26-27/',  1),
  ('TR',  'stock_transfer',    '2026-27', 'TR/26-27/',  1),
  ('ADJ', 'stock_adjustment',  '2026-27', 'ADJ/26-27/', 1);

-- ============================================================
-- 3. RLS: change 01's pattern — members read, both roles write drafts, posting functions
--    (SECURITY DEFINER) are the only writers of anything posted.
-- ============================================================

alter table delivery_challans enable row level security;
alter table delivery_challan_lines enable row level security;
alter table stock_transfers enable row level security;
alter table stock_transfer_lines enable row level security;
alter table stock_adjustments enable row level security;
alter table stock_adjustment_lines enable row level security;
alter table day_closes enable row level security;

create policy select_active_members on delivery_challans for select using (is_active_member());
create policy select_active_members on delivery_challan_lines for select using (is_active_member());
create policy select_active_members on stock_transfers for select using (is_active_member());
create policy select_active_members on stock_transfer_lines for select using (is_active_member());
create policy select_active_members on stock_adjustments for select using (is_active_member());
create policy select_active_members on stock_adjustment_lines for select using (is_active_member());
create policy select_active_members on day_closes for select using (is_active_member());

create policy insert_draft on delivery_challans for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on delivery_challans for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on delivery_challans for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on stock_transfers for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on stock_transfers for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on stock_transfers for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on stock_adjustments for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on stock_adjustments for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on stock_adjustments for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on delivery_challan_lines for insert
  with check (is_active_member() and exists (
    select 1 from delivery_challans h where h.id = challan_id and h.status = 'draft'
  ));
create policy update_draft on delivery_challan_lines for update
  using (is_active_member() and exists (
    select 1 from delivery_challans h where h.id = challan_id and h.status = 'draft'
  ));
create policy delete_draft on delivery_challan_lines for delete
  using (is_active_member() and exists (
    select 1 from delivery_challans h where h.id = challan_id and h.status = 'draft'
  ));

create policy insert_draft on stock_transfer_lines for insert
  with check (is_active_member() and exists (
    select 1 from stock_transfers h where h.id = transfer_id and h.status = 'draft'
  ));
create policy update_draft on stock_transfer_lines for update
  using (is_active_member() and exists (
    select 1 from stock_transfers h where h.id = transfer_id and h.status = 'draft'
  ));
create policy delete_draft on stock_transfer_lines for delete
  using (is_active_member() and exists (
    select 1 from stock_transfers h where h.id = transfer_id and h.status = 'draft'
  ));

create policy insert_draft on stock_adjustment_lines for insert
  with check (is_active_member() and exists (
    select 1 from stock_adjustments h where h.id = adjustment_id and h.status = 'draft'
  ));
create policy update_draft on stock_adjustment_lines for update
  using (is_active_member() and exists (
    select 1 from stock_adjustments h where h.id = adjustment_id and h.status = 'draft'
  ));
create policy delete_draft on stock_adjustment_lines for delete
  using (is_active_member() and exists (
    select 1 from stock_adjustments h where h.id = adjustment_id and h.status = 'draft'
  ));

-- day_closes gets no INSERT/UPDATE/DELETE policy: post_day_close is its only writer, and a
-- reopen goes through cancel_document. There is no draft stage for a cash count.

-- ============================================================
-- 3b. Table grants (owner decision, review finding on defence in depth)
--     RLS has been the only thing standing between a client role and the ledger. That is one
--     mistake deep: a table created without `enable row level security`, or a policy widened by
--     accident, and `anon` or `authenticated` can write journal rows directly. Grants are the
--     second lock, and they are the one the posting functions do not need — they are
--     SECURITY DEFINER and run as the owner, so revoking table privileges from every client
--     role does not touch them.
-- ============================================================

-- anon is never a business user of this database. Supabase's default grants hand it privileges
-- on every table in public; take them all back, on everything that exists today.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
-- ...and on everything created from here on, so a future migration cannot silently re-open it.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- The ledger core is written by post_*/cancel_* functions only — spec: "direct INSERT on
-- journal_entries/journal_lines/stock_movements is granted to no role". That was true of the
-- RLS policies but not of the grants; make it true of both, for service_role as well, which
-- bypasses RLS entirely and was therefore the one identity that could rewrite history.
revoke insert, update, delete, truncate on journal_entries  from authenticated, service_role;
revoke insert, update, delete, truncate on journal_lines    from authenticated, service_role;
revoke insert, update, delete, truncate on stock_movements  from authenticated, service_role;
revoke insert, update, delete, truncate on audit_log        from authenticated, service_role;

-- doc_sequences belongs to the same class: it is the counter that makes document numbers
-- gapless per FY series, and a client that can UPDATE next_no can mint a duplicate invoice
-- number — a GST-visible defect — or skip a number and break the gapless guarantee. Only
-- next_doc_no() writes it, and that is SECURITY DEFINER, so numbering is unaffected. SELECT
-- stays (change 09's masters screen shows the current numbers).
revoke insert, update, delete, truncate on doc_sequences    from authenticated, service_role;

-- ============================================================
-- 4. post_delivery_challan
--    Stock OUT of the challan's warehouse at weighted-average cost; the value parks in
--    Goods in Transit until the invoice relieves it (Dr Goods in transit / Cr Inventory).
--    No stock movement INTO a warehouse: the goods have physically left, which is why the
--    acceptance scenario says on-hand "drops once (at challan time)" and the invoice adds
--    no movement of its own. Goods in Transit is an account, not a godown.
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
-- 5. _post_sales_invoice: change 03's post_sales_invoice body, extended with the challan hook.
--    Everything else is carried over verbatim — the only differences are the challan lock and
--    validation after the document lock, the "skip the stock block" condition inside the line
--    loop, COGS sourced from the challan's carried cost, Cr Goods in Transit instead of
--    Cr Inventory, and marking the challan converted.
--
--    The body moved here from the public entry point so that post_cash_sale can skip the
--    credit-limit check on its own path only ("Cash sale is one transaction", Decisions from
--    change 04 review). It gets NO grant to any role: the two public wrappers below are
--    SECURITY DEFINER and owned by the same role, so they can call it regardless of grants,
--    exactly as post_* functions already call next_doc_no.
--
--    p_override_credit is a third parameter the spec's two-argument signature does not name —
--    change 03's admin credit-limit override has to live somewhere, and it is tested. It
--    defaults to false, so the specced call shape `_post_sales_invoice(id, false)` is valid.
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

-- The public entry point keeps change 03's exact signature and behaviour; it never skips the
-- credit check.
create or replace function public.post_sales_invoice(p_invoice_id uuid, p_override_credit bool default false)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return _post_sales_invoice(p_invoice_id, false, p_override_credit);
end;
$$;

revoke all on function public.post_sales_invoice(uuid, bool) from public, anon, service_role;
grant execute on function public.post_sales_invoice(uuid, bool) to authenticated;

-- ============================================================
-- 5b. post_cash_sale: invoice + full-amount allocated receipt in one transaction.
--     The credit-limit check is skipped on this path only, because AR is raised and settled
--     before commit — a walk-in customer with credit_limit = 0 can therefore still buy for cash,
--     which is the whole point of the fixed credit-limit semantics.
--     Both legs are ordinary function calls, so a failure in the receipt rolls the invoice back
--     with it: there is no "posted but unpaid" intermediate state to clean up.
-- ============================================================

create or replace function public.post_cash_sale(p_invoice_id uuid, p_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.post_cash_sale(uuid, uuid) from public, anon, service_role;
grant execute on function public.post_cash_sale(uuid, uuid) to authenticated;

-- ============================================================
-- 6. post_stock_transfer / receive_stock_transfer
--    Warehouse to warehouse through the seeded 'In Transit' warehouse. No journal entry ever:
--    the value never leaves Inventory, only the godown it sits in changes. Both return void,
--    following change 04's mark_cheque_cleared (there is no journal_entry_id to return).
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

create or replace function public.receive_stock_transfer(p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.receive_stock_transfer(uuid) from public, anon, service_role;
grant execute on function public.receive_stock_transfer(uuid) to authenticated;

-- ============================================================
-- 7. post_stock_adjustment
--    Admin only. Decreases are valued at the current weighted average (Dr Stock loss /
--    Cr Inventory); increases at the line's rate, or the average when the rate is NULL
--    (Dr Inventory / Cr Stock loss). Both directions are posted gross so a mixed adjustment
--    still reads as what it was.
-- ============================================================

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
-- 8. post_day_close
--    Expected cash is derived from the cash ledger, never from the counter's arithmetic.
--    The spec's older signature passes p_actor; superseded by the audit's "Actor and grants"
--    rule (auth.uid() inside the function) — see implementation-notes.md.
-- ============================================================

create or replace function public.post_day_close(p_date date, p_counted numeric, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  select role into v_role from app_users where user_id = v_actor and is_active;
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
$$;

revoke all on function public.post_day_close(date, numeric, text) from public, anon, service_role;
grant execute on function public.post_day_close(date, numeric, text) to authenticated;

-- ============================================================
-- 9. cancel_document: changes 03 + 04's branches carried over, plus delivery_challan,
--    stock_transfer, stock_adjustment and day_close.
--    The only edit inside a pre-existing branch is in sales_invoice: cancelling a converted
--    invoice now reopens its challan (invoice_id back to NULL), which is exactly what the
--    Cancellation-edge-cases rule "cancel the invoice first (which reopens the challan)"
--    requires. The challan row is locked immediately after the invoice, matching
--    post_sales_invoice's order.
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
$$;

-- service_role deliberately not granted (change 03's decision #9): auth.uid() is NULL under a
-- service-role session, so the grant would be a dead path that always fails DN_FORBIDDEN.
revoke all on function public.cancel_document(source_type, uuid, text) from public, anon, service_role;
grant execute on function public.cancel_document(source_type, uuid, text) to authenticated;
