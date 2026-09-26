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
`singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton)` enforces at most one row; `legal_name, trade_name, gstin CHAR(15), state_code CHAR(2), address jsonb, fy_start_month int DEFAULT 4, einvoice_enabled bool DEFAULT false`

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
`series text /* 'DN','PB','CN','DB','RCPT','PAY','EXP'; later 'DC','GT','ADJ' */, doc_type source_type, fy_label text, prefix text, next_no int DEFAULT 1, UNIQUE(series, fy_label)`

### journal_entries
`entry_no bigserial, entry_date date, narration text, source_type source_type, source_id UUID, status doc_status DEFAULT 'posted', reversed_by UUID NULL REFERENCES journal_entries, posted_by UUID, posted_at timestamptz`

### journal_lines
`entry_id FK ON DELETE RESTRICT, line_no int, account_id FK accounts, party_id FK parties NULL, debit NUMERIC(14,2) DEFAULT 0, credit NUMERIC(14,2) DEFAULT 0, CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit + credit > 0))`

### stock_movements
`item_id FK, warehouse_id FK, movement_date date, qty NUMERIC(12,3) /* signed: + in, − out, base UOM */, rate NUMERIC(14,4), value NUMERIC(14,2), source_type source_type, source_id UUID`

### Documents
All document header tables carry `updated_at timestamptz` (maintained by trigger) for draft conflict detection, and both roles may DELETE drafts and their lines.

**sales_invoices**: `invoice_no text UNIQUE, invoice_date date, party_id FK, billing_address jsonb, shipping_address jsonb, place_of_supply CHAR(2), status doc_status DEFAULT 'draft', taxable_total, cgst_total, sgst_total, igst_total, round_off NUMERIC(6,2), grand_total /* all NUMERIC(14,2) */, journal_entry_id UUID NULL, vehicle_no text, transporter_name text, transporter_gstin text, transport_mode text, distance_km int, ewb_no text, ewb_date date, ewb_valid_until timestamptz, irn text, irn_ack_no text, irn_ack_date timestamptz, signed_qr text`

**sales_invoice_lines**: `invoice_id FK ON DELETE CASCADE, line_no, item_id FK, item_name text, hsn_code text, uom text, qty NUMERIC(12,3), alt_qty NUMERIC(12,3) NULL, rate NUMERIC(14,4), discount_pct NUMERIC(5,2) DEFAULT 0, taxable_value, gst_rate NUMERIC(5,2), cgst_amt, sgst_amt, igst_amt /* NUMERIC(14,2) */` — snapshot columns, never joined to `items` for display of posted docs.

**purchase_invoices / purchase_invoice_lines**: mirror of sales plus `supplier_bill_no text, supplier_bill_date date, rcm bool DEFAULT false, itc_eligible bool DEFAULT true`.

**credit_notes / debit_notes** (+ lines): same line shape, plus `against_invoice_id UUID NULL, reason text` — `credit_notes.against_invoice_id` references `sales_invoices`, `debit_notes.against_invoice_id` references `purchase_invoices`.

**payments**: `voucher_no text UNIQUE, direction text CHECK (direction IN ('receipt','payment')), payment_date date, party_id FK, mode payment_mode, instrument_no text, instrument_date date, amount NUMERIC(14,2), discount NUMERIC(14,2) DEFAULT 0, account_id FK /* cash or bank ledger */, status doc_status, journal_entry_id UUID`

**payment_allocations**: `payment_id FK, invoice_type text, invoice_id UUID, amount NUMERIC(14,2)` — Σ allocations ≤ payment amount + coalesce(discount, 0) (trigger).

**expense_vouchers** (+ lines): salaries, advances, wages, freight, rent, fuel. `voucher_no, voucher_date, party_id NULL /* employee or vendor */, status, journal_entry_id`; lines: `account_id, party_id NULL, amount, narration, rcm bool DEFAULT false`.

### audit_log
`actor UUID, action text, entity text, entity_id UUID, before jsonb, after jsonb, at timestamptz DEFAULT now()` — insert-only (no UPDATE/DELETE grants).

## Requirement: Integrity triggers

1. **Balanced entries** — deferred constraint trigger on `journal_lines`: at transaction end, for each touched `entry_id`, `SUM(debit) = SUM(credit)` else RAISE.
2. **Immutability** — BEFORE UPDATE OR DELETE on `journal_entries`, `journal_lines`, `stock_movements`: RAISE unless the only change is setting `journal_entries.reversed_by` on a previously-NULL value.
3. **Period lock** — BEFORE INSERT on `journal_entries` and `stock_movements`: RAISE if the date's `fiscal_periods.is_locked`, or if the date has no `fiscal_periods` row at all (missing period ⇒ blocked, not allowed).
4. **No negative stock** — in `post_*` functions (not a trigger): computed on-hand after movement must be ≥ 0, else RAISE `negative_stock` (admin may override via explicit flag).
5. **Leaf-only postings** — BEFORE INSERT on `journal_lines`: RAISE if `accounts.is_group`.
6. **Minimum lines** — deferred constraint trigger on `journal_entries`: an entry must have ≥ 2 lines at transaction end.
7. **Party rule** — BEFORE INSERT on `journal_lines`: `party_id` required when the account is `is_control`, forbidden otherwise.

## Requirement: Posting engine (plpgsql, SECURITY DEFINER)

