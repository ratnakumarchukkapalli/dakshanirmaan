-- db-architecture spec: "RLS and roles"
--
-- Two roles only (admin, user). Active membership is app_users.user_id = auth.uid() AND is_active.
-- Helper functions are SECURITY DEFINER, owned by the migration role, so they can read app_users
-- without recursing through app_users' own RLS policy.

create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from app_users where user_id = auth.uid() and is_active
  );
$$;

create or replace function public.current_app_role()
returns app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from app_users where user_id = auth.uid() and is_active;
$$;

-- Enable RLS, deny-by-default, on every table this change creates.
alter table organization enable row level security;
alter table accounts enable row level security;
alter table parties enable row level security;
alter table party_addresses enable row level security;
alter table items enable row level security;
alter table warehouses enable row level security;
alter table fiscal_periods enable row level security;
alter table doc_sequences enable row level security;
alter table journal_entries enable row level security;
alter table journal_lines enable row level security;
alter table stock_movements enable row level security;
alter table sales_invoices enable row level security;
alter table sales_invoice_lines enable row level security;
alter table purchase_invoices enable row level security;
alter table purchase_invoice_lines enable row level security;
alter table credit_notes enable row level security;
alter table credit_note_lines enable row level security;
alter table debit_notes enable row level security;
alter table debit_note_lines enable row level security;
alter table payments enable row level security;
alter table payment_allocations enable row level security;
alter table expense_vouchers enable row level security;
alter table expense_voucher_lines enable row level security;
alter table audit_log enable row level security;
alter table app_users enable row level security;

