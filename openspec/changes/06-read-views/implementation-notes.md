# Implementation notes — 06 read-views

## What was built

One migration, one pgTAP file. Nothing in migrations 01–05 was edited; nothing was committed or
pushed.

**`supabase/migrations/20260919120000_read_views.sql`**

1. **Schema**
   - `parties.interest_rate_pm NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (>= 0)`. `whatsapp_phone` and
     `default_site_id` are **not** added (change 09).
   - `bank_statements` and `bank_statement_lines`, columns exactly as the spec, plus
     `NOT NULL DEFAULT 0 CHECK (>= 0)` on debit/credit, `match_status` CHECK
     (`unmatched|auto|manual|ignored`), `CHECK (period_to >= period_from)`, `ON DELETE CASCADE`
     from lines to statement, and the spec's `(statement_id, match_status)` index (+ one on
     `(account_id, period_to desc)`). RLS: active members SELECT; INSERT/UPDATE/DELETE only when
     `current_app_role() = 'admin'`. No app writes them (Phase 2).
2. **Seventeen views**, every one `WITH (security_invoker = true)`, plain SQL, nothing
   materialised, `GRANT SELECT` to `authenticated` only (see Grants).

| View | Notes |
|---|---|
| `v_trial_balance` | admin-only. One row per leaf account, all-time, zero-balance accounts included. `total_debit`, `total_credit`, `closing = Dr − Cr`, `side` (side the closing falls on, NULL at zero), `natural_side` (by account type). |
| `v_pnl` | admin-only. Income/expense accounts **by `entry_date`** with `month`, `fy_label` (April–March). `amount` = natural-side movement, `profit_effect` = credit − debit. |
| `v_balance_sheet` | admin-only. Asset/liability/equity **by account × `entry_date`** (`amount` on the natural side) plus one synthetic equity row per `entry_date` (`is_current_profit = true`) carrying the P&L profit. Sum with `entry_date <= D` for an as-of sheet. |
| `v_day_book` | Every posted entry: `doc_no`, `total_debit`, `line_count`, `is_reversal`, `is_reversed`, `reversed_by`. |
| `v_party_ledger` | AR/AP control lines only, with `account_key`, `doc_no`, `line_no`, `is_reversal`, and a running balance per (party, account) in the "owed" sense (AR = Dr − Cr, AP = Cr − Dr). |
| `v_party_balances` | customer/supplier/both parties. `ar_balance`, `ap_balance`, `net_balance` (AR − AP), `balance` by type (customer → AR, supplier → AP, both → AR − AP). |
| `v_party_interest` | One row per open sales invoice past its credit days: `open_amount`, `overdue_days`, `overdue_months`, `interest_rate_pm`, `interest = round(open × rate/100 × overdue_days/30, 2)`. |
| `v_party_aging` | Per party: four buckets, `open_total`, `unallocated`, `unapplied_discount`, `interest`, `ar_balance`, `other_ar` (see decisions 3–4). |
| `v_stock_summary` / `_all` | item × warehouse qty, `avg_rate` (0 at qty 0), value, `is_transit`. Plain variant excludes the transit warehouse. |
| `v_stock_ledger` / `_all` | movements with `seq`, `running_qty`, `running_value`, `doc_no`, `is_reversal`. |
| `v_employee_ledger` | Lines on `employee_advance`/`salary_payable`, `voucher_type`, `period_month`, running `advance_balance` / `payable_balance`. |
| `v_bank_recon` | Each `is_money` account that is not the cash box: book balance, latest statement's closing balance, difference, unmatched-line count. |
| `v_attention` | See decision 8. |
| `v_document_refs`, `v_open_sales_invoices` | **Internal helpers** (not in the proposal's list). The first maps `(source_type, source_id)` → document number for ten document kinds so four views do not each repeat the join; the second is the single definition of "open invoice" that ageing and interest both read, so they cannot disagree. Granted like the others. |

**`supabase/tests/database/00008_read_views.test.sql`** — 132 assertions. Fixtures are created
as postgres (drafts, as the app writes them) and posted through the real `post_*` / `cancel` /
`bounce` / `receive` / `post_day_close` functions in real `authenticated` sessions (admin, and
`user` for a receipt and an advance). The mixed set: two purchases, five sales invoices (one
cancelled, one converted from a challan), two challans, a cash receipt, an on-account receipt, a
discounted receipt, a bounced cheque, a cheque in hand, an issued cheque, an outgoing payment,
rent, two advances, a salary with a partial recovery, a posted-and-received transfer, a transfer
left in transit, a shrinkage adjustment, and a day close Rs 200 short. Nothing is inserted into
`journal_lines`/`stock_movements`.

## Defaults and deviations (everything a reviewer should know)

1. **`interest_rate_pm` added** here, default 0 → interest 0 (the row still shows, with 0).
2. **Bank tables** created as specced; `v_bank_recon` returns book balance with NULL
   `bank_balance`/`difference` and 0 unmatched until a statement exists. "Bank" ledger = any
   `is_money` non-group account whose `system_key` is not `cash`, so a second bank ledger appears
   with one `UPDATE accounts SET is_money = true` and no code change. Closing balance = the
   latest `txn_date` line with a printed `balance` on the statement with the latest `period_to`;
   two lines on the same date are tie-broken by `created_at, id`, so a statement whose last-day
   lines carry different balances can pick the wrong one. Book balance is as of today, the
   statement's as of `period_to`; `statement_period_to` is exposed so the app can say so.
3. **Open invoice** = `grand_total − Σ allocations of posted payments − Σ posted credit notes
   against it` (credit notes are joined for real — the table exists — but nothing posts one until
   change 20). Draft allocations do not count; bounced/cancelled receipts are `status =
   'cancelled'` with allocations deleted, so they never count. A credit note with no
   `against_invoice_id` reduces AR but no invoice; it shows up in `other_ar`.
4. **Discount vs allocation — SUPERSEDED by follow-up fix 1 below (allocations may now total amount + discount); kept for history.** A receipt posts AR credit =
   `amount + discount`, but change 04 caps allocations at `amount`. So the discount reduces AR
   yet can never be attached to an invoice: an invoice settled by cash + discount stays open by
   exactly the discount. I did not touch change 04. The ageing view exposes it honestly:
   `unapplied_discount` (Σ discount on posted receipts) and `other_ar`, so
   `open_total − unallocated − unapplied_discount + other_ar = ar_balance` always holds. Fix
   options for later: let allocations include the discount, or treat discount as its own
   settlement row. `other_ar` also catches opening balances / manual journals on AR.
5. **Ageing buckets** by days since the **invoice date** (0–30 / 31–60 / 61–90 / 90+), not
   shifted by `credit_days`; `credit_days` only drives *overdue* (interest and `v_attention`).
   `unallocated` = posted receipt `amount` − its allocations (on account), shown separately, not
   netted into buckets. Only **sales** invoices are aged; there is no payables ageing (not in
   scope).
6. **Sign conventions** per the proposal: `v_party_balances.balance` positive = they owe us
   (customer) / we owe them (supplier); a `both` party has `ar_balance`, `ap_balance`,
   `net_balance`, and `balance = AR − AP` (so negative = we owe them on net). Trial balance
   `closing = Dr − Cr`; `side` is the side that value falls on, `natural_side` the account type's.
7. **Trial balance is all-time, no date axis** (the spec shape is one row per account). P&L and
   balance sheet carry `entry_date`/`month` so the app can filter. If the app needs an as-of
   trial balance it will have to derive it from `v_day_book`/journal, or a later change can add a
   dated variant. The balance sheet's synthetic profit row is **cumulative since the books began**
   because Phase 1 posts no year-end closing entry; it is labelled accordingly.
8. **`v_attention`** columns: `kind, severity (critical|warning|info), subject_type, subject_id,
   title, detail, due_date, amount, interest`. `due_date` is when the thing became/becomes due:
   oldest overdue invoice's due date; challan date + 7; transfer date + 2; the cheque's
   `instrument_date`; the day-close date; the GST due date; next 1 April.
   - `overdue_party`: from `v_party_interest` (`overdue_days > 0`), critical when > 30 days. A party
     with `credit_days = 0` is overdue from the day after the invoice.
   - `low_stock`: `reorder_level > 0`, active, `is_stock`, on-hand across **non-transit**
     warehouses `< reorder_level`; critical at ≤ 0.
   - `cheque_due`: posted `mode = 'cheque'`, `cheque_status in ('in_hand','issued')`,
     `instrument_date <= today + 3` (past-due included, critical). A cheque with no
     `instrument_date` has no due date and is **not** listed. Deposited-awaiting-clearing cheques
     are not listed.
   - `stale_challan` (posted, `invoice_id IS NULL`, > 7 days), `transfer_in_transit` (> 2 days),
     `day_close_difference` (a *posted* close dated yesterday with `difference <> 0`; a missed close
     is not flagged).
   - `gst_due` (admin): **no filed flag or due-date column exists.** GSTR-1 on the 11th and GSTR-3B
     on the 20th of the month after the reporting month, shown only when that due date falls within
     the next 7 days **and** the reporting month had a posted sales invoice (purchases-only months
     with ITC to claim are not flagged). Warning within 3 days, else info. Because nothing records
     "filed", it will keep showing until the due date passes.
   - `create_fy_periods` (admin): from 1 March, when next April's `fiscal_periods` row is missing;
     critical in the last 7 days. It does not flag a missing row for the *current* month.
   - The storage-80% item is Phase 2 (skipped).
   - "Today" is `(now() AT TIME ZONE organization.timezone)::date` everywhere; a test asserts
     neither `v_attention` nor `v_open_sales_invoices` mentions `CURRENT_DATE`.
9. **Transit warehouse**: the proposal says "excluded by default; expose `is_transit` so the app
   can opt in" — views take no parameters, so opt-in needs a second view. I built
   `v_stock_summary_all` / `v_stock_ledger_all` (with `is_transit`) and defined the plain names as
   `select * from …_all where not is_transit`. The reason it matters: transfers post no journal
   entry, so goods in the lorry are still in Inventory GL. **Σ `v_stock_summary_all.value` =
   Inventory GL** always; `v_stock_summary` is short by exactly the in-transit value (tested: 30
   bags × 300 = 9,000). `is_transit` is `false` on every row of the plain views.
10. **Admin-only views** use `(select current_app_role()) = 'admin'` (evaluated once per query).
    `current_app_role()` was already `STABLE` and executable by `authenticated` (change 03 revoked
    only `public` and `anon`); nothing needed granting or weakening — asserted in the test.
    **Known limit (accepted for Phase 1, owner decision):** a `user` can still `SELECT`
    `journal_lines` / `journal_entries` / `accounts` directly (spec: active members read every
    business table), so the admin-only gate is a *view-level* guard, exactly as specced, not a
    data-level one. Fine for ≤ 10 trusted family users; revisit before go-live with SECURITY DEFINER
    user-facing views. The same paragraph is now in the db-architecture spec under "Views
    (change 06)".
11. **Grants**: `REVOKE ALL … FROM public, anon, authenticated, service_role` then
    `GRANT SELECT … TO authenticated` on every view (default privileges would otherwise hand every
    role ALL on a new view, and simple views are auto-updatable). `service_role` gets **nothing**
    on the views, per the proposal — a server-side job using the service key must read the base
    tables (or be granted later). Verified that change 05's ledger-table write revokes leave the
    `security_invoker` views readable: `authenticated` keeps SELECT on the base tables.
12. **`v_party_ledger` / `v_employee_ledger` running balances** are per (party, account) —
    `partition by party_id, account_key` — because a `both` party has AR and AP and a single
    running number would mix the two directions. `line_no` is exposed so the app can reproduce the
    window order (`entry_date, entry_no, line_no, line id`). `is_reversal` is any entry that is the
    `reversed_by` target of another (cancellation, cheque bounce); the original is `is_reversed`
    in the day book.
13. **`v_stock_ledger` ordering**: `(movement_date, created_at, id)` with a `seq` column.
    Movements from one transaction share `created_at`, so `id` breaks the tie; final running
    figures are exact, intermediate ones inside a single posting are not meaningful.
14. **`v_employee_ledger`** joins `expense_vouchers` for `voucher_type` and `period_month`; reversal
    entries share the voucher's `source_id`, so they carry the same period. Only an *unnamed* casual
    wage has no party, so it is not in this view by construction.

## Deferred / out of scope (per the proposal)

- `v_gstr1_b2b`, `v_gstr1_b2c`, `v_hsn_summary`, `v_gstr3b_summary` → change 18.
- `v_rebate_tracker` → Phase 2 (brand rebates).
- Storage 80% item in `v_attention` → Phase 2.
- Payables ageing (purchase invoices / debit notes) — not asked for.
- Bank statement import/matching → Phase 2. Nothing populates the two new tables.
- A journal-side index on `journal_entries(reversed_by)`. `is_reversal` uses one hashed subplan
  per query, fine at ≤ 50k lines/year; revisit only if a view breaches 500 ms.
- Performance was not measured on production-sized data.

## How to run

```
cd "/Users/ratnakumarchukkapalli/Daksh Nirmaan"
supabase db reset && supabase test db
```

Result at hand-off: `supabase db reset` clean (migration `20260919120000_read_views.sql` applies
after the 05 pair); `supabase test db` **All tests successful — 611 tests across 8 files**, i.e.
the seven existing files (479 assertions) plus 132 new. The existing tests were not modified.

`00008` reads views as postgres with the admin's JWT claims set (so `current_app_role()`
resolves), then repeats a read of all 17 views under genuine `authenticated` sessions (admin, user,
a stranger with no `app_users` row) and `anon`, asserting: admin reads everything with no error; a
`user` gets no error and zero rows from exactly `v_trial_balance`, `v_pnl`, `v_balance_sheet`; a
non-member gets zero rows and no error everywhere; `anon` gets `permission denied` on all 17.
Date-driven `v_attention` kinds (`gst_due`, `create_fy_periods`) recompute their expected count
from first principles rather than assuming the run date; everything else uses fixed 2026-27
dates or dates relative to today.


