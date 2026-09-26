# Change 16 — ops

Skill: daksh-api (scripts, CI); no schema change
Spec section: security-deployment "Dependencies & CI", "Data residency, backups, disaster recovery", "Production topology and plans" (backups row), "Non-functional clarifications" (client bundle hygiene, operational runbook), scenario "backup actually restores".
Context: the app is built through change 15 but nothing guards it and nothing backs it up. This change adds the checks that run on every push, a daily encrypted dump, a restore drill that proves the dump comes back with balanced books, and the runbook a family member could follow.
Owner decision (Ratna, 2026-09-26): **Sentry and the Google Drive upload are not required for now.** They are left out and written up in the runbook as later steps; nothing here depends on them.
Do not: put any secret in the repo; add `xlsx`; change app behaviour or the database; start change 17/19; commit or push (Ratna commits).

## Scope
**In**
1. `.github/workflows/ci.yml` — on push and pull request: **static job** (typecheck, lint, vitest, `npm audit --audit-level=high`) and **integration job** (local Supabase stack, `supabase test db` pgTAP, production build, bundle grep, `next start` + HTTP smoke, browser smoke). A red job blocks merge.
2. `scripts/check-bundle.mjs` (+ pure scanner and tests): fails if the client output (`.next/static`) contains a Supabase secret key (`sb_secret_…`, the value of `SUPABASE_SECRET_KEY` or `INVOICE_LINK_SECRET` when set, or a JWT whose role claim is `service_role`), or if any `NEXT_PUBLIC_*` variable other than the Supabase URL and publishable key is set in the build environment or listed in `.env.example`.
3. `scripts/smoke.mjs` — HTTP checks against a running app: `/login` renders with a per-request nonce CSP and the security headers, `/` and `/reports` redirect a signed-out visitor to `/login`, report Excel and invoice PDF routes refuse a signed-out request, the manifest and service worker are served, Supabase signup is a dead end. `scripts/smoke-browser.mjs` — one Chromium visit to `/login` that fails on a console error or page error (Playwright installed in CI only, never a project dependency).
4. Backups (`scripts/backup/`): `dump.sh` (`pg_dump` of the `public` data plus the sign-in accounts, custom format, a manifest with the migration version and row counts, verified with `pg_restore --list`, encrypted with `age` to the family public key), `restore-drill.sh` (decrypt → freshly migrated local stack → restore → check that debits equal credits and the counts match the manifest), `retention.mjs` (pure: 14 daily + 12 weekly + 12 monthly, tested).
5. `.github/workflows/backup.yml` — daily cron + manual run: dumps the hosted database, encrypts, keeps the file as a private workflow artifact for 30 days. **Skips with a clear notice when its two secrets (`DATABASE_URL`, `AGE_PUBLIC_KEY`) are not set**, so it is safe to merge before the owner sets them up.
6. `.github/dependabot.yml` (npm + Actions, weekly). The `exceljs` → `uuid` moderate advisory deferred from change 13: fixed with an `overrides` entry if the export tests still pass, otherwise logged.
7. `RUNBOOK.md`: restore from a dump; the restore drill; rotate keys (Supabase secret key, invoice-link secret, age key, Resend key); un-pause a Free project; push migrations; what CI checks and how to read a red run; monthly checklist; how to switch on the Drive copy and Sentry later.

**Out** (logged in notes and the runbook): Sentry (needs an account and DSN), the Google Drive upload (needs a folder and a service account; artifacts are the interim copy), the manual approval workflow for `supabase db push` (migrations are pushed from a developer machine until go-live, as the spec allows), the read-only `preview_reader` Postgres role (nothing is deployed to Vercel yet), Supabase log drain, Vercel alerting.

## Defaults for owner unknowns (conservative; logged)
1. The interim off-platform copy is a GitHub Actions artifact, encrypted with `age`, kept 30 days (the free artifact maximum is 90). It does not survive losing the GitHub account as well; the Drive copy is what closes that gap.
2. The dump covers the `public` schema data and `auth.users` / `auth.identities` (a restore needs the sign-in accounts for `app_users`); it does not carry passwords or sessions (there are none: sign-in is by emailed code).
3. Retention pruning is a script the runbook describes and tests cover; artifacts expire by themselves, so nothing deletes backups automatically until the Drive copy exists.
4. Node 22 and the pinned Supabase CLI version in CI match the versions used locally.

## Acceptance
- "backup actually restores": dump of a local database with the demo books → encrypted → drill into a freshly migrated stack → trial balance debits = credits and every counted table matches the manifest.
- A build with a planted service key in `.next/static` fails the bundle check; a clean build passes. A stray `NEXT_PUBLIC_` variable fails it.
- The smoke script passes against a production build on the local stack and fails when a header is missing (tested against a stubbed server).
- Every workflow is valid YAML, every command in it was run locally in the same form, and the workflow files reference no secret that is not documented in the runbook.
- No secret, key, or dump is committed; `age` private key handling is described, never generated into the repo.

## Gates
`npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`, `supabase test db` (unchanged 1456), then the drill and the bundle check run for real. The workflows themselves can only be proven by a push to GitHub; that first run is the last check.
