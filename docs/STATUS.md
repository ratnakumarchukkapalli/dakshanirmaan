# Where we are (updated 2026-09-22)

One page. If this and a chat disagree, fix this file.

## Decision (2026-09-22)
No early demo. Build the remaining changes properly, one at a time, in full per their spec
section and acceptance scenarios — not narrowed for a screenshot. Demo happens once the changes
below are done.

## Done
01 foundation-schema · 02 integrity-triggers · 03 posting-sales · 04 posting-purchase-payment ·
05 posting-challan-transfer-adjust-dayclose · 06 read-views · 07 app-shell · 08 auth-users ·
09 masters · 10a sales-billing-ui · 10b invoice-documents.
Local demo data exists (`supabase/demo/demo-data.sql`) and can be reloaded any time; it is not
the goal, just a convenience for testing screens as they're built.

## Left (Phase 1), build in this order — one change per session
11 challans-ui · 12 payments-ui · 13 parties-stock-staff-ui · 14 dashboard · 15 reports-p1 ·
16 ops · 17 cutover · 18 self-audit-and-gst · 19 aal2-enforcement.
Full list with owner/skill/spec-section/acceptance per change: `openspec/changes/README.md`.
Change 19 must land before 17 (cutover) for real go-live, but can be built whenever in this list
— it does not block the other UI changes.

**11 challans-ui BUILT, UNCOMMITTED, VERIFIED against a live local database (2026-09-22).** Challan
form + Open challans panel at `/sales/challans/new`; `saveDraftChallan`/`postChallan`/
`convertChallanToInvoice` in `src/app/actions/challans.ts`; `/sales` list gained a Challans
segment. A real Chromium walkthrough (Docker started, `supabase db reset`, demo data loaded) found
and fixed two bugs: the Open challans panel was always empty (ambiguous `parties` embed —
`delivery_challans` has two FKs to `parties` — PostgREST error was being swallowed silently) and
the form didn't actually clear after posting (state reset but not the react-hook-form values).
Also closed the idempotency race window flagged in the first pass: migration
`20260922100000_challan_invoice_unique_draft.sql` adds a partial unique index
(`sales_invoices_one_draft_per_challan`) so at most one draft invoice can ever exist per challan,
and the action recovers cleanly if it loses that race. Verified: 941/941 pgTAP (937 + 4 new),
325/325 vitest (20 in `challans.test.ts`), lint/tsc/build clean, and the live browser walkthrough
(10/10 checks, including converting the same open challan twice and landing on the identical
invoice both times). Not done: 390px / dark-theme visual check (walkthrough ran at 1280px, one
theme). Full details in `openspec/changes/11-challans-ui/implementation-notes.md`. Next: review,
then commit when Ratna says so, then change 12.

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
