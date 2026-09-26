# Change 13 — parties, stock and staff UI: implementation notes

Status: built, all automated gates green, live-browser verified (see "Verified live"). **Not committed, not pushed.**
Brief: `daksh-ui` + `daksh-api` + `daksh-schema` (one migration). Proposal: `proposal.md` in this folder.

## What was built
- **Parties** (`/parties`, `/parties/[id]`, extended, not rebuilt): ageing chip per row (oldest receivable bucket from
  `v_party_aging`), **Overdue** segment (party present in `v_party_interest`), rows Enter-activatable. Ledger page: balance pill,
  site chips, ageing tiles (receivables from `v_party_aging` + on-account and interest tiles when non-zero; payables bucketed
  from `v_open_purchase_invoices` with `src/lib/ageing.ts`), ledger from `v_party_ledger` for a financial year (current /
  previous / all) with a brought-forward row and closing line, invoice rows open the invoice on Enter, **Statement PDF / Excel**
  (`/api/parties/[id]/statement.pdf|xlsx`), **WhatsApp reminder** (wa.me, customer-facing text always English).
- **Stock** (`/stock`, `/stock/[id]`): godown segmented (+ All), search, tiles, table with level chips and "≈ N pcs" for TMT,
  transfers-in-transit card with **Receive**, **Godown transfer** / **Adjustment** modals (multi-line, item Picker, on-hand hint),
  **+ New item** (existing `ItemModal`). Item ledger per godown and FY from `v_stock_ledger`.
- **Staff** (`/staff`, `/staff/[id]`, owner-only): tiles, employee table, per-voucher ledger (`summariseVouchers` folds the three
  journal lines of a salary into "earned / recovered / paid"), modals **Pay advance**, **Record salary** (month, live preview of
  the recovery), **Daily wages** (named worker or unnamed casual), **Add / edit employee** (pay rates).
- Actions `src/app/actions/stock.ts` (`recordAdjustment`, `recordTransfer`, `receiveTransfer`) and `staff.ts` (`recordAdvance`,
  `recordSalary`, `recordWages`, `createEmployee`, `updateEmployee`); schemas `src/schemas/stock.ts`, `staff.ts`; loaders
  `src/lib/{party-ledger,stock-data,staff-data}.ts`; pure math `stock-math.ts`, `ageing.ts`, `fy.ts`, decimal helpers
  (`signOf`, `negateDecimal`, `subtractDecimal`, `multiplyDays`); `src/lib/db.ts` (`rows`/`one`: a failed read throws instead of
  rendering empty). UI: `LedgerTable`, `AgeingTiles`, `SiteChips`, `StatTile` (+tone/small).
- Spec updates in the same change: api-architecture ("Parties, stock and staff actions"), db-architecture (owner-only salary data).

## Schema addition (owner decision "salary is owner-only" — found leaking)
`20260926100000_staff_salary_owner_only.sql`: (1) `parties.monthly_salary/daily_wage` were readable by any counter user through the API
-> column-level SELECT (table-level revoked, every other column granted back by name); (2) `employee_pay_rates()` (SECURITY DEFINER,
admin-only rows) + `v_employees` (security_invoker, admin-gated); (3) salary/wage vouchers and their lines invisible to `user`.
pgTAP `00020_staff_salary_owner_only.test.sql` (186: leak checks + `has_column` drift guard for every column the three screens
read/write). Existing tests adjusted: `00011` (reads the reset salary as owner), `00008` (view count 18 -> 19).
**Consequence: `select *` / `parties(*)` on `parties` now fails with permission denied** — the demo script's helpers used it and were
fixed; recorded in the api spec. ~~Not closed (change 19): journal narrations / `v_day_book`~~ — wrong as written (`journal_lines` has no
narration column; the leak was the amounts on the lines, `v_day_book` totals and `audit_log`). Closed by the database review fixes below.
Still open: `v_stock_*` cost columns are API-readable (UI never selects them for a counter session) — change 19.