-- SELECT: active members, on every business table (spec: "Active members: SELECT on business
-- tables"). app_users is handled separately below (own row, or admin sees all).
create policy select_active_members on organization for select using (is_active_member());
create policy select_active_members on accounts for select using (is_active_member());
create policy select_active_members on parties for select using (is_active_member());
create policy select_active_members on party_addresses for select using (is_active_member());
create policy select_active_members on items for select using (is_active_member());
create policy select_active_members on warehouses for select using (is_active_member());
create policy select_active_members on fiscal_periods for select using (is_active_member());
create policy select_active_members on doc_sequences for select using (is_active_member());
create policy select_active_members on journal_entries for select using (is_active_member());
create policy select_active_members on journal_lines for select using (is_active_member());
create policy select_active_members on stock_movements for select using (is_active_member());
create policy select_active_members on sales_invoices for select using (is_active_member());
create policy select_active_members on sales_invoice_lines for select using (is_active_member());
create policy select_active_members on purchase_invoices for select using (is_active_member());
create policy select_active_members on purchase_invoice_lines for select using (is_active_member());
create policy select_active_members on credit_notes for select using (is_active_member());
create policy select_active_members on credit_note_lines for select using (is_active_member());
create policy select_active_members on debit_notes for select using (is_active_member());
create policy select_active_members on debit_note_lines for select using (is_active_member());
create policy select_active_members on payments for select using (is_active_member());
create policy select_active_members on payment_allocations for select using (is_active_member());
create policy select_active_members on expense_vouchers for select using (is_active_member());
create policy select_active_members on expense_voucher_lines for select using (is_active_member());
create policy select_active_members on audit_log for select using (is_active_member());

create policy select_own_or_admin on app_users for select
  using (user_id = auth.uid() or current_app_role() = 'admin');

-- INSERT/UPDATE on draft documents: both roles (spec: daily billing must not block on admin).
-- Header tables: new rows must be draft; edits only while still draft.
create policy insert_draft on sales_invoices for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on sales_invoices for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on sales_invoices for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on purchase_invoices for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on purchase_invoices for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on purchase_invoices for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on credit_notes for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on credit_notes for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on credit_notes for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on debit_notes for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on debit_notes for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on debit_notes for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on payments for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on payments for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on payments for delete
  using (is_active_member() and status = 'draft');

create policy insert_draft on expense_vouchers for insert
  with check (is_active_member() and status = 'draft');
create policy update_draft on expense_vouchers for update
  using (is_active_member() and status = 'draft')
  with check (status = 'draft');
create policy delete_draft on expense_vouchers for delete
  using (is_active_member() and status = 'draft');

-- Line tables: follow their header's draft status.
create policy insert_draft on sales_invoice_lines for insert
  with check (is_active_member() and exists (
    select 1 from sales_invoices h where h.id = invoice_id and h.status = 'draft'
  ));
create policy update_draft on sales_invoice_lines for update
  using (is_active_member() and exists (
    select 1 from sales_invoices h where h.id = invoice_id and h.status = 'draft'
  ));
create policy delete_draft on sales_invoice_lines for delete
  using (is_active_member() and exists (
    select 1 from sales_invoices h where h.id = invoice_id and h.status = 'draft'
  ));

create policy insert_draft on purchase_invoice_lines for insert
  with check (is_active_member() and exists (
    select 1 from purchase_invoices h where h.id = invoice_id and h.status = 'draft'
  ));
create policy update_draft on purchase_invoice_lines for update
  using (is_active_member() and exists (
    select 1 from purchase_invoices h where h.id = invoice_id and h.status = 'draft'
  ));
create policy delete_draft on purchase_invoice_lines for delete
  using (is_active_member() and exists (
    select 1 from purchase_invoices h where h.id = invoice_id and h.status = 'draft'
  ));

create policy insert_draft on credit_note_lines for insert
  with check (is_active_member() and exists (
    select 1 from credit_notes h where h.id = note_id and h.status = 'draft'
  ));
create policy update_draft on credit_note_lines for update
  using (is_active_member() and exists (
    select 1 from credit_notes h where h.id = note_id and h.status = 'draft'
  ));
create policy delete_draft on credit_note_lines for delete
  using (is_active_member() and exists (
    select 1 from credit_notes h where h.id = note_id and h.status = 'draft'
  ));

create policy insert_draft on debit_note_lines for insert
  with check (is_active_member() and exists (
    select 1 from debit_notes h where h.id = note_id and h.status = 'draft'
  ));
create policy update_draft on debit_note_lines for update
  using (is_active_member() and exists (
    select 1 from debit_notes h where h.id = note_id and h.status = 'draft'
  ));
create policy delete_draft on debit_note_lines for delete
  using (is_active_member() and exists (
    select 1 from debit_notes h where h.id = note_id and h.status = 'draft'
  ));

create policy insert_draft on expense_voucher_lines for insert
  with check (is_active_member() and exists (
    select 1 from expense_vouchers h where h.id = voucher_id and h.status = 'draft'
  ));
create policy update_draft on expense_voucher_lines for update
  using (is_active_member() and exists (
    select 1 from expense_vouchers h where h.id = voucher_id and h.status = 'draft'
  ));
create policy delete_draft on expense_voucher_lines for delete
  using (is_active_member() and exists (
    select 1 from expense_vouchers h where h.id = voucher_id and h.status = 'draft'
  ));

-- The six document header tables and their line tables also get a DELETE policy, draft-only,
-- both roles (spec: both roles may delete their own drafts and lines) — see delete_draft above.
--
-- Everything else gets no INSERT/UPDATE/DELETE policy (deny-by-default):
-- - masters (organization, accounts, parties, party_addresses, items, warehouses,
--   fiscal_periods, doc_sequences) — admin-only writes land with change 09 (masters);
-- - ledger core (journal_entries, journal_lines, stock_movements) — SECURITY DEFINER
--   post_* functions only, per spec, arriving change 02+;
-- - payment_allocations — populated by post_payment (change 04), not written directly;
-- - audit_log — written by post_*/cancel_* functions (change 02+), which bypass RLS as
--   SECURITY DEFINER owned by the migration role;
-- - app_users — initial admin provisioning is a service_role operation; invite/disable
--   actions land with change 08 (auth-users).
