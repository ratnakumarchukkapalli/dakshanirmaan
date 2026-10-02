# Daksha Nirmaan — Runbook

For whoever keeps the app running: Ratna, or a family member following the steps. Nothing here needs the code to be understood; where a command is needed it is copy-and-paste. If a step surprises you, stop and ask before changing anything on the hosted database.

> **Repository visibility.** The GitHub repository is **PUBLIC** (checked 2026-10-02) until the owner switches it to Private. Treat everything committed as already copied by strangers (it holds no hosted keys; the secret scan guards that). Switching it is go-live checklist item 1 (section 12); this paragraph and the table row below may only be changed to say "private" after that item is ticked.

**Where things live**
| What | Where |
|---|---|
| The books (database, sign-in) | Supabase project `daksha-nirmaan` (Mumbai, Free plan) |
| The code | GitHub `ratnakumarchukkapalli/dakshanirmaan`: **public today**; must be switched to private by the owner (section 12, item 1) |
| The website | Not deployed yet (Vercel is set up at go-live, change 17) |
| Daily backup | GitHub Actions workflow **Backup** (encrypted file, kept 30 days) |
| The key that opens backups | The family's `age` private key file. **Not in GitHub, not on the server.** |

---

## 1. What CI checks, and how to read a red run

Every push to `main` and every pull request runs **CI** (`.github/workflows/ci.yml`). Three jobs; all must be green before merging. (GitHub only *enforces* "must be green" through branch protection, which a private repository needs a paid plan for, so on the current plan it is a rule we follow, not one GitHub forces: never merge or deploy on red.)

| Step | What it catches | Same thing on a laptop |
|---|---|---|
| Type check | wrong types in the code | `npx tsc --noEmit` |
| Lint | style and common mistakes | `npm run lint` |
| Unit tests | the app's logic | `npm test` |
| Dependency audit | a **high or critical** known vulnerability in a package (moderate ones do not block; Dependabot opens weekly update pull requests) | `npm audit --audit-level=high` |
| Database tests (pgTAP) | the books' rules: balanced entries, no edits to posted entries, period locks, negative stock, who may do what | `supabase test db` |
| Build | the app compiles for production | `npm run build` |
| Secret scan (files and history) | any secret-shaped string (API keys, private keys, tokens) in any file or **any past commit** of the repository, using gitleaks with the rules in `.gitleaks.toml`. A hit fails the run even if the file was deleted later: rotate the secret (section 3) and, if the string is a harmless test value, add a narrow, commented exception to `.gitleaks.toml` | `gitleaks git --config .gitleaks.toml .` and `gitleaks dir --config .gitleaks.toml .` (install gitleaks first) |
| Bundle secret scan | the secret key, the invoice-link secret, or any `service_role` token, a database URL with a password, a private key (PEM) or the family's `AGE-SECRET-KEY-1…` inside what the browser downloads (`.next/static` and `public/`); any `NEXT_PUBLIC_` variable other than the Supabase URL and publishable key | `npm run check:bundle` (after a build) |
| HTTP smoke | the running app: security headers and a fresh nonce on the sign-in page, signed-out visitors sent to `/login`, report downloads refused without a session, manifest and service worker served, **Supabase sign-up closed** | `npm run smoke` (app running) |
| Browser smoke | the sign-in page renders in a real browser with no console error | `npm run smoke:browser` (needs `npm i --no-save playwright`) |

**Reading a red run:** open the failed step and read its last lines. The secret-scan and smoke steps print `LEAK`, `STRAY` or `FAIL` lines that name exactly what is wrong. A `LEAK` line from the bundle scan means a secret reached the browser bundle: treat the secret as exposed and rotate it (section 3) even if the change is reverted. A pgTAP failure names the test.

---

## 2. Backups

**How it works.** Every day at 02:00 India time the **Backup** workflow (`.github/workflows/backup.yml`) runs `scripts/backup/dump.sh`:
1. dumps the data of every table in `public` plus the sign-in accounts (`auth.users`, `auth.identities`) and the owners' authenticator enrolments (`auth.mfa_factors`);
2. checks the dump is readable and lists at least 20 tables of data;
3. writes a `manifest.json` (migration version, row count of every table, total debits and credits);
4. encrypts both into `dn-backup-<date>.tar.age` with the family's **public** key and uploads it as a private workflow artifact kept for 30 days.