## Role matrix (read off the functions)
Adjustment, transfer and receive are admin-only in the database (`post_stock_adjustment`, `post_stock_transfer`,
`receive_stock_transfer`) -> actions require a verified admin and the controls are not rendered for a counter session. The database
lets `user` post an advance <= Rs 5,000 but the owner decision makes the whole staff area owner-only: proxy (`access.ts`), rail/menu
(`nav.ts` `ADMIN_ONLY`, and `SideRail` now filters `RAIL_MAIN`), page redirect, action gate, database.

## Conservative defaults (owner unknowns)
1. Overdue = at least one open invoice past its credit days (`v_party_interest`). 2. Ledgers default to the current FY, earlier balance
as a b/f row; `fy=all` shows everything. 3. Salary posts to the Salaries ledger by system key `salaries` (account 5500; an earlier draft wrongly said no key existed), wages to
`loading_unloading`; salary recovers the maximum advance unless the owner types less; **wages recover nothing unless typed** (the
database would otherwise take the whole advance on the first wage payment). 4. New employees get the organisation's state. 5. No staff
screen for counter staff. 6. WhatsApp reminder only with a valid WhatsApp mobile and a positive receivable. 7. Statement sections for a
customer-and-supplier party share one table with an Account column and a closing line per account. 8. Single-godown ledger (no merged
"All godowns" ledger: running balances are per godown). 9. Salary month picker offers the last 12 months.

## Deviations / notes
- Catalog `saveDraft*` + `post*` pairs collapsed into one action per modal (a failed post deletes the draft it just saved); adjustments
  had no catalog row; api spec updated.
- **New error code `transfer_state`** (maps `DN_TRANSFER_STATE`, previously unmapped -> `internal`).
- Statement PDF uses the print palette hex literals (black on white) like the invoice PDF; no theme exists in a PDF.
- Excel numbers are `Number(...)` of the 2-dp text (a spreadsheet cell must be a number); nothing is computed.
- Level chips / thresholds use exact decimals; cost figures for counter staff are not selected at all (`select` lists differ by role).
- `exceljs` 4.4.0 added as a dependency (pinned). `npm audit` reports 2 moderate advisories via exceljs -> `uuid` (v3/v5/v6 with a
  supplied buffer; exceljs does not call that path). Left for the change-16 CI audit decision.
- Site chips display the sites; the ledger is **not filterable by site** (ledger rows carry no site).
- Vehicle-running tile of the prototype dropped (no data source).

## Bugs the live browser found (all fixed)
1. **Nested `Modal` closed its parent**: React bubbles a dialog's `close` up the tree, so choosing an item in the Picker (a Modal
   inside the adjustment/transfer modal) closed the whole form. `Modal` now stops propagation of `close`.
2. **Salary form said "Choose a month" on a valid value**: the schema `.transform`ed `YYYY-MM` -> `YYYY-MM-01` and then ran again in
   the action. Transform removed (action adds the day); `stock-staff.test.ts` asserts every new schema survives being parsed twice.
3. **Counter staff still had a Staff link** in the side rail (`SideRail` ignored `visibleFor` for the main group).
4. Staff ledger showed three journal lines per salary; now one line per voucher. 5. Ledger dates/documents wrapped at 390 px;
segmented links / search / small buttons were under 44 px (global CSS fix). 6. PDF header lines overlapped.

## Verified live (Playwright, temporary install outside the repo; local Supabase + `next dev`)
Signed in as the owner (TOTP computed from the enrolment secret) and as counter staff (email code from the local mail catcher).
- Parties: Enter on a list row opens the ledger; Enter on an invoice ledger row opens the invoice; balance pill equals
  `v_party_balances`; Excel closing balance equals the ledger (number cell, `#,##0.00`); PDF renders (%PDF, checked visually);
  unknown party 404; bad `fy` falls back.
- Stock: Enter on a row opens the item ledger; adjustment (loss 2 bags: Dr Stock loss / Cr Inventory 601.54, stock -2); negative-stock
  refusal shows the friendly message and leaves no draft; transfer -> in transit -> Receive lands the stock in the destination godown.