All functions run in one transaction, take a document id, **derive the actor from `auth.uid()` (never a parameter — a caller-supplied uuid would let a `user` act as admin)**, validate status = 'draft', and return the created `journal_entry_id`. `REVOKE EXECUTE … FROM public, anon; GRANT EXECUTE … TO authenticated` on every one.

```
next_doc_no(p_series text, p_date date) RETURNS text
  -- SELECT ... FOR UPDATE on doc_sequences; gapless per FY series
post_sales_invoice(p_invoice_id uuid, p_override_credit bool DEFAULT false) RETURNS uuid
  -- validates party/lines; determines CGST+SGST vs IGST from place_of_supply vs org.state_code;
  -- journal: Dr AR(party) grand_total · Cr sales income per category · Cr output tax · Dr/Cr round_off
  -- + Dr COGS / Cr Inventory at weighted-avg cost; stock_movements OUT per line;
  -- sets status='posted', journal_entry_id; line snapshots (item_name, hsn_code, uom = base_uom,
  -- gst_rate) are re-copied from `items` under the item lock before tax is computed — draft line
  -- columns are client-writable and never trusted. Same for every post_* that owns item lines.
  -- Refuses the In Transit warehouse (DN_VALIDATION:invalid_warehouse), qty <= 0, rate < 0,
  -- discount outside 0..100 and a zero grand total (DN_VALIDATION:zero_total).
post_purchase_invoice(p_invoice_id uuid) RETURNS uuid
  -- Dr Inventory taxable · Dr input tax (if itc_eligible) · Cr AP(party); stock IN at cost;
  -- weighted avg recalc: new_avg = (on_hand_value + line_value) / (on_hand_qty + qty)
post_payment(p_payment_id uuid) RETURNS uuid
  -- receipt: Dr cash/bank · Cr AR(party) (+ Dr discount_allowed if discount>0); payment: mirrored
post_credit_note / post_debit_note
  -- proportional reversal of revenue+tax; stock back IN at original issue cost
post_expense_voucher(p_voucher_id uuid) RETURNS uuid
  -- generic Dr expense/advance lines · Cr cash/bank/salary_payable; employee advances hit
  --   employee_advance control with party_id; RCM lines additionally Cr rcm_payable + Dr input tax
cancel_document(p_source_type source_type, p_source_id uuid, p_reason text) RETURNS uuid
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
- Exactly two roles. **admin** (the family/owners): everything — post/cancel any document, credit/debit notes, purchases, expense/salary vouchers, stock transfers and adjustments, period lock/unlock, negative-stock override, settings, user management, all reports. **user** (general/counter staff): create and edit drafts, post sales invoices and receipts (daily billing must not block on admin), **post delivery challans and cash sales** (`post_cash_sale`), **deposit and clear cheques**, **close the day** (`post_day_close`), record employee advances; no cancellations (including reopening a day close), no purchases/expenses posting, no stock transfers or adjustments, no cheque bouncing, no P&L/Balance Sheet, no settings.
  - Owner decision (2026-09-19): a delivery challan is open to `user` deliberately. It grants strictly less authority than the sales invoice the same user may already post — no revenue, no COGS, two asset accounts, fully reversible while un-invoiced — and gating it above the invoice would stop the counter dispatching a lorry.
- Public signup SHALL be **disabled** in Supabase Auth; accounts are provisioned by the admin only. An authenticated session without an active `app_users` row gets nothing (RLS checks membership, not just `auth.uid()`).
- RLS enabled on every table, deny-by-default. Active members: SELECT on business tables (P&L/BS views admin-only). INSERT/UPDATE on draft documents: both roles. Posting functions re-check role internally per the matrix above.
- Posting functions are `SECURITY DEFINER`; direct INSERT on `journal_entries/journal_lines/stock_movements` is granted to **no role** — service role via functions only.
- **Role helpers (change 19).** `current_app_role()` is the single source of the caller's role: the active `app_users.role` for `auth.uid()`, except that an `admin` whose session is not `aal2` (JWT claim `aal`) gets **NULL** — no business access at all, not a downgrade to `user`. `is_active_member()` = `current_app_role() IS NOT NULL`. Every RLS policy, every `security_invoker` view and every posting function's role check goes through these two; functions SHALL NOT read `app_users.role` directly (`v_role := current_app_role()`). The `user` role ignores the claim. Exception kept on purpose: `app_users` policy `select_own_or_admin` lets a caller read their own row (`user_id = auth.uid()`) at any level, because the sign-in proxy and `/login/mfa` need it.

## Requirement: Seed data

Seed migration SHALL create: default CoA (per DESIGN.md §2.2 with all `system_key` accounts), one warehouse ('Head Godown') plus the hidden `In Transit` warehouse (change 05), fiscal periods for FY 2026-27, doc_sequences — **ten** series for FY 2026-27: `DN` (sales_invoice), `PB` (purchase_invoice), `CN` (credit_note), `DB` (debit_note), `RCPT` (payment, receipts), `PAY` (payment, outgoing), `EXP` (expense_voucher) from change 01, plus `DC` (delivery_challan), `TR` (stock_transfer), `ADJ` (stock_adjustment) from change 05 — organization placeholder row.

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
Header: `challan_no text UNIQUE, challan_date, party_id, warehouse_id, site_address jsonb, vehicle_no, driver_party_id NULL, status doc_status, invoice_id UUID NULL /* set when converted */, journal_entry_id NULL`. Lines: same snapshot shape as sales lines minus tax amounts (`gst_rate` is snapshotted; `value` carried for the EWB threshold), `CHECK (qty > 0)`.
Posting: **one** stock movement — OUT of the challan's warehouse at weighted-average cost. There is no movement into any warehouse: the goods have physically left, and `goods_in_transit` is an **account**, not a godown. The value moves in the journal only (Dr Goods in transit · Cr Inventory at avg cost). Converting to invoice: the invoice posts revenue + tax, writes **no** stock movement, and relieves goods-in-transit (Dr COGS · Cr Goods in transit at the cost the challan carried out) instead of Inventory; the invoice may not be dated before its challan (`DN_VALIDATION:invoice_before_challan`). So on-hand drops exactly once, at challan time, and the stock ledger's post-opening movement value always equals the Inventory GL balance while Goods in Transit holds exactly the delivered-but-uninvoiced cost. Un-invoiced challans older than 7 days surface in `v_attention`.

### quotations + quotation_lines (Phase 2)
`quote_no, quote_date, party_id, valid_until, status text CHECK (status IN ('open','accepted','expired','converted')), converted_invoice_id NULL`. Lines snapshot item + rate. No journal or stock effect ever.

### stock_transfers + stock_transfer_lines
`transfer_no, transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status text CHECK (status IN ('draft','in_transit','received','cancelled')), received_at, received_by`, `CHECK (from_warehouse_id <> to_warehouse_id)`. Post: OUT from source at avg cost, IN to **the** seeded `In Transit` warehouse (`warehouses.is_transit`, one row only, enforced by a partial unique index — not a per-transfer bucket); receive: OUT of transit, IN to destination at the same rate (no revaluation), dated the day of receipt in the org timezone. No journal entry in either direction (value stays in Inventory). Neither end of a transfer may name the transit warehouse itself. Cancellable from `draft` (nothing moved) or `in_transit` (movements mirrored back to the source); once `received` the correction is a new transfer the other way (`DN_TRANSFER_STATE`).

### payments (columns added)
`cheque_status cheque_status NULL, cheque_bank text, deposited_on date, cleared_on date, bounced_on date, bounce_reversal_entry_id UUID NULL`
- Receipt by cheque posts to a **Cheques in hand** ledger (system_key `'cheques_in_hand'`, asset) not Bank; `deposit` moves to Bank (Dr Bank · Cr Cheques in hand); `bounce` posts a reversal of the original receipt and deletes allocations (function `bounce_cheque(p_payment_id, p_actor)`).
- Payment by cheque: Cr Bank at issue (status `issued`), `presented` is informational.

### bank_statements + bank_statement_lines
`bank_statements: account_id, period_from, period_to, imported_by, imported_at, source_file text`
`bank_statement_lines: statement_id, txn_date, narration text, debit NUMERIC(14,2), credit NUMERIC(14,2), balance NUMERIC(14,2) NULL, matched_payment_id UUID NULL, matched_entry_id UUID NULL, match_status text CHECK (match_status IN ('unmatched','auto','manual','ignored'))`. Matching is by amount+date window (±3 days) then narration token overlap; unmatched lines create receipts/expenses via existing actions. View `v_bank_recon` (book vs bank balance, unmatched count). **Owner-only to read and write** (bank balances are not counter-staff data): both tables and `v_bank_recon`, as with `v_employee_ledger` (salary data), return nothing to a `user` role (decided in the second review of change 06).

### attachments
`entity text, entity_id UUID, storage_path text, mime text, bytes int, uploaded_by, uploaded_at` — Supabase Storage bucket `docs` (private, RLS via signed URLs, 5 MB cap). Used first for purchase-bill photos.

### day_closes
`close_date date, opening_cash, cash_in, cash_out, deposited, expected NUMERIC(14,2), counted NUMERIC(14,2) CHECK (counted >= 0), difference NUMERIC(14,2), note text, closed_by, closed_at, journal_entry_id NULL, status doc_status DEFAULT 'posted'`. One **live** close per date: a partial unique index on `close_date WHERE status <> 'cancelled'`, so a reopened close keeps its row (the audit trail the reopen rule asks for) and the date can be closed again.

`post_day_close(p_date, p_counted, p_note)` — three arguments; the actor is `auth.uid()` inside the function like every other posting function. It computes `expected = opening_cash + cash_in − cash_out − deposited` from the cash ledger, where `deposited` is the day's cash credits whose entry also debits `bank` and `cash_out` is every other credit, so no outflow is counted twice and `expected` is by construction the cash ledger's closing balance for that date. The difference posts to `cash_over_short` (Dr/Cr Cash) **dated on `p_date`**; a difference of exactly zero posts no entry and leaves `journal_entry_id` NULL. It locks nothing (period locks are separate) and returns the journal entry id, or NULL when there was no difference. Reopening is admin-only (`cancel_document('day_close', …)`) and audit-logged, and its reversal is dated on `close_date` — not on the day of the reopen — so the cancelled adjustment cannot leak into a later re-close's `expected`.

**Ordering:** days may be closed out of order, and a day already closed can be reopened and re-closed. `opening_cash`, `cash_in`, `cash_out`, `deposited` and `expected` are therefore **informational snapshots** of what the ledger said at the moment of the close; the ledger itself is the truth, and a back-dated entry can leave an older close's stored numbers stale. Reports read the ledger, never these columns.

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

## Requirement: Implementation clarifications (pre-implementation audit, 2026-09-16)

Resolutions for gaps found while auditing changes 03–18 against this spec. Each is binding; the change named owns the migration.

### Actor and grants (all `post_*`/`cancel_*`, change 03 onward)
Actor = `auth.uid()`; `RAISE 'DN_FORBIDDEN'` when null or when `current_app_role()` is not the required role (NULL for a non-member or an admin not at `aal2`). Functions are `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE EXECUTE FROM public, anon`, `GRANT EXECUTE TO authenticated`. `audit_log.actor` = that uid.

### Numbering (change 03)
`next_doc_no(p_series text, p_date date) RETURNS text`: `fy_label` derived from the date with April start (`'2026-27'`); if no `doc_sequences` row exists for (series, fy_label) it is created with `prefix = series || '/' || 'YY-YY' || '/'` and `next_no = 1`; row locked with `FOR UPDATE`; result = `prefix || lpad(next_no, 4, '0')` (e.g. `DN/26-27/0347`); `next_no` incremented in the same statement. Never called at draft time.

### Tax and rounding (changes 03, 04, 20)
- Line: `taxable_value = round(qty × rate × (1 − discount_pct/100), 2)`; intra-state: `cgst_amt = sgst_amt = round(taxable × gst_rate/200, 2)`, `igst_amt = 0`; inter-state: `igst_amt = round(taxable × gst_rate/100, 2)`.
- **Which state decides.** On a **sale**, `place_of_supply` vs `organization.state_code`. On a **purchase**, the **supplier's** `parties.state_code` vs ours: an inward bill's place of supply is our own state in both the intra- and the inter-state case, so it cannot tell CGST+SGST from IGST and is not authoritative. `purchase_invoices.place_of_supply` is retained for GSTR-2 reporting only and is never read by `post_purchase_invoice`.
- `purchase_invoices.rcm` has **no posting path** in Phase 1: `post_purchase_invoice` raises `DN_VALIDATION:rcm_purchase_unsupported`. The one Phase-1 reverse-charge case (GTA freight) is a linked expense voucher — see RCM freight below.
- Header totals = Σ lines. `grand_total = round(taxable_total + tax totals, 0)`; `round_off = grand_total − unrounded sum`. Postgres `round(numeric)` is half-away-from-zero, so the true range is **[−0.49, +0.50]**, not the reverse. The Dr/Cr direction stated here — **Dr when negative, Cr when positive — is the sales side**, where the rounded grand total is debited to AR. On a **purchase** the rounded total is *credited* to AP, so the same arithmetic reverses: a positive round-off is Dr `round_off`, a negative one is Cr. Each posting function derives the side from which leg carries the rounded total; neither is a special case of the other.
- The function overwrites header totals with its own computation; client-submitted totals are ignored.

### Income and stock accounts by item (change 03)
Add `system_key` to seeded accounts via `UPDATE accounts SET system_key = …` in change 03's migration: `'sales_cement'` (4100), `'sales_steel'` (4200), `'sales_other'` (4300), `'freight_recovered'` (4400), `'discount_received'` (4500), `'salaries'` (5500), `'godown_rent'` (5400). Sales line income account = by `items.category` (cement/steel/other). Add `items.is_stock bool NOT NULL DEFAULT true`; non-stock items (freight, loading charges billed to customer) post to `freight_recovered` and create **no** stock movement; they carry the goods' GST rate (composite supply) through the freight item's own master `gst_rate`, which the posting function snapshots onto the line like any other (it never trusts a client-written `gst_rate`; a different composite rate needs its own freight item).

### Warehouse on documents (change 03)
Add `warehouse_id uuid NOT NULL REFERENCES warehouses` to `sales_invoices` and `purchase_invoices` (default = `warehouses.is_default` at draft creation, set by the action). Stock movements use it. Challans, transfers, adjustments carry their own.

### COGS and weighted average (change 03)
`stock_on_hand(item, warehouse)` = Σqty, Σvalue over movements; `avg_rate = round(Σvalue/Σqty, 4)` (0 when qty = 0). Sale movement: `rate = avg_rate`, `value = round(qty × rate, 2)`, qty negative. Purchase movement: `rate = line taxable_value/qty` (+ tax when `itc_eligible = false`), value positive. `DN_NEGATIVE_STOCK` when resulting on-hand < 0 unless `organization.allow_negative_stock` is true (add that column, default false; admin toggles it in Settings) **and** the actor is admin.

### Credit limit (change 03)
If `parties.credit_limit > 0` and current AR balance (from journal lines on `ar` for the party) + `grand_total` > `credit_limit`: `RAISE 'DN_CREDIT_LIMIT'` unless `p_override_credit` and actor is admin. The override is audit-logged with `after.override = true`.

### Walk-in customer (change 03 seed)
Seed one party: `name = 'Cash / Walk-in customer'`, `type = 'customer'`, `state_code = '37'`, `gstin NULL`, `credit_limit = 0` (which since the change-04 review means **no credit at all**, not unlimited), plus `parties.is_walk_in bool DEFAULT false` set true on it. A cash sale is **one transaction**: `post_cash_sale(p_invoice_id, p_account_id)` posts the invoice and a full-amount receipt allocated to it atomically, skipping the credit-limit check on that path only because AR nets to zero before commit — which is exactly what lets a `credit_limit = 0` party buy for cash. A failure in the receipt leg rolls the invoice back with it, so there is no posted-and-unpaid intermediate state. (This supersedes the earlier two-transaction "Post & receive cash" note.)

### Stock adjustments (change 05 — table was missing)
`stock_adjustments`: `adj_no text UNIQUE, adj_date, warehouse_id, status doc_status, reason text, journal_entry_id` + `stock_adjustment_lines: adjustment_id, item_id, item_name (snapshot), qty NUMERIC(12,3) signed, rate NUMERIC(14,4) NULL /* NULL = use avg */`. `post_stock_adjustment(id)`: admin only; Dr `stock_loss` / Cr `inventory` for negative qty at avg rate, reverse for positive at the given rate (or avg). Series `ADJ`.

### Enum extensions (change 05)
`ALTER TYPE … ADD VALUE` for `delivery_challan`, `stock_transfer`, `quotation`, `day_close` goes in its **own migration file** before the one that uses the values (a value added inside a transaction cannot be used in that transaction). Add `stock_adjustment` is already present.

### Transit for transfers (change 05)
Model in-transit stock as a seeded system warehouse `name = 'In Transit'`, `warehouses.is_transit bool DEFAULT false` set true; hidden from pickers. `post_stock_transfer` moves OUT of source / IN to transit at the source avg rate; `receive_stock_transfer(id)` moves OUT of transit / IN to destination at the same rate. No journal entry.

### Challan → invoice (change 05 + 03 hook)
Add `sales_invoices.challan_id uuid NULL REFERENCES delivery_challans`. When set, `post_sales_invoice` posts COGS as Dr `cogs` / Cr `goods_in_transit` (no new stock movement) and marks the challan `invoice_id`. Lines must match the challan's items and quantities (`DN_VALIDATION:challan_mismatch` otherwise).

### RCM freight (change 04)
RCM freight is **not** a purchase-invoice line. The purchase form's freight block creates a linked `expense_vouchers` row (`party_id` = lorry owner, line account `freight_inward`, `rcm = true`, `purchase_invoice_id` reference column added to `expense_vouchers`). `post_expense_voucher` on an RCM line additionally posts Cr `rcm_payable` 5% and Dr `input_cgst`/`input_sgst` 2.5% each (intra-state GTA) — ITC on RCM is claimable in the month the tax is paid; the 3B view handles timing, the posting does not.

### Payment allocations (change 04)
Trigger on `payment_allocations` (`SECURITY DEFINER` — it reads RLS-protected tables to enforce its caps, and a policy-filtered read makes a cap silently pass): Σ amount per payment ≤ `payments.amount + coalesce(payments.discount, 0)` (owner decision 2026-09-19: AR is credited by amount + discount, so allocations may close the invoice fully); each allocation ≤ that invoice's open amount; `invoice_type` ∈ (`'sales_invoice'`,`'purchase_invoice'`) and must match `payments.direction` (receipt → sales, payment → purchase); the invoice's `party_id` must equal the payment's (`DN_VALIDATION:allocation_party_mismatch`); a `cancelled` payment can never be allocated. Every INSERT/UPDATE/DELETE writes an `audit_log` row. Unallocated remainder is simply AR/AP balance with no allocation row ("on account").

**Only a posted payment's allocations count** (owner decision, 2026-09-19). Open amount = `grand_total − Σ allocations of *posted* payments − posted credit/debit notes`, and `DN_HAS_ALLOCATIONS` likewise fires only for allocations of posted payments. A draft receipt is a plan, not money: two operators must both be able to draft receipts against the same invoice, and a half-typed draft must not freeze an invoice against cancellation. The race is resolved at posting time instead — `post_payment` re-validates every allocation under the payment's lock (caps, party match, invoice still posted), so the second draft to post fails with `DN_VALIDATION:allocation_exceeds_invoice` rather than over-settling the invoice.

### Payments: discount and cheques (change 04)
Receipt with `discount > 0`: Dr `discount_allowed`; payment with discount: Cr `discount_received`. Cheque receipt: Dr `cheques_in_hand` (add system_key + account 1130 in change 04) instead of bank; `deposit_cheque(id)`: Dr bank / Cr cheques_in_hand, status `deposited`; `mark_cheque_cleared(id)`: status only; `bounce_cheque(id, p_reason)`: admin; reversal entry of the receipt (or of the deposit + receipt if deposited), allocations deleted, status `bounced`. Cheque payment: Cr bank at post, status `issued`; `presented` is informational. Posting a receipt or payment with discount > 0 is admin-only (owner decision 2026-09-19).

### Salaries, advances, wages (change 04)
One voucher, one entry, employee ledger via control accounts only (the party rule forbids `party_id` on expense accounts):
- Advance: Dr `employee_advance` (party) / Cr cash|bank. `user` role limit ₹5,000 per voucher (`DN_FORBIDDEN` above).
- Salary for month M: Dr `salaries` gross; Cr `salary_payable` (party) gross; Dr `salary_payable` (party) gross; Cr `employee_advance` (party) recovered; Cr cash|bank net. Recovered = min(advance balance, gross) unless the voucher specifies less.
- Daily wages for a named worker: same shape with gross = days × rate through `salary_payable`, expense account `loading_unloading`. Unnamed casual hamali: Dr `loading_unloading` / Cr cash, no party.
`v_employee_ledger` = lines on `employee_advance` + `salary_payable` for the party.

### Views (change 06)
All views `WITH (security_invoker = true)` so base-table RLS applies. Admin-only views (`v_pnl`, `v_balance_sheet`, `v_trial_balance`) add `WHERE current_app_role() = 'admin'` so a `user` sees zero rows rather than an error. Views take no parameters: they expose `entry_date`/`month` columns and the app filters. `v_party_balances.balance` sign: positive = party owes us (AR) or we owe them (AP) per `type`; `v_party_aging` buckets from open sales invoices (grand_total − allocations − credit notes), on-account receipts shown as a separate `unallocated` column, not netted into buckets. `v_stock_summary` and `v_stock_ledger` exclude the transit warehouse unless asked.

**Known limit (accepted for Phase 1, owner decision 2026-09-19).** The admin-only views (`v_pnl`, `v_balance_sheet`, `v_trial_balance`) gate at *view level only*. Members read every business table under the RLS spec, so a `user` can still `SELECT` `journal_lines`, `journal_entries` and `accounts` directly and derive the same figures. Accepted for Phase 1 (≤ 10 family users, all trusted). Revisit before go-live: replace the direct member read on the ledger tables with SECURITY DEFINER user-facing views (role-checked inside), so the data itself, not just the report, is gated.

### Dashboard views (change 14)
`v_sales_daily` (`sale_date`, `invoice_count`, `billed_total`, `round_off`; posted invoices, grand totals, not net of credit notes), `v_sales_daily_category` (`sale_date`, `category`, `amount` = taxable + GST of the lines; Σ amount + round_off = billed_total; category read from `items` at query time, lines carry no snapshot) and `v_money_balances` (`account_id`, `code`, `name`, `system_key`, `balance`; money accounts, **admin-only** like `v_bank_recon`). All security_invoker, SELECT to authenticated. Migration `20260927100000_dashboard_views.sql`, pgTAP `00022` (also a `has_column` drift guard for every column the dashboard reads).

### Report read functions and views (change 15)
`day_close_preview(p_date)` (`SECURITY DEFINER`, both roles, `stable`, `EXECUTE` to `authenticated` only): returns `close_date, opening_cash, cash_in, cash_out, deposited, expected` computed exactly as `post_day_close` computes them (a pgTAP drift guard compares the two), so the counter's screen shows the figure the close will store even though payroll cash entries are hidden from them line by line. `v_money_ledger` (`security_invoker`, admin-gated like `v_money_balances`): every posted line on a money account with `running_balance` = the account's all-time `debit - credit` up to and including the row (`order by entry_date, entry_no, line_no, id`); the opening balance of a date range is the running balance of the last row before it, so reports read it and never re-add. The ageing, day-book and stock reports read `v_party_aging`, `v_day_book` and `v_stock_summary(_all)` unchanged.

### Opening balances (change 17)
`post_opening_balances(p_date)`: admin; one journal entry `source_type = 'opening'` with AR/AP lines per party (party rule), cash/bank, and the balancing line to an equity account `'opening_balance_equity'` (add system_key + account 3900); opening stock = stock_movements `'opening'` per item/warehouse at given rate + Dr `inventory` / Cr `opening_balance_equity`. Fiscal periods for the opening month must exist (change 02 rule).

### Masters write policies (change 09)
Admin: INSERT/UPDATE on all masters. `user`: INSERT/UPDATE on `parties` and `party_addresses` only (walk-in and new site customers at the counter), no DELETE anywhere; deactivation is `is_active = false`. `organization`, `accounts`, `items`, `warehouses`, `fiscal_periods`, `doc_sequences`: admin only. `app_users`: no client writes; invites/disable go through a `SECURITY DEFINER` function `admin_set_user(p_user_id, p_role, p_active)` that checks the caller is admin and enforces ≤ 10 active.

## Requirement: Non-functional invariants (system-design audit, 2026-09-16)

### Concurrency and lock ordering (changes 03–05, 20)
- Every posting function acquires locks in this fixed order to make deadlocks impossible: (1) the document row `FOR UPDATE`; (2) the party row `FOR UPDATE` (credit-limit check reads a consistent balance); (3) every item row touched, `FOR UPDATE`, **ordered by item id**; (4) the `doc_sequences` row. Never in another order.
- The negative-stock check runs after the item lock, so two simultaneous sales of the last bags cannot both pass.
- Weighted average is computed after the item lock from all movements; concurrent purchases therefore serialise per item, which is correct.
- Draft edits: `updated_at` compared in the action's WHERE clause (`UPDATE … WHERE id = $1 AND updated_at = $2`); zero rows updated → `conflict`.

### Idempotency
- `post_*` on a non-draft raises `DN_NOT_DRAFT` and writes nothing. Double-submits from the UI therefore cannot double-post.
- `cancel_document` on an already-cancelled document raises `DN_NOT_POSTED`.
- `receive_stock_transfer`, `deposit_cheque`, `mark_cheque_cleared` are state-machine transitions; an invalid transition raises `DN_CHEQUE_STATE` / `DN_TRANSFER_STATE`.

### Cancellation edge cases
- `cancel_document` on a sales invoice with any `payment_allocations` raises `DN_HAS_ALLOCATIONS` — the receipt must be re-allocated or reversed first. Same for purchase invoices.
- Cancelling a purchase whose stock has since been sold raises `DN_NEGATIVE_STOCK` (the reversal would take stock below zero); the fix is a debit note for the quantity still on hand, never a forced reversal.
- Cancelling a challan already converted to an invoice raises `DN_CONVERTED`; cancel the invoice first (which reopens the challan).
- Credit note quantity per line ≤ invoiced quantity − prior credit notes on that invoice line (`DN_VALIDATION:qty_exceeds_invoice`).

### Time zone
- Business dates are `date` columns in **Asia/Kolkata**. Vercel functions run in UTC, so "today" is computed as `(now() AT TIME ZONE 'Asia/Kolkata')::date` in SQL and with the same zone in TS (`Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata' })`). Add `organization.timezone text NOT NULL DEFAULT 'Asia/Kolkata'`. `post_day_close` uses this date. Never `CURRENT_DATE` in functions.