Anyone with the private key can read the books, so the private key is never in GitHub. A **manual** run (Run workflow) with a secret missing only prints a warning and stops, so it can be switched on step by step. A **scheduled** run with `DATABASE_URL` or `AGE_PUBLIC_KEY` missing **fails** (red) instead, and so does a dump of a database with no journal entries or (if you set it, 2.1 step 4) a wrong `AGE_PUBLIC_KEY`: a red Backup run means no backup was made that day, fix it the same day. If a posting lands while the dump is being read the script retries (up to 3 times) so the manifest always matches the dump.

The dump prints `circular foreign-key constraints` warnings; they are normal and harmless (the restore loads with checks off and then verifies the books).

*Authenticator enrolments are in the backup.* `auth.mfa_factors` holds the owners' TOTP secrets. They are dumped, but only ever inside the age-encrypted archive (the dump is never stored unencrypted), so whoever can open the books can also read them: that is one more reason the private key stays with the family. A restore brings the owners' authenticator apps back, and the drill reports it (`authenticator enrolments restored`). *If a restore does not include them (an older backup, or the table was not loaded), every owner must set up the authenticator app again **in person**:* an owner who signs in with a password alone can enrol a new authenticator, so the person who restored hands the password over face to face and watches the enrolment, as in go-live item 4. Until then treat that owner account as not secure.

*Known gap:* the bill photos in the private `docs` bucket are **not** in the database dump (the bucket is empty today). Switch the opt-in copy on once photos exist (2.5).

### 2.1 Setting it up (once)
1. **Make the key pair** on a trusted computer (`brew install age` on a Mac, `apt install age` on Linux):
   `age-keygen -o ~/family-age-key.txt`
   **Make it OUTSIDE this repository folder** (your home folder, as above, or a USB stick), never inside it: a `git add -A` in the repo would otherwise commit the key that opens every backup. (`.gitignore` and the secret scan are a safety net, not permission.) It prints `Public key: age1…`. Copy that line.
2. **Store `family-age-key.txt` in at least two safe places** (for example a password manager and a printed copy in the family locker). Without it every backup is unreadable; with it anyone can read them. Never commit it, never email it, never put it in GitHub.
3. In GitHub: repository → **Settings → Secrets and variables → Actions → New repository secret**:
   - `AGE_PUBLIC_KEY` = the `age1…` line.
   - `DATABASE_URL` = the Supabase **session pooler** connection string: Supabase dashboard → project → **Connect** → *Session pooler* → copy the URI (copy the exact host from that screen; the port is `5432` and the user looks like `postgres.dcmgbkugdyxsjvkirmft`) and put the database password in. If the password contains any of `@ / # : ? %` the URL breaks: reset the password to letters and digits only (section 3) instead of fiddling with encoding. Use the pooler, not the direct host: GitHub's machines have no IPv6 and the Free direct host is IPv6-only.
4. *(Recommended, optional.)* Guard against a wrong-but-valid key (a typo that is still a well-formed `age1…` key would encrypt every backup so nobody can open it). Compute the fingerprint of the **correct** public key on your computer:
   `printf '%s' 'age1…paste the public key…' | shasum -a 256` (Mac) or `… | sha256sum` (Linux); take the 64 hex characters.
   Then GitHub → **Settings → Secrets and variables → Actions → Variables** tab (not Secrets) → **New repository variable**: name `EXPECTED_AGE_RECIPIENT_SHA256`, value = those 64 characters. The Backup run then fails before encrypting if `AGE_PUBLIC_KEY` differs. It is a fingerprint of a public key, safe to keep as a variable. Skip it and nothing else changes. **It only catches typos in the secret: the monthly decrypt check (section 5) is what proves a backup opens with the private key.**
   **Before the opening balances are posted (go-live, section 8) the hosted books are empty, and the Backup run refuses an empty-books dump on purpose.** Until then add one more repository variable, `ALLOW_EMPTY_BACKUP` = `1`, so the runs stay green; **delete it as soon as the opening balances are posted**, so an emptied database can never pass as a good backup (the full lifecycle is 2.6).
