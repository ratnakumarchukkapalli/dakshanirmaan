# DB Architecture Specification

## Purpose

Define the complete Postgres schema, invariants, and posting engine for Daksha Nirmaan. This spec is the contract for all migrations. The design rationale lives in `docs/DESIGN.md` §1–§4; this file is what gets built.

## Requirement: Enums and reference types

The schema SHALL define these enums:

```sql
CREATE TYPE account_type   AS ENUM ('asset','liability','equity','income','expense');
CREATE TYPE party_type     AS ENUM ('customer','supplier','both','employee');
CREATE TYPE doc_status     AS ENUM ('draft','posted','cancelled');
CREATE TYPE source_type    AS ENUM ('sales_invoice','purchase_invoice','credit_note','debit_note',
                                    'payment','expense_voucher','stock_adjustment','opening','manual');
CREATE TYPE payment_mode   AS ENUM ('cash','upi','neft','cheque','bank');
CREATE TYPE app_role       AS ENUM ('admin','user');
```

## Requirement: Core tables

The schema SHALL contain the following tables. All tables get `id UUID PK DEFAULT gen_random_uuid()`, `created_at timestamptz DEFAULT now()`; document tables also get `created_by UUID REFERENCES auth.users`.

### organization (single row)
`legal_name, trade_name, gstin CHAR(15), state_code CHAR(2), address jsonb, fy_start_month int DEFAULT 4, einvoice_enabled bool DEFAULT false`

### accounts
`code text UNIQUE, name, type account_type, parent_id UUID REFERENCES accounts, is_group bool DEFAULT false, is_control bool DEFAULT false, system_key text UNIQUE NULL`
- Postings allowed only where `is_group = false` (ERPNext group/ledger rule).
- `system_key` marks accounts the engine needs (`'ar'`, `'ap'`, `'inventory'`, `'cogs'`, `'output_cgst'`, `'output_sgst'`, `'output_igst'`, `'input_cgst'`, `'input_sgst'`, `'input_igst'`, `'round_off'`, `'salary_payable'`, `'employee_advance'`, `'cash'`, `'rcm_payable'`). Seed migration SHALL create the full CoA per DESIGN.md §2.2.

### parties + party_addresses
`parties: name, type party_type, gstin CHAR(15) NULL, state_code CHAR(2), phone, credit_limit NUMERIC(14,2) DEFAULT 0, credit_days int DEFAULT 0, monthly_salary NUMERIC(14,2) NULL, daily_wage NUMERIC(14,2) NULL, is_active bool`
`party_addresses: party_id FK, label, address jsonb, state_code CHAR(2), is_default bool`

### items
`name, brand, category text CHECK (category IN ('cement','steel','other')), hsn_code text, gst_rate NUMERIC(5,2), base_uom text, alt_uom text NULL, conversion_factor NUMERIC(12,4) NULL /* 1 alt_uom = N base_uom */, reorder_level NUMERIC(12,3) DEFAULT 0, sale_rate NUMERIC(14,4), is_active bool`

### warehouses
`name, address jsonb, is_default bool`

### fiscal_periods
`year_label text /* '2026-27' */, month date /* first of month */, is_locked bool DEFAULT false, UNIQUE(month)`

### doc_sequences
`doc_type source_type, fy_label text, prefix text, next_no int DEFAULT 1, UNIQUE(doc_type, fy_label)`

### journal_entries
`entry_no bigserial, entry_date date, narration text, source_type source_type, source_id UUID, status doc_status DEFAULT 'posted', reversed_by UUID NULL REFERENCES journal_entries, posted_by UUID, posted_at timestamptz`

### journal_lines
`entry_id FK ON DELETE RESTRICT, line_no int, account_id FK accounts, party_id FK parties NULL, debit NUMERIC(14,2) DEFAULT 0, credit NUMERIC(14,2) DEFAULT 0, CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit + credit > 0))`

### stock_movements
`item_id FK, warehouse_id FK, movement_date date, qty NUMERIC(12,3) /* signed: + in, − out, base UOM */, rate NUMERIC(14,4), value NUMERIC(14,2), source_type source_type, source_id UUID`