### Fiscal-year rollover
- `next_doc_no` creates the next FY's sequence rows automatically (see Numbering).
- Fiscal periods do **not** auto-create (change-02 rule: missing period blocks). Admin function `ensure_fiscal_year(p_label text)` creates the 12 rows; `v_attention` raises "Create FY 20XX-XX periods" from 1 March if next April's row is missing.

### Function exposure (change 03 onward)
- At the top of change 03's migration: `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public;` and explicitly revoke on every function created so far (`is_active_member`, `current_app_role`, trigger functions, `touch_updated_at`). Only `post_*`, `cancel_document`, `receive_stock_transfer`, cheque transitions, `post_day_close`, `admin_set_user`, `ensure_fiscal_year`, `stock_on_hand` get `GRANT EXECUTE TO authenticated`. `next_doc_no` is internal: no grant.
- `audit_log` gets the same `reject_mutation` trigger as the ledger (insert-only enforced by trigger, not just by missing grants).

### Data volume and retention
- Expected ≤ 50k journal lines and ≤ 5k documents per year; every list uses keyset pagination on `(date, id)`; no report needs materialisation at this scale. Re-evaluate only if a view exceeds 500 ms in `pg_stat_statements`.
- FY close = export bundle (change 25); no rows are ever deleted. Attachments (bill photos) are the only growth risk: 5 MB cap, and the 1 GB Free storage limit is monitored in `v_attention` (admin) at 80%.

