# Final security pass before go-live (2026-10-02)

Method: the repeatable attack test (`scripts/attack-test/run-all.sh`, local stack, ~2,500 requests) plus three independent Opus reviews (database layer, application layer, sign-in / deployment / operations). Hosted project checked read-only (catalog, counts, config diff). Previous reports: `2026-09-attack-test.md`, `2026-09-phase1-review.md`.

## Result in one paragraph
No critical finding. The ledger, posted amounts, owner-only secrecy (bank, payroll, cost), MFA gating, signed links, exports, bank reconciliation, quotations, notes and attachments all held. Three things must be fixed before real data goes in: (1) a race that lets a counter user change the lines of an invoice at the moment it posts, (2) a stolen owner session never expires at the database, (3) the repository is public although the plan says private. Plus a short list of process steps that only the owner can do (backup, second owner, SSL, account 2FA).

## Attack test
- Matrix 1,648 requests: 1,647 as expected. The 9 "fails" are stale expectations of the harness, not holes (owner may now delete an unused item (26); bank tables are function-only (22); counter can no longer `select *` on stock movements (28); no one can add accounts/warehouses through the API, the app has no such feature). Funcs 234/234. Tamper/extras: all PASS or KNOWN (K1-K4 accepted limits). Next.js layer: the 3 "fails" are new owner-only actions the harness did not know (refused for the counter = correct). Service-key actions: all refused for the counter.
- TODO (harness upkeep): update expectations for the above; add a two-session race row for finding D1.

## Findings and disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| D1 | HIGH | Child line tables (sales/challan/expense-voucher/adjustment/transfer lines, payment allocations) only have RLS "header is draft"; a counter can insert/update a line in the instant an invoice posts, so a posted invoice shows a line that is in no journal entry (GSTR-1/PDF diverge) | FIX (migration, header-lock trigger like `note_lines_guard`) |
| T1 | HIGH/MED | `current_app_role()` checks aal2 but never session age: a copied owner cookie can be refreshed forever and keeps aal2 | FIX (8 h from `amr` timestamps in the function) + secure/8 h cookie options |
| R1 | HIGH | GitHub repo is PUBLIC (plan said private until this review) | OWNER ACTION: make private |
| B1 | HIGH (ops) | Backups are OFF and Free plan has no PITR | OWNER ACTION: switch on (steps below); fix dump gaps (MFA factors, storage) |
| S1 | MED | `service_role` can rewrite posted documents without audit; headers have no immutability trigger | FIX: revoke writes on business tables, add posted-header guard |
| P1 | MED | Changing own password needs no current password; other sessions stay open | FIX (current password + sign out others) + dashboard "Secure password change" |
| E1 | MED | Hosted DB SSL enforcement OFF | OWNER ACTION (one command) |
| A1 | MED | New owner account can be taken over until TOTP enrolled; go-live does not check owners have TOTP | FIX: `owners_have_totp` go-live check + Users screen status; process: enrol in person |
| C1 | MED | Counter staff can post cash deposits (spec-intended) which can hide a pocketed amount; only bank reconciliation reveals it | OWNER DECISION |
| M1 | MED | Once SMTP is on, magic-link/recover emails allow sign-in for anyone controlling a counter person's mailbox | OWNER DECISION before Resend |
| B2 | MED | Backup credential is the `postgres` password | FIX later (`backup_reader` login) / SHA-pin actions now |
| A2 | LOW | Audit log shows counters bank import/match rows, note stock-cost keys, bank narration on vouchers | FIX |
| A3 | LOW | Settings sub-pages gated only by layout + proxy; encoded-path bypass | FIX (page gates, decode path, escape matcher dots) |
| A4 | LOW | Sign-in limiter counts all attempts: anyone can lock the owner out of the app | FIX (count failures; pair budget) |
| A5 | LOW | Signed invoice links: no rate limit on valid links, no revocation | FIX (rate limit; document secret rotation) |
| A6 | LOW | Export GET routes can be triggered cross-site (audit spam, CPU) | FIX (`Sec-Fetch-Site`) |
| A7 | LOW | Control characters in party names break owner Excel reports; names not sanitised in two xlsx builders | FIX |
| A8 | LOW | `inviteUser` reuses an orphan sign-in without setting the new password / lifting ban / clearing factors | FIX |
| D2 | LOW | Cash deposit vs day close can race | FIX (advisory lock) |
| D3 | LOW | Hosted-only `rls_auto_enable()` executable by anon (harmless) ; default privileges / MAINTAIN grants wider than needed | FIX (revoke) |
| H1 | LOW | Hosted dashboard-only settings: min password 8, no captcha, exposed schemas, otp_expiry 3600 | OWNER ACTIONS (list below) |
| K1-K4 | accepted | Counter can derive bank/cash/profit/stock-cost/supplier-price data via API | OWNER DECISION before go-live: still accepted? |

## Owner actions (cannot be done by code)
1. GitHub -> repo -> Settings -> General -> Danger Zone -> Change visibility -> Private. (Treat history as already copied; it contains no hosted keys.)
2. `supabase ssl-enforcement update --enable-db-ssl-enforcement --experimental --project-ref dcmgbkugdyxsjvkirmft`.
3. Dashboard -> Authentication -> Providers -> Email -> Secure password change ON; OTP expiry 600; Site URL + redirect allow-list set to the real domain; Data API exposed schemas = `public` only; confirm Phone sign-up OFF.
4. Create a SECOND owner and enrol TOTP in person (hand over password face to face, enrol on the spot). Keep both factors.
5. Switch backup on: `age-keygen -o ~/family-age-key.txt` (two copies, outside the repo); GitHub secrets `AGE_PUBLIC_KEY`, `DATABASE_URL` (session pooler, `?sslmode=require`); variables `EXPECTED_AGE_RECIPIENT_SHA256`, `ALLOW_EMPTY_BACKUP=1`; uncomment the schedule in `.github/workflows/backup.yml`; run it once; download and run `scripts/backup/restore-drill.sh`; delete `ALLOW_EMPTY_BACKUP` when opening balances are posted. Year-end: download the FY archive ZIP (change 25) and keep it offline (GST needs ~6 years).
6. 2FA on the Supabase organisation login, GitHub, Vercel and the email account behind them.
7. Vercel: Preview environment must not hold production secrets; Git Fork Protection ON; turn Deployment Protection off only at go-live; decide Hobby vs Pro.
8. Before Resend SMTP: decide about counter mailboxes (give counter accounts addresses the owner controls) and make email templates show a code.
9. Optional hardening: Turnstile captcha on sign-in; 12-character minimum for owners.
