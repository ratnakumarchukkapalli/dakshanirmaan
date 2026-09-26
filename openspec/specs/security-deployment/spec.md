# Security & Deployment Specification

## Purpose

Security posture and deployment topology for dakshanirmaantraders.in. This is real money and the family's books — the standard is: a leaked browser bundle, a stolen phone, or a compromised staff account must not be able to read or rewrite the ledger beyond that account's role.

## Requirement: Accounts & authentication

- Exactly two provisioned accounts at launch: **admin** (owners) and **user** (counter/general). Supabase **public signup disabled**; no OAuth; **email + password sign-in for everyone** (change 08b, 2026-09-26, replacing email OTP so no SMTP is needed to sign in). Passwords: minimum 8 characters (Supabase Auth `minimum_password_length`, also checked by the app), set by an owner when a person is added and reset by an owner; a person changes their own from the account menu. No self-service "forgot password" (an owner resets it).
- **TOTP MFA enforced for admin** (Supabase Auth MFA) after the password step. Session: 8 h time-box from sign-in, refresh rotation on. The time-box is enforced **by the app** (`src/proxy.ts` reads the token's `amr` sign-in time), not by Supabase Auth (its session-limit setting is a paid feature). Known limit: a stolen refresh token used directly against Supabase Auth is not cut off by the app; an owner is unaffected (below `aal2` the database treats an admin as no-one), a counter user is exposed. Resetting a password does not end the person's other open sessions (up to 8 h).
- Sign-in brute force: Supabase built-in rate limits ON (`sign_in_sign_ups` 30 per 5 min per IP) plus an app limiter on the sign-in action (10 attempts per 15 min per email+IP and 40 per email, in memory per function instance) and on the TOTP code check. The app limiter does not cover a caller who talks to Supabase Auth directly; only the built-in per-IP limit applies there.
- Email delivery: sign-in needs no email. Custom SMTP (Resend) is **deferred** (Ratna, 2026-09-26) until a flow that sends email (invite by link, self-service reset) is wanted; until then Supabase's default sender is used only for development.
- An authenticated user without an active `app_users` row is a nobody — RLS checks membership, not merely `auth.uid()`.

## Requirement: Transport, domain, DNS

- `dakshanirmaantraders.in` on Vercel: apex + `www` (301 → apex). TLS via Vercel; **HSTS** `max-age=63072000; includeSubDomains; preload`.
- Registrar: lock enabled, DNSSEC if the registrar supports it, auto-renew on. DNS at the registrar or Vercel DNS.
- Email DNS from day one even before sending mail (blocks spoofed "invoices" from our domain): SPF `-all` baseline, DMARC `p=reject`, DKIM when transactional mail (invoice sharing) is added.

## Requirement: HTTP security headers (Next.js `headers()` config)

`Content-Security-Policy` (default-src 'self'; connect-src 'self' https://<project>.supabase.co; img-src 'self' data:; no unsafe-eval; style-src per Tailwind needs) · `X-Frame-Options: DENY` + `frame-ancestors 'none'` · `X-Content-Type-Options: nosniff` · `Referrer-Policy: strict-origin-when-cross-origin` · `Permissions-Policy` denying camera/mic/geolocation.

## Requirement: Secrets & keys

- Service-role key: **server-only**, never in a `NEXT_PUBLIC_` var, never in client bundles (CI check greps build output). Browser gets only the anon key + RLS.
- Env vars in Vercel encrypted store; `.env*` gitignored (already a global rule). Key rotation on any staff/device change.
- Database access from CI/local only via `supabase` CLI with per-developer credentials — no shared postgres passwords in chat/notes.

## Requirement: Database posture

(Details in `db-architecture`; restated as security invariants.) RLS deny-by-default on every table; ledger tables have **no direct write grants to any role** — writes only through `SECURITY DEFINER` posting functions, each with `SET search_path = public, pg_temp` (search-path hijack guard); all functions parameterized; audit_log is insert-only. P&L/Balance Sheet views admin-only.

## Requirement: Data residency, backups, disaster recovery

- Supabase region **ap-south-1 (Mumbai)**; Vercel function region `bom1` to match. Books stay in India.
- Supabase plan with **PITR** (≥ 7 days). Additionally a **weekly logical dump** (`pg_dump` via scheduled job) to a private encrypted bucket the family controls — the backup must survive losing the Supabase account itself.
- **Restore drill** once per quarter into staging: restore latest dump, run `v_trial_balance`, confirm it balances. An untested backup is not a backup.
- FY close: export full books (journal, ledgers, GST reports) as archives kept offline.

## Requirement: Environments

- **production** and **staging** are separate Supabase projects; Vercel preview deployments bind to staging only. Migrations: staging → verified → production. No experimenting on the real books, ever.
- Seed/demo data lives in staging; production seeds only the CoA/org scaffolding.

## Requirement: Monitoring & response

- Sentry (server + client) for errors; Supabase log drain for auth anomalies + function RAISEs; Vercel alerting on error-rate spikes.
- Admin-visible **audit trail page** (from `audit_log`): who posted/cancelled what, when — the family can self-audit.
- Alert on: repeated `forbidden`/`DN_*` violations (probing), sign-in from new device for admin, period-unlock events.

## Requirement: Business continuity (provider failure ≠ business failure)

The business must be able to bill today and never lose its books, regardless of what happens to Vercel, Supabase, or this codebase.

- **Data is the crown jewel; compute is replaceable.** The schema is vanilla Postgres + plpgsql with zero Supabase-proprietary features in the ledger path, so the weekly `pg_dump` restores onto *any* Postgres (Neon, RDS, self-hosted, a laptop). A tested `RUNBOOK.md` documents the evacuation: restore dump → run migrations → point the app at the new `DATABASE_URL`.
- **Vercel outage/loss**: the app is a stateless Next.js build in a Git repo; redeploy to Netlify/Cloudflare/self-host within hours. We control the domain's DNS — repoint and done. Code lives on GitHub + local clones (two copies minimum).
- **Supabase outage (hours)**: PWA serves cached read-only dashboard/balances. For billing continuity the business keeps a **manual invoice book with its own GST series** (e.g. `DNM/26-27/xx`) — handwritten GST invoices are legal; they're entered into the app when service resumes. The distinct series prevents numbering conflicts.
- **Supabase account loss (worst case)**: weekly dumps live in storage the *family* controls (not the Supabase account), so nothing short of losing both simultaneously loses data — and FY archives exist offline besides.
- **CA-friendly, Tally-independent exports** (this app exists to avoid Tally): every ledger/report exports to Excel; GSTR-1/3B export in portal formats; FY-end archive is self-contained (PDF + Excel + JSON) and readable with no app at all. A **Tally XML voucher export** is the final escape hatch — if the business is ever forced onto Tally (CA insistence, sale of business), the books walk out cleanly.

## Requirement: Dependencies & CI

- Lockfile committed; Dependabot/`npm audit` in CI, high-severity blocks merge. `xlsx` banned (use `exceljs`). CI runs: typecheck, lint, unit tests, **pgTAP suite for posting invariants** (balanced entries, immutability, period locks, negative stock, role gates), and the bundle-grep for the service key.

#### Scenario: signup is a dead end
- WHEN anyone hits the Supabase signup endpoint for our project
- THEN account creation is rejected (provider disabled) and nothing short of the admin provisioning a user grants access

#### Scenario: stolen user-role phone
- WHEN a signed-in `user` session is exfiltrated
- THEN the attacker can at most draft/post sales documents (fully audit-logged); ledger rewrite, cancellations, settings, exports of P&L are all refused by both action gates and DB functions

#### Scenario: backup actually restores
- WHEN the quarterly drill restores the weekly dump into staging
- THEN migrations apply cleanly and `v_trial_balance` balances to zero

## Requirement: Production topology and plans (decided 2026-09-16, revised same day by the owner)

Ten users at most, one business, real books. **Decision (Ratna, as owner): run lean on free tiers; pay only when a free-tier limit actually bites.**

| Layer | Choice | Why / what it costs us |
|---|---|---|
| Database/Auth/Storage | **Supabase Free** — single project **`daksha-prod`** in the existing org next to `expenses-app`, region **ap-south-1 (Mumbai)**; there is no hosted staging | Free = 500 MB DB (the business grows ≈ 50–100 MB/yr), 1 GB storage, 50k MAU, **no vendor backups**, **pauses after 7 idle days**. Backups are ours: **daily** `pg_dump` via GitHub Actions → age-encrypted → family Google Drive (see below). Pausing is not a risk for a shop that bills daily; un-pause is one click. Upgrade to Pro ($25/mo per org, includes one Micro) only if the owner later wants vendor-managed backups or a pause ever hurts. PITR ($100/mo) never. |
| Staging | Local Supabase stack (Docker) for every change; the hosted project receives migrations only after local pgTAP passes | Two free projects per org are allowed; a second hosted project is added only if local rehearsal proves insufficient. |
| App hosting | **Vercel Hobby during the build**; **at go-live either Vercel Pro ($20/mo, 1 seat) or a free host that permits commercial use** — owner decides then | Vercel's fair-use rule: Hobby is "non-commercial personal use only"; commercial = "used for the purpose of financial gain of anyone involved in any part of the production". An internal billing tool for a for-profit shop is a grey area their examples don't cover (no visitor payments, no ads, nobody paid to build it). The risk of staying on Hobby is an unannounced deployment pause, mitigated by the PWA read-only cache and the manual invoice book, but not eliminated. Region `bom1` either way. |
| Domain | `dakshanirmaantraders.in` ≈ ₹800–1,000/yr; registrar lock + auto-renew + DNSSEC | Email DNS (SPF `-all`, DMARC `p=reject`) from day one. |
| Email/OTP | Supabase built-in | Revisit only if delivery flakes. |
| Errors/monitoring | Sentry free tier; Vercel built-in analytics | |
| Backups off-platform | GitHub Actions **daily** cron (free minutes suffice): `pg_dump --no-owner` → `age`-encrypted → family-owned Google Drive via service account; retention 14 daily + 12 weekly + 12 monthly; quarterly restore drill into the local stack | Survives losing the Supabase account. This is the *primary* backup on Free. |

**Run cost:** $0 during the build. At go-live: domain only (≈ ₹80/month amortised) if the app host stays free, or ≈ $20/month (≈ ₹1,700) with Vercel Pro. For comparison Tally Prime Silver is ≈ ₹18,000/yr for a single user with no cloud.

**Personal-data boundary (non-negotiable):** the business never shares a Supabase *project* with `expenses-app` (personal finances). Same org is fine; same database is not.

### Environments and promotion
- `local` (supabase CLI, docker; every change rehearses here with pgTAP) → `production` (`daksha-prod`, Supabase Free, Mumbai). A separate hosted staging project is added only if a real need appears.
- Migrations: `supabase db push` to the hosted project is a manual, approved GitHub Actions job (or `supabase db push` from a developer machine before go-live) that first runs the dump workflow.
- Vercel env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (per environment), `SUPABASE_SERVICE_ROLE_KEY` (server-only, production + preview separately), `SENTRY_DSN`. CI greps the `.next` output for the service key on every build.

### Supabase project settings checklist (production)
- Auth: email provider on, **signup disabled**, OTP length 6, OTP expiry 10 min, rate limits default, MFA (TOTP) enabled, session idle timeout 8 h, refresh-token rotation on, site URL = `https://dakshanirmaantraders.in`, redirect allowlist = that origin only.
- Database: SSL enforced; network restrictions to Vercel egress not possible (dynamic IPs) → rely on RLS + strong password + no exposed direct connection string in the app (use the pooler URL only in CI).
- Storage: bucket `docs` private; policies via `app_users` membership; file size limit 5 MB; MIME allowlist.
- API: PostgREST `db-schema = public` only; `max_rows = 1000`; the ledger tables have no grants to `anon`/`authenticated` beyond SELECT via policies.

### Rollout steps (first deploy)
1. Register domain; set registrar lock, auto-renew, DNSSEC. 2. Create `daksha-prod` (Free, Mumbai). 3. Apply migrations + seed CoA locally; run pgTAP; then push to `daksha-prod`. 4. Connect GitHub repo to Vercel; set env vars per environment; add domain; enable HSTS preload after first successful TLS. 5. Promote migrations to prod; provision the admin accounts (dad, babai, Ratna) and the counter user; enforce TOTP. 6. Import opening balances and opening stock (see `openspec/changes/` cutover plan). 7. First weekly dump runs; do a restore drill into staging before go-live.

#### Scenario: preview never touches production data
- WHEN a pull request deploys a Vercel preview
- THEN it is protected by Vercel Authentication and binds to the same `daksha-prod` project with a **read-only** Postgres role (`preview_reader`) whose env vars are set only on the Preview environment; a preview that carries the service-role key fails CI

## Requirement: Non-functional clarifications (system-design audit, 2026-09-16)

- **Transactional email (superseded by change 08b, 2026-09-26):** sign-in is email + password, so no code emails are sent. Supabase's built-in sender is rate-limited to a few messages per hour and is for development only; configure custom SMTP (Resend free tier, domain with DKIM/SPF/DMARC) **before any flow that emails people** (invite by link, self-service reset) is switched on. Not a go-live blocker while owners create and reset passwords by hand.
- **Sessions:** access token 1 h, refresh rotation on, refresh-token reuse detection on, time-box 8 h from sign-in (enforced by the app, see "Accounts & authentication"). Admin actions that unlock a period, cancel, or change users require `aal2` (TOTP verified in this session). **Enforced by the database as well as the app (change 19):** an admin session below `aal2` is treated by Postgres as no-one — every RLS policy, view and posting function refuses it — so a stolen email inbox (lock 1 only) cannot reach the books through the public REST API.
- **Content-Security-Policy:** nonce-based, generated per request in middleware (Next.js `headers()` cannot vary per request); `script-src 'self' 'nonce-…' 'strict-dynamic'`; no `unsafe-eval`, no `unsafe-inline` for scripts; `style-src 'self' 'unsafe-inline'` is accepted for Tailwind; `connect-src 'self' https://dcmgbkugdyxsjvkirmft.supabase.co wss://dcmgbkugdyxsjvkirmft.supabase.co`.
- **Rate limits:** see "Accounts & authentication" (password sign-in limits; in-memory per function instance is acceptable at this scale; no Redis).
- **Server-action abuse:** every action re-checks the role and the DB re-checks; posting is idempotent; there is no unauthenticated action surface. Route handlers for PDF/Excel require an active member and stream at most one document per request.
- **API keys:** use the project's **publishable** key in the browser and the **secret** key server-only (new Supabase key format); legacy `anon`/`service_role` JWTs are not used. The CI grep covers both names.
- **Client bundle hygiene:** `NEXT_PUBLIC_*` contains only the Supabase URL and publishable key; CI fails if any other `NEXT_PUBLIC_` variable appears.
- **Operational runbook (`RUNBOOK.md`, change 16):** restore from dump; rotate keys (Supabase secret key, Resend key, age key) after any staff or device change; un-pause a Free project; move the domain; monthly checklist (dump verified, storage < 80%, next FY periods exist from March).
- **Observability:** Sentry on server + client with PII scrubbing (no GSTIN/phone in breadcrumbs); Supabase dashboard `pg_stat_statements` reviewed monthly; `v_attention` is the in-app alert channel (no email alerts in v1).
- **Threats explicitly out of scope for v1:** DDoS beyond Vercel's default mitigation, malicious admin (the owners are the admins), physical theft of an unlocked signed-in device with a valid `aal2` session inside its 8-hour window (mitigated by device lock, not by the app).

#### Scenario: a stolen counter session ends after eight hours
- WHEN a counter user's signed-in browser is used more than 8 hours after sign-in
- THEN the app signs it out and asks for the password again (a refresh token replayed directly against Supabase Auth is a known limit, see "Accounts & authentication")