#### Scenario: last bags cannot be sold twice
- WHEN two sessions post invoices for the remaining 10 bags of an item at the same moment
- THEN exactly one succeeds and the other raises `DN_NEGATIVE_STOCK`, and stock on hand is 0, not −10

#### Scenario: cancel is blocked by an allocated receipt
- WHEN `cancel_document` runs on an invoice that a posted receipt is allocated to
- THEN it raises `DN_HAS_ALLOCATIONS` and nothing changes

## Requirement: Decisions from change 04 review (2026-09-18)

- **Cheque banking is counter work.** `deposit_cheque` and `mark_cheque_cleared` are permitted for `user` as well as `admin` (they move money between our own accounts, or change status only). `bounce_cheque` stays admin (it reverses a receipt).
- **Issued cheque that bounces:** no dedicated function in Phase 1. The admin cancels the payment via `cancel_document` (reversal) and records a new payment when re-issued. Revisit only if it recurs.
- **Refunds** (money back to a customer, or from a supplier) are Phase 2: a `payments.direction` value `'refund'` with mirrored posting. Phase 1 handles them as credit/debit notes plus, if cash actually moves, a manual admin journal. Added to feature-roadmap.
- **Salary period:** add `expense_vouchers.period_month date NULL` (first of month) in change 04's migration; the salary/wage voucher sets it; `v_employee_ledger` groups by it.
- **Credit limit semantics fixed:** `parties.credit_limit` becomes **nullable**; `NULL = unlimited` (default for new parties), `0 = no credit`. The walk-in party is seeded with 0. `post_sales_invoice` checks `credit_limit IS NOT NULL AND balance + grand_total > credit_limit`. Migration in change 05: alter column, set existing `0` rows to `NULL` except `is_walk_in`.
- **Cash sale is one transaction:** `post_cash_sale(p_invoice_id uuid, p_account_id uuid) RETURNS uuid` (change 05) posts the invoice and a full-amount receipt allocated to it atomically; the credit-limit check is skipped only inside this path because AR nets to zero before commit. Implement by moving the body of `post_sales_invoice` into an internal `_post_sales_invoice(p_invoice_id, p_skip_credit bool)` with **no grant to any role**; the public `post_sales_invoice` calls it with `false`. Supersedes the two-transaction `postAndReceiveCash` note in api-architecture; the action becomes a single `rpc('post_cash_sale')`.

