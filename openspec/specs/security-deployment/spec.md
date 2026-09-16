# Security & Deployment Specification

## Purpose

Security posture and deployment topology for dakshanirmaantraders.in. This is real money and the family's books — the standard is: a leaked browser bundle, a stolen phone, or a compromised staff account must not be able to read or rewrite the ledger beyond that account's role.

## Requirement: Accounts & authentication

- Exactly two provisioned accounts at launch: **admin** (owners) and **user** (counter/general). Supabase **public signup disabled**; no OAuth; email OTP sign-in.
- **TOTP MFA enforced for admin** (Supabase Auth MFA). Session: 8h idle expiry, refresh rotation on; sign-out everywhere on role/password change.
- OTP brute force: Supabase built-in rate limits ON plus middleware rate limiting on `/login` (IP + email keyed).
- Email delivery: **Supabase default email service for now** (decision 2026-07-04 — two users, low OTP volume). Custom SMTP only if delivery proves unreliable.
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

## Requirement: Production topology and plans (decided 2026-09-16)

Ten users at most, one business, real books. Paid tiers are chosen for backups, custom domain rights, and support — not for capacity.

| Layer | Choice | Why |
|---|---|---|
| App hosting | **Vercel Pro** (1 seat) | Hobby forbids commercial use; Pro gives the custom domain on a commercial project, 1 TB bandwidth, password-protected previews, team-less single seat is enough. Region `bom1`. |
| Database/Auth/Storage | **Supabase Pro** (≈ $25/mo incl. $10 compute credit) — project `daksha-prod`, region **ap-south-1 (Mumbai)**; compute **Micro** (1 GB RAM) is ample for ≤ 10 users | Pro = daily backups (7-day retention), 8 GB DB, 100 GB storage, no project pausing, email support. **PITR add-on is not enabled at launch** (it is a per-project add-on billed extra); the weekly logical dump to family storage plus daily backups is the recovery story. Revisit PITR after the first FY close. |
| Staging | second Supabase project `daksha-staging` on the **Free** tier (pauses after inactivity — acceptable for staging) | Migrations rehearse here; Vercel preview deployments bind here only. |
| Domain | `dakshanirmaantraders.in` (registrar of choice; `.in` via a registrar such as GoDaddy/Hostinger/BigRock) — apex + `www` → Vercel; registrar lock + auto-renew + DNSSEC | Vercel DNS for the app; keep email DNS (SPF `-all`, DMARC `p=reject`) even before sending mail. |
| Email/OTP | Supabase built-in (decision 2026-07-04) | ≤ 10 users; revisit if OTP delivery flakes (then Resend with DKIM on the domain). |
| Errors/monitoring | Sentry free tier (Next.js SDK); Vercel built-in analytics; Supabase log drain off (dashboard logs suffice) | |
| Backups off-platform | GitHub Actions weekly cron: `pg_dump --no-owner` → `age`-encrypted → upload to a family-owned Google Drive folder via service account; retention 12 weekly + 12 monthly | Survives losing the Supabase account. |

**Estimated run cost:** Vercel Pro $20 + Supabase Pro $25 + domain ≈ ₹800/yr + Sentry $0 ≈ **$45–50/month** (verify current prices at purchase; both vendors reprice). No per-user fees — the reason the app exists.

### Environments and promotion
- `local` (supabase CLI, docker) → `staging` (Supabase Free, Vercel preview) → `production` (Supabase Pro, Vercel Production on the domain).
- Migrations: `supabase db push` to staging from CI on merge to `main`; production push is a manual, approved GitHub Actions job that first takes an on-demand backup.
- Vercel env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (per environment), `SUPABASE_SERVICE_ROLE_KEY` (server-only, production + preview separately), `SENTRY_DSN`. CI greps the `.next` output for the service key on every build.

### Supabase project settings checklist (production)
- Auth: email provider on, **signup disabled**, OTP length 6, OTP expiry 10 min, rate limits default, MFA (TOTP) enabled, session idle timeout 8 h, refresh-token rotation on, site URL = `https://dakshanirmaantraders.in`, redirect allowlist = that origin only.
- Database: SSL enforced; network restrictions to Vercel egress not possible (dynamic IPs) → rely on RLS + strong password + no exposed direct connection string in the app (use the pooler URL only in CI).
- Storage: bucket `docs` private; policies via `app_users` membership; file size limit 5 MB; MIME allowlist.
- API: PostgREST `db-schema = public` only; `max_rows = 1000`; the ledger tables have no grants to `anon`/`authenticated` beyond SELECT via policies.

### Rollout steps (first deploy)
1. Register domain; set registrar lock, auto-renew, DNSSEC. 2. Create `daksha-staging` (Free) and `daksha-prod` (Pro, Mumbai). 3. Apply migrations + seed CoA to staging; run pgTAP. 4. Connect GitHub repo to Vercel; set env vars per environment; add domain; enable HSTS preload after first successful TLS. 5. Promote migrations to prod; provision the admin accounts (dad, babai, Ratna) and the counter user; enforce TOTP. 6. Import opening balances and opening stock (see `openspec/changes/` cutover plan). 7. First weekly dump runs; do a restore drill into staging before go-live.

#### Scenario: preview never touches production data
- WHEN a pull request deploys a Vercel preview
- THEN its env binds to `daksha-staging` only; a preview build that references the production URL fails CI