5. **Actions → Backup → Run workflow.** When it is green, download the artifact from the run page (GitHub gives a **.zip**; unzip it to get the `dn-backup-….tar.age` file) and do the restore drill (2.3) once with it. Also keep a copy of that file somewhere the family owns: GitHub deletes artifacts after 30 days.

### 2.2 Keeping and pruning
GitHub keeps each artifact 30 days and then deletes it. If the copies are also saved elsewhere (section 7), prune that folder with
`node scripts/backup/retention.ts <folder>` (shows what it would delete: the newest backup of each of the last 14 days, 12 weeks and 12 months are kept) and add `--apply` to delete.

### 2.3 Restore drill (do it once now, then every quarter)
"An untested backup is not a backup." This never touches the hosted database: it resets your **local** Supabase, loads the backup into it and checks the books. It **wipes your local database** (fine, it is only test data) and refuses to run against anything that is not plainly this machine.

You need on the computer: Docker running, the `supabase` CLI, the `age` tool, and the PostgreSQL **17** command-line tools (`psql`, `pg_restore`; on a Mac `brew install libpq` then `brew link --force libpq`). Run it from the project folder, but keep the **key file outside the folder** (for example `~/family-age-key.txt`; never copy the key into the repository to run the drill). If the code has moved on since the backup, commit or stash your own work before checking out the older commit.

**Find the right commit.** The backup only loads into a database built from the migrations it was taken with, so check out the commit whose newest migration equals the backup's `migration_version` (not a commit picked by date: the hosted database can be behind `main`):
```
# 1. which migration version is the backup at?
age -d -i ~/family-age-key.txt dn-backup-<date>.tar.age | tar -xO manifest.json | grep migration_version
#    e.g.  "migration_version": "20260920130000"
# 2. the commit that added that migration (run inside the repository):
git log --diff-filter=A --format=%H -1 -- supabase/migrations/<version>_*.sql
# 3. check it out (commit or stash your own work first); afterwards `git checkout main` returns
git checkout <that hash>
ls supabase/migrations | sed 's/_.*//' | sort | tail -1     # must print <version>
```
Then run the drill:
```
supabase start                                   # local stack (Docker running)
AGE_IDENTITY=~/family-age-key.txt \
  scripts/backup/restore-drill.sh dn-backup-<date>.tar.age --yes
```
It passes only when: the backup is for the same migration version as the checkout, every table's row count equals the manifest, the sign-in accounts match, total debits equal total credits, every entry balances, and the totals equal the manifest. It ends with `drill: PASSED`. Anything else is a failed backup: fix the cause the same day and take a new one.
(To rehearse against the local database itself, dump it first: `DATABASE_URL=… AGE_RECIPIENT=age1… scripts/backup/dump.sh backups`. The rehearsal on 2026-09-26 with the demo books passed, and a backup whose manifest was altered failed as it should.)

### 2.4 Restoring for real (the hosted database is lost or wrecked) — developer only
**Do not attempt this alone.** It has not been rehearsed against a hosted project, and a mistake can wipe a database that still has data. Ask Ratna (or whoever built the app) to do it; ask them to make it a script with the drill's safety checks first.