## Follow-up fixes (owner decisions, applied after the first hand-off)

**1. Allocations may total `amount + discount`** — new migration
`supabase/migrations/20260919130000_allocation_discount.sql`; migration 04 (committed) is not
edited. Bug found while building ageing: `post_payment` credits AR (debits AP) by
`amount + discount`, but the cap trigger and `post_payment` capped a payment's allocations at
`amount` alone, so an invoice settled by cash + discount stayed open by the discount forever. The
migration `CREATE OR REPLACE`s exactly two functions, extracted verbatim from 20260918120000 with
one comparison changed in each:
- `check_payment_allocation()` Cap 1: `Σ allocations ≤ payments.amount + coalesce(discount, 0)`.
- `post_payment(uuid)`: the up-front total check, same change.
Everything else is byte-identical: per-invoice open-amount cap, the N1 per-invoice grouping and
unique constraint, direction/party/cancelled checks, SECURITY DEFINER, `search_path`, locking
order; grants re-stated (`check_payment_allocation` revoked from all client roles;
`post_payment` revoked from public/anon/service_role, granted to authenticated). No other function
compares Σ allocations to `amount` (`post_cash_sale` allocates the full invoice with no discount).
The column is direction-agnostic, so outgoing payments with a discount received follow the same
rule (tested).
- `v_party_aging` semantics (edited in place, 06 is uncommitted): allocations consume the cash
  first, then the discount. Per receipt, `unallocated = max(amount − allocated, 0)` and
  `unapplied_discount = discount − max(allocated − amount, 0)`. Receipt 900 + 100 allocated 1,000
  → both 0; allocated 900 → `unapplied_discount = 100`. The reconciliation identity
  `open_total − unallocated − unapplied_discount + other_ar = ar_balance` is unchanged. Deviation 4
  above described the old limitation; it no longer applies. Data posted before this change is
  unaffected (allocations ≤ amount remain valid).
