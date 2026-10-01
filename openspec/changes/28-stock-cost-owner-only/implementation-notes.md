# 28 — stock-cost-owner-only: implementation notes (database half, 2026-10-01)

Migration `supabase/migrations/20261006100000_stock_cost_owner_only.sql`; pgTAP `supabase/tests/database/00032_stock_cost_owner_only.test.sql` (71 tests). Full suite on an empty local database (`supabase db reset` → `supabase test db`): 32 files, 2432 tests, PASS. No existing test needed changing (none read cost as a counter). Nothing pushed to hosted.

## 1. Discovery: where stock cost was exposed

| Object | Cost columns | Readable by `user` before | After this change |
|---|---|---|---|
| `stock_movements` (table) | `rate`, `value` | yes (table SELECT) | **closed**: column SELECT not granted to `authenticated` (any app session, admin included; admins read cost through the views) |
| `v_stock_summary_all` / `v_stock_summary` | `avg_rate`, `value` | yes | **NULL** for a non-admin; admin unchanged |
| `v_stock_ledger_all` / `v_stock_ledger` | `rate`, `value`, `running_value` | yes | **NULL** for a non-admin; admin unchanged |
| `stock_on_hand(item, wh)` | `value`, `avg_rate` | yes (direct RPC) | **NULL** for a non-admin direct call; posting engine path unchanged |
| `v_attention` (low_stock) | none (qty only; `amount` is NULL for stock rows) | — | unaffected |
| dashboard views `v_sales_daily*`, `v_money_balances` (20260927100000) | none (sales and money only) | — | unaffected |
| reports views `v_money_ledger` etc. (20260927110000) | none | — | unaffected |
| `v_trial_balance` / `v_pnl` / `v_balance_sheet` (Inventory, COGS balances) | inventory value, COGS | no (admin-only since change 06) | unaffected |
| `go_live_readiness()` (inventory ties) | Σ stock value | no (admin-only, raises DN_FORBIDDEN) | unaffected (SECURITY DEFINER, reads the table as owner) |
| `post_*` / `cancel_*` / `receive_stock_transfer` / `post_opening_balances` / `cancel_opening_balances` / `items_guard` | read cost internally | n/a (return ids) | unaffected: SECURITY DEFINER, owner keeps table SELECT |
| `check_period_not_locked` (trigger) | reads NEW only | — | unaffected |
| **Residual** `journal_lines` / `journal_entries` | Dr `cogs` / Cr `inventory` amounts on every sale, challan, credit/debit note, transfer-free adjustments, opening; Dr `inventory` on purchases | yes (`select_active_members`, only payroll hidden) | **open** (see 3) |
| **Residual** `v_day_book.total_debit` | Σ debit of an entry = invoice grand total + COGS | yes | **open** |
| **Residual** `purchase_invoices` / `purchase_invoice_lines` (`rate`, `taxable_value`, totals), `debit_notes` / `debit_note_lines` | purchase price = cost basis | yes (`select_active_members`) | **open** (outside this change's brief; owner question) |
| **Residual** `stock_adjustment_lines.rate` | cost of an adjustment-in | yes | **open** |
| `opening_lines.rate/amount`, `opening_batches` | opening cost | no (admin-only) | — |

Screens: the stock, item-ledger, reports-stock, dashboard and document-view screens; Excel export of the stock report (reports-data.ts) — see "Screens contract".

## 2. Design chosen

Admins and counter users are the same Postgres role, so a plain REVOKE would also blind admins, and a `security_invoker` view that names `m.rate`/`m.value` fails the column check for every app session. Shape (the change-13 `parties.monthly_salary` pattern):

1. `revoke select on stock_movements from authenticated` + `grant select (id, created_at, item_id, warehouse_id, movement_date, qty, source_type, source_id, reversal_of)`. A future column gets no SELECT until granted on purpose. `select *` on the table is refused for app sessions (the app never reads the table directly).
2. `stock_movement_cost()` — SECURITY DEFINER, `returns table(movement_id, rate, value)`, rows only when `current_app_role() = 'admin'` (one-time filter; for anyone else the table is never scanned). Not a `v_*` view, so the 00026 invariant "every view is security_invoker" still holds. Executable by `authenticated` only (revoked from public, anon, service_role).
3. The four stock views: `create or replace`, same names/columns/types/order/grants, still `security_invoker`. Quantities from `stock_movements`; cost via `LEFT JOIN stock_movement_cost()`. For a non-admin every cost column is NULL — including `avg_rate` when qty = 0 (an explicit role case; previously 0). For an admin the figures are bit-identical (pgTAP compares against the old formulas over the raw table). `v_stock_summary` / `v_stock_ledger` (`select * from _all`) needed no change.
4. `stock_on_hand()` stays SECURITY INVOKER, now plpgsql with three branches: if `has_column_privilege('public.stock_movements','value','SELECT')` — true for the function owner inside every SECURITY DEFINER post_*/cancel_* and for service_role — the **original body**, unchanged, so weighted-average cost and COGS cannot drift; else admin → same figures via `stock_movement_cost()`; else qty only, cost NULL. The branch is decided by the caller's privileges, not by any argument.

Trade-offs, stated: (a) an admin's ledger/summary query materialises `stock_movement_cost()` over all movements (no predicate push-down into a function) — fine at this business's volume (thousands of movements/year); revisit with a parameterised function if the item ledger gets slow. (b) `postgres`/`service_role` reading the *views* without an admin JWT now get NULL cost (current_app_role() is NULL for them); nothing in the app or scripts does that (backups dump tables; go_live_readiness reads the table). (c) Admins can no longer read `stock_movements.rate/value` straight from the table through the API — only through the views/function (the app never did).

## 3. Residual: cost still derivable by a counter user (accepted for now — owner question)

Posting is not changed, and `journal_lines` is readable by any active member (only payroll entries are hidden, change 13). From it a counter user can derive:
- **Per invoice cost**: the sales entry carries `Dr COGS / Cr Inventory` = qty × weighted-average cost, so cost per unit of each sold line (exact for a single-item invoice, aggregate for a multi-item one). Same for delivery challans (stock out at avg cost between two asset accounts), credit notes (stock back at original cost), stock adjustments.
- **Total inventory value**: Σ(debit − credit) over the `inventory` account lines.
- **Purchase cost**: purchase entries `Dr Inventory`; and directly `purchase_invoice_lines.rate` / `purchase_invoices` totals and `debit_note_lines.rate` (purchase price = cost basis), readable through `select_active_members`.
- **`v_day_book.total_debit`** for a sale = grand total + COGS, so COGS = total_debit − invoice grand total.
- `stock_adjustment_lines.rate` (cost of an adjustment-in).

Default taken: **accepted residual**, logged in the spec. Closing it needs a separate change: hide `cogs`/`inventory` lines (or whole stock-bearing entries) from a `user` the way change 13 hides payroll entries — which breaks "every entry a user sees is balanced" and touches every journal read view — plus owner-only RLS on purchase invoices/debit notes/adjustment lines (the counter screens would lose purchase lists).

**Owner questions for Ratna:** (1) Is COGS/Inventory in `journal_lines` and the day book an accepted residual, or in scope? (2) Should the counter see purchase invoices and their rates at all? Purchase rate is the most direct cost leak left, and purchases are already admin-only to post. Recommended: (2) yes, close it in a follow-up (owner-only SELECT on purchase_invoices/lines, debit notes/lines, stock_adjustment_lines.rate); (1) accept until a counter actually uses the journal API.

## 4. Screens contract (for the Sonnet screen half — src/ not touched here)

Existing queries keep working: cost columns are just NULL for a counter; no query selects from `stock_movements` directly; no `stock_on_hand` RPC from src. What each file must do:
- `src/lib/stock-data.ts` — summary (`v_stock_summary`, `v_stock_summary_all` transit) and item ledger (`v_stock_ledger`, cost columns already admin-only via `cols`). Make sure a NULL `avg_rate`/`value`/`running_value` maps to `null` (not `d2(null)` = 0) and the counter shape omits cost; brought-forward value must stay `null`.
- `src/lib/reports-data.ts` (~277–305) — stock report already selects cost only for admins; the `v_stock_summary_all` `value` total vs `v_trial_balance` inventory (admin path) must not be computed for a counter (value is NULL → would sum to 0 and show a false mismatch). Excel export: no cost columns for a counter.
- `src/lib/dashboard-data.ts` (~118–119) — `loadStockValue()` (inventory value tile) is documented "owner only"; verify the page calls it only for an admin. If a counter ever reaches it, `value` is NULL → `sumMoney` must not render ₹0; hide the tile.
- `src/app/(app)/sales/[id]/view/page.tsx:49`, `src/app/(app)/purchases/[id]/view/page.tsx:45`, `src/components/notes/NoteView.tsx:41` — select `rate, value` from `v_stock_ledger`; for a counter these are NULL: render no cost column (or select qty only when not admin).
- `src/lib/sales-data.ts:34` — qty only; no change.
- `src/app/(app)/reports/stock/page.tsx` — comment already says cost for owners only; verify it renders nothing for NULL.
Rule: the database is the enforcement; TS role checks only decide layout. Never coerce NULL cost to 0.

## 5. Tests changed

None. Existing suite (31 files / 2361 tests) passes unchanged with the migration; new file adds 71.

## 6. Screens (built 2026-10-01)
Audit of the Screens contract found the stock, item-ledger, reports-stock (screen + Excel), and dashboard paths already select cost columns for owners only (`isAdmin`), so nothing to change there; `loadStockValue` is only called when `isAdmin`. The one real gap: the three posted-document views (`sales/[id]/view`, `purchases/[id]/view`, `components/notes/NoteView.tsx`) selected `rate, value` from `v_stock_ledger` for everyone, so a counter would have seen "₹0.00" for cost (NULL through `inrRate`/`inr2`). Each now computes `showCost = rows.some(m => m.rate !== null)` and renders the cost-rate/cost-value columns only then. Data-driven on purpose: the database decides, the page only lays out (no TS role check).

## 7. Live browser walk (2026-10-01, Playwright, local stack, counter + owner aal2)
All PASS, 390 px and desktop, no console/page errors. Counter: /stock, item ledger, /reports/stock (+ Excel: Item, Godown, Unit, On hand only), dashboard (no stock value tile), sales invoice and credit note "Stock effect" (qty only); counter REST: the four stock views return value/avg_rate/rate/running_value NULL, `stock_movements?select=rate,value` and `*` -> 42501, `stock_on_hand` cost NULL, `stock_movement_cost` empty; counter still drafts and posts a sale. Owner: tile ₹6,58,966 + ₹6,015 in transit = Inventory account in the trial balance (₹6,64,981.55); invoice stock effect -20 @ ₹300.7693 = -₹6,015.39 equals the `stock_movements` row; ledger rates match purchase rates (300 / 302 -> weighted avg 300.7692).
**Counter-visible cost still found (the accepted residual, section 3):** the "Journal entry" card on the invoice and credit-note view shows `5100 COGS` and `1300 Inventory` lines (e.g. ₹6,015.39 for 20 bags). Owner question 1 stands.

## 8. Independent review (Opus, 2026-10-01): APPROVE
Admin figures bit-identical (00032 admin checks also run clean against 37 real demo movements), `stock_movement_cost()` hygiene confirmed (pinned search_path, no args, EXECUTE only postgres/authenticated), every cost reader is a SECURITY DEFINER function owned by postgres, no src/ reads the table directly. Low findings: (1) spec said "closed" while cost is derivable — reworded; (2) residual list missed `v_open_purchase_invoices` / supplier `v_party_ledger` — added; (3) 00032:183 asserts 0 low_stock rows, ties to fixtures (kept, not a false green); (4) no test that service_role cannot execute `stock_movement_cost()` (design prevents it); (5) pre-existing: `authenticated` holds TRIGGER/REFERENCES/MAINTAIN on `stock_movements` — sweep in a later grants-hygiene pass. Before go-live Ratna must answer owner questions 1 and 2 (section 3): the counter can still read total inventory value exactly (Σ Inventory in `journal_lines`).
