# Change 08 — auth-users: implementation notes

Status: built, all gates green, **not committed, not pushed, not yet independently reviewed** (auth + RLS → Opus fresh-context review recommended before commit). Change 07 is also still uncommitted in the same working tree.

## What exists
- **Migration** `20260920100000_auth_users.sql`: `app_users` + `email`, `locale`, `invited_by`, `invited_at`; guard trigger (≤ 10 active people, ≥ 1 active admin, never deleted); `admin_set_user()` (admin + TOTP-verified session, cannot change yourself, audited); `set_my_locale()`; grants (anon/service_role revoked by name, `authenticated` cannot write `app_users` directly).
- **Auth config** (`supabase/config.toml`): signup off, OTP 10 min, TOTP on, code-only email template (`supabase/templates/magic_link.html`).
- **Sign-in**: `/login` (email → 6-digit code), `/login/mfa` (admin: QR set-up first time, then 6-digit authenticator code), sign-out in the avatar menu.
- **Proxy gate** (`src/proxy.ts`, `src/lib/access.ts`, `src/lib/supabase/proxy.ts`): active member required; admin held on `/login/mfa` until TOTP is done; session older than 8 h ends; `user` role cannot reach `/settings/**`.
- **Users & roles** (`/settings/users`, admin only): list, add, disable, enable. `inviteUser` / `disableUser` / `enableUser` in `src/app/actions/admin.ts`. Disabling also bans the sign-in account.
- **Language** saved on the person row (`setLocale` = `toggleLocale` + `set_my_locale`), applied at sign-in.
- `src/lib/action-result.ts` (envelope + `DN_*` mapper), `src/lib/action-errors.ts`, `src/schemas/{auth,users}.ts`, `scripts/create-admin.mjs` (`npm run create-admin`).
- Removed: `DN_AUTH_GATE`, `isAuthGateOff`, the "Dev session" identity (a test proves the env variable no longer does anything).

## Verified
- `supabase db reset` + `supabase test db`: **705 tests green** (680 existing + 25 new in `00010_auth_users.test.sql`).
- `npm run lint`, `npx tsc --noEmit`, `npm test` (52 tests), `npm run build`: clean.
- Real browser against the production build, local Supabase + local mail catcher, **29 of 29 checks**: anonymous → `/login`; email carries the code and no link; admin held on the authenticator step; QR + typed key shown; wrong app code refused, right one lets in; second sign-in asks for the app code; counter user has no authenticator step, no Settings link, is turned away from `/settings/users`; add / duplicate / bad-email handling; disable makes the next request land on `/login`, disabled person gets the same generic error, re-enable works; language saved on the row and restored on a fresh device; unknown email gets the same "code sent" screen and creates no account; 6th code request in 15 min is rate-limited; no sideways scroll at 390 px.
- Direct Auth API: password signup and OTP-with-create both answer `signup_disabled`; the existing admin's OTP works.
- Secret key: 0 hits in `.next/static`; only `NEXT_PUBLIC_SUPABASE_URL` and `…_PUBLISHABLE_KEY` are read; the secret is imported only by `lib/supabase/admin.ts`, `actions/admin.ts`, and the script.

