Skill: daksh-api (also load daksh-schema for the migration + pgTAP conventions, daksh-ui for the screens)
Spec section: openspec/specs/security-deployment/spec.md → "## Requirement: Accounts & authentication" + "## Requirement: Non-functional clarifications" (Sessions, Rate limits, Transactional email, Content-Security-Policy bullets); openspec/specs/api-architecture/spec.md → "## Requirement: Authorization" + "## Requirement: Implementation clarifications" (Auth bullet) + "admin.ts" line of "Action catalog extensions"; openspec/specs/db-architecture/spec.md → app_users columns (locale, invited_by, invited_at, max 10 active users)
Context: Change 07 built the shell but nobody can sign in: `/login` is a placeholder and the shell is reachable only through a development switch (`DN_AUTH_GATE=off`). This change is the front door. Email one-time code sign-in for both roles, TOTP (authenticator app) as a second step for admins, an owner screen to add and disable users, sign-out, and a per-person language setting. It also deletes the development switch. No money or stock logic is touched.
Do not: read other specs; touch the posting functions (03–06) or their migrations; build masters/org settings (09); add OAuth, passwords, or public signup; push to hosted; commit (Ratna commits).

## Scope

**In**
1. **Migration `…_auth_users.sql`** (new file only): `app_users` gains `email`, `locale` (`en`/`te`, default `en`), `invited_by`, `invited_at`; a guard trigger (max 10 active users; at least one active admin always remains; rows are never deleted, only deactivated); `admin_set_user(...)` (SECURITY DEFINER; caller must be an active admin **with a TOTP-verified session (`aal2`)**; cannot demote or disable yourself; writes `audit_log`); `set_my_locale(text)`; grants (execute to `authenticated` only; direct writes to `app_users` revoked from `authenticated`).
2. **Auth config** (`supabase/config.toml`): public signup off, OTP valid 10 min, TOTP enrol/verify on, `magic_link` email template shows the code only (no link).
3. **Sign-in**: `/login` — email → 6-digit code. Server actions `requestOtp`, `verifyOtp` (never reveal whether an email is registered; always the same reply). Rate limits: 5 code requests per email per 15 min, 20 per IP per hour (in memory).
4. **Admin second step**: `/login/mfa` — first time shows a QR code + text secret to add to an authenticator app and confirm; afterwards asks for the 6-digit app code. Until an admin session is TOTP-verified, every page except `/login/mfa` redirects there.
5. **Session rules in `src/proxy.ts`**: signed-in + active `app_users` row required; admin needs `aal2`; a session older than **8 hours since sign-in** is ended (time-box, read from the signed token — see defaults); `user` role cannot reach `/settings/**`.
6. **Settings → Users & roles** (`/settings/users`, admin only): list (name, email, role, active, invited), add user (email, name, role), disable / re-enable. Actions `inviteUser`, `disableUser`, `enableUser`; disabling also blocks the person's Supabase Auth account from getting new sessions.
7. **Sign-out** in the avatar menu; **language**: `setLocale` stores the choice on the person's row, and it is applied at sign-in.
8. **Role-aware shell**: `user` role no longer sees Settings; the "Dev session" identity and `DN_AUTH_GATE` are **deleted**.
9. **Bootstrap**: `npm run create-admin -- <email> "<name>"` creates the first admin (service key, local or hosted) since nobody can sign up.
10. First real action files: `src/lib/action-result.ts` (envelope + `DN_*` mapper), `src/schemas/auth.ts`, `src/schemas/users.ts`.
11. Tests: pgTAP `00010_auth_users.test.sql`; Vitest for the access decision, session time-box, rate limiter, error mapper, schemas; a real-browser walk-through (sign in with a code from the local mail catcher, enrol TOTP, second-step, sign-out, disable a user).

**Out (log in notes)**: password / email change flows; per-user "sign out everywhere" button; role change of an existing user (only disable/enable + create in Phase 1); Resend/custom SMTP set-up on the hosted project (a go-live step — the config here and the runbook line are the deliverable); Supabase hosted dashboard mirroring (written as a checklist in the notes, done by a person); captcha.

