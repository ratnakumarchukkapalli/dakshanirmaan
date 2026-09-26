Skill: daksh-schema + daksh-posting (migration + posting function), then daksh-ui + daksh-api (owner-only cutover screen)
Spec section: openspec/specs/db-architecture/spec.md → "### Opening balances (change 17)"; security-deployment → "Rollout steps" 6–7 and the go-live checks it names (real OTP arrives)
Context: The books start empty. Before the family stops using Tally / the paper book, the dues they are owed, the dues they owe, the cash and bank balances and the stock in the godown must go in as one balanced opening entry, so the trial balance balances on day one and every later report starts from the right place.
Do not: post opening balances any way but through `post_opening_balances`; write business math in TypeScript; load `supabase/demo/demo-data.sql` into the real project; commit `.env`; push to hosted (Ratna does, after review).

## Scope

1. **Database (one migration, `20260929100000_cutover.sql`).**
   - Account `3900 Opening Balance Equity` (`system_key = 'opening_balance_equity'`), leaf, equity.
   - Staging: `opening_batches` (one live batch at a time: draft or posted) and `opening_lines` (`kind` party / money / stock; party rows are `receivable` or `payable`). Owner-only RLS. Rows are editable only while the batch is a draft.
   - `post_opening_balances(p_date, p_expected_equity)`: owner, aal2, draft batch, period unlocked, one `source_type = 'opening'` journal entry (Dr AR per customer, Cr AP per supplier, Dr cash/bank, Dr Inventory; balancing line to `opening_balance_equity`), one `'opening'` stock movement per item/warehouse at the given rate. `p_expected_equity` refuses a stale preview.
   - `cancel_opening_balances(p_reason)`: owner; only while no other document has ever posted (books empty apart from the opening); mirror reversal dated on the opening date; the lines come back as a fresh draft batch so they can be corrected and posted again.
   - `ensure_fiscal_year(p_label)` (spec'd, never built): owner; creates the 12 April–March rows.
   - `go_live_readiness()`: owner; the checks the database can answer (organisation details filled, ≥ 2 owners, current + next month open, opening posted, ledger balanced, inventory account = stock ledger).
   - Owner decision 3: `organization.fy_start_month` is locked to April.
2. **Screen** `/settings/cutover` (owner only): (a) opening dues — pick party, side, amount; (b) cash and bank balances; (c) opening stock — table entry plus **CSV import** (item, warehouse, qty, rate; parsed and checked before anything is staged, no `xlsx`); (d) live preview of the balancing equity figure; (e) post / cancel; (f) the go-live checklist: the readiness rows above plus the manual items (real OTP arrives on the domain, TOTP on hosted, backup ran + restore drill done, manual invoice book labelled `DNM/26-27/`, demo data absent).
3. **`DNM/` manual-book series.** A paper book has no software side: the series only has to differ from `DN/`. Written into the go-live checklist and RUNBOOK; no numbering code.
4. **Docs.** `db-architecture` (opening functions, `ensure_fiscal_year`, `go_live_readiness`), STATUS, RUNBOOK go-live checklist.

## Conservative defaults (log in `implementation-notes.md`)
- Opening date = the last day *before* the first day billed in the app (else the opening cash lands as that day's cash-in).
- Party dues only for customers/suppliers (`both` allowed on either side); employee advances/salary payable are not part of opening.
- Amounts > 0 only; a bank overdraft is not supported at opening.
- Opening dues are single figures per party, not invoice by invoice: they show in the ledger and balances and in ageing as `other_ar`, not in the age buckets (change 15 behaviour, unchanged).
- After anything else has posted, a wrong opening figure is not reversible in the app (no manual journals in Phase 1).

## Done when
- **"trial balance balances after import"**: pgTAP proves Σdr = Σcr on `v_trial_balance` after `post_opening_balances`; AR/AP per party, cash, bank, inventory each equal what was staged; `v_stock_summary` carries the staged qty at the staged rate.
- Refusals proven: non-owner, owner at aal1, locked/missing period, second live batch, double post, stale `p_expected_equity`, party of the wrong type, non-stock item, transit warehouse, non-money account; cancel refused once another document has posted.
- Screen walk-through (browser, 390 px and desktop): stage by hand + CSV, preview, post, cancel, re-post; the change-14 dashboard and change-15 reports show the opening figures.
- pgTAP, vitest, `tsc`, lint, `npm run build` clean.