## KNOWN GAPS — read before go-live
1. **TOTP is not enforced inside the posting functions.** The 18 role checks in changes 03–06 read `app_users` directly and never look at the session's authentication level. Enforced: the proxy (admin cannot reach any page at step 1), every admin server action, and the DB function `admin_set_user`. **Not** enforced: someone who controls an admin's *email inbox* but not their authenticator can obtain a step-1 session and call the database API by hand (the publishable key is public) as if they were an admin — cancel invoices, post as admin, etc. Fix = one small aal-aware role helper used by all 18 places (edits reviewed posting migrations → a dedicated change, Opus). **Owner/architect decision needed: do it before go-live (recommended) or accept.**
2. **Session limit is a fixed 8 h from sign-in, not idle time.** Supabase's own limit is a paid feature. Someone signing in at 9:30 is asked for a new code at 17:30 (owners will feel this in the evening). Constant `SESSION_MAX_HOURS` in `src/lib/auth/session-age.ts`. The clock logic is unit-tested (fails closed); the browser walk-through did not wait 8 h.
3. **A disabled person's browser session resumes if they are re-enabled** (their cookie is still valid; the ban only stops new tokens). Acceptable for an admin who re-enables on purpose; if a disable must also destroy sessions, add "sign out everywhere" (needs the person's token or a SQL delete of `auth.sessions` — not built).
4. **Rate limits are in memory per server instance** (spec-accepted). A cold-started or second instance starts with an empty count.
5. **Supabase MFA on the Free plan is unconfirmed.** The generated `config.toml` comment says "Multi-factor-authentication is available to Supabase Pro plan". It worked locally. **Verify TOTP enrolment on the hosted `daksha-nirmaan` project before relying on it.** If it is Pro-only, the admin second step needs another route (or the plan).

## Deviations / decisions taken (owner may overrule)
1. **"Invite" = create account, no email**, then the person uses the normal code screen (spec said `inviteUserByEmail`; that needs a link-landing page — a second way in).
2. **Rate limits run in the sign-in action**, not the proxy (only the action can see the email).
3. **Uniform replies**: unknown / disabled / wrong / expired all read "That code did not work" (except a real send failure, which says "something went wrong").
4. **Extra actions**: `enableUser` (spec lists only `disableUser`; without it a disabled person could never return and would still count nothing against the 10 cap).
5. **Users can be created as admin or user**; changing an existing person's role is possible in the DB function but has no UI (out of Phase 1).
6. **`[auth.email] enable_signup` must stay `true`**: in Supabase that switch is the email *provider*; `false` disables email sign-in for everyone (found by testing). Strangers are kept out by `enable_signup = false` under `[auth]`.
7. Local `email_sent` rate raised 2 → 30 so testing is not throttled; it applies to local only.

## Hosted-dashboard checklist (a person does this; local `config.toml` does not reach hosted)
- Auth → Providers → Email: **enabled**. Auth → Sign In / Providers → **"Allow new users to sign up" OFF**.
- Email OTP expiry **600** s; OTP length 6.
- MFA → TOTP **enabled** (see gap 5).
- Email templates → **Magic Link**: paste `supabase/templates/magic_link.html` (code only, no link) and subject "Your Daksha Nirmaan sign-in code".
- **Custom SMTP (Resend)** with DKIM/SPF/DMARC before go-live (built-in sender allows a few emails per hour). Go-live checklist (change 17) verifies a real code arrives.
- Site URL + redirect URLs set to the real domain.
- Create the first owner: `NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… npm run create-admin -- <email> "<name>"` (refuses if an active admin exists; `--force` to override).

## Local development
`supabase db reset` wipes sign-in accounts. After a reset, recreate the owner with the command above (local values from `supabase status`), open http://localhost:3000, sign in (the code arrives in the local mail catcher at http://127.0.0.1:54324), scan the QR code with an authenticator app.

## Not verified
- Hosted project, real SMTP delivery, and real-phone authenticator flow.
- Waiting past 8 h in a browser (unit-tested only).
- Contrast ratios by tool; Telugu on a real device.
- Concurrent admins racing the "≤ 10 people" rule beyond the advisory lock (single-connection pgTAP cannot race).

## Needs native-speaker review
All new Telugu strings in `login.*`, `mfa.*`, `users.*`, `errors.*`, `topbar.signOut` were written by the model.

## For later changes
- 09: org settings tabs join `/settings`; role change UI if wanted; GSTIN pill.
- 16: `RUNBOOK.md` gets: create first admin, recover a lost authenticator (an admin with `service_role` deletes the factor: `auth.admin.mfa.deleteFactor`), key rotation.
- Lost authenticator: not built. Until the runbook exists, recovery = another admin removes the factor via the dashboard, or `create-admin --force` after removing the row.
- The shared `Toast` primitive is still unbuilt; forms show inline notices.