## Conservative defaults (owner unknowns — log each in `implementation-notes.md`)

1. **"Invite" = create the account with no email, then the person signs in with a code.** The spec says `inviteUserByEmail`, which sends a link and needs a link-landing page (a second, riskier way in). Creating the account and having the person use the normal code screen needs no link handling. The Users screen tells the admin to ask them to open the app and sign in with that email.
2. **Session limit = 8 hours since sign-in (time-box), enforced by the app.** Supabase's own time-box / inactivity setting is a paid-plan feature and the project is on Free. The sign-in time is read from the signed session token, so it cannot be edited by the user. Consequence: someone who signs in at 9:30 is asked for a new code at 17:30. Named constant `SESSION_MAX_HOURS`; owner may raise it.
3. **TOTP is enforced at the app boundary and inside the new user-management database function — not inside the 18 role checks of the posting functions (03–06).** Those read `app_users` directly; changing them means editing reviewed posting migrations. Known residual gap: a person who controls an admin's *email* but not their authenticator could sign in to a first-step (`aal1`) session and call the database API directly with a hand-made request. **Log prominently; recommend a dedicated follow-up (Opus) before go-live** that makes every role lookup aal-aware.
4. **Rate limits run inside the sign-in action**, not proxy, because only the action can see the email address. In-memory per server instance, as the security spec accepts.
5. **Uniform replies**: unknown email, disabled user, and wrong/expired code look the same to the visitor ("The code did not work — request a new one"). Real cause goes to the server log only.
6. **Disable is soft and total**: `is_active=false` (proxy blocks on the next request) + Supabase Auth ban (no new tokens). Enable reverses both. A row is never deleted. If the second step fails, envelope `partial` tells the admin what to redo.
7. **Max 10 active users, ≥ 1 active admin** enforced in the database trigger, so no code path can violate them.
8. **Language on the person's row is authoritative at sign-in**; the cookie remains the fast path and the only store for the signed-out login screen.
9. **First admin** is created by the `create-admin` script (service key, run by a person). It refuses to run if an active admin already exists, unless `--force`.

## Done when

- **"signup is a dead end"**: with public signup disabled, a direct Auth API signup request is refused, and `requestOtp` for an unregistered email creates nothing and gives the same reply as a registered one.
- **"general user cannot cancel"** (kept for 08's brief): a `user`-role session cannot call `admin_set_user` (pgTAP) nor `inviteUser`/`disableUser` (action returns `forbidden`); a `user` visiting `/settings/users` is redirected home.
- pgTAP `00010`: admin at `aal2` can create/disable/enable; admin at `aal1` refused; `user` refused; unauthenticated refused; cannot disable/demote yourself; cannot remove the last active admin; 11th active user refused; `app_users` cannot be written or deleted directly by `authenticated`; `set_my_locale` changes only the caller's row and rejects unknown locales; existing 680+ tests still pass (`supabase db reset` + `supabase test db`).
- Browser walk-through passes at 390 px and 1280 px: code sign-in → admin TOTP enrolment → home; sign-out; second sign-in asks TOTP; disabled user's next request lands on `/login`; session older than 8 h is ended (simulated by a test clock in the unit test and one forged-old-token check).
- `DN_AUTH_GATE`, `isAuthGateOff`, and the dev fallback identity are gone; `grep` proves it.
- Gates: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`; no hardcoded hex or user-visible literal; secret key not in the client bundle; no `NEXT_PUBLIC_` beyond the two allowed; `implementation-notes.md` written (including a hosted-dashboard checklist: signup off, OTP expiry 600, TOTP on, code-only template, custom SMTP before go-live); not pushed; **not committed**.
- **Review**: touches auth + RLS → Opus fresh-context review with `daksh-review` (ask Ratna before launching; narrow scope: migration + actions + proxy).