### Documents
**sales_invoices**: `invoice_no text UNIQUE, invoice_date date, party_id FK, billing_address jsonb, shipping_address jsonb, place_of_supply CHAR(2), status doc_status DEFAULT 'draft', taxable_total, cgst_total, sgst_total, igst_total, round_off NUMERIC(6,2), grand_total /* all NUMERIC(14,2) */, journal_entry_id UUID NULL, vehicle_no text, transporter_name text, transporter_gstin text, transport_mode text, distance_km int, ewb_no text, ewb_date date, ewb_valid_until timestamptz, irn text, irn_ack_no text, irn_ack_date timestamptz, signed_qr text`

**sales_invoice_lines**: `invoice_id FK ON DELETE CASCADE, line_no, item_id FK, item_name text, hsn_code text, uom text, qty NUMERIC(12,3), alt_qty NUMERIC(12,3) NULL, rate NUMERIC(14,4), discount_pct NUMERIC(5,2) DEFAULT 0, taxable_value, gst_rate NUMERIC(5,2), cgst_amt, sgst_amt, igst_amt /* NUMERIC(14,2) */` — snapshot columns, never joined to `items` for display of posted docs.

**purchase_invoices / purchase_invoice_lines**: mirror of sales plus `supplier_bill_no text, supplier_bill_date date, rcm bool DEFAULT false, itc_eligible bool DEFAULT true`.

**credit_notes / debit_notes** (+ lines): same line shape, plus `against_invoice_id UUID NULL, reason text`.

**payments**: `voucher_no text UNIQUE, direction text CHECK (direction IN ('receipt','payment')), payment_date date, party_id FK, mode payment_mode, instrument_no text, instrument_date date, amount NUMERIC(14,2), discount NUMERIC(14,2) DEFAULT 0, account_id FK /* cash or bank ledger */, status doc_status, journal_entry_id UUID`

**payment_allocations**: `payment_id FK, invoice_type text, invoice_id UUID, amount NUMERIC(14,2)` — Σ allocations ≤ payment amount (trigger).

**expense_vouchers** (+ lines): salaries, advances, wages, freight, rent, fuel. `voucher_no, voucher_date, party_id NULL /* employee or vendor */, status, journal_entry_id`; lines: `account_id, party_id NULL, amount, narration, rcm bool DEFAULT false`.

### audit_log
`actor UUID, action text, entity text, entity_id UUID, before jsonb, after jsonb, at timestamptz DEFAULT now()` — insert-only (no UPDATE/DELETE grants).

## Requirement: Integrity triggers

1. **Balanced entries** — deferred constraint trigger on `journal_lines`: at transaction end, for each touched `entry_id`, `SUM(debit) = SUM(credit)` else RAISE.
2. **Immutability** — BEFORE UPDATE OR DELETE on `journal_entries`, `journal_lines`, `stock_movements`: RAISE unless the only change is setting `journal_entries.reversed_by` on a previously-NULL value.
3. **Period lock** — BEFORE INSERT on `journal_entries` and `stock_movements`: RAISE if the date's `fiscal_periods.is_locked`.
4. **No negative stock** — in `post_*` functions (not a trigger): computed on-hand after movement must be ≥ 0, else RAISE `negative_stock` (admin may override via explicit flag).
5. **Leaf-only postings** — BEFORE INSERT on `journal_lines`: RAISE if `accounts.is_group`.

## Requirement: Posting engine (plpgsql, SECURITY DEFINER)

All functions run in one transaction, take a document id + acting user, validate status = 'draft', and return the created `journal_entry_id`.

