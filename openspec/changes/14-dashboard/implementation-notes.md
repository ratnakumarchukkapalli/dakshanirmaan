# Change 14 — dashboard: implementation notes

Status: built, all automated gates green, live-browser verified (see below). **Not committed, not pushed.** Proposal: `proposal.md`.

## What was built
- `/` (RSC): header (weekday + DD-MM-YYYY, day-close chip, books-balanced chip for the owner), quick actions, six stat tiles (hero = today's sales), 7-day chart, attention list.
- Chart `src/components/dashboard/SalesChart.tsx` is the only `'use client'` file (asserted by `boundaries.test.ts`): stacked bars by category (steel/cement tokens, neutral `--c-other` only when another category sold), legend, tooltip on hover **and keyboard focus** (Escape dismisses, edges align so it stays in the viewport), per-day `aria-label`, "View as table" `<details>` with every figure.
- Attention list `AttentionList.tsx`: rows are real `<a>` links (Tab + Enter), severity chip carries text, top 10 + "N more not shown".
- Data layer `src/lib/dashboard-data.ts` (each loader independent, `settle()` logs and returns a visible error state per section; `completeRows` throws if PostgREST's 1000-row cap cut a list) and pure `dashboard-math.ts` (exact-decimal sums, 7-day window, link map, sort).
- Migration `20260927100000_dashboard_views.sql`: `v_sales_daily`, `v_sales_daily_category`, `v_money_balances` (admin-gated). pgTAP `00022` (71 tests: has_column guard for everything the dashboard reads, day totals vs documents, cancelled/draft excluded, category + round-off reconcile, counter sees no money balances, grants). `00008` view count 19 -> 22.
- Tokens `--c-other`, `--hero-end` (all three theme blocks, `@theme`), `StatTile` gained `hero` / `subTone`. Spec rows added (frontend tokens, db "Dashboard views").

## Role matrix (as built)
Counter: today's sales, chart, To collect + overdue, Low stock, attention rows (the view already hides GST/FY rows). Owner adds To pay, Cash + bank, Stock value, books-balanced chip. Owner-only queries are not made for a counter session; verified in the rendered DOM and by a mocked-loader test.

## Deviations / defaults (owner unknowns)
1. Sales = billed total incl. GST, before credit notes (none exist until change 20). Tooltip/table show round-off (2 dp) so a day's categories reconcile to its total.
2. Item category comes from `items` at query time (lines have no snapshot): recategorising an item recolours history in the chart.
3. Attention `title`/`detail` are the database's English sentences (rendered verbatim, also in Telugu); chip, amounts, layout are localised. A structured `v_attention` (params instead of prose) is the fix if the owner wants Telugu sentences.
4. To pay, Cash + bank, Stock value hidden from counter (payroll cash is RLS-hidden from a counter, so a counter-side cash sum would be wrong as well as private).
5. Day-close quick action goes to `/reports` (placeholder until change 15). Stale-challan rows go to `/sales?status=challan` (posted challans have no view page). Cheque rows go to `/payments` (no per-cheque page).
6. Chart is a fixed 7 days; no date filter. Offline "last dashboard" caching belongs with the PWA work, not done here.
7. `--c-other` gray fails the validator's chroma floor by design (a neutral is meant to read gray); it passes lightness, CVD separation, normal-vision floor and 3:1 contrast in both themes.

## Found while verifying (fixed)
Chart bars used a `.seg` class that collided with the global segmented-control `.seg` (padding, 12px radius): renamed `.bar`. Round-off of -0.30 showed as "-₹0" with whole-rupee formatting: now 2 dp.

## Verified live (Playwright in the scratchpad outside the repo, `npm start` production build, local Supabase, demo data + extra invoices dated today incl. a third-category item)
- Owner (TOTP) and counter (mail-catcher code), 1280 and 390 px, light and dark: no horizontal scroll, no console errors.
- Tiles vs SQL: hero = `v_sales_daily` today; To collect = sum `v_party_balances.ar_balance`; To pay = sum ap; Cash + bank = raw ledger sum over money accounts; Stock value = raw stock_movements sum; overdue and low-stock = `v_attention`; trial-balance chip = raw debit-credit 0.00. Chart table figures = `v_sales_daily`.
- Hover and keyboard focus show the tooltip, Escape hides it, Tab moves day to day; legend lists Cement/Steel/Other; day hit targets 47 px at 390; tooltips stay inside a 390 px viewport for days 1, 4, 7.
- Enter on each attention row and each quick action lands on a real page (payments, party ledger, sales challans, item ledger, new invoice, new receipt, new challan, reports).
- Counter: exactly three tiles; rendered page has no To pay / Cash / Stock value / books text or figures; the raw HTML+RSC payload contains only counter-visible figures (its UI message catalogue does carry the owner tile *labels*, no numbers).
- Telugu renders (h1, tile labels); screenshot reviewed.

## Not verified
- Counter's own JWT against PostgREST for the new views (token could not be read from the cookie in the script): covered by pgTAP `00022` (counter sees 0 rows of `v_money_balances`/`v_trial_balance`), not driven live.
- Telugu strings are agent-written: **native review needed** for all `dashboard.*`.
- Not run: reduced-transparency emulation, screen-reader pass, hosted project (migration is local only; `supabase db push` after review).
- No independent review of change 14 yet (Sonnet reviewer with `daksh-review`; the migration is small).

## Gates
`supabase db reset` + `supabase test db` 1336/1336 (1265 + 71); `npx tsc --noEmit` clean; `npm run lint` clean; `npm test` 458/458 (436 + 22); `npm run build` clean.

## Owner questions
1. Should counter staff see To pay / cash drawer? (default: no.) 2. Is "sales" incl. GST right for the hero, or ex-GST? 3. Want Telugu sentences in the attention list (needs a structured `v_attention`)? 4. Chart window fixed at 7 days, or a 7/30-day toggle?