- Staff: Enter on a row opens the ledger; advance 2,000; salary recovers the advance (preview matched; advance to 0); unnamed daily
  wages 2 x 600 = 1,200; add employee; edit rates.
- Counter: `/staff` and `/staff/[id]` redirect home; no Staff link; `/stock` has no adjustment/transfer/new-item/receive control and no
  cost columns; the HTML of `/stock` and the item ledger contain no cost figures; with the counter's own JWT against PostgREST:
  `parties?select=monthly_salary` -> 403 permission denied, salary/wage vouchers, `v_employees`, `employee_pay_rates` -> empty.
- 1280 px and 390 px, light and dark, admin and counter, all six screens: no horizontal page scroll; modals (Telugu) fit 390 px;
  Escape closes dialogs.
- **Change-12 leftovers:** `/payments/new?id=<draft>` resumes a saved draft (party, amount, note, allocation restored; Enter on a
  draft row opens it); auto-allocate with 900 + 100 discount fills a 1,000 invoice exactly and posting settles it (open 0, AR 0).

## Not verified / deferred
- Telugu strings are agent-written: **need native-speaker review** (all of `stock.*`, `staff.*`, `statement.*`, the new `parties.*`
  keys, `errors.transfer_state`, the new `errors.validation.*` / `errors.field.*` keys).
- No jsdom/component test infrastructure: the Modal fix and the form flows are covered by the live run, not by a unit test.
- Statement PDF with a very long ledger (multi-page header repeat) and a customer-and-supplier party were checked by unit test /
  reading, not visually. The 44 px pass covers segmented links, search, small buttons; links inside `RowLink` rows (whole row is the
  target) stay small by design.
- **Change 13 has had no independent review yet** (screens + actions: Sonnet reviewer with `daksh-review`; the migration and the column-grant change deserve an Opus read).

## Owner questions
1. Should a counter user be allowed to record advances (<= Rs 5,000) from a phone? The database allows it; the owner decision hides all
   salary data, so there is no screen. 2. Account for wages: Loading & Unloading (as the prototype) or a wages account of its own?
3. Should counter staff see the transfer in transit list (it is read-only for them today)? 4. Change 19 should decide the
   remaining stock-cost exposure through `v_stock_*` / `stock_movements` (salary exposure in the ledger is closed, see below).
   5. Should advance vouchers/entries also be owner-only? Today a counter sees them (and the database lets a counter post one).

## Review fixes (Opus review of 13, app)
- **Salary ledger by key**: `recordSalary` looks the ledger up by `system_key = 'salaries'` (as wages use `loading_unloading`), not by code 5500; default #3 above corrected.
- **Cancelled vouchers in the staff ledger**: `v_employee_ledger` exposes no `is_reversal`/`reversed_by`. A cancel posts a second journal entry against the SAME `source_id`, so `summariseVouchers` treats any later entry (higher `entry_no`) of a source as a reversal (narration `Reversal of ...` is a fallback) and folds it with every figure negated and `reversal: true` (shown with a "Reversal" chip). Original + reversal net to zero (vitest). **Follow-up when a cancel UI is added:** expose `journal_entries.reversed_by` (or an `is_reversal` flag) in the view and drop the heuristic. The view also lacks `entry_id`/`source_id` in the pgTAP drift guard (`00020`, `v_employee_ledger` column list): the app now reads both.
- **Idempotent posting**: `recordAdvance/Salary/Wages` and `recordAdjustment/Transfer` take a required client `id` (UUID made once per modal open; the modal content unmounts on close, so a new open is a new id). The draft is inserted with that id (RLS insert policies check only `status = 'draft'` and membership, not `id`). A repeat finds the document already posted/cancelled and returns `ok({ id })` without posting again; a leftover draft under the id (earlier call died) is cleared and the call runs fresh; losing the PK race to a call still in flight returns `conflict`. Helper `src/lib/draft-claim.ts`; new error string `errors.field.request_invalid`.
- **Statement export of a truncated ledger** (>20,000 lines) is refused: HTTP 422 with `statement.truncated` (en + te), and the xlsx/pdf builders throw as a second line of defence. The party page's truncated note no longer tells the owner to "use the Excel statement" (`parties.ledgerTruncated` en + te). Telugu strings need the same native review as the rest.

