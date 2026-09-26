# Phase 1 independent review — 06, 07, 08b, 13, 16, 19 (2026-09-26)

Reviewers: Opus (19, 08b, 06), Sonnet (13, 07, 16), each with a blank context, skill `daksh-review` plus
the skills and single spec section named per change. The coordinator (this session) checked every
high finding against the code. Nothing was fixed; no file under `src/`, `supabase/migrations/` or
`supabase/tests/` was edited by this review.

**Baseline caveat.** The reviewed tree is committed HEAD (`8a19a7f`). While the review ran, another
session started change 27 (attack-test fixes): uncommitted edits to `src/app/actions/sales.ts`,
`InvoiceForm.tsx`, messages, `docs/STATUS.md`, `db-architecture/spec.md`, and a new migration
`20261001100000_attack_test_fixes.sql`, and it reset/reloaded the local database. None of that was
reviewed here, and spec line numbers below may have shifted. My own pgTAP baseline (empty DB after
`supabase db reset`, before that session's work): **25 files, 1779 tests, PASS.** I did not re-run
pgTAP afterwards, to avoid resetting a database another session is using.

## Verdicts

| Change | Verdict | Reason |
|---|---|---|
| 19 aal2-enforcement | **Approve** | Every table, view and callable function turned away an owner below aal2 (live, impersonated sessions). |
| 06 read-views | **Approve** | 23/23 views `security_invoker`; owner-only views empty for `user`; books reconcile on the fixture. |
| 08b password-login | **Approve with fixes** | App-side gates hold; the session time-box and rate limit exist only in the Next app, not at Supabase Auth. |
| 13 parties-stock-staff-ui | **Approve with fixes** | Salary lock holds on every path tried; payroll cash is inferable through the day close (already listed in the spec as accepted); stock cost still readable by the counter. |
| 07 app-shell | **Approve with fixes** | Nonce CSP and headers correct on all app responses; HSTS not set to the spec value. |
| 16 ops | **Approve with fixes** | Backup mechanics and restore work; an unconfigured or emptied backup ends **green**. Must be fixed before go-live. |

## Confirmed findings (critical / high: checked by the coordinator)

No critical findings. Two highs, both confirmed by reading the code.

### H1 (16) Backup workflow succeeds with no backup when a secret is missing — confirmed
`.github/workflows/backup.yml` step "Is the backup configured?" (lines ~24-35): if `DATABASE_URL` or
`AGE_PUBLIC_KEY` is empty it emits a `::warning::`, sets `ready=false` and every later step is
skipped, so the run is **green**, on scheduled runs too.
Failure: someone rotates or deletes `DATABASE_URL`, or the secrets are never set; every daily run is
green, no artifact exists, and Supabase Free has no point-in-time recovery, so this is the only backup.
Spec: `security-deployment` "Production topology and plans" (backup is the primary copy) and scenario
"backup actually restores". Today the state is known (STATUS "PENDING: nothing is backed up"); the
risk is the silent regression after it is switched on.

### H2 (13) Payroll cash is inferable by a counter through the day close — confirmed, but documented and accepted; needs owner decision
`day_close_preview(p_date)` (`SECURITY DEFINER`, callable by `user`; created in
`20260927110000_reports_p1.sql:23`, role check rewritten to `current_app_role()` by change 19) sums
every cash-account journal line for the date with no payroll filter. `post_day_close` stores the same
figures in `day_closes.cash_out` / `expected`, which a `user` can read.
Failure: an 18,000 cash salary plus a 3,000 rent voucher on one day: the counter's
`day_close_preview(today).cash_out` = 21,000 while `journal_lines` shows only the 3,000 credit, so 18,000
is derived by subtraction. (Not reproduced live: the shared local database was being reset by the
other session at that point; confirmed from the function body, and demo data has payroll cash rows on
2026-09-20 (3,600) and 2026-09-26 (100) that would show it.)
Spec: "employee salary/wages are visible to the owners only" (owner decision 2), versus
`db-architecture/spec.md` "Not closed (a)" (near line 418), which already records this exact residual.
The counter needs the drawer figure, so it cannot be closed in the database; options are owner
sign-off as accepted, or pay payroll from bank rather than the till.

## Confirmed findings (medium / low)

Coordinator-verified where marked (V); otherwise reviewer-reported, not independently re-run.

**08b**
- M1 (V) Session time-box is app-only. `src/lib/auth/session-age.ts` + `src/proxy.ts`;
  `supabase/config.toml:277-281` `[auth.sessions]` is commented out. A stolen counter `sb-*-auth-token`
  cookie contains the refresh token; `POST /auth/v1/token?grant_type=refresh_token` with the public key
  works after 8 h and RPCs succeed, because Postgres never checks `amr`/session age. Owners are safe
  (aal1 = nobody). Spec `security-deployment` line ~10 "Session: 8h idle expiry".
- M2 Rate limit is app-only and in-memory. `src/app/actions/auth.ts:26`, `src/lib/auth/rate-limit.ts:84`:
  a direct `POST /auth/v1/token` (grant_type=password) bypasses per-email limits; only GoTrue's per-IP
  30 / 5 min (`config.toml:206`) applies. The limiter also resets per serverless instance. Spec line ~11.
- L1 (V) Spec not rewritten: `security-deployment/spec.md:7-14` still says "email OTP sign-in", OTP
  rate limits, Supabase default email. Code does password + owner TOTP.

**13**
- M3 Ageing tiles omit non-invoice receivables: `src/app/(app)/parties/[id]/page.tsx` ~88-97 reads
  `v_party_aging` buckets only; `other_ar` (opening-balance AR) is never read (`grep other_ar src` is empty,
  only the view defines it). A customer with a 1,00,000 opening receivable shows the balance pill but
  all ageing tiles 0. (`other_ar` absence in `src/` confirmed by me.)
- M4 Stock cost readable by a `user` through the API (`v_stock_summary.avg_rate/value`,
  `v_stock_ledger.rate/value`, `stock_movements.rate/value`). Owner decision 1; spec line ~418(c) still
  lists it open. STATUS: "still homeless".
- L2 `staff-data.ts:~68` "Paid in {month}" sums gross voucher lines (18,000 shown when 14,500 was paid).
- L3 `parties/page.tsx:~113-125` `Number()` on NUMERIC money for display (hard rule breach, display only).
- L4 `stock-data.ts`: the "Stock value" tile changes with the search filter.
- L5 `parties/page.tsx`: Overdue segment sends every overdue party id in one `.in()` URL; too long at a
  few hundred parties.
- L6 (docs) `db-architecture/spec.md` ~418(c) says aal1 admin sees everything; tested: 0 rows.

**07**
- M5 (V) No `Strict-Transport-Security` in `next.config.ts`, `src/proxy.ts` or `vercel.json`. Spec
  requires `max-age=63072000; includeSubDomains; preload`; only Vercel's default applies.
- L7 Proxy matcher (`src/proxy.ts:34`) excludes `sw.js`, `offline.html`, `icons/`, `_next/static`, so those
  responses carry no CSP (`offline.html` has inline `<style>`). Follows the Next docs; literal-spec gap only.

**16**
- M6 Empty-books dump exits 0 (`dump.sh:82-84`, plain WARNING) and is uploaded; 30-day expiry then
  rotates out every good backup.
- M7 A well-formed but wrong age recipient succeeds silently; detected only by the manual monthly
  decrypt check (RUNBOOK §5).
- M8 No working-tree/history secret scan; `.gitignore` lacks `*.age`, `*.dump`, `*.pem`,
  `family-age-key.txt` (V: absent). RUNBOOK §2.1 says `age-keygen -o family-age-key.txt` without "outside
  the repo", and §2.3 says to run from the project folder, so `git add -A` could commit the key that opens
  every backup. Bundle scan reads only `.next/static` and misses DB URLs, PEM keys and `AGE-SECRET-KEY`.
- L8 RUNBOOK §2.3 `git log -1 --before=<backup date>` is wrong when hosted lags HEAD: the right commit is
  the one whose newest migration equals the manifest's `migration_version`.
- L9 RUNBOOK §2.4 step 3 refers to numbered "steps 1-2" of `restore-drill.sh` (none exist) and gives no
  `age -d` / `tar` commands; hosted restore unrehearsed.

## Discarded findings
None. Both highs were confirmed. Medium/low items above were not all independently re-run (marked V where
they were). Reviewer observations that could not be shown as a failure are listed below, not ranked.

## What held (evidence for the acceptance scenarios)
- **19:** 59 tables/views x 8 session shapes (admin aal2/aal1/no claim/null/aal in metadata, user aal1/aal2,
  anon): admin below aal2 gets 0 rows everywhere except its own `app_users` row; `user` identical at both
  levels; anon refused. 37 authenticated-executable functions: 15 raise `DN_FORBIDDEN` at aal1, 22 are
  invoker-rights/harmless/empty. Claim spoofing (`AAL2`, array, metadata) gives NULL role. Deactivated users
  get NULL. No function body still reads `app_users.role` directly; every policy uses the two helpers.
  *Not done:* the 15 rewritten function bodies were not diffed line by line against their earlier
  definitions.
- **06:** `reloptions` `security_invoker=true` on 23/23 views; `authenticated` SELECT only, none for anon.
  `v_trial_balance`, `v_pnl`, `v_balance_sheet`, `v_money_balances`, `v_money_ledger`, `v_bank_recon`,
  `v_employee_ledger`, `v_employees` return 0 rows to `user`. Trial balance Dr = Cr, balance sheet
  balances, party ledger = AR control, ageing reconciles, stock views match `stock_on_hand()`.
- **08b (read, not live):** every route behind the proxy; every server action and all six route handlers
  gated; no open redirect; service key only via `server-only`; wrong password, unknown email, banned and
  inactive all return the same `sign_in_failed` shape.
- **13 (run):** counter cannot read `monthly_salary`/`daily_wage`, `v_employees`, pay-rate RPC, payroll
  vouchers, or payroll journal lines (also absent from `v_day_book`, `v_document_refs`, `audit_log`);
  aal1 admin sees 0; /staff blocked in nav, proxy, page and every action; party ledgers = `v_party_balances`
  = control accounts, stock ledger = `v_stock_summary`, 0 mismatches.
- **07 (run, built copy):** per-request nonce on 13/13 scripts, no `unsafe-eval`, other headers match spec
  on pages, redirects, API routes, manifest and 404; path-traversal bypasses of the proxy all 307 to /login;
  nav vs page gates agree for both roles.
- **16 (run):** bundle scan catches a `service_role` JWT, `sb_secret_...` and the exact secret in
  `.js/.json/.map/.txt`, ignores the anon JWT. `dump.sh` fails cleanly (no partial file, no password echo)
  on unreachable DB, failing `pg_dump`, unset secrets, malformed recipient. Encrypt/decrypt/restore
  mechanics reproduce a database with counts equal to the manifest and debits = credits. Workflows: no
  `pull_request_target`, no `continue-on-error`, `contents: read`, secrets scoped to two steps.
  *Not run:* `restore-drill.sh` itself (it resets the database), anything against hosted, the real Backup
  workflow.

## Observations (no concrete failure shown)
- 08b: password minimum is 8 (`schemas/auth.ts:20`, `config.toml:181`) while the 08b proposal/notes say 12
  (lowered on purpose in `f0c09bf`; users screen hint still says 12). Password reset relies on GoTrue
  revoking refresh tokens; no explicit global sign-out (spec: "sign-out everywhere on role/password change"),
  check live. GoTrue is faster for unknown/banned emails on the direct path (timing). `pickClientIp` trusts
  `x-real-ip` (safe on Vercel only). An owner invited before enrolling TOTP can be taken over by whoever
  uses the starting password first.
- 19: eight post functions lock the row before the role check, so an aal1 owner can learn a document UUID
  exists (`DN_NOT_DRAFT`) and briefly holds a `FOR UPDATE` lock. If TOTP failed on hosted Free every owner
  would be locked out (proven working 2026-09-26).
- 06: a `user` can read `journal_lines` + `accounts` and rebuild P&L/balance sheet (view gate only; accepted
  Phase 1, spec 131 vs 134). `v_stock_summary` excludes in-transit stock by design.
- 13: advance vouchers remain visible to a counter (owner question); a counter can rename an employee;
  `entry_no` gaps reveal hidden entries; "Purchases" nav link shown to `user` opens a placeholder.
- 07: proxy decides on the raw pathname, so `/%73taff` skips `isStaffPath` (page/layout gates still catch
  it; `/settings/*` sub-pages rely on the layout and RLS); prefetches hit `getUser` + `app_users` each;
  `connect-src` adds a `wss:` origin the spec does not list; 500/error-page CSP and the service worker in a
  real browser were not exercised.
- 16: actions pinned to tags not SHAs (accepted); hosted `postgres` role may not allow
  `session_replication_role` / `TRUNCATE auth.users` in the drill (unverified); scheduled workflows are
  auto-disabled after 60 days of inactivity on public repos; artifacts are downloadable by any GitHub user
  once public (encrypted); unpinned PGDG apt script.

## Ordered fix list (for a separate fix session)
1. **Backup fails loudly (H1, M6, M7).** In `backup.yml`, on `schedule` with a missing secret: fail the job
   (skip only on `workflow_dispatch`); make an empty-books dump exit non-zero with an `::error::`; verify the
   recipient (e.g. store the expected `age1...` public key fingerprint in the repo or do a trial decrypt with
   a check value). Before go-live.
2. **Secret hygiene (M8).** Add `*.age`, `*.dump`, `*.pem`, `family-age-key.txt`, `backups/` variants to
   `.gitignore`; RUNBOOK §2.1: "generate the key outside the repo"; add a gitleaks (or equivalent) step to CI
   over the tree and history; widen the bundle check (DB URLs, PEM, `AGE-SECRET-KEY`, scan `public/`).
3. **Owner decisions before more code (H2, M4).** (a) payroll cash in day close: accept and record, or pay
   payroll from bank; (b) stock cost hidden from the counter (decision 1): pick the change that builds it
   (column-level revoke + owner-only cost view), then update spec 418(c).
4. **Auth-layer session limit and rate limit (M1, M2).** Either enforce in the database (`current_app_role()`
   refuses a `user` whose token `amr` sign-in is older than 8 h) or enable Supabase `[auth.sessions]`
   timebox/inactivity when the plan allows; add a per-email/IP limit that does not depend on the Next
   process, or record the direct-endpoint bypass as accepted (owners unaffected: aal1 = nobody). Check
   password reset revokes other sessions.
5. **Spec rewrites (L1, L6).** `security-deployment` "Accounts & authentication", the OTP rate-limit
   clarification and Environments lines: password login, real limits, min password (8 vs 12), owner-only TOTP;
   `db-architecture` ~418(c): aal1 admin sees nothing. Fix `users.passwordHint` copy.
6. **HSTS (M5).** Add `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` in
   `next.config.ts` `headers()`. Optionally serve `offline.html` with a CSP (L7).
7. **Ageing tiles (M3).** Show `other_ar` as an "Opening / other" tile so tiles sum to the balance pill.
8. **RUNBOOK corrections (L8, L9).** Restore commit = the one whose newest migration equals the manifest's
   `migration_version`; write out `age -d` + `tar` commands in §2.4 and remove the reference to numbered steps.
9. **Lows (L2-L5).** "Paid in {month}" should be net of recovered advances (or relabel gross); stock value
   tile independent of search; replace `Number()` with the decimal helpers; overdue segment via a view or
   RPC instead of a long `.in()`.

## Fix status (2026-09-26, same day; uncommitted)
Fixed by two Sonnet agents, checked by the coordinator (tsc clean, vitest 585/585, gitleaks checksum matches the
published release, workflow YAML parses):
- **H1, M6, M7** backup: scheduled run with a missing secret now fails; empty-books dump fails unless
  `ALLOW_EMPTY_BACKUP=1` (wired to an Actions *variable*: set it only until the opening balances are posted,
  RUNBOOK 2.1); optional `EXPECTED_AGE_RECIPIENT_SHA256` variable guards a wrong recipient; upload only after a
  fully successful dump. Verified by running `dump.sh` against local Postgres (round trip, empty-books refusal,
  fingerprint match/mismatch); the workflow itself was **not** run on GitHub.
- **M8** `.gitignore` patterns; RUNBOOK key-outside-repo; new CI job `secrets` (gitleaks 8.30.0, pinned + sha256,
  history and tree, `.gitleaks.toml` with two narrow allowlists); bundle check widened (DB URLs with password,
  PEM, `AGE-SECRET-KEY-1`, also scans `public/`). Gitleaks does not flag an `AGE-SECRET-KEY`; that case rests on
  `.gitignore` and the bundle check.
- **L8, L9** RUNBOOK 2.3/2.4 corrected (hosted restore still marked UNTESTED).
- **M5** HSTS header added + test. **M3** "Opening / other" ageing tile. **L2** "Paid in month" is net of
  recovered advances (unit-tested). **L3** decimal helpers on the parties pages. **L4** stock tiles independent
  of search. **L5** overdue segment no longer builds a long `.in()` URL. `users.passwordHint` copy says 8.
  M3/L2/L4/L5 are covered by unit tests or read only; not walked in a browser or against a live database.
- **L1, L6** spec rewrites: `security-deployment` (password login, real limits, 8-h time-box by the app, SMTP
  deferred, replacement scenario) and `db-architecture` 418(c).

**Owner decisions (Ratna, 2026-09-26):** H2 payroll cash in the day close: accepted, recorded in the spec.
M1/M2 session time-box and rate limit only in the app: accepted, documented in the spec, revisit at the security
review. M4 stock cost hidden from the counter: to be built as change 28
(`openspec/changes/28-stock-cost-owner-only/proposal.md`), not built yet. **Skipped:** L7 (CSP on `offline.html`/`sw.js`, follows Next docs); the parties-list ageing chip
for opening-balance-only customers. Also to do by hand: switch on the backup (STATUS PENDING) and set the
`ALLOW_EMPTY_BACKUP` variable until go-live.
