-- db-architecture spec: "Core tables"
-- All tables: id UUID PK, created_at timestamptz. Document header tables also get created_by.

create table organization (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  singleton bool not null default true unique check (singleton),
  legal_name text not null,
  trade_name text,
  gstin char(15),
  state_code char(2) not null,
  address jsonb,
  fy_start_month int not null default 4,
  einvoice_enabled bool not null default false
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null unique,
  name text not null,
  type account_type not null,
  parent_id uuid references accounts (id),
  is_group bool not null default false,
  is_control bool not null default false,
  system_key text unique
);

create table parties (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  type party_type not null,
  gstin char(15),
  state_code char(2) not null,
  phone text,
  credit_limit numeric(14,2) not null default 0,
  credit_days int not null default 0,
  monthly_salary numeric(14,2),
  daily_wage numeric(14,2),
  is_active bool not null default true
);

create table party_addresses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  party_id uuid not null references parties (id),
  label text not null,
  address jsonb not null,
  state_code char(2) not null,
  is_default bool not null default false
);

create table items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  brand text,
  category text not null check (category in ('cement','steel','other')),
  hsn_code text not null,
  gst_rate numeric(5,2) not null,
  base_uom text not null,
  alt_uom text,
  conversion_factor numeric(12,4), -- 1 alt_uom = N base_uom
  reorder_level numeric(12,3) not null default 0,
  sale_rate numeric(14,4) not null,
  is_active bool not null default true
);

create table warehouses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  address jsonb,
  is_default bool not null default false
);

create table fiscal_periods (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  year_label text not null, -- e.g. '2026-27'
  month date not null,      -- first of month
  is_locked bool not null default false,
  unique (month)
);

create table doc_sequences (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  series text not null,
  doc_type source_type not null,
  fy_label text not null,
  prefix text not null,
  next_no int not null default 1,
  unique (series, fy_label)
);

-- Ledger core (change 02 adds the integrity triggers; change 03+ adds the SECURITY DEFINER
-- post_* functions that are the only writers). No app role gets direct write access here.

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  entry_no bigserial not null unique,
  entry_date date not null,
  narration text,
  source_type source_type not null,
  source_id uuid,
  status doc_status not null default 'posted',
  reversed_by uuid references journal_entries (id),
  posted_by uuid,
  posted_at timestamptz
);

create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  entry_id uuid not null references journal_entries (id) on delete restrict,
  line_no int not null,
  account_id uuid not null references accounts (id),
  party_id uuid references parties (id),
  debit numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0,
  check (debit >= 0 and credit >= 0 and (debit = 0 or credit = 0) and (debit + credit > 0))
);

create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  item_id uuid not null references items (id),
  warehouse_id uuid not null references warehouses (id),
  movement_date date not null,
  qty numeric(12,3) not null, -- signed: + in, - out, base UOM
  rate numeric(14,4) not null,
  value numeric(14,2) not null,
  source_type source_type not null,
  source_id uuid
);

-- Documents

create table sales_invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  invoice_no text unique,
  invoice_date date not null,
  party_id uuid not null references parties (id),
  billing_address jsonb,
  shipping_address jsonb,
  place_of_supply char(2) not null,
  status doc_status not null default 'draft',
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  round_off numeric(6,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  journal_entry_id uuid references journal_entries (id),
  vehicle_no text,
  transporter_name text,
  transporter_gstin text,
  transport_mode text,
  distance_km int,
  ewb_no text,
  ewb_date date,
  ewb_valid_until timestamptz,
  irn text,
  irn_ack_no text,
  irn_ack_date timestamptz,
  signed_qr text
);

create table sales_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  invoice_id uuid not null references sales_invoices (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  -- snapshot columns: never joined to items for display of posted docs
  item_name text not null,
  hsn_code text not null,
  uom text not null,
  qty numeric(12,3) not null,
  alt_qty numeric(12,3),
  rate numeric(14,4) not null,
  discount_pct numeric(5,2) not null default 0,
  taxable_value numeric(14,2) not null,
  gst_rate numeric(5,2) not null,
  cgst_amt numeric(14,2) not null default 0,
  sgst_amt numeric(14,2) not null default 0,
  igst_amt numeric(14,2) not null default 0
);

create table purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  invoice_no text unique,
  invoice_date date not null,
  party_id uuid not null references parties (id),
  billing_address jsonb,
  shipping_address jsonb,
  place_of_supply char(2) not null,
  status doc_status not null default 'draft',
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  round_off numeric(6,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  journal_entry_id uuid references journal_entries (id),
  vehicle_no text,
  transporter_name text,
  transporter_gstin text,
  transport_mode text,
  distance_km int,
  ewb_no text,
  ewb_date date,
  ewb_valid_until timestamptz,
  irn text,
  irn_ack_no text,
  irn_ack_date timestamptz,
  signed_qr text,
  supplier_bill_no text,
  supplier_bill_date date,
  rcm bool not null default false,
  itc_eligible bool not null default true
);

