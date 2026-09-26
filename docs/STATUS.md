# Where we are (updated 2026-09-26)

One page. If this and a chat disagree, fix this file.

## Decision (2026-09-22)
No early demo. Build the remaining changes properly, one at a time, in full per their spec
section and acceptance scenarios — not narrowed for a screenshot. Demo happens once the changes
below are done.

## Done
01 foundation-schema · 02 integrity-triggers · 03 posting-sales · 04 posting-purchase-payment ·
05 posting-challan-transfer-adjust-dayclose · 06 read-views · 07 app-shell · 08 auth-users ·
09 masters · 10a sales-billing-ui · 10b invoice-documents · 11 challans-ui · 12 payments-ui · 13 parties-stock-staff-ui · 14 dashboard · 15 reports-p1 (built + live-verified 2026-09-26, UNCOMMITTED; review owed).
Local demo data exists (`supabase/demo/demo-data.sql`) and can be reloaded any time; it is not
the goal, just a convenience for testing screens as they're built.

## Review status (2026-09-25)
Independent Opus review of 10a/10b/11 and the change-12 milestone review ("money flows end to
end") are DONE; every finding was fixed (see each change's `implementation-notes.md`: "Review
fixes" sections). Gates on the combined tree: 1010 pgTAP, 362 vitest, tsc/lint/build clean.
**COMMITTED a4dad1e and pushed (GitHub + hosted, 2026-09-26):** change-12 fixes (migration `20260925100000_payments_note.sql`,
cancelPayment action), 10a/posting fixes (migration `20260925110000_posting_snapshot_warehouse_guards.sql`:
post-time item snapshot re-read, transit-warehouse refusal, e-way-bill CHECKs), 11 fixes (locked
challan drafts, race recovery). Hosted DB now has all 25 migrations through `20260927100000`.
Change-12 draft resume and auto-allocate-with-discount were watched live in the change-13 session (both work).
Still open: `place_of_supply` on a draft is client-writable (owner question); re-allocating a posted receipt
(later change); 06/07 have Sonnet-only reviews; 03–05/08/09 had Opus reviews earlier; `/security-review`
before go-live.

## Change 13 status (2026-09-25)
Committed a4dad1e, pushed to GitHub + hosted 2026-09-26. Extra migrations: `20260926100000_staff_salary_owner_only.sql`,
`20260926110000_payroll_owner_only_ledger.sql` (). Gates: 1265 pgTAP, 436 vitest,
tsc/lint/build clean. Open owner questions: counter-staff advances <= 5,000 (DB allows, no screen);
wages account (Loading & Unloading vs own); day_closes cash figures include payroll cash. Stock cost
readable via API until change 19. `exceljs` -> uuid audit advisory (moderate) deferred to change 16.

## Change 14 status (2026-09-26)
Committed a4dad1e, pushed to GitHub + hosted 2026-09-26. Migration `20260927100000_dashboard_views.sql` (v_sales_daily,
v_sales_daily_category, admin-gated v_money_balances);  Gates: 1336 pgTAP, 458 vitest,
tsc/lint/build clean. Reviewed by Opus 2026-09-26 (APPROVE; nits fixed in change 15's commit). Owner questions: counter sees To pay / cash drawer? (default no); sales incl. GST?
(default yes); Telugu attention sentences (needs structured v_attention); chart 7 vs 30 days.
Day-close quick action now points at /reports/day-close (change 15).

## Change 15 status (2026-09-26)
Built, Opus-reviewed together with 14 (14 APPROVE, 15 APPROVE AFTER FIXES, all fixed: counter closes days in order,
`post_day_close` refuses a stale expected figure, stock residue rows), committed and pushed to GitHub + hosted.
Migration `20260927110000_reports_p1.sql` (`day_close_preview`, admin-gated `v_money_ledger`, `post_day_close` with
`p_expected_seen` + counter in-order guard). Gates: 1456 pgTAP, 501 vitest, tsc/lint/build clean. Screens: `/reports` cards,
day close (close + owner-only reopen), day book, ageing (+ AR chip), stock (+ inventory chip), cash & bank book (owner only),
Excel for the last four. Notes: `openspec/changes/15-reports-p1/implementation-notes.md`.
Owner questions: payables ageing wanted? stock as at a past date? day-close by denomination? should an owner be allowed to
close a day out of order in the app (DB allows it; the screen asks to reopen the later day first)?

## Next session
Start **16 ops** (Sonnet, daksh-api). Nothing is unpushed.

## Left (Phase 1), build in this order — one change per session
16 ops · 17 cutover · 18 self-audit-and-gst · 19 aal2-enforcement.
Full list with owner/skill/spec-section/acceptance per change: `openspec/changes/README.md`.
Change 19 must land before 17 (cutover) for real go-live, but can be built whenever in this list
— it does not block the other UI changes.

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
