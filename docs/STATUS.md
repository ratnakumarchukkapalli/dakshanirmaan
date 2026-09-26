# Where we are (updated 2026-09-26)

One page. If this and a chat disagree, fix this file.

## Decision (2026-09-22)
No early demo. Build the remaining changes properly, one at a time, in full per their spec
section and acceptance scenarios — not narrowed for a screenshot. Demo happens once the changes
below are done.

## Done
01 foundation-schema · 02 integrity-triggers · 03 posting-sales · 04 posting-purchase-payment ·
05 posting-challan-transfer-adjust-dayclose · 06 read-views · 07 app-shell · 08 auth-users ·
09 masters · 10a sales-billing-ui · 10b invoice-documents · 11 challans-ui · 12 payments-ui · 13 parties-stock-staff-ui · 14 dashboard · 15 reports-p1 · 16 ops · 19 aal2-enforcement (pushed to GitHub + hosted 2026-09-26) · 17 cutover · 18 self-audit-and-gst (built, reviewed, committed; hosted push pending).
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

## Change 19 status (2026-09-26)
Committed e646613, **pushed to GitHub + hosted 2026-09-26** (hosted now has all 27 migrations through `20260928100000`). No separate review (Ratna, 2026-09-26: built by Opus); the pre-go-live `/security-review` covers it. Migration
`20260928100000_aal2_enforcement.sql`: `current_app_role()` is NULL for an admin below `aal2`, `is_active_member()` goes through it,
the 15 remaining direct `app_users` role lookups now call it. Gates: 1567 pgTAP (new `00012`; 201 test sessions got `"aal":"aal2"`),
build clean; real-session REST proof (step-1 owner: `DN_FORBIDDEN` + empty reads) and an 18/18 Playwright login-flow walk.
Notes: `openspec/changes/19-aal2-enforcement/implementation-notes.md`. **Before pushing to hosted: confirm TOTP works on the hosted
Free plan (change 08 gap 5) — if it does not, this migration locks every owner out.** 2026-09-26: hosted dashboard shows
TOTP (App Authenticator) **Enabled** on the Free plan, and **proven by a script against hosted**: throw-away user signed in (aal1),
enrolled + verified a TOTP factor (aal2), user deleted. Change 19 is safe to push.
**Found 2026-09-26: on the Free plan Supabase will not let you edit email templates until custom SMTP is set up**, and the default
template sends only a link, no code — so nobody can sign in to hosted until Resend SMTP (domain + DKIM/SPF) is configured and
`supabase/templates/magic_link.html` pasted. Hard prerequisite for 17 (cutover).
Not in 19's brief, so not built: owner decisions 1 (stock cost hidden from counter) and 4 (master-edit audit trail) below, which
say "build with 19" — needs a decision on where they go before 17.

## Change 17 status (2026-09-26)
**Built, Opus-reviewed (3 fixes applied), committed with 18.** Migration `20260929100000_cutover.sql` (opening batches/lines, `post_opening_balances`, `cancel_opening_balances`, `opening_preview`, `ensure_fiscal_year`, `go_live_readiness`, FY locked to April, account 3900), screen Settings → Go-live (hand entry + CSV), RUNBOOK section 8. Gates: 1656 pgTAP, 549 vitest, tsc/lint/build clean, live browser walk passed. Notes: `openspec/changes/17-cutover/implementation-notes.md`. Owner decision 4 (master-edit audit trail) was built in change 18; decision 1 (stock cost hidden from counter) is still homeless.
**Ratna, 2026-09-26: custom SMTP (Resend) is NOT needed now** — deferred (it only blocks real sign-in on hosted; needed before the family logs in there). Order: build 18, then deploy to Vercel.
**Deploy plan:** the GitHub repo stays **private** and goes public only after the `/security-review`; link Vercel ↔ Supabase the same way as MyExpenseTracker (Vercel project from the GitHub repo via `vercel link`, env vars in Vercel, region `bom1` here vs `hnd1` there).

## Change 18 status (2026-09-26)
**Built, browser-walked, Opus-reviewed (fixes applied).** Migration `20260930100000_self_audit_and_gst.sql` (`gstr1_data`, `gstr3b_summary`, `set_period_lock`, master-edit audit triggers, statements functions), reports Trial balance / P&L / Balance sheet / GST returns (GSTR-1 JSON + Excel, GSTR-3B), Settings → Period locks and Audit trail, `docs/research/gstr1-schema.md`. Gates: 1769 pgTAP, 575 vitest, tsc/lint/build clean. **17 and 18 are both uncommitted in the working tree.** Notes: `openspec/changes/18-self-audit-and-gst/implementation-notes.md` (start there; it lists what is left: browser walk, portal upload test, Opus review, two doc updates).

## Decision 2026-09-26: password login (change 08b)
Ratna chose **email + password for everyone, owners also do the authenticator step**, like MyExpenseTracker (no SMTP needed). Brief: `openspec/changes/08b-password-login/proposal.md`. Build it after 17/18 are reviewed, committed and pushed, and before the Vercel deploy.

## Next session
Plan agreed with Ratna 2026-09-26: finish Phase 1 fully — **19 aal2-enforcement** (Opus, DONE and committed, see above; brief in `openspec/changes/19-aal2-enforcement/proposal.md`; `daksh-schema` + `daksh-posting`), then **17 cutover**, then **18 self-audit-and-gst** (Sonnet each; 18 starts with the GSTR-1 schema research task) — and only then a guided **Vercel deploy** (Ratna uses the existing hosted Supabase project `daksha-nirmaan`). One session edits the codebase at a time.
At deploy time decide: that project holds the REAL books, so a fake-data demo should go in a second hosted project (Free allows two per org); `demo-data.sql` must never be loaded into the real one. Also needed then: hosted Auth settings (email OTP, signups off, TOTP), the owner account via create-admin, Resend SMTP, Vercel env vars (RUNBOOK section 3 lists the secrets).
Changes 16 and 19 are done and pushed; nothing is unpushed.

## PENDING (Ratna, deferred 2026-09-26) — turn the nightly backup on
Until this is done **nothing is backed up** (the Backup workflow runs daily but prints a warning and stops). Steps, in `RUNBOOK.md` 2.1:
1. `age-keygen -o family-age-key.txt`; keep the file in two safe places; never in GitHub.
2. GitHub → Settings → Secrets and variables → Actions: add `AGE_PUBLIC_KEY` (the `age1…` line) and `DATABASE_URL` (Supabase → Connect → Session pooler URI with the password; letters/digits-only password).
3. Actions → Backup → Run workflow; download the artifact (a zip), then run the restore drill once (RUNBOOK 2.3). The hosted dump is untried until this happens.
Also open: 7 Dependabot pull requests (eslint 10, typescript 7, @types/node 26, actions/checkout 7 are major bumps; do not merge blindly).
Must be done before go-live (change 17) at the latest.

## Left (Phase 1), build in this order — one change per session
19 aal2-enforcement (committed) · 17 cutover and 18 self-audit-and-gst (both built, uncommitted, unreviewed). Then review, commit, push, and the guided Vercel deploy.
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