create table purchase_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  invoice_id uuid not null references purchase_invoices (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  hsn_code text not null,
  uom text not null,
  qty numeric(12,3) not null,
  alt_qty numeric(12,3),
  rate numeric(14,4) not null,
  discount_pct numeric(5,2) not null default 0,
  taxable_value numeric(14,2) not null,
  gst_rate numeric(5,2) not null,
  cgst_amt numeric(14,2) not null default 0,
  sgst_amt numeric(14,2) not null default 0,
  igst_amt numeric(14,2) not null default 0
);

create table credit_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  note_no text unique,
  note_date date not null,
  party_id uuid not null references parties (id),
  place_of_supply char(2) not null,
  status doc_status not null default 'draft',
  against_invoice_id uuid references sales_invoices (id),
  reason text,
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  round_off numeric(6,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  journal_entry_id uuid references journal_entries (id)
);

create table credit_note_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  note_id uuid not null references credit_notes (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  hsn_code text not null,
  uom text not null,
  qty numeric(12,3) not null,
  rate numeric(14,4) not null,
  taxable_value numeric(14,2) not null,
  gst_rate numeric(5,2) not null,
  cgst_amt numeric(14,2) not null default 0,
  sgst_amt numeric(14,2) not null default 0,
  igst_amt numeric(14,2) not null default 0
);

create table debit_notes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  note_no text unique,
  note_date date not null,
  party_id uuid not null references parties (id),
  place_of_supply char(2) not null,
  status doc_status not null default 'draft',
  against_invoice_id uuid references purchase_invoices (id),
  reason text,
  taxable_total numeric(14,2) not null default 0,
  cgst_total numeric(14,2) not null default 0,
  sgst_total numeric(14,2) not null default 0,
  igst_total numeric(14,2) not null default 0,
  round_off numeric(6,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  journal_entry_id uuid references journal_entries (id)
);

create table debit_note_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  note_id uuid not null references debit_notes (id) on delete cascade,
  line_no int not null,
  item_id uuid not null references items (id),
  item_name text not null,
  hsn_code text not null,
  uom text not null,
  qty numeric(12,3) not null,
  rate numeric(14,4) not null,
  taxable_value numeric(14,2) not null,
  gst_rate numeric(5,2) not null,
  cgst_amt numeric(14,2) not null default 0,
  sgst_amt numeric(14,2) not null default 0,
  igst_amt numeric(14,2) not null default 0
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  voucher_no text unique,
  direction text not null check (direction in ('receipt','payment')),
  payment_date date not null,
  party_id uuid not null references parties (id),
  mode payment_mode not null,
  instrument_no text,
  instrument_date date,
  amount numeric(14,2) not null,
  discount numeric(14,2) not null default 0,
  account_id uuid not null references accounts (id), -- cash or bank ledger
  status doc_status not null default 'draft',
  journal_entry_id uuid references journal_entries (id)
);

create table payment_allocations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  payment_id uuid not null references payments (id),
  invoice_type text not null,
  invoice_id uuid not null,
  amount numeric(14,2) not null
  -- sum(amount) per payment <= payment.amount is enforced by a trigger added with post_payment (change 04)
);

create table expense_vouchers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  voucher_no text unique,
  voucher_date date not null,
  party_id uuid references parties (id), -- employee or vendor
  status doc_status not null default 'draft',
  journal_entry_id uuid references journal_entries (id)
);

create table expense_voucher_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  voucher_id uuid not null references expense_vouchers (id) on delete cascade,
  line_no int not null,
  account_id uuid not null references accounts (id),
  party_id uuid references parties (id),
  amount numeric(14,2) not null,
  narration text,
  rcm bool not null default false
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

-- app_users: base shape from "RLS and roles". Columns added by change 08 (auth-users).
create table app_users (
  user_id uuid primary key references auth.users (id),
  role app_role not null,
  name text not null,
  is_active bool not null default true,
  created_at timestamptz not null default now()
);

-- Draft concurrency: document header tables carry updated_at, maintained by trigger, so the
-- app can detect two people editing the same draft at once.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- clock_timestamp(), not now(): now() is frozen for the whole transaction, so a multi-save
  -- transaction (or a test asserting the value advances) would see no change.
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger touch_updated_at before update on sales_invoices
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on purchase_invoices
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on credit_notes
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on debit_notes
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on payments
  for each row execute function public.touch_updated_at();
create trigger touch_updated_at before update on expense_vouchers
  for each row execute function public.touch_updated_at();