```
next_doc_no(p_doc_type source_type, p_date date) RETURNS text
  -- SELECT ... FOR UPDATE on doc_sequences; gapless per FY series
post_sales_invoice(p_invoice_id uuid, p_actor uuid) RETURNS uuid
  -- validates party/lines; determines CGST+SGST vs IGST from place_of_supply vs org.state_code;
  -- journal: Dr AR(party) grand_total · Cr sales income per category · Cr output tax · Dr/Cr round_off
  -- + Dr COGS / Cr Inventory at weighted-avg cost; stock_movements OUT per line;
  -- sets status='posted', journal_entry_id, snapshots verified
post_purchase_invoice(p_invoice_id uuid, p_actor uuid) RETURNS uuid
  -- Dr Inventory taxable · Dr input tax (if itc_eligible) · Cr AP(party); stock IN at cost;
  -- weighted avg recalc: new_avg = (on_hand_value + line_value) / (on_hand_qty + qty)
post_payment(p_payment_id uuid, p_actor uuid) RETURNS uuid
  -- receipt: Dr cash/bank · Cr AR(party) (+ Dr discount_allowed if discount>0); payment: mirrored
post_credit_note / post_debit_note
  -- proportional reversal of revenue+tax; stock back IN at original issue cost
post_expense_voucher(p_voucher_id uuid, p_actor uuid) RETURNS uuid
  -- generic Dr expense/advance lines · Cr cash/bank/salary_payable; employee advances hit
  --   employee_advance control with party_id; RCM lines additionally Cr rcm_payable + Dr input tax
cancel_document(p_source_type source_type, p_source_id uuid, p_actor uuid) RETURNS uuid
  -- posts a mirror-image reversal entry + opposite stock movements; original keeps its number;
  -- sets status='cancelled', links reversed_by
stock_on_hand(p_item uuid, p_warehouse uuid) RETURNS TABLE(qty numeric, value numeric, avg_rate numeric)
```

Every `post_*`/`cancel_*` writes one `audit_log` row.

## Requirement: Views (read model)

`v_trial_balance` (account, Σdebit, Σcredit, closing) · `v_party_ledger` (per party: date, doc ref, debit, credit, running balance) · `v_party_balances` + `v_party_aging` (buckets 0–30/31–60/61–90/90+ from open invoices minus allocations) · `v_stock_summary` (item × warehouse: qty, avg rate, value) · `v_stock_ledger` · `v_pnl` / `v_balance_sheet` (by account type over period) · `v_day_book` · `v_gstr1_b2b`, `v_gstr1_b2c`, `v_hsn_summary` (from posted invoice lines) · `v_gstr3b_summary` · `v_employee_ledger` (advances vs salary from journal lines on employee control accounts).

Views SHALL be plain SQL over base tables — no materialization in v1.

## Requirement: RLS and roles

- `app_users: user_id PK REFERENCES auth.users, role app_role, name, is_active`
- Exactly two roles. **admin** (the family/owners): everything — post/cancel any document, credit/debit notes, purchases, expense/salary vouchers, period lock/unlock, negative-stock override, settings, user management, all reports. **user** (general/counter staff): create and edit drafts, post sales invoices and receipts (daily billing must not block on admin), record employee advances; no cancellations, no purchases/expenses posting, no P&L/Balance Sheet, no settings.
- Public signup SHALL be **disabled** in Supabase Auth; accounts are provisioned by the admin only. An authenticated session without an active `app_users` row gets nothing (RLS checks membership, not just `auth.uid()`).
- RLS enabled on every table, deny-by-default. Active members: SELECT on business tables (P&L/BS views admin-only). INSERT/UPDATE on draft documents: both roles. Posting functions re-check role internally per the matrix above.
- Posting functions are `SECURITY DEFINER`; direct INSERT on `journal_entries/journal_lines/stock_movements` is granted to **no role** — service role via functions only.

## Requirement: Seed data

Seed migration SHALL create: default CoA (per DESIGN.md §2.2 with all `system_key` accounts), one warehouse ('Head Godown'), fiscal periods for FY 2026-27, doc_sequences (`DN/26-27/` for sales, `PB`, `CN`, `DB`, `RCPT`, `PAY`, `EXP`), organization placeholder row.

#### Scenario: posting a sales invoice keeps books balanced
- WHEN `post_sales_invoice` runs on a draft intra-state invoice of taxable ₹65,000 at 18% GST
- THEN one journal entry exists with Σdebit = Σcredit = ₹132,100 side-total (AR 76,700 + COGS at avg cost), invoice status = 'posted', and stock_movements decrement each line's item in base UOM