## Requirement: Decisions from the change 04/05 reviews (2026-09-19)

Fixes and owner decisions from the two fresh-context reviews of the posting engine. Each is binding; changes 04 and 05 own the migrations.

### Money accounts
`accounts.is_money bool NOT NULL DEFAULT false`, true on the `cash` and `bank` system accounts. A helper `is_money_account(uuid)` (asset, not group, not control, `is_money`) gates every leg where real money moves: `post_payment.account_id`, `post_expense_voucher.pay_account_id`, `deposit_cheque`, `post_cash_sale.p_account_id`. `cheques_in_hand` is deliberately **not** a money account — a cheque in the drawer is not cash. A cheque *receipt* may not name the cash account at all (its `account_id` is the bank it will be deposited into). Opening a second bank ledger is one `UPDATE accounts SET is_money = true`, never a code change.

### Cost basis
A sale of stock carrying no cost (`avg_rate <= 0` with `qty > 0`) raises `DN_VALIDATION:no_cost_basis` rather than posting revenue against zero COGS. A challan whose goods carry no cost raises `DN_VALIDATION:zero_cost`; a stock-adjustment *increase* valued at zero raises `DN_VALIDATION:zero_rate`; an adjustment moving no value at all raises `DN_VALIDATION:zero_value`.

### Cancelling a purchase whose stock has moved
Quantity alone does not prove a purchase is still reversible. `cancel_document` raises `DN_NEGATIVE_STOCK` when, for any (item, warehouse) the bill touched, a non-reversal movement from another document exists on or after the purchase's own movement date, or when the reversal would leave the stock ledger with negative value. Weighted average is a running average: once later movements have consumed stock at the blended rate, removing the purchase re-prices the remainder at a rate it never had. The remedy stays a debit note for the quantity still on hand.

