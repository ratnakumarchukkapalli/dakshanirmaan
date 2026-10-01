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

## Attack-test fixes (2026-09-26, migration `20261001100000_attack_test_fixes.sql`, uncommitted, local only)
From `docs/reviews/2026-09-attack-test.md`: F2 `place_of_supply` is derived in `post_sales_invoice` (shipping state if it is one of the
party's own addresses, else the party's state; anything else -> `DN_VALIDATION:invalid_place_of_supply`) and written back; the invoice
form shows it read-only and `saveDraftInvoice` derives it too; CHECK on all four document tables. F1 write policies on
`payment_allocations` now require the payment to be a draft. F4 `gstin_checksum_ok` revoked from public/anon. F3 `set_created_by`
trigger on every table with `created_by`. F5 `hidden_payroll_*` return ids to a counter user only; `set_my_locale` writes for members only.
L1 guard: `00026_attack_test_fixes.test.sql` fails if any public function is anon-executable, any table lacks RLS, or a `created_by`
table lacks the trigger. Debit/credit notes have no post function yet: whoever writes them must derive place of supply the same way.
Not yet pushed to hosted. Hosted ACLs were never compared with local (review "Limits").

## Review status (2026-09-25)
Independent Opus review of 10a/10b/11 and the change-12 milestone review ("money flows end to
end") are DONE; every finding was fixed (see each change's `implementation-notes.md`: "Review
fixes" sections). Gates on the combined tree: 1010 pgTAP, 362 vitest, tsc/lint/build clean.
**COMMITTED a4dad1e and pushed (GitHub + hosted, 2026-09-26):** change-12 fixes (migration `20260925100000_payments_note.sql`,
cancelPayment action), 10a/posting fixes (migration `20260925110000_posting_snapshot_warehouse_guards.sql`:
post-time item snapshot re-read, transit-warehouse refusal, e-way-bill CHECKs), 11 fixes (locked
challan drafts, race recovery). Hosted DB now has all 25 migrations through `20260927100000`.
Change-12 draft resume and auto-allocate-with-discount were watched live in the change-13 session (both work).
Still open: re-allocating a posted receipt (later change; allocations of a posted receipt are now immutable through the API, see attack-test fixes below); 06/07 have Sonnet-only reviews; 03–05/08/09 had Opus reviews earlier; `/security-review`
before go-live.

## Phase 1 review (2026-09-26)
Independent reviews of 06/07/08b/13/16/19: report `docs/reviews/2026-09-phase1-review.md` (no criticals; 19 and 06 approved). Fix-list items 1, 2, 5-9 are fixed and uncommitted (see its "Fix status"). **Owner decisions (Ratna, 2026-09-26):** payroll cash inferable via the day close = accepted (H2, recorded in the spec); session time-box / sign-in rate limit enforced only in the app = accepted and documented (M1/M2, revisit at the security review); stock cost hidden from the counter = build as **change 28** (`openspec/changes/28-stock-cost-owner-only/proposal.md`). When the backup is switched on, set the Actions variable `ALLOW_EMPTY_BACKUP=1` until the opening balances are posted (RUNBOOK 2.1).

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
**Built, browser-walked, Opus-reviewed (fixes applied), committed with 17.** Migration `20260930100000_self_audit_and_gst.sql` (`gstr1_data`, `gstr3b_summary`, `set_period_lock`, master-edit audit triggers, statements functions), reports Trial balance / P&L / Balance sheet / GST returns (GSTR-1 JSON + Excel, GSTR-3B), Settings → Period locks and Audit trail, `docs/research/gstr1-schema.md`. Gates: 1769 pgTAP, 575 vitest, tsc/lint/build clean. Committed 76f2ed2 and pushed (GitHub + hosted). Notes: `openspec/changes/18-self-audit-and-gst/implementation-notes.md` (start there; it lists what is left: browser walk, portal upload test, Opus review, two doc updates).

## Change 08b status (2026-09-26): password login — built, browser-walked
Ratna chose **email + password for everyone, owners also do the authenticator step**, like MyExpenseTracker (no SMTP needed). Built after 17/18 were committed and pushed (76f2ed2). Notes: `openspec/changes/08b-password-login/implementation-notes.md`. Next: commit/push it, then the guided Vercel deploy (hosted db push of migrations 20260929/20260930 needs Ratna's OK; set hosted Auth min password length 12).

## Attack test (2026-09-26)
Adversarial permission run against local Supabase (5 identities, ~2,160 checks): `docs/reviews/2026-09-attack-test.md`. Nothing critical; the ledger, posted amounts, payroll, purchases, outgoing payments, discounts, credit override and day-close rules all held. Six small gaps (F1 posted-receipt allocations editable, F2 `place_of_supply` steerable, F3 `created_by` forgeable, F4 `gstin_checksum_ok` open to anon, F5 helpers answer no-one identities, L1 no catalog-wide guard) are scoped in `openspec/changes/27-attack-test-fixes/proposal.md` (Opus, fresh session, before change 26). Repeatable harness: `bash scripts/attack-test/run-all.sh` (local only). **K1–K4 (counter can derive bank/cash/profit/stock cost/supplier prices via the API): accepted for now (Ratna, 2026-09-26)** — counter logins are trusted family/staff; revisit if that changes. Not part of change 27. Hosted was not tested; a read-only catalog comparison on hosted needs Ratna's OK.

**Change 27 review (2026-09-26): APPROVE AFTER FIXES.** F2 was half closed (counter staff can still add/edit a `party_addresses` state). Follow-up `openspec/changes/27b-address-state-owner-only/proposal.md` (Opus, fresh session) — **sequenced later by Ratna: Phase 2 starts from 20 and reaches 27b in order**; until then a counter user can still steer the tax head by adding an out-of-state address (tax total unchanged, head wrong). **Owner decision (Ratna, 2026-09-26): out-of-state delivery sites are added by the owner only.** Change 27 is already on hosted; 27b's migration will need the same push. Hosted catalog comparison still awaits Ratna's OK.

## Hosted (2026-09-26)
All 29 migrations are on hosted `daksha-nirmaan` (Free, Mumbai). Hosted Auth was fixed via a minimal `supabase config push` (only declared keys are touched): **sign-ups OFF** (were ON), **minimum password length 12 → lowered to 8 on 2026-09-26 at Ratna's request** (was 6); TOTP already enabled. Still to set after the Vercel URL is known: Auth site URL (currently `http://localhost:3000`). Vercel plan: **Hobby** (Ratna's choice, 2026-09-26). Free-plan facts: project pauses after 7 idle days; no point-in-time recovery, so the nightly GitHub backup (RUNBOOK 2.1, still not switched on) is the only backup.

## Next session (superseded: Phase 1 finished, Phase 2 starts with 21)
Plan agreed with Ratna 2026-09-26: finish Phase 1 fully — **19 aal2-enforcement** (Opus, DONE and committed, see above; brief in `openspec/changes/19-aal2-enforcement/proposal.md`; `daksh-schema` + `daksh-posting`), then **17 cutover**, then **18 self-audit-and-gst** (Sonnet each; 18 starts with the GSTR-1 schema research task) — and only then a guided **Vercel deploy** (Ratna uses the existing hosted Supabase project `daksha-nirmaan`). One session edits the codebase at a time.
At deploy time decide: that project holds the REAL books, so a fake-data demo should go in a second hosted project (Free allows two per org); `demo-data.sql` must never be loaded into the real one. Also needed then: hosted Auth settings (email OTP, signups off, TOTP), the owner account via create-admin, Resend SMTP, Vercel env vars (RUNBOOK section 3 lists the secrets).
Changes 16 and 19 are done and pushed; nothing is unpushed.

## Backup: SWITCHED OFF (Ratna, 2026-10-01)
The nightly Backup workflow no longer runs on a schedule (it failed every day because it was never configured, and Ratna does not want it for now). **Consequence to remember: hosted is on the Supabase Free plan with no point-in-time recovery, so with this off there is NO backup of the books.** Fine while hosted holds no real data (0 posted documents on 2026-10-01); revisit before the family starts entering real invoices. To switch on: uncomment the `schedule` in `.github/workflows/backup.yml`, add the secrets `AGE_PUBLIC_KEY` and `DATABASE_URL` (RUNBOOK 2.1). Also open: 7 Dependabot pull requests (eslint 10, typescript 7, @types/node 26, actions/checkout 7 are major bumps; do not merge blindly). Email sending (Resend SMTP) is deferred until after Phase 2 (Ratna, 2026-10-01).

## Left before go-live
Phase 1 (01–19, 08b) is built, committed and pushed. Remaining: the backup (switched off, see above; revisit before real data), Resend SMTP before the family signs in (after Phase 2), the pre-go-live `/security-review` (after all phases, per Ratna 2026-09-26), owner decision 1 (stock cost hidden from counter, still homeless), and the open owner questions listed per change above.
Full list with owner/skill/spec-section/acceptance per change: `openspec/changes/README.md`.

## Deployed (2026-09-26)
Vercel (Hobby) is linked to the private GitHub repo and deploys every push to `main`; stable address `https://dakshanirmaan.vercel.app` (Deployment Protection on, so only Ratna's Vercel login reaches it). Hosted Auth Site URL and Redirect URL are set to that address. Ratna signed in on it and it works. Commit 6284fc7 (dashboard tiles link to their screens, `loading.tsx` skeleton, dotted GST message keys renamed) is live. Hosted holds the REAL books: never load demo data there.

## Change 21a status (2026-09-29): built, verified, independently reviewed
Purchases list/tiles, bill form, draft edit, posted view, post/cancel, all **owner-only** (actions, proxy, nav, and a page-level `requireOwnerPage()`), plus migration `20261002100000_purchase_supplier_bill_unique.sql` (same supplier bill number cannot be posted twice). Gates: tsc, lint (0 errors), vitest 637, build, pgTAP 27 files / 1840 tests on an empty DB, live browser walks (owner + counter, both themes, 390 px). Opus review (migration/access) and Sonnet review (screens/actions) both APPROVE AFTER FIXES; fixes applied (see `openspec/changes/21-purchases-ui/implementation-notes.md`, which also lists the open items: counter can still write draft purchase rows via REST — fold into 21b's Opus session; counter can see AP on Parties). **21b** (bill-photo attachments + Storage RLS + the RCM freight block + that RLS tightening) is briefed in `openspec/changes/21-purchases-ui/proposal.md`, Opus for the migration. **20 notes** is briefed (`openspec/changes/20-notes/proposal.md`), waits for an Opus session; 27b is still later in the sequence.

## Change 20 status (2026-10-01): database half done, reviewed three times, pushed; screens still to build
Migration `20261003100000_notes.sql` (`post_credit_note`, `post_debit_note`, note support in `cancel_document`, owner-only note drafts, `note_lines_guard` trigger, cumulative tax and rounding on partial returns, GSTR-3B/HSN fixes) + pgTAP `00028` (341 tests). Built by an Opus subagent; **three independent Opus review rounds**, every finding fixed (cumulative tax/rounding, zero-quantity value clean-up, invoice-snapshotted buyer GSTIN, posted-lines trigger, last-return-always-possible rounding, notes cancel latest-first `later_notes`). Gates: pgTAP 28 files / 2181 tests on an empty DB, tsc, lint 0 errors, vitest 637. Pushed to GitHub and hosted. **Screens built 2026-10-01, independently reviewed (APPROVE AFTER FIXES, fixed), committed locally, not yet pushed; see "Screens" in `openspec/changes/20-notes/implementation-notes.md`).** Original brief for them (Sonnet session: credit-note button on the invoice view, `sales/credit-notes/new`, debit-note button on the bill view, `notes.ts` actions, i18n en+te) — everything the UI needs (function names, error codes, draft columns, messages) is in `openspec/changes/20-notes/implementation-notes.md`. **Owner decisions (Ratna 2026-09-29), revisit later:** a return larger than the unpaid part of a part-paid invoice is refused; value-only debit notes post to Discount Received; a full return after a rate-difference note is refused. Later list (in the notes): 40P01 deadlock message, GST Section 34(2) time limit, credit notes without GST, rate-difference-then-return crediting, invoice-lines guard trigger.

## Change 21b + 27b status (2026-10-01): built, Opus-reviewed (fixes applied), committed locally, NOT pushed
Migration `20261004100000_purchase_attachments_and_address_guard.sql` (not on hosted yet: **needs OK to `supabase db push`**; first real upload on hosted must be checked, see notes "Hosted"): purchase drafts owner-only in RLS, `attachments` table + private bucket `docs` (5 MB, jpeg/png/pdf) + owner-only Storage policies, photos of a posted/cancelled bill cannot be removed, `expense_vouchers_bill_link_guard` (freight link owner-only, bill must be posted), `party_addresses_guard` now also on INSERT (counter staff: same-state delivery sites only, 27b). App: bill photo on draft form and posted view (phone camera / photo / PDF, shrunk on the phone, signed one-minute open link, magic-byte check on the server), RCM freight card on the posted view, invoice-form place-of-supply preview now uses the same rule as the server. Gates: pgTAP 30 files / 2289 tests, vitest 722, tsc/lint/build clean, attack harness (see notes), live browser walk 17/17. Notes: `openspec/changes/21-purchases-ui/implementation-notes.md` (21b sections, review), `openspec/changes/27b-address-state-owner-only/implementation-notes.md`. **Owner question (default = accept):** a counter user can still create a NEW party registered in another state (its sales are then IGST); existing customers cannot be steered. Later: freight voucher has no cancel button; Telugu pass in a browser; sweep for orphan files.

## Then Phase 2
20 notes · 21 purchases-ui · 22 bank-recon (high priority: HDFC, mostly UPI/bank) · **23 cash-deposit** (added 2026-09-26: no entry exists for depositing cash into the bank) · 24 quotes-rebates-interest · 25 exports-portability. Suggested order: 21, 23, 22, 20, then 24, 25.

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
- **pgTAP needs an empty local database.** Loading `supabase/demo/demo-data.sql` makes 13 of 25 test files fail (invoice numbers, counts). Order: `supabase db reset` → `supabase test db` → then `create-admin` and the demo load. Clean baseline 2026-09-26: 25 files, 1779 tests pass.

## Ideas (Ratna, not scheduled)
- **Admin delete for unused items (2026-09-26):** now change 26, brief in `openspec/changes/26-delete-unused-items/proposal.md`; do it after the attack test and review fixes.
- **New-item auto-fill (2026-09-26):** when adding an item, fill HSN, GST %, base/second unit and reorder level from the category (and default the sale rate from the last sale of that item), so the owner types less. Small UI change in the item modal (`src/components/items/ItemModal.tsx`); presets must stay editable and the CA confirms HSN/GST values.
- Users screen hint says "at least 12 characters" while the message beside it and hosted Auth say 8 — align the copy (`users.passwordHint`).
