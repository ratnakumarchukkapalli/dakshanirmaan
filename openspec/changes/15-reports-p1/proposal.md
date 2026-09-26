# Change 15 — reports-p1

Skill: daksh-ui + daksh-api (+ daksh-schema for one small migration of read functions/views)
Spec section: frontend-architecture "Route structure" (`reports/` card grid) + "Server/client component split" (day-close counted-cash input) + "Accessibility"; api-architecture "Route handlers" (`GET /api/reports/[name]/xlsx`); db-architecture "day_closes" and "Implementation clarifications (Views)".
Context: `/reports` is a placeholder and the dashboard's Day-close quick action lands on it. Every figure comes from a view (06 / 13 / 14) or a new read function; TypeScript only formats and does exact-decimal sums. Excel exports use `exceljs` and read through the same loaders as the screens, so a workbook always equals the screen it came from.
Do not: put business math in TypeScript; read `day_closes` snapshot columns as truth for reports (the ledger is truth); use `xlsx`; start change 16; commit or push (Ratna commits).

## Scope
**In**
1. `/reports` — card grid of the built reports (cards are keyboard-activatable links; the owner-only Cash & bank book card is hidden from a counter).
2. `/reports/day-close?date=` — the day's cash position (opening, cash in, cash out, deposited to bank, **expected in drawer**) from the new SECURITY DEFINER `day_close_preview(date)`; a counted-cash form (the only client component of the change) calling `post_day_close`; when the date is already closed, shows the stored result (counted, difference chip with text, closed by/at, note) and an owner-only **Reopen** (`cancel_document('day_close')` with a reason); list of the last 14 closes.
3. `/reports/day-book?from=&to=&type=&page=` — `v_day_book`, 100 rows per page, reversal / reversed chips, total-per-page not shown (a day book has no total).
4. `/reports/aging?q=` — receivables from `v_party_aging`: four bucket tiles, on-account and interest tiles, per-party rows (0–30 / 31–60 / 61–90 / 90+, on account, interest, receivable), rows open the party ledger. Owner sees a **reconciliation chip**: Σ receivable equals the AR control account in `v_trial_balance` (or says by how much it differs and why: entries with no party).
5. `/reports/stock` — `v_stock_summary` by item × godown, godown segmented; owner also sees average rate, value and the total, with a reconciliation chip against the Inventory account (`v_stock_summary_all` incl. transit vs `v_trial_balance`). A counter's request never selects cost columns.
6. `/reports/cash-bank?account=&from=&to=` — **owner only**: one money account at a time (Cash, each bank), opening, every line with running balance, in/out/closing tiles; from new admin-gated `v_money_ledger`.
7. Excel: `GET /api/reports/[name]/xlsx` for `aging`, `stock`, `day-book`, `cash-bank` (same filters as the screen, same role gates, money as numbers with `#,##0.00`, dates as dates).
8. Migration `20260927110000_reports_p1.sql`: `day_close_preview(p_date)` (both roles, same arithmetic as `post_day_close`, so the counter's expected figure includes payroll cash they cannot see line by line), `v_money_ledger` (admin-gated, running balance), grants, pgTAP.
9. en + te strings (te agent-written, marked for native review), tokens only, 390 px, both themes. `/reports/cash-bank` added to the proxy's owner-only paths.

**Out** (logged in notes): payables ageing (party page already buckets supplier bills), stock as at a past date, day-close cash-counting denominations, printable/PDF versions, trial balance / P&L / balance sheet / GSTR (change 18), site-sales and rebates reports (later).

## Role matrix
| | counter (`user`) | owner (`admin`, aal2) |
|---|---|---|
| Day close (preview, close, list) | yes | yes; also Reopen |
| Day book | yes (RLS hides payroll entries) | yes, all |
| Ageing | yes | yes + reconciliation chip |
| Stock report | quantities only | + rate, value, total, reconciliation |
| Cash & bank book | **no** (page redirects, view returns nothing, export 403) | yes |

## Defaults for owner unknowns (conservative; logged)
1. Day-close date defaults to today (organisation time zone); back-dated closes allowed as the database allows (unlocked period, not future).
2. Day book / cash book default range = current month to today. Cash book row cap 1,000 per range (an error card asks to narrow the dates rather than showing a partial running balance).
3. Ageing lists only parties with a non-zero balance or unapplied receipts (the view's own filter), sorted by receivable, largest first.
4. Ageing buckets are by invoice date, as in `v_party_aging` (not due date).
5. Stock report is "now" only.

## Acceptance
- "ageing totals = AR control balance": Σ `ar_balance` of the ageing screen equals the AR row of `v_trial_balance` when every AR line has a party (pgTAP + live), and the chip says so.
- Day close: the screen's expected equals what `post_day_close` stores in `day_closes.expected` for the same ledger (pgTAP drift guard, counter session incl. a payroll cash entry); closing with a difference shows the DB's difference; closing twice → friendly "already closed"; a locked month → `period_locked` message; a counter has no Reopen.
- A counter's rendered pages and export requests contain no cash/bank figure and no stock cost.
- Workbooks open with the same rows and totals as the screen (vitest builds each workbook and reads it back).
- Rows are keyboard-activatable; 390 px no sideways scroll; both themes; empty and error states real (a failed query is a visible error card, never an empty table).
- Server components by default; the day-close form is the only `'use client'` file besides existing ones (asserted by a boundaries test).

## Gates
`supabase db reset` + `supabase test db` green (baseline 1336 + new), `npx tsc --noEmit`, `npm run lint`, `npm test` (baseline 458 + new), `npm run build`, then a live-browser run as owner and counter at 1280 and 390 px, light and dark.