1. Create a new Supabase project (Free, Mumbai). Note its new database URL.
2. From a checkout at the right commit (the one whose newest migration equals the backup's `migration_version`, found with the commands in 2.3): `supabase link --project-ref <new ref>` then `supabase db push` (builds the tables and seed data).
3. Decrypt, empty the seed rows, load the data. This is exactly what `scripts/backup/restore-drill.sh` does against the local database (it uses `supabase db reset` in place of step 2 and never touches a hosted one). Write `NEW_URL` = the **new** project's session-pooler URL; run this only on a database with no data of its own, and keep the key outside the repository:
   ```
   # decrypt and unpack
   age -d -i ~/family-age-key.txt dn-backup-<date>.tar.age | tar -xf - data.dump manifest.json
   # empty the seed rows (all public tables, and the sign-in accounts)
   psql "$NEW_URL" -v ON_ERROR_STOP=1 -c "
     set session_replication_role = replica;
     do \$\$ declare t text; begin
       for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop
         execute 'truncate table ' || t || ' restart identity cascade';
       end loop;
       truncate table auth.identities, auth.users cascade;
     end \$\$;"
   # load the data in one transaction, with triggers off
   { echo "set session_replication_role = replica;"; pg_restore --data-only --no-owner -f - data.dump; } \
     | psql "$NEW_URL" -v ON_ERROR_STOP=1 --single-transaction
   ```
   Then run the drill's checks (the `checks` SQL near the end of `restore-drill.sh`: row counts against `manifest.json`, sign-in accounts, debits = credits, every entry balances, no orphan lines).
   `auth.mfa_factors` is part of the same load, so the owners' authenticator apps work again after it. If the backup you restore predates that table (a manifest without `auth_mfa_factors`), or the load of it was skipped, **each owner must enrol the authenticator again in person** (section 10): hand them a new password face to face and watch the enrolment.
   **This whole hosted path is UNTESTED.** Only the same commands against the local database have been rehearsed. On a hosted project the pooler login may not be allowed to set `session_replication_role` or to truncate `auth.users`; if psql refuses, stop and ask Ratna rather than working around it.
4. Check the manifest numbers the same way the drill does, sign in as an owner, open the trial balance on Reports (or ask Ratna), and only then point the app at the new project (`NEXT_PUBLIC_SUPABASE_URL`, both keys, in the app's environment).
Restoring into a *hosted* project follows the tested local path but has **not been rehearsed** against a hosted target. Do the local drill first; if time allows, rehearse steps 1–4 on a throwaway second project before you ever need it.

### 2.5 Bill photos (opt-in, off by default)
`scripts/backup/storage-copy.sh` copies the private `docs` bucket with the Supabase CLI (`supabase storage ls|cp`) into `dn-storage-<date>.tar.age`, encrypted with the same public key (inside: the `docs/` folder and a `manifest.json` with a sha256 of every file). In the Backup workflow it is a second step, run **only when the repository variable `BACKUP_STORAGE` is `1`** (default off, because there are no photos yet). To switch it on: Variables → `BACKUP_STORAGE` = `1` and `SUPABASE_PROJECT_REF` = the project ref (the letters in the dashboard address); Secrets → `SUPABASE_ACCESS_TOKEN` = a personal access token from Supabase dashboard → Account → Access Tokens (give it a name like "dn-backup"; delete it if the person who made it leaves). Then run the workflow once and open the file: `age -d -i ~/family-age-key.txt dn-storage-<date>.tar.age | tar -t`. An **empty bucket fails the run** unless `ALLOW_EMPTY_BACKUP` is `1` (same rule as the database dump, 2.6). Restoring photos: unpack the archive and upload the files back to the bucket `docs` under the same paths (dashboard → Storage, or `supabase storage cp -r`); the `attachments` rows in the database dump already point at those paths. The photo copy is not part of `restore-drill.sh`; check the manifest's file count against the bucket by eye.

### 2.6 The `ALLOW_EMPTY_BACKUP` switch (a lifecycle, not a setting)
1. **Before go-live** the hosted books and the photo bucket are empty, so the backup *refuses* to keep an empty copy. Set the repository variable `ALLOW_EMPTY_BACKUP` = `1` so the trial runs stay green (step 2.1.4).
2. **The day the opening balances are posted** (section 8) **delete the variable.** From then on an empty or emptied database makes the run red instead of silently producing a "good" empty backup that pushes real ones out.
3. If the bucket copy is on (2.5) and no photo has been uploaded yet, the same variable lets it pass; delete it once, not twice: the books are what matter, so do not leave it set just because the bucket is still empty. Turn `BACKUP_STORAGE` off again instead of keeping `ALLOW_EMPTY_BACKUP` on.
4. Never set it on a scheduled production run "to make it green". A red run is the alarm doing its job.

---

## 3. Keys and secrets: what exists, and how to rotate

| Secret | What it opens | Where it lives | Rotate when |
|---|---|---|---|
| Supabase **secret key** (`SUPABASE_SECRET_KEY`) | server-only admin access to the database | the app's server environment; your `.env.local` | anyone with access leaves, a device holding it is lost, or the secret scan ever prints `LEAK` |
| Supabase **publishable key** | what the browser uses (no power on its own) | shipped to the browser by design | never needed |
| **Invoice-link secret** (`INVOICE_LINK_SECRET`) | signs the 24-hour WhatsApp invoice links. **Rotating it revokes every link already sent**; there is no other way to cancel one link | server environment | leaked, or you want every shared link to stop working |
| **age private key** | opens the backups | the family's safe places only | a holder leaves or a copy is lost |
| Supabase access token (`SUPABASE_ACCESS_TOKEN`, only if the bill-photo copy is on) | lets the Backup workflow read the `docs` bucket through the Supabase CLI | GitHub secret | the person who made it leaves; delete it in Supabase → Account → Access Tokens |
| Database password | direct database access (used by the Backup workflow and `supabase db push`) | GitHub secret `DATABASE_URL`; Supabase dashboard | anyone with it leaves |
| Resend key (optional) | sending email, only if a "forgot password" email is added later | not used now | anyone with it leaves |

**How:**
- *Supabase secret key:* dashboard → **Project Settings → API Keys** → create a new secret key, put it in the app's environment (and `.env.local`), redeploy, then delete the old key.
- *Invoice-link secret:* generate a new one (`openssl rand -base64 48`), replace it in the environment, redeploy. **Every signed link already sent (WhatsApp invoice links, valid up to 24 hours) stops working at once**: that is how a link that went to the wrong person is revoked. Tell the counter to send fresh links. A cancelled invoice's link answers "410 cancelled" by itself, and each address and each invoice is limited to 30 link downloads per 10 minutes (then "429, try later").
- *age key:* make a new pair (2.1), replace `AGE_PUBLIC_KEY`, run **Backup** once. Keep the **old private key** until the old backups have aged out, otherwise they cannot be opened. Note the reverse risk: anyone who kept the old private key can still open every old backup, so if a person with the key leaves, delete the old artifacts too.
- *Database password:* dashboard → **Project Settings → Database → Reset database password**, then update `DATABASE_URL` in GitHub. Do this on a quiet moment: the app's own connection uses keys, but backups and `db push` use this password.
- After **any** staff or device change, rotate everything the person could have seen.

---

## 4. Routine tasks

**Un-pause a Free project.** Supabase Free pauses a project after 7 idle days. Dashboard → the project → **Restore project** (one click, a few minutes). A shop that bills daily will not see this.

**Push database changes to the hosted project.** From a developer machine, after local `supabase test db` passes and the change is reviewed: `supabase db push --dry-run` (read the list), run the **Backup** workflow (or check last night's is green), then `supabase db push`. Before go-live this is done by hand; the spec's approval workflow comes with the go-live work.

**When the CI secret scan or a dependency alert appears.** Secret scan: section 1. Dependabot pull request: read the title, let CI run, merge if green; a *major* version jump needs a person to read the release notes first.

---

## 5. Monthly checklist (10 minutes)
- [ ] The Backup workflow ran every day this month (Actions → Backup). A red run, or a manual run that says "Backup not configured", is not a backup.
- [ ] Downloaded the latest artifact (a .zip: unzip it) and confirmed it decrypts (`age -d -i family-age-key.txt dn-backup-….tar.age | tar -t` lists `data.dump` and `manifest.json`). If the backup run prints `WARNING — the database has no journal entries`, something is badly wrong.
- [ ] Every third month: the full restore drill (2.3) passed.
- [ ] Supabase dashboard → **Reports/Usage**: database size under 400 MB of the 500 MB Free limit; file storage under 80%.
- [ ] From **March**: next financial year's periods exist (the dashboard's attention list warns; Settings → period locks).
- [ ] CI is green on `main`; no open Dependabot pull request older than two weeks.
- [ ] Nobody has left or lost a device without section 3 being done.

---

## 5b. Yearly (after the financial year closes, April)
- [ ] **Download the FY archive ZIP** (Settings → **Export & backup**, pick the year that just ended) and keep it **offline** (a USB stick or disk in the family locker, plus one copy in the family's own cloud storage), not only in GitHub or Supabase. It is the self-contained, app-independent copy of the books (README, Excel, Tally XML, JSON, PDFs, GST JSON, checksum list). GST law needs the books for about **6 years**, so keep every year's ZIP for at least that long.
- [ ] Verify the ZIP opens and `MANIFEST.sha256` matches (the README inside says how).
- [ ] Rehearse the full restore drill (2.3) once on the year-end backup.

---

## 6. Domain (not registered yet)
`dakshanirmaantraders.in` is to be registered with registrar lock, auto-renew and DNSSEC, then pointed at the app host (change 17). Moving it later: lower the DNS TTL a day ahead, change the records at the registrar, wait for the certificate, then set the site URL and redirect list in Supabase **Authentication → URL configuration** to the new address.

---

## 7. Switching on the later pieces (not needed yet)

**Google Drive copy (the copy that survives losing GitHub too).** Needs: a Google account the family controls, a folder ("DN backups"), and a Google *service account* the folder is shared with. When ready: create the service account and share the folder with its email; add its JSON key as the GitHub secret `DRIVE_SERVICE_ACCOUNT_JSON` and the folder id as `DRIVE_FOLDER_ID`; add an upload step to `backup.yml` after "Keep the encrypted file" (a change 16 follow-up; ask for it). Until then the 30-day GitHub artifact is the only off-server copy, which does **not** survive losing the GitHub account, so download a backup to the family's own storage now and then.

**Sentry (error reports).** Needs a free Sentry account and one project; Sentry then shows a *DSN* (a URL that only lets the app send errors, it opens nothing). Set it as `SENTRY_DSN` in the app's environment and ask for the Sentry wiring (server and client, with GSTIN and phone numbers scrubbed). Note `NEXT_PUBLIC_SENTRY_DSN` would fail the secret scan on purpose; the client-side setup has to go through the app's own settings rather than a `NEXT_PUBLIC_` variable, or the scan's allow-list must be changed deliberately.

**Manual approval for database pushes, Vercel preview safety, log alerts.** Part of go-live (change 17); see `openspec/specs/security-deployment/spec.md`.

---

## 8. Go-live day (change 17)

Do these in order. The app's **Settings → Go-live** screen shows the first block as green/amber chips; the rest only you can check.

**Before the opening entry**
- [ ] Hosted Auth (**Authentication → Providers → Email**): email + password sign-in on, sign-ups off, **minimum password length 8**, leaked-password protection on if the plan offers it; **Authentication → Multi-factor: TOTP on**. No SMTP is needed: the app sends no email (Resend is optional, for a later "forgot password" email).
- [ ] The owner account made with `ADMIN_PASSWORD='…8+ characters…' npm run create-admin -- <email> "<name>"` (or leave ADMIN_PASSWORD out and write down the password it prints once); the other owners added under Settings → Users; each owner has set up the authenticator app. At least two owners.
- [ ] Settings → Organisation: legal name, GSTIN, address filled in (they are locked once invoices exist).
- [ ] Real masters in: parties, items (HSN, GST rate, units), godowns. `supabase/demo/demo-data.sql` was **never** loaded into this database.
- [ ] Backup workflow has run once and the restore drill (2.3) passed.

**Opening entry** (Settings → Go-live)
- [ ] Pick the **last day before you start billing in the app** as the opening date.
- [ ] Enter each customer's due and each supplier's due (one figure per party), cash and bank balances, and the stock (by hand or CSV: `item,godown,qty,rate`; names exactly as in the app).
- [ ] Check the totals against Tally / the paper book: owed to us, we owe, cash and bank, stock value. **Opening capital** is the balancing figure.
- [ ] Post. If a figure is wrong, **Cancel the posting** (possible only until the first bill or voucher is posted), correct the draft, post again.
- [ ] Reports → Trial balance balances; Stock report equals the godown count; Ageing shows the dues as "other".

**Day one**
- [ ] The paper invoice book (used if the app is down) is labelled `DNM/26-27/` so its numbers never clash with `DN/`.
- [ ] Sign in from a real phone with email + password; an owner is asked for the authenticator code. Everyone changes their starting password from the avatar menu → **Change password**.
- [ ] Do not post test bills or receipts in the real books (a posted document can only be reversed, never removed); rehearse in a second hosted project.
- [ ] Keep Tally (or the old book) read-only for reference for the first month.

---

## 9. Monthly GST (by the 11th and the 20th)

Reports → **GST returns** (owner only). Pick the month.
- [ ] **Clean warnings.** The GSTR-1 card must show no red warning (missing HSN, unit not in the GST list, an export, no business GSTIN). Fix the item or organisation, then reload.
- [ ] **Books agree.** The "Check against the books" rows under GSTR-3B are zero (a bill cancelled in a later month, or a credit note not yet in the ledger, are the usual reasons for a difference — understand it before filing).
- [ ] **GSTR-1.** Download the JSON, upload it on the portal (Returns → GSTR-1 → Prepare offline → Upload), let the portal validate, enter your turnover figures there (the file carries 0), review, file. The first month: compare the portal's totals with the section table on the screen.
- [ ] **GSTR-3B.** Key the rows from the table (or the Excel) into the form. The screen does not work out the cash payable after using credits.
- [ ] **Lock the month.** Settings → Period locks → Lock, once the return is filed. Unlocking later needs a reason and shows in the Audit trail.
- [ ] From February: Settings → Period locks → **Create** the next financial year.

---

## 10. Passwords

- **A person forgot their password:** Settings → Users → **Reset password** (owner), type a new one (8+ characters), tell them in person; they change it from the menu.
- **An owner forgot theirs (or lost the authenticator):** another owner resets the password. Losing the authenticator app: remove the factor in the Supabase dashboard (Authentication → Users → the person → Factors) so they can enrol again after signing in. Keep at least two owners. **Enrol in person:** until the authenticator is set up, a password alone is enough to enrol one, so hand the password over face to face and stay while they enrol (the same applies after a restore that did not bring `auth.mfa_factors` back, 2.4).
- **A leaver:** Settings → Users → **Disable** (they cannot sign in at once); reset the password too if it was shared.
- The app sends no email, so nothing arrives by mail: passwords and resets are always handed over in person.

---

## 11. First deploy to Vercel (GitHub repo must be private first: section 12, item 1)

The Supabase project `daksha-nirmaan` (ap-south-1) is separate from `expenses-app` (each app has its own project, in the same organisation). The repo must be **private** before real data and keys are anywhere near it (section 12, item 1); the final security pass (2026-10-02) found it public.

1. **Once, in a terminal:** `npx vercel login` (opens the browser). Then in the repo folder: `npx vercel link` → create a new project `daksha-nirmaan` under your personal team (this writes `.vercel/`, which is git-ignored). `vercel.json` already sets the region to Mumbai (`bom1`).
2. **Connect Git:** Vercel dashboard → the project → Settings → Git → connect `ratnakumarchukkapalli/dakshanirmaan` (private repos need the Vercel GitHub app authorised for that repo). Production branch `main`.
3. **Environment variables** (Production only. The Preview environment must **not** hold production secrets: leave it empty, or give it values for a different, throwaway Supabase project, never the real books):
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://dcmgbkugdyxsjvkirmft.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the publishable key (Supabase → Project Settings → API Keys)
   - `SUPABASE_SECRET_KEY` = the secret key (same page). **Server-only; never prefix with NEXT_PUBLIC_.**
   - `INVOICE_LINK_SECRET` = a new value from `openssl rand -base64 48` (changing it later revokes every link already sent, section 3)
   - `APP_ORIGIN` = the deployed address without a trailing slash (first the `https://<project>.vercel.app` one; the family domain later)
   `npx vercel env add NAME production` prompts for each value (paste it; it is not echoed).
4. **Supabase dashboard (hosted):** Authentication → **URL configuration**: Site URL = `APP_ORIGIN`; Providers → Email: sign-ups **off**, minimum password length **8**; Multi-factor: TOTP **on**.
5. **Deploy:** `npx vercel deploy --prod` (or push to `main`). Open the address, then on your own machine create the first owner **against hosted** with the hosted URL and secret key in the environment: `NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… ADMIN_PASSWORD='…' npm run create-admin -- <email> "<name>"`. (Easiest, from the repo folder: `bash scripts/create-admin-hosted.sh <email> "<name>"` — it asks for the hosted secret key (from the dashboard; the CLI only shows it masked) and the password at hidden prompts.) Sign in, set up the authenticator app, add the other owners and the counter user under Settings → Users.
6. **Vercel plan:** Hobby is "non-commercial personal use" and this is a business tool (security-deployment spec, Hosting): decide between Pro (about $20/month) and staying on Hobby knowing the risk of a pause. The app keeps working from the manual invoice book (`DNM/` series) meanwhile.
7. **Never** load `supabase/demo/demo-data.sql` into hosted.

---

## 12. Go-live checklist: what only the owner can do

From the final pre-go-live security pass (`docs/reviews/2026-10-final-security-pass.md`, 2026-10-02). The code fixes are done by the developer; these steps need the owner's accounts. Tick each as it is done, with the date. Do items 1 to 4 and 6 **before** real data goes in.

- [ ] **1. Make the GitHub repository private.** GitHub → the repository → Settings → General → Danger Zone → Change visibility → Private. Treat the history as already copied (it holds no hosted keys). Only after this is ticked may the header of this file say "private".
- [ ] **2. Turn on database SSL enforcement:** `supabase ssl-enforcement update --enable-db-ssl-enforcement --experimental --project-ref dcmgbkugdyxsjvkirmft`.
- [ ] **3. Supabase dashboard settings:** Authentication → Providers → Email: **Secure password change ON**; OTP expiry **600** seconds; Site URL and the redirect allow-list set to the real domain only; Data API → exposed schemas = `public` only; confirm **Phone sign-up is OFF**.
- [ ] **4. Create a SECOND owner and enrol the authenticator in person.** Hand the password over face to face, enrol the authenticator on the spot, keep both factors. Never send a first password by message.
- [ ] **5. Switch the backup on** (details 2.1 and the header of `.github/workflows/backup.yml`): `age-keygen -o ~/family-age-key.txt` (two copies, outside the repository); GitHub secrets `AGE_PUBLIC_KEY` and `DATABASE_URL` (session pooler, ending `?sslmode=require`); variables `EXPECTED_AGE_RECIPIENT_SHA256` and `ALLOW_EMPTY_BACKUP=1`; uncomment the `schedule:` lines in the workflow; run it once; download the file and run `scripts/backup/restore-drill.sh`; **delete `ALLOW_EMPTY_BACKUP` when the opening balances are posted** (2.6). Optional bill-photo copy: 2.5. Every year: the FY archive ZIP (section 5b).
- [ ] **6. Two-factor sign-in on the accounts behind the system:** the Supabase organisation login, GitHub, Vercel and the email account behind them.
- [ ] **7. Vercel:** the Preview environment must not hold production secrets; Git Fork Protection ON; turn Deployment Protection off only at go-live; decide Hobby or Pro (section 11 step 6).
- [ ] **8. Before Resend / any SMTP:** decide about the counter staff mailboxes (give counter accounts addresses the owners control) and make the email templates show a code, not a sign-in link (finding M1).
- [ ] **9. Optional hardening:** Turnstile captcha on sign-in; 12-character minimum password for owners.
- [ ] **10. Owner decisions recorded** (the developer logs them in the change notes): counter staff may post cash deposits (finding C1; the bank reconciliation is what reveals a pocketed amount, so import the statement monthly); the counter can still derive bank/cash/profit/stock-cost data through the API (findings K1-K4): still accepted?
- [ ] **11. After items 1 to 5:** sign in as each owner on a real phone, run the monthly checklist (section 5) once, then the go-live day steps (section 8).