### Employee vouchers
An advance/salary/wage voucher's party must be an **active** party of type `employee`; a `salary` voucher with no party raises `DN_VALIDATION:missing_party` (unnamed casual hamali remains a `wages` voucher with no party). Cancelling an advance the salary has already recovered raises `DN_VALIDATION:advance_already_recovered` — cancel the salary first, which restores the advance. RCM freight is refused for an inter-state or party-less transporter (`DN_VALIDATION:rcm_interstate`): the posting hard-codes the intra-state GTA CGST/SGST split.

### Table grants (owner decision)
RLS is not the only lock on the ledger. `anon` holds **no** privileges on any table in `public` (and `ALTER DEFAULT PRIVILEGES` keeps it that way for tables created later). `authenticated` **and** `service_role` hold no INSERT/UPDATE/DELETE on `journal_entries`, `journal_lines`, `stock_movements` or `audit_log` — the `post_*`/`cancel_*` functions are `SECURITY DEFINER` and keep working, so nothing legitimate needs those grants, and `service_role` (which bypasses RLS entirely) stops being the one identity that could rewrite history.

### Single transit warehouse
Exactly one `warehouses.is_transit` row, enforced by a partial unique index, since the transfer functions resolve it with `WHERE is_transit`.

## Implementation clarifications: owner-only salary data (change 13, 2026-09-26)

