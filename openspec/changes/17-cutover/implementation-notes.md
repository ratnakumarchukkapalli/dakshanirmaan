# Change 17 — cutover: implementation notes

Built 2026-09-26 (Sonnet 5). Opus-reviewed 2026-09-26 (APPROVE AFTER FIXES, all three fixed, see below). Committed with change 18. Proposal: `proposal.md`.

## What was built
- Migration `20260929100000_cutover.sql`: account 3900 `opening_balance_equity`; `opening_batches` + `opening_lines` (owner-only RLS, draft-only edit trigger, one live batch); `post_opening_balances(p_date, p_expected_equity)`, `cancel_opening_balances(p_reason)`, `opening_preview()`, `ensure_fiscal_year(p_label)`, `go_live_readiness()`; `CHECK (fy_start_month = 4)` (owner decision 3).
- Screen `/settings/cutover` ("Go-live" tab, owner only): party dues, cash/bank, stock (by hand + CSV), the database's preview, post, cancel-and-correct, readiness chips + manual checklist. Actions `src/app/actions/cutover.ts`; CSV parser `src/lib/opening-csv.ts`; data `src/lib/cutover-data.ts`; en + te messages.
- RUNBOOK section 8 (go-live day); `db-architecture` "Opening balances" rewritten to match.

## Gates
pgTAP 1656 (new `00024_cutover`: 89 assertions; `00002` count 33→34 for the new system key and `00014` two probes moved from `fy_start_month = 5` to `state_code`, both planned consequences of this change), vitest 549 (22 new: CSV parser + actions), `tsc`, lint, `npm run build` clean.
Browser (Playwright, production build on :3100, real owner session at aal2): stage a customer due, supplier due, cash, bank, stock by hand and by CSV; bad CSV names the line; unknown item / duplicate / missing-period refusals show their sentences; equity preview ₹3,27,000; post; ledger 3,67,000 = 3,67,000; stock report and dashboard render; cancel returns the lines as a draft; re-post; no sideways scroll at 390 px; no page errors.

## Decisions taken (conservative defaults; Ratna can overrule)
1. Opening date = last day before billing starts (screen defaults to yesterday).
2. Opening dues are one figure per party (not invoice by invoice); they show in ledger/balance and ageing `other_ar`, not the age buckets. Receipts against them stay unallocated (change-12 behaviour).
3. Party dues only for customers/suppliers; employee advances / salary payable are not part of opening.
4. Amounts > 0; no bank overdraft at opening.
5. Cancel is allowed only while the books hold nothing but the opening; after that a wrong opening figure has no in-app fix (no manual journals in Phase 1).
6. `DNM/` needs no code: it is the paper book's prefix (checklist + RUNBOOK).
7. Opening stock refuses an item/godown that already has movements (would re-average silently). Cancelled openings net to zero, so re-posting is allowed.
8. `ensure_fiscal_year` was in the spec but never built; added here because an opening date in another financial year needs its periods. The "Create FY" attention row on the dashboard (from 1 March) is still not built — change 18's period-locks screen is the natural home.
9. The organisation form now shows April only (schema `z.literal('4')`); DB CHECK is the lock.

## Not built / left for Ratna
- Owner decision 1 (stock cost hidden from counter) and 4 (audit trail on master edits) were tagged "build with 19" and 19 did not build them. Not done here either; 4 is a prerequisite for change 18's audit-trail page.
- `v_day_book` does not list the opening entry (it unions known document types); the trial balance, ledgers and reports read the journal directly and do show it.
- Review owed: Opus + `daksh-review` (posting function, RLS, auth) before push to hosted.
- Hosted push needs Resend SMTP first (STATUS): nobody can sign in to hosted until then.

## Review fixes (Opus, 2026-09-26)
1. CSV import refused a name that matches more than one item or godown (`csv.ambiguous_item` / `ambiguous_godown`) instead of staging against the last match; vitest covers it.
2. `cancel_opening_balances` takes `lock table journal_entries, stock_movements in share row exclusive mode` before the "nothing else has posted" check, so a sale cannot commit in between.
3. `post_opening_balances` refuses (`DN_VALIDATION:opening_after_documents`) a date on or after any non-opening journal entry or stock movement; pgTAP covers it (00024 now 90 assertions).
Gates after fixes: pgTAP 1779, vitest 576, tsc/lint clean. Not re-reviewed after the fixes.
**Know this:** a wrong opening figure discovered once other documents exist has no in-app fix (no manual-journal or party-balance adjustment path in Phase 1).
