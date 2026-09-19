Skill: daksh-schema
Spec section: openspec/specs/db-architecture/spec.md → "### Views (change 06)" (under Implementation clarifications) + "## Requirement: Views (read model)" + "### v_attention (dashboard feed)", "### interest on overdue", "### bank_statements + bank_statement_lines", "### parties (columns added)", "### Employee vouchers"/"Salaries" clarifications for `v_employee_ledger`, "### Fiscal-year rollover"
Context: Changes 01–05 wrote the whole posting engine; nothing reads it yet. This change adds the read model: plain-SQL `v_*` views the app (dashboard, ledgers, ageing, stock, reports) and the family's self-check reports will query. Views never write, never store numbers that the ledger can derive, and must respect RLS (`security_invoker = true`). Balances must reconcile with the posted journal and stock ledger, so the acceptance test is a reconciliation, not a snapshot.
Do not: read other specs; implement UI; materialise anything; edit migrations 01–05 (new files only); touch journal tables directly; build GSTR views; push to hosted.

## Scope

**In:** `v_trial_balance`, `v_pnl`, `v_balance_sheet` (admin-only predicate), `v_party_ledger`, `v_party_balances`, `v_party_aging`, `v_party_interest`, `v_stock_summary`, `v_stock_ledger`, `v_day_book`, `v_employee_ledger`, `v_bank_recon`, `v_attention`.

**Out (deferred, log in notes):**
- `v_gstr1_b2b`, `v_gstr1_b2c`, `v_hsn_summary`, `v_gstr3b_summary` → change 18 (it owns the GSTR schema research prerequisite).
- `v_rebate_tracker` → Phase 2 (brand rebates).

## Conservative defaults (owner unknowns — log each in `implementation-notes.md`)

1. **`parties.interest_rate_pm`** (`NUMERIC(5,2) NOT NULL DEFAULT 0`) does not exist yet; add it in this change's migration (spec: "parties (columns added)"). Skip `whatsapp_phone`/`default_site_id` — change 09 owns them. Interest = 0 when rate is 0.
2. **`bank_statements` + `bank_statement_lines`** do not exist. Create both exactly as specced (RLS: active members read, admin write; no app writes yet — Phase 2 owns import/matching) so `v_bank_recon` (book balance of each `is_money` bank account vs latest statement closing balance, unmatched-line count) can exist. Empty tables → view returns book balance with NULL bank balance and 0 unmatched.
3. **GST filing due dates** in `v_attention`: no column exists. Derive: GSTR-1 due on the 11th and GSTR-3B on the 20th of the month after each month with posted sales, only while that month is not yet marked filed — there is no "filed" flag in Phase 1, so show the *next upcoming* due date within 7 days, computed from `(now() AT TIME ZONE organization.timezone)::date`. Never `CURRENT_DATE`.
4. **Sign conventions:** follow the spec (`v_party_balances.balance` positive = party owes us for customers, we owe them for suppliers, per `type`; a `both` party gets AR and AP shown as two columns `ar_balance`, `ap_balance` plus net). Trial balance `closing` = Σdebit − Σcredit with the natural side in a `side` column.
5. **Transit warehouse** (`warehouses.is_transit`) excluded from `v_stock_summary`/`v_stock_ledger` by default; expose an `is_transit` column so the app can opt in.
6. **Admin-only views** (`v_trial_balance`, `v_pnl`, `v_balance_sheet`): `WHERE current_app_role() = 'admin'` → a `user` sees zero rows, no error. Check `current_app_role()` is `STABLE` and executable by `authenticated` (change 03 revoked default function privileges — grant if needed; do not weaken anything else).
7. **Grants:** `GRANT SELECT` on each view to `authenticated` only; nothing to `anon`. Confirm change 05's "revoke writes on ledger tables" still leaves `security_invoker` views readable (views read as the caller, so `authenticated` needs SELECT on the base tables — verify, don't assume).

## View notes

- **`v_party_ledger`**: from `journal_lines` on control accounts `ar`/`ap` (+ employee accounts excluded — those are `v_employee_ledger`). Columns: party_id, entry_date, entry_id, source_type, doc ref (join the document number via `source_type`/`source_id`), debit, credit, running balance (window over `entry_date, entry_id, line id`). Includes reversals as their own rows.
- **`v_party_aging`**: open **sales** invoices = `grand_total − Σ posted allocations − Σ posted credit notes` (credit notes don't exist until change 20 — leave a clearly commented join point or `0`); buckets 0–30/31–60/61–90/90+ by days past **invoice date** (spec: bucket from open invoices; if `credit_days` shifting is preferred, log it); `unallocated` = on-account receipts not allocated, shown separately. Draft-payment allocations do **not** count (change 04 decision).
- **`v_party_interest`**: per open invoice past `credit_days`: `open_amount × interest_rate_pm/100 × (overdue_days/30)`, computed `numeric`, rounded to 2 in the view.
- **`v_stock_summary`**: item × warehouse: qty, `avg_rate = round(Σvalue/Σqty,4)` (0 when qty 0), value; must equal `stock_on_hand()`. **`v_stock_ledger`**: movements with running qty/value per item×warehouse.
- **`v_day_book`**: all posted entries by date with source type, narration/ref, total debit; reversal entries flagged.
- **`v_employee_ledger`**: lines on `employee_advance` + `salary_payable` per employee party, grouped/labelled by `expense_vouchers.period_month` where the source is a voucher.
- **`v_pnl`**: income/expense accounts, net by `entry_date`/month (views take no parameters — expose `entry_date`/`month`, the app filters). **`v_balance_sheet`**: asset/liability/equity by account plus current-period profit rolled into equity so the sheet balances.
- **`v_attention`**: one row per item — `kind`, `severity`, `subject_id`, `title`/`detail` fields, `due_date`, `amount`. Kinds: overdue party (with interest), item below `reorder_level`, cheque due ≤ 3 days (in hand or issued), un-invoiced challan > 7 days, transfer in transit > 2 days, yesterday's day-close difference ≠ 0, GST due date (default 3), "Create FY periods" from 1 March if next April's `fiscal_periods` row is missing. Admin-only kinds (GST, FY, storage) filtered by `current_app_role()`; the storage 80% item is Phase-2 (skip, log).

## Done when

- **"trial balance view balances after 03–05 fixtures"**: pgTAP, real `authenticated` admin session, posts a mixed set (sale, purchase, receipt, payment, expense/salary, challan → invoice, stock adjustment, day close with a difference, a cancelled invoice) then asserts `Σdebit = Σcredit` in `v_trial_balance`; balance sheet balances (assets = liabilities + equity incl. current profit); P&L net = income − expense.
- Reconciliations: `v_party_balances` = sum of the party's AR/AP control-account lines; ageing open total (+ interest columns) = AR control balance for the fixture; `v_stock_summary.value` = `stock_on_hand()` and, post-opening, = Inventory GL balance; employee ledger closing = advance/payable balances.
- A `user` session sees **zero rows** from `v_trial_balance`, `v_pnl`, `v_balance_sheet` and no error; non-member/`anon` denied on every view.
- `v_attention` fixtures: one row per kind that applies (stale challan, transit > 2 days, cheque due, low stock, day-close diff, overdue with interest).
- New pgTAP file `00008_read_views.test.sql`; `supabase db reset` clean; `supabase test db` all green (existing 467 still pass); hard rules hold (no float, parameterless plain SQL, `security_invoker = true` on every view — assert via `pg_class.reloptions`); `implementation-notes.md` written; not pushed to hosted; **not committed** (Ratna commits).
