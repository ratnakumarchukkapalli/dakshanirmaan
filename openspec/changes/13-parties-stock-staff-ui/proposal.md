Skill: daksh-ui + daksh-api (+ daksh-schema for one small migration, see "Schema addition")
Spec section: openspec/specs/frontend-architecture/spec.md -> "Route structure" (`parties/`, `stock/`, `staff/`) + the ledger/ageing/site-chip component list; api-architecture -> action catalog (`expenses.ts`, `transfers.ts`) + "Route handlers added" (`/api/parties/[id]/statement.(pdf|xlsx)`); prototype `#screen-parties`, `#screen-stock`, `#screen-staff` only.
Context: Change 09 built `/parties` (list) and `/parties/[id]` (details + delivery sites); `/stock` and `/staff` are placeholders. Views (change 06) and posting functions (`post_stock_adjustment`, `post_stock_transfer`, `receive_stock_transfer`, `post_expense_voucher`, change 05/04) exist. This change is the screens on top of them.
Do not: write `journal_*` / `stock_movements` directly (the posting functions are the only writers); put business math in TypeScript that becomes truth; read other specs; touch changes 01-12 migrations (a new migration file only); start change 14; commit or push (Ratna commits).

## Scope
**In**
1. **Parties list** (extend): ageing chip per party (oldest open bucket, from `v_party_aging`), **Overdue** segment (a party with an open invoice past its credit days = present in `v_party_interest`), balance column with "to collect / to pay", rows Enter-activatable.
2. **Party ledger** (`/parties/[id]`, extend): balance pill, **site chips** (the party's delivery sites, default marked), **ageing tiles** (0-30 / 31-60 / 61-90 / 90+, plus on-account and interest when non-zero; receivables from `v_party_aging`, payables bucketed from `v_open_purchase_invoices`), **ledger table** from `v_party_ledger` (date, document, details, debit, credit, running balance; FY selector current / previous / all with a balance-brought-forward row; reversal rows are their own rows, tagged; a document link is a keyboard-activatable row for invoices), **statement export** Excel (exceljs) + PDF (react-pdf) via route handlers, **WhatsApp reminder** (wa.me text, no Business API).
3. **Stock summary** `/stock`: godown segmented (each non-transit godown + All), search, tiles, table (item, HSN, in stock with "about N pcs" for TMT, avg cost, value, level chip), transfers-in-transit card with **Receive**, header buttons **Godown transfer**, **Adjustment**, **+ New item** (reuses `ItemModal`). Rows Enter -> `/stock/[itemId]`.
4. **Stock ledger** `/stock/[id]`: `v_stock_ledger` per godown, in / out / balance, rate and average (admin only), document column.
5. **Modals** (multi-line, item Picker): adjustment (per godown, loss/found per line, reason), transfer (from/to, vehicle, lines). Each is one action that saves the draft and posts it; a failed post removes the draft so nothing orphans.
6. **Staff** `/staff` + `/staff/[id]` (owner-only): tiles (salary bill / month, advances outstanding, paid this month), employee table, employee ledger from `v_employee_ledger`; modals **Pay advance**, **Record salary** (month, advance recovery), **Daily wages** (named worker or unnamed casual), **Add / edit employee** (pay rates).
7. en + te strings for all of it (key parity), tokens only, 44 px targets, 390 px + both themes.

**Out (log in notes)**: multi-godown ledger merge; site-wise ledger filtering (ledger rows carry no site); payable ageing interest; purchase-side credit/debit notes; per-item reorder editing (ItemModal already edits it); vehicle-running tile (no data source); notes/quotes.

## Routes
`/parties` (list), `/parties/[id]` (ledger), `/stock`, `/stock/[id]`, `/staff`, `/staff/[id]`; handlers `GET /api/parties/[id]/statement.xlsx?fy=` and `.pdf?fy=`.

## Actions (each: zod schema from `src/schemas/`, role gate, envelope, revalidate)
| Action | File | Gate | Calls |
|---|---|---|---|
| `recordAdjustment` | `stock.ts` | verified admin | draft insert + `post_stock_adjustment` |
| `recordTransfer` | `stock.ts` | verified admin | draft insert + `post_stock_transfer` |
| `receiveTransfer` | `stock.ts` | verified admin | `receive_stock_transfer` |
| `recordAdvance` / `recordSalary` / `recordWages` | `staff.ts` | verified admin | draft voucher + `post_expense_voucher` |
| `createEmployee` / `updateEmployee` | `staff.ts` | verified admin | `parties` insert/update (owner-only columns) |
The api catalog lists `saveDraft*` + `post*` pairs; the modals never keep a draft, so each pair collapses to one call (documented in the api spec).

## Views used
`v_party_balances`, `v_party_ledger`, `v_party_aging`, `v_party_interest`, `v_open_purchase_invoices`, `v_stock_summary(_all)`, `v_stock_ledger`, `v_employee_ledger`, new `v_employees`.

## Role matrix (read off the database, not guessed)
| | counter (`user`) | owner (`admin`, aal2) |
|---|---|---|
| Parties list / ledger / statement / reminder | yes | yes |
| Stock summary + ledger (quantities) | yes | yes |
| Stock cost (avg rate, value, rate columns, value tiles) | **no** (UI omits; only quantity columns are selected; DB enforcement = change 19) | yes |
| Adjustment, transfer, receive, new item | **hidden** (all four are admin-only in the DB) | yes |
| Staff screen, employee ledger, advances, salary, wages | **hidden and refused** (owner decision; the DB lets `user` post advances up to Rs 5,000 but there is no UI for it) | yes |

## Schema addition (owner decision "salary is owner-only", found leaking)
`parties.monthly_salary` / `daily_wage` were readable by any counter user through the API, and salary / wage vouchers through `expense_vouchers`. One migration `20260926100000_staff_salary_owner_only.sql`: column-level SELECT on `parties` without the two salary columns for `authenticated`; salary and wage vouchers (and their lines) visible to admins only; `v_employees` (admin-gated, owner-rights view, the only path to the pay rates). pgTAP + `has_column` drift guard for every column the new screens read. The remaining copy of the same facts in `journal_lines` narrations / `v_day_book` is logged for change 19.

## Conservative defaults (owner unknowns; each logged in implementation-notes.md)
1. Overdue = at least one open invoice past its credit days. 2. Ledger defaults to the current FY (April-March) with the earlier balance carried as a b/f row. 3. Salary posts to account 5500 Salaries, wages to Loading & Unloading; advance recovery defaults to the maximum the database allows (advance outstanding, capped at the gross). 4. New employees are created in the organisation's state. 5. Counter staff get no staff screen at all. 6. WhatsApp reminder is offered only when the party has a valid mobile and a positive receivable.

## Acceptance scenarios
- **Ledger rows Enter-activatable:** on `/parties`, `/stock`, `/staff` every row takes focus, Enter opens its ledger; ledger rows for invoices open the invoice. Verified by keyboard in a real browser.
- **390 px:** all six screens and every modal fit with no horizontal page scroll, in both themes.
- **Statement:** the Excel closing balance equals the ledger pill and `v_party_balances`; numbers are numbers with `#,##0.00`.
- **Cost hidden:** a counter session's stock pages contain no rate/value figure (page text and the queries selected).
- **Adjustment / transfer:** loss adjustment reduces stock and shows Dr Stock loss / Cr Inventory in the journal; a transfer moves stock to In Transit, Receive lands it in the destination godown; neither button exists for a counter session.
- **Salary:** salary voucher with an advance outstanding recovers it; ledger shows advance falling to 0; counter session cannot read `parties.monthly_salary` (permission denied) or see the staff route.
- **Change-12 leftovers watched live:** resume a saved payment draft at `/payments/new?id=`; auto-allocate 900 + 100 discount against a 1,000 invoice.

## Gates
`supabase db reset` + `supabase test db`, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, i18n key parity, no hex / `parseFloat` on stored values / `xlsx`, live-browser walkthrough (1280 + 390, light + dark, admin + counter).