- Tests: new file `00009_allocation_discount.test.sql` (25 assertions) instead of extending 00006
  or 00008, so no existing test needed touching: 900 + 100 against a 1,000 invoice allocates 1,000,
  posts (as a counter user), the invoice closes, ageing shows `unapplied_discount = 0` and
  reconciles; 1,000.01 raises `allocation_exceeds_payment`; the exact boundary passes; a fully
  allocated payment accepts nothing more; a closed invoice still raises `allocation_exceeds_invoice`;
  shrinking the discount after allocating makes `post_payment` refuse; cash-only allocation leaves
  `unapplied_discount = 100`; an outgoing payment 4,500 + 500 discount clears a 5,000 bill and AP
  to 0; grants unchanged.
- Not edited (flag for the spec owner): the change-04 allocation paragraph in the spec still says
  "Σ amount per payment ≤ `payments.amount`". It should now read `amount + discount`.

**2. `challan_possible_duplicate` in `v_attention`** (edited in place). Warning only, never a
block. A posted, un-invoiced challan is flagged when, for the same party and one of its items, a
posted challan (other than itself) dated on/after it, **or** a posted sales invoice not linked to
any challan (`challan_id IS NULL`) dated on/after it, carries a quantity of that item **≥ the
challan's**. Deliberately simple and conservative:
- "Overlapping quantity" is read as `other qty ≥ challan qty` — a smaller later sale to the same
  party is normal and is not flagged. Consequence: a resale split across several smaller documents
  is not caught.
