# Where we are (updated 2026-09-22)

One page. If this and a chat disagree, fix this file.

## Decision (2026-09-22)
No early demo. Build the remaining changes properly, one at a time, in full per their spec
section and acceptance scenarios — not narrowed for a screenshot. Demo happens once the changes
below are done.

## Done
01 foundation-schema · 02 integrity-triggers · 03 posting-sales · 04 posting-purchase-payment ·
05 posting-challan-transfer-adjust-dayclose · 06 read-views · 07 app-shell · 08 auth-users ·
09 masters · 10a sales-billing-ui · 10b invoice-documents · 11 challans-ui (reviewed, no findings,
committed 2026-09-22).
Local demo data exists (`supabase/demo/demo-data.sql`) and can be reloaded any time; it is not
the goal, just a convenience for testing screens as they're built.

## Left (Phase 1), build in this order — one change per session
12 payments-ui · 13 parties-stock-staff-ui · 14 dashboard · 15 reports-p1 ·
16 ops · 17 cutover · 18 self-audit-and-gst · 19 aal2-enforcement.
Full list with owner/skill/spec-section/acceptance per change: `openspec/changes/README.md`.
Change 19 must land before 17 (cutover) for real go-live, but can be built whenever in this list
— it does not block the other UI changes.

**12 payments-ui BUILT, UNCOMMITTED, NOT YET LIVE-BROWSER VERIFIED (2026-09-22).** Payments list
(tiles + cheque-lifecycle row actions) at `/payments`, receipt/outgoing-payment form with an
allocation grid at `/payments/new`; `saveDraftPayment`/`postPayment`/`depositCheque`/`markCleared`/
`bounceCheque` in `src/app/actions/payments.ts`. One schema addition (Ratna's go-ahead):
`v_open_purchase_invoices` (migration `20260922110000_open_purchase_invoices.sql`), the mirror of
`v_open_sales_invoices` for the outgoing-payment direction — nothing else covered open purchase
invoices since purchases has no UI until change 21. Role gates read directly off the database: any
member posts a receipt; only a verified admin can post an outgoing payment or one with a discount
(the form hides the Pay toggle and the discount field from anyone else, matching `post_payment`'s
own rule); bounce is admin-only. A fresh-context review (same day) found 3 real issues — the
"auto-allocate" fill used float arithmetic instead of the exact-decimal helpers, that logic had no
test despite the proposal asking for one, and an unused `hero` tile variant had a hardcoded hex —
all three fixed (see implementation notes). Verified after fixes: 945/945 pgTAP (941 + 4 new),
352/352 vitest (18 in `payments.test.ts`, 9 in new `payments-alloc.test.ts`), lint/tsc/build clean,
i18n parity checked. **Not done this round: the live-browser walkthrough.** Local Supabase came up
clean and demo data was attempted, but creating a throwaway local test admin hit a permission block
(exporting the local dev secret key was flagged as credential leakage) and Ratna chose to skip the
walkthrough rather than work around it — so unlike changes 10a/10b/11, this one has not been
watched working end to end against a real browser; the reviewer flagged this as the one open item
worth closing before commit, since it's exactly the flow (auto-allocate) that had the bug. Full
details in `openspec/changes/12-payments-ui/implementation-notes.md`. Next: close the live-browser
gap if practical, then commit when Ratna says so, then change 13.

## Then Phase 2
20 notes · 21 purchases-ui · 22 bank-recon · 24 quotes-rebates-interest · 25 exports-portability.

## Owner decisions already made (2026-09-21, Ratna delegated to Claude, she can overrule)
1. Stock cost hidden from counter staff — owner-only cost view, build with 19.
2. Employee salary/wages owner-only — build with 13 (staff screen).
3. FY start locked to April — small migration, build with 17 or 19.
4. Audit trail on master edits (parties/items/organisation) — small trigger, build with 19.
Also: lock organisation legal name/GSTIN/address once invoices exist (PDF reads them live).

## Working rules
- **One change per session.** Finish it, review if warranted, commit, `/clear`, start the next
  fresh. Don't chain several changes into one prompt — context fills up and quality drops.
- Each session: load the skill and read only the one spec section the change's README row names.
- Only one session edits the codebase at a time.