- `parties.monthly_salary` / `daily_wage`: column-level SELECT is not granted to `authenticated`; the only readers are `employee_pay_rates()` (SECURITY DEFINER, returns rows for an admin only) and `v_employees` (security_invoker, admin-gated, the staff list read model). A column added to `parties` later has no SELECT grant until granted on purpose.
- `expense_vouchers` / `expense_voucher_lines` of type `salary` and `wages` are visible to admins only (a `user` still sees expense and advance vouchers).
- Pay rates cannot be written by a non-admin app session at all: trigger `parties_pay_guard` (`BEFORE UPDATE OF monthly_salary, daily_wage`) raises `DN_VALIDATION:admin_only_field` even when the value is unchanged, so an UPDATE/PATCH is not an oracle for the stored rate (`parties_guard` alone refused only a *different* value). WHERE/RETURNING on the columns is refused by the column grant. A counter INSERT already has both columns nulled by `parties_guard`.
- Payroll ledger rows are owner-only (migration `20260926110000`): the SELECT policies on `journal_entries`, `journal_lines` and `audit_log` hide from a non-admin every journal entry whose source is a `salary` or `wages` expense voucher (original and its cancellation reversal, which share the source), all of their lines, and the `expense_vouchers` audit rows of those vouchers (which carry `voucher_type`, `gross`, `recovered`). The rule is by the entry's source, never by line party, so an entry is hidden whole: every entry a `user` can see is complete and balanced, and `v_day_book` simply has no payroll rows for them. Helpers `hidden_payroll_entry_ids()` / `hidden_payroll_voucher_ids()` are SECURITY DEFINER (the voucher headers are invisible to the caller) and return nothing to an admin. Advances and ordinary expense vouchers (even ones posted to Salaries 5500) are not payroll by this rule and stay visible. Posting functions are SECURITY DEFINER (owner bypasses RLS) and `check_journal_balanced` / `check_journal_has_lines` are now SECURITY DEFINER too, since deferred constraint triggers fire at COMMIT as the session role. A new view or screen that computes cash for a `user` from `journal_lines` will not see payroll cash; anything a counter must reconcile (day close `expected`) comes from a SECURITY DEFINER function.
- Salaries account: `accounts` code `5500` Salaries carries `system_key = 'salaries'` (set in change 03); salary vouchers post their gross to it.
- Not closed: (a) inference only — `day_closes.cash_out`/`expected` (readable by a `user`, who does the close) include payroll cash, so a day with a single cash salary reveals that net amount paid, not to whom; (b) entry numbering gaps / the helper functions reveal that hidden entries exist, never amounts; (c) change 19: cost columns of `v_stock_summary` / `v_stock_ledger` and `stock_movements.rate/value` (owner-only stock cost, a business-only leak) remain readable through the API, and aal1 admin sessions see everything an aal2 one does.