- The other challan counts whether or not it has itself been invoiced (the goods left on it).
  Two genuine same-size loads to one party will flag the earlier one; that is the price of a
  simple rule, and it is a warning.
- Cleared by: converting the flagged challan to an invoice, cancelling it, or cancelling the other
  document. Cancelling the invoice that converted it re-opens the challan and the warning returns.
- Tests (8, in 00008): none in the base fixture; appears for a later same-size challan; severity
  is `warning`; clears when that challan is cancelled; appears for an unlinked invoice; clears on
  conversion; returns when the converting invoice is cancelled; clears when the challan is cancelled.

**3. `v_bank_recon` closing-balance tie-break** (edited in place). New column
`closing_balance_ambiguous boolean` (false when there is no statement). Rule, on the latest
statement's last `txn_date` among lines that carry a balance:
1. one distinct balance → that balance, not ambiguous;
2. several distinct balances → look for a *terminal* line: some other line's
   `balance − this.debit + this.credit = this.balance` (something precedes it in running order) and
   no other last-day line follows it the same way; exactly one terminal balance → that balance, not
   ambiguous (this beats the `(created_at, id)` pick — tested with the earlier-created line as the
   true last line);
3. otherwise → ambiguous = true; `bank_balance` shows the old `(created_at, id)`-greatest pick so
   the number is still there, but the app should flag it rather than trust it.