#### Scenario: cancelled invoice reverses, never deletes
- WHEN `cancel_document` runs on a posted invoice
- THEN a new reversal entry mirrors every line, stock returns, original entry and number remain, status = 'cancelled'

#### Scenario: locked period rejects postings
- WHEN any posting function targets a date whose fiscal period `is_locked`
- THEN it raises and no rows are written

## Requirement: Schema extensions for prototype-v2 features (added 2026-09-16)

These extend the core above; nothing above changes. Enum deltas are additive.

```sql
ALTER TYPE source_type ADD VALUE 'delivery_challan';
ALTER TYPE source_type ADD VALUE 'stock_transfer';
ALTER TYPE source_type ADD VALUE 'quotation';      -- never posts; listed for numbering only
ALTER TYPE source_type ADD VALUE 'day_close';
CREATE TYPE cheque_status AS ENUM ('in_hand','deposited','cleared','bounced','issued','presented');
```

New `system_key` accounts: `'bank'` (default bank ledger), `'cash_over_short'`, `'rebate_income'`, `'rebate_receivable'`, `'stock_loss'`, `'freight_inward'`, `'loading_unloading'`, `'discount_allowed'`, `'interest_income'`, `'goods_in_transit'` (asset, for challans/transfers).

### parties (columns added)
`interest_rate_pm NUMERIC(5,2) DEFAULT 0 /* % per month on overdue */, whatsapp_phone text, default_site_id UUID NULL`

### delivery_challans + delivery_challan_lines
Header: `challan_no text UNIQUE, challan_date, party_id, site_address jsonb, vehicle_no, driver_party_id NULL, status doc_status, invoice_id UUID NULL /* set when converted */, journal_entry_id NULL`. Lines: same snapshot shape as sales lines minus tax (value carried for EWB threshold).
Posting: stock OUT from warehouse, stock IN to `goods_in_transit` (journal: Dr Goods in transit · Cr Inventory at avg cost). Converting to invoice: invoice posts revenue + tax and relieves goods-in-transit (Dr COGS · Cr Goods in transit) instead of Inventory. Un-invoiced challans older than 7 days surface in `v_attention`.

### quotations + quotation_lines (Phase 2)
`quote_no, quote_date, party_id, valid_until, status text CHECK (status IN ('open','accepted','expired','converted')), converted_invoice_id NULL`. Lines snapshot item + rate. No journal or stock effect ever.

### stock_transfers + stock_transfer_lines
`transfer_no, transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status text CHECK (status IN ('draft','in_transit','received','cancelled')), received_at, received_by`. Post: OUT from source at avg cost, IN to a per-transfer transit bucket; receive: OUT of transit, IN to destination at the same rate (no revaluation). No journal entry (value stays in Inventory).

### payments (columns added)
`cheque_status cheque_status NULL, cheque_bank text, deposited_on date, cleared_on date, bounced_on date, bounce_reversal_entry_id UUID NULL`
- Receipt by cheque posts to a **Cheques in hand** ledger (system_key `'cheques_in_hand'`, asset) not Bank; `deposit` moves to Bank (Dr Bank · Cr Cheques in hand); `bounce` posts a reversal of the original receipt and deletes allocations (function `bounce_cheque(p_payment_id, p_actor)`).
- Payment by cheque: Cr Bank at issue (status `issued`), `presented` is informational.

### bank_statements + bank_statement_lines
`bank_statements: account_id, period_from, period_to, imported_by, imported_at, source_file text`
`bank_statement_lines: statement_id, txn_date, narration text, debit NUMERIC(14,2), credit NUMERIC(14,2), balance NUMERIC(14,2) NULL, matched_payment_id UUID NULL, matched_entry_id UUID NULL, match_status text CHECK (match_status IN ('unmatched','auto','manual','ignored'))`. Matching is by amount+date window (±3 days) then narration token overlap; unmatched lines create receipts/expenses via existing actions. View `v_bank_recon` (book vs bank balance, unmatched count).

