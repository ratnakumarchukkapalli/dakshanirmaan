# Change 08b — password-login: implementation notes

Built and browser-walked 2026-09-26 (Sonnet 5). Brief: `proposal.md`. Not separately reviewed (auth: the pre-go-live `/security-review` covers it — schedule it before making the repo public).

## What changed
- `signIn` (email + password, `signInWithPassword`) replaces `requestCode` / `verifyCode`; unknown email, wrong password, disabled person and a sign-in account with no active `app_users` row all give the same message (`errors.sign_in_failed`); rate-limited per email+IP (10 / 15 min, 40 per email) with the existing limiter; a non-member is signed out again at once; owners go on to `/login/mfa` (unchanged TOTP step, still enforced by the database at aal2).
- `changePassword` (any member; owner needs aal2), `resetUserPassword` (owner), `inviteUser` now takes the starting password (min 12, max 72); Users screen: password field + "Suggest one" (random, shown so it can be read out once) and per-row **Reset password**; avatar menu → `/account` (Change password).
- `scripts/create-admin.mjs`: `ADMIN_PASSWORD` env (12–72 chars) or a generated password printed once; an existing email gets its password set.
- `supabase/config.toml`: `minimum_password_length = 12` (restart local Supabase to apply; the app enforces 12 itself). RUNBOOK sections 8 (go-live) and 10 (passwords) rewritten. en + te messages.
- No migration. `allowCodeRequest` (OTP code request limiter) is left in `rate-limit.ts`, unused, with its tests.

## Gates
vitest 580, tsc, lint, `npm run build` clean. pgTAP untouched (1779). Live browser walk (production build): wrong password = unknown email message; owner held at `/login/mfa`, bounced back from `/sales`, enrolls TOTP and gets in; owner adds a counter user (short password refused, generate, add); counter signs in (no MFA), is turned away from Settings, changes own password (short refused); owner resets it, old password stops working, new one works; disabled person gets the same message; no sideways scroll at 390 px; no page errors.

## Conservative defaults / known limits
- No forced change at first login (would need a schema flag); the go-live checklist asks everyone to change it from the menu.
- No self-service "forgot password" (needs email): an owner resets it. Resetting does not end the person's other open sessions (up to 8 h).
- Hosted Supabase must have the minimum password length set to 12 in the dashboard (RUNBOOK 8) — the app checks 12 on every set, but the service's own floor protects the create-admin path.