Predecessors are searched within the same statement only. Tests (5 in 00008): single balance not
ambiguous; unrelated last-day balances flagged ambiguous with a candidate value shown; running
order picks 550 over the created_at pick of 500 and is not flagged.

**4. P&L gate limit documented** — a "Known limit" paragraph added to
`openspec/specs/db-architecture/spec.md` under "Views (change 06)" and reflected in deviation 10
above. No code change.

**Result after the follow-up:** `supabase db reset` clean; `supabase test db` all successful —
649 tests across 9 files (existing 479 + 00008: 145 + 00009: 25).


## Review fixes (second round)

- **Spec text made consistent with the discount decision:** `db-architecture/spec.md` (payment_allocations line),
  `frontend-architecture/spec.md` (allocation grid line) now say `Σ allocations ≤ amount + coalesce(discount, 0)`;
  change 04's implementation-notes item 14 is marked SUPERSEDED (history kept).
- **`v_bank_recon`:** `book_balance` is now the ledger as of the statement's `period_to`
  (`entry_date <= period_to`) when a statement exists, else as of today; `book_balance_today` is a separate,
  always-today column; `difference = book_balance − bank_balance`. A posting dated after `period_to`
  therefore cannot move `difference` (tested: a bank expense dated 05-09 moves only `book_balance_today`).