### attachments
`entity text, entity_id UUID, storage_path text, mime text, bytes int, uploaded_by, uploaded_at` — Supabase Storage bucket `docs` (private, RLS via signed URLs, 5 MB cap). Used first for purchase-bill photos.

### day_closes
`close_date date UNIQUE, opening_cash, cash_in, cash_out, deposited, expected NUMERIC(14,2), counted NUMERIC(14,2), difference NUMERIC(14,2), note text, closed_by, closed_at, journal_entry_id NULL`. `post_day_close(p_date, p_counted, p_note, p_actor)` computes expected from the cash ledger, posts the difference to `cash_over_short` (Dr/Cr Cash), and locks nothing (period locks are separate). One close per date; reopening is admin-only and audit-logged.

### brand_rebates (Phase 2)
`brand text, period_from, period_to, slab_qty NUMERIC(12,3), rate_per_unit NUMERIC(14,4) NULL, fixed_amount NUMERIC(14,2) NULL, accrued_amount NUMERIC(14,2), received_note_id UUID NULL, status text CHECK (status IN ('expected','accrued','received','shortfall'))`. Accrual voucher: Dr Rebate receivable (party = brand supplier) · Cr Rebate income; on receipt of the supplier's credit note, a debit note settles the receivable. View `v_rebate_tracker` (purchased qty per brand per period vs slab).

### interest on overdue (computed, never auto-posted)
`v_party_interest`: for each open invoice past `credit_days`, `open_amount × interest_rate_pm/100 × overdue_months` (pro-rata days/30). Shown on the ageing report; posting is a manual debit note (admin) against `interest_income`.

### app_users (columns added)
`locale text DEFAULT 'en' CHECK (locale IN ('en','te')), invited_by UUID NULL, invited_at timestamptz NULL`. Max 10 active users enforced by a trigger (business is small; keeps Supabase Auth MAU trivial).

### v_attention (dashboard feed)
Union view: overdue parties beyond credit days (with computed interest), items below reorder, cheques due within 3 days (in hand or issued), un-invoiced challans > 7 days, transfers in transit > 2 days, yesterday's day-close difference ≠ 0, GST filing due dates from `fiscal_periods`.

## Requirement: Indexes (baseline, Phase 1)

```sql
CREATE INDEX ON journal_lines (party_id, entry_id);
CREATE INDEX ON journal_lines (account_id, entry_id);
CREATE INDEX ON journal_entries (entry_date);
CREATE INDEX ON journal_entries (source_type, source_id);
CREATE INDEX ON stock_movements (item_id, warehouse_id, movement_date);
CREATE INDEX ON sales_invoices (party_id, invoice_date DESC);
CREATE INDEX ON sales_invoices (status) WHERE status = 'draft';
CREATE INDEX ON purchase_invoices (party_id, invoice_date DESC);
CREATE INDEX ON payment_allocations (invoice_id);
CREATE INDEX ON payments (party_id, payment_date DESC);
CREATE INDEX ON audit_log (entity, entity_id);
CREATE INDEX ON bank_statement_lines (statement_id, match_status);
```
Lists paginate by keyset (`(date, id)` cursors), 50 rows per page. Views stay plain SQL; revisit materialisation only if a report exceeds 500 ms on production data (with ≤ 10 users and ≤ 50k journal lines/year this is not expected).

#### Scenario: challan then invoice keeps stock and books consistent
- WHEN a challan for 100 bags is posted and later converted to an invoice
- THEN stock on hand drops once (at challan time), goods-in-transit rises then falls to zero, COGS is recognised only at invoice time, and the challan links to the invoice

#### Scenario: cheque bounce re-opens the invoices
- WHEN `bounce_cheque` runs on a deposited receipt allocated to two invoices
- THEN a reversal entry mirrors the receipt, both allocations are removed, ageing shows the invoices open again, and the receipt's `cheque_status = 'bounced'`

#### Scenario: day close records the difference
- WHEN counted cash is ₹200 short of expected
- THEN `day_closes.difference = -200`, a journal entry Dr Cash over/short 200 · Cr Cash 200 exists, and tomorrow's `v_attention` lists it
