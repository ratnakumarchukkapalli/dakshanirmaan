# Change 14 — dashboard

Skill: daksh-ui + daksh-api (+ daksh-schema for one small migration of read views) + dataviz (chart)
Spec section: frontend-architecture "Route structure" (`page.tsx` Dashboard), "Mobile version" (surface order), "Accessibility"; db-architecture "Views" and `v_attention`; prototype `#screen-dashboard` only.
Context: `/` is a placeholder. Every figure has to come from a view (change 06 / 12 / 13) or a new read view; nothing is computed in TypeScript beyond exact-decimal sums and formatting.
Do not: write ledger tables; put business math in TypeScript; start change 15; commit or push (Ratna commits).

## Scope
**In**
1. Header: date title (DD-MM-YYYY), organisation godown-free sub line, **books-balanced pill** (admin only, from `v_trial_balance`), **day-close status** (today closed / not closed yet, from `day_closes`).
2. **Quick actions** (real links, 44 px): New invoice `/sales/new`, Receive payment `/payments/new`, Delivery challan `/sales/challans/new`, Day close `/reports` (the day-close screen is change 15; until then it lands on the reports page).
3. **Stat tiles** (hero = today's sales): today's sales (+ invoice count, drafts), to collect (+ overdue), to pay, cash + bank, stock value, low stock.
4. **Chart**: sales of the last 7 days, stacked per day by item category (steel `--c-steel`, cement `--c-cement`, and a neutral `--c-other` only when another category sold), tooltip on hover **and keyboard focus**, legend, a table view under the chart (`<details>`), the only client component.
5. **Needs attention** from `v_attention`: severity chip (text), title/detail as the database wrote them, amount, each row a real link to the right screen.
6. New migration `20260927100000_dashboard_views.sql`: `v_sales_daily`, `v_sales_daily_category`, `v_money_balances` (admin-gated), grants, pgTAP drift guard + role tests.
7. en + te strings (key parity; Telugu agent-written, marked for native review), tokens only (new `--c-other`, `--hero-end`), 390 px, both themes.

**Out** (logged in notes): credit notes netted out of sales (notes are change 20), purchase-side tiles (ITC, RCM; change 21), month/FY sales comparison, per-godown dashboard, offline last-dashboard caching (service worker part of the PWA work), a date-range filter on the chart (fixed 7 days), localised text inside `v_attention` (the view writes English sentences).

## Tiles and their source
| Tile | Source | Notes |
|---|---|---|
| Today's sales (hero) | `v_sales_daily` (`sale_date` = org-timezone today: `billed_total`, `invoice_count`) + `sales_invoices` draft count | posted invoices only, incl. GST, cash sales included; not net of credit notes |
| To collect | `v_party_balances.ar_balance` summed (exact decimal) | = AR control balance |
| Overdue (sub of To collect) | `v_attention` kind `overdue_party` (`amount`, count) | same rows the list shows |
| To pay | `v_party_balances.ap_balance` summed; suppliers = rows with balance > 0 | admin only |
| Cash + bank | `v_money_balances` (new, admin-gated) summed; cash drawer = row `system_key = 'cash'` | admin only |
| Stock value | `v_stock_summary.value` summed; in transit = `v_stock_summary_all` where `is_transit` | admin only (cost) |
| Low stock | `v_attention` kind `low_stock` (count) + names from `items` | quantities only |
| Chart | `v_sales_daily_category` (`sale_date`, `category`, `amount`) + `v_sales_daily.billed_total` | 7 days incl. today, zero-filled in TS (no arithmetic on money) |
| Books balanced | `v_trial_balance` `total_debit` and `total_credit` summed | admin only |
| Day close | `day_closes` (`close_date`, `difference`, `status`) | readable by members |

## Role matrix (read off the views and policies)
| | counter (`user`) | owner (`admin`, aal2) |
|---|---|---|
| Today's sales, chart, drafts | yes | yes |
| To collect + overdue | yes (`v_party_balances`/`v_attention` readable) | yes |
| To pay | **no** | yes |
| Cash + bank | **no** (payroll cash is hidden from a counter by RLS, so a counter-side sum would be wrong as well as private) | yes |
| Stock value, stock in transit value | **no** (cost) | yes |
| Low stock | yes (quantities) | yes |
| Books-balanced pill (TB) | **no** | yes |
| Attention rows | all but `gst_due`, `create_fy_periods` (the view filters them) | all |
The admin-only queries are not made at all for a counter session (not just hidden).

## Defaults for owner unknowns (conservative; logged)
1. Sales = billed total incl. GST, before credit notes (none exist yet). 2. Chart window = today and the 6 days before (organisation time zone). 3. "Overdue" = the `v_attention` definition (an open invoice past its credit days). 4. Counter sees To collect but not To pay. 5. Day-close quick action goes to `/reports` until change 15. 6. Item category is read from `items` at query time (invoice lines carry no category snapshot). 7. Attention list shows at most 10 rows; a counter link says how many more exist.

## Acceptance
- Both themes; tooltip appears on hover and on keyboard focus of a day; legend present (and marks are also named by a table view); works at 390 px with no sideways scroll.
- Attention rows and quick actions are keyboard-activatable links; each attention row lands on a real page.
- Server components by default; the chart is the only `'use client'` file.
- Each tile equals a direct SQL query of its source view; a counter session's HTML contains no admin-only figure.
- Empty states (no sales this week, nothing needs attention) and error states (a failed query renders a visible error card, never a blank tile) are real.

## Gates
`supabase db reset` + `supabase test db` green (baseline 1265 + new), `npx tsc --noEmit`, `npm run lint`, `npm test` (baseline 436 + new), `npm run build`, then a live-browser run as owner and counter at 1280 and 390 px, light and dark.