- **`v_employee_ledger`:** both running balances are `coalesce(..., 0)`; a filtered window sum was NULL until the
  first matching line (tested with a salary-only employee and the first row of an advance-first employee).
- **Tests:** 00009 adds cancel-receipt-with-discount and bounce-cheque-with-discount (allocations gone, invoice
  fully open, ageing open 1,000 / unallocated 0 / unapplied_discount 0 / other_ar 0). 00008 strengthens the
  `both`-party ledger check to values per (party, account) partition, plus builder one's running balance row by row.
- **TRUNCATE on the bank tables:** revoked `truncate, references, trigger` on `bank_statements` and
  `bank_statement_lines` from `authenticated` and `service_role` in the read_views migration (tested). INSERT/UPDATE/DELETE
  are deliberately **kept**: the admin-only write policies are how Phase 2's importer will write, and RLS gates them;
  revoking them would make those policies dead. The same default TRUNCATE grant exists on every other public table
  (change 05 revoked writes only on the ledger tables and audit_log) - not PostgREST-reachable, so left alone; worth a
  one-line sweep in a later hardening change.
- **Result:** `supabase db reset` clean; `supabase test db` all successful, 670 tests / 9 files
  (existing 479 + 00008: 158 + 00009: 33).

### Logged for later (no code)

a. **DECIDED (owner, 2026-09-19): a discount is admin-only for now** - `post_payment` raises `DN_FORBIDDEN` when `discount > 0` and the caller is not an admin (both directions; a `user` may still save the draft; discount 0/NULL unchanged). Implemented in `20260919130000_allocation_discount.sql` (edited in place, still uncommitted). Revisit if the counter needs small discounts - a percentage cap is the likely next step. Original question, kept for history: **discount abuse.** With allocations now allowed up to `amount + discount`, a `user` (counter
   staff) can close an invoice with any discount on a receipt (e.g. Rs 1 cash + Rs 999 discount closes Rs 1,000).
   Consider later: a discount cap, admin-only above X% of the receipt/invoice, or a `v_attention` kind for large
   discounts. Not implemented; the posting path is unchanged.
b. `v_party_interest` and `v_open_sales_invoices` (hence `v_party_aging` and the `overdue_party` attention rows) use the
   party's **current** `credit_days` and `interest_rate_pm`, not values snapshotted on the invoice. Editing a party's
   terms re-prices history's overdue/interest figures. Snapshot the terms on `sales_invoices` if that matters.
c. TRUNCATE grant: see above (bank tables fixed; other tables logged).
d. No index on `journal_entries(reversed_by)`; `is_reversal` uses one hashed subplan per query. Revisit if any view is
   slow at production volume.

### Discount admin-only (owner decision, applied after the second round)

- `post_payment`: right after the existing role gate, `coalesce(discount, 0) > 0 and role <> 'admin'` raises
  `DN_FORBIDDEN` (same idiom as the direction gate above it, before anything is locked or written). The rest of the
  function is unchanged. `post_cash_sale` inserts its receipt with no discount (column default 0) and calls
  `post_payment`, so it is unaffected; no other caller sets a discount.
- Tests (00009, now 43): a user can save a draft with a discount; posting it as a user raises `DN_FORBIDDEN` with the
  draft, voucher number and journal untouched; an admin posts the same receipt; a user still posts discount 0; a payment
  with a discount received is blocked for a user and allowed for an admin. The one existing test that posted a
  discounted receipt as a `user` (00009's 900 + 100 receipt) now posts as admin; nothing else needed changing (00006's
  discounted receipt and payment and 00008's discounted receipt were already posted by admin).
- Result: 680 tests, all green, 9 files.