## Review fixes (Opus review of 13, database)
Migration `20260926110000_payroll_owner_only_ledger.sql`, pgTAP `00021_payroll_owner_only_ledger.test.sql` (67). Existing tests unchanged.
- **UPDATE oracle on pay rates (major)**: `parties_guard` refused a counter's pay-column write only when the value differed, so writing the
  correct salary succeeded. New trigger `parties_pay_guard` (`BEFORE UPDATE OF monthly_salary, daily_wage`) raises
  `DN_VALIDATION:admin_only_field` for any non-admin app session, same value or not (also upserts). WHERE/RETURNING on the columns were
  already refused by the column grant (tested). Insert needed nothing: `parties_guard` nulls both columns for a counter. Owner edits
  (the `updateEmployee` shape) still work; the counter whitelist (name, phone, WhatsApp, default site) still works.
- **Salary amounts in the ledger (major)**: `journal_lines` named the employee with the gross (salary_payable) and recovery, `v_day_book`
  showed entry totals, `audit_log` carried `{"voucher_type":"salary","gross":...}`. Now the SELECT policies of `journal_entries`,
  `journal_lines` and `audit_log` hide, from a non-admin, every entry whose source is a `salary`/`wages` expense voucher (the cancellation
  reversal shares the source), all its lines, and those vouchers' audit rows. Rule = entry source, not line party, so entries vanish whole
  (party-less Dr Salaries / Cr Cash legs too) and nothing a counter sees is partial or unbalanced. Helpers `hidden_payroll_entry_ids()` /
  `hidden_payroll_voucher_ids()` are SECURITY DEFINER (voucher headers are invisible to the caller), empty for an admin, used as
  `not in (select …)` = one hashed sub-plan per query (checked with EXPLAIN). `check_journal_balanced` / `check_journal_has_lines` made
  SECURITY DEFINER: deferred triggers fire at COMMIT as the session role and must not be blinded by RLS.
- **Side effects for a counter session** (all asserted in 00021 unless noted): `v_party_ledger`, `v_party_balances`, `v_party_aging`,
  `v_party_interest`, `v_attention` — unchanged (payroll never touches AR/AP; `v_attention` reads no journal line; read, not tested);
  `v_day_book` — payroll entries gone entirely, everything else identical; stock views — unaffected (no journal rows); `v_employee_ledger`,
  `v_employees`, `v_trial_balance`/`v_pnl`/`v_balance_sheet`, `v_bank_recon` — already admin-only. Counter posting an advance, a sales
  invoice, a receipt and the day close all still work; the day close `expected` includes the salary cash the counter cannot see (posted at
  the owner's figure -> no difference entry). Owner aal2 and aal1 see everything (aal1 unchanged, change 19); non-member sees nothing.
- **Not hidden, by choice**: advance vouchers/entries (counter may post one; change-13 kept them visible — owner question 5); ordinary
  expense vouchers posted to Salaries 5500. **Residual**: `day_closes.cash_out`/`expected` include payroll cash (a day with one cash salary
  reveals the net paid, not to whom); numbering gaps and the helper functions reveal that hidden entries exist, never amounts. Stock cost
  (`v_stock_*`, `stock_movements.rate/value`) stays open for change 19. A future counter-facing cash book must compute through a SECURITY
  DEFINER function, not `journal_lines`.
- **Spec**: db-architecture "owner-only salary data" corrected (no "narrations"; what is closed / remaining) and records that account 5500
  Salaries has `system_key = 'salaries'` (the earlier default #3 wording "no system key exists" was wrong).
- Gates: `supabase db reset` + `supabase test db` 1263/1263 (1196 + 67), `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` 436/436.
