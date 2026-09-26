Skill: daksh-api (server actions, auth) + daksh-ui (login screens, Users screen); daksh-schema only if a migration turns out to be needed (none expected)
Spec section: openspec/specs/security-deployment/spec.md → login/sessions (rewritten by this change); api-architecture "Auth (change 08)"; openspec/changes/08-auth-users/implementation-notes.md
Context: Change 08 made sign-in an emailed one-time code (+ authenticator app for owners). On Supabase Free the code email needs custom SMTP (the default template sends a link, and templates cannot be edited without SMTP), and Ratna deferred SMTP (2026-09-26). MyExpenseTracker signs in with email + password on Supabase Auth. Decision (Ratna, 2026-09-26): **email + password for everyone; owners still complete the authenticator (TOTP) step.** No email is ever sent by the app.
Do not: weaken the aal2 rules (`current_app_role()` already treats an owner below aal2 as nobody — leave it); add sign-up; add a "forgot password" email flow; commit `.env`; put the service key in client code.

## Scope
1. **Sign-in:** `signIn({email, password})` server action → `supabase.auth.signInWithPassword`; same generic failure whether the email is unknown, disabled or the password is wrong; rate-limited per email+IP (reuse `rate-limit.ts`); then the existing `app_users` active check; owner → `/login/mfa`, counter → `/`. Remove the request-code / verify-code actions and the code step of `LoginForm`.
2. **Adding a person** (`inviteUser`): the owner types a starting password (≥ 12 characters; a "generate" button offers a random one shown once) → `auth.admin.createUser({email, password, email_confirm: true})`; the owner tells the person in person. **Reset a person's password** (owner action → `auth.admin.updateUserById`), and **change my own password** (any signed-in member, `auth.updateUser`; an owner needs aal2 to reach it).
3. **First owner:** `scripts/create-admin.mjs` takes the password from the `ADMIN_PASSWORD` environment variable (or generates one and prints it once); never on the command line.
4. **Password rules:** minimum 12 characters (zod schema shared by the forms and actions; Supabase dashboard **Authentication → Providers → Email → minimum password length** set to 12, leaked-password protection on if the plan has it — note in RUNBOOK). Sign-ups stay off.
5. **Owners unchanged:** TOTP enrolment and challenge exactly as today (`/login/mfa`); the database still refuses an owner below aal2.
6. **Docs/tests:** rewrite change 08's login walk-through for password; unit tests for the new actions (happy, wrong password, disabled user, rate limit, owner routed to MFA); update `auth.test.ts`; en + te messages; RUNBOOK section for "a person forgot their password" (owner resets it) and go-live checklist line (OTP email no longer needed; SMTP optional).

## Conservative defaults (log in implementation-notes.md)
- No forced change at first login (needs a schema flag); the RUNBOOK asks the owner to have the person change it straight away from the menu.
- No self-service "forgot password" (needs email); an owner resets it.
- Lock-out: 5 wrong passwords per email+IP in 10 minutes → the existing rate-limit message.
- Local config: `supabase/config.toml` `minimum_password_length = 12` and email confirmations off (no email exists locally either).

## Done when
- A counter user and an owner sign in with email + password locally; the owner is held on `/login/mfa` until the authenticator code is entered; wrong password, disabled user and unknown email all show the same message; the 18-check login walk from change 19 passes with the password steps.
- pgTAP unchanged and green; vitest, `tsc`, lint, `npm run build` clean; no OTP UI or action remains.
