# Change 19 aal2-enforcement — implementation notes (2026-09-26, Opus)

Closes change 08 KNOWN GAPS 1. **Not committed, not pushed to hosted.**

## What changed
- Migration `supabase/migrations/20260928100000_aal2_enforcement.sql`:
  - `current_app_role()` returns NULL for an `admin` whose JWT `aal` claim is not `aal2` (missing claim counts as not `aal2`). `user` role unchanged. No JWT (migrations, `service_role`, `postgres`): unchanged (auth.uid() is null, nothing matches).
  - `is_active_member()` = `current_app_role() IS NOT NULL` — the rule lives in one function.
  - 15 functions redefined with the single line `select role into v_role from app_users where user_id = v_actor and is_active;` → `v_role := current_app_role();`: `_post_sales_invoice`, `bounce_cheque`, `cancel_document`, `day_close_preview`, `deposit_cheque`, `mark_cheque_cleared`, `post_cash_sale`, `post_day_close`, `post_delivery_challan`, `post_expense_voucher`, `post_payment`, `post_purchase_invoice`, `post_stock_adjustment`, `post_stock_transfer`, `receive_stock_transfer`. (`post_sales_invoice` is a wrapper over `_post_sales_invoice`.) `v_actor` is `auth.uid()` in all 15, so it is the same row.
  - A guard `DO` block at the end fails the migration if any public function still has the direct lookup.
- pgTAP: new `00012_aal2_enforcement.test.sql` (110 assertions). `"aal":"aal2"` added to 201 impersonated sessions in `00001/3/5/6/7/8/9` by script (diff is exactly two line shapes). `00021` had two assertions that pinned the gap itself ("known gap, change 19"); flipped to assert the closed behaviour (plan 67 → 68).
- Docs: `db-architecture` spec (RLS and roles: role-helper bullet; posting-function actor sentence), `security-deployment` spec (Sessions: TOTP enforced by the database too), change 08 notes (gap 1 marked closed).

## How the function bodies were produced
Generated from `pg_get_functiondef` on the local DB, with only the one line replaced — not hand-copied. To rule out local drift, the DB was reset **without** the new migration and the bodies regenerated: identical to the migration (byte for byte, apart from a trailing newline). So each body is exactly the latest committed definition. The migration is therefore long (≈2,900 lines) but only 15 lines differ from the previous definitions; review by diffing each function against its previous latest definition.

## Deviations from the brief
1. **15 lookups, not 18.** The brief counted every copy in the migration files; three functions had later redefinitions. The count that matters is the *latest* definition in the catalog: 15, now 0 (catalog query + the migration's guard). The old copies stay in the old migration files (migrations are never edited).
2. **201 test sessions, not ~390.** The brief's figure counted the `set local request.jwt.claims to ''` resets too. Files 00013–00023 were written after change 08 and already carry `aal`.
3. **`00010` line 44 left without `aal` on purpose** ("admin with no aal claim is refused" — the absence is the test).
4. The brief's file list had no numbers past 00011; the new test takes the free `00012` as instructed.

## Conservative defaults (owner may overrule)
- Owner at step 1 = no access (NULL / not a member), not "downgraded to user". A stolen lock-1 session is worth nothing.
- No change to how `aal` is minted or to session length.
- `admin_set_user` keeps its own explicit `aal2` check (now redundant; harmless; the database and the app each check).
- `set_my_locale` still works for a step-1 owner (updates only their own row's language) — the sign-in screens need it.

## Verification
- `supabase db reset` + `supabase test db`: **1567 pgTAP, all green** (1456 before + 110 new + 1 in 00021).
- Mutation check: with the new migration removed, `00012` fails on every aal1 refusal / emptiness assertion and `00021`'s two flipped assertions fail — the tests really exercise the gate.
- Every existing `aal1` session in the other tests is a counter user, an inactive user or a non-member — none is an owner, so no refusal assertion is passing for the wrong reason.
- **Manual proof, real session, REST API** (local stack; OTP read from Mailpit, TOTP enrolled via `/auth/v1/factors`):
  - owner at step 1 (`aal1`): `POST /rest/v1/rpc/post_sales_invoice` → 400 `DN_FORBIDDEN`; `GET /rest/v1/sales_invoices`, `journal_entries`, `v_trial_balance` → `[]`; `GET /rest/v1/app_users` → own row only.
  - same owner after TOTP (`aal2`): sees the draft, posts it (`DN/26-27/0001`), 1 journal entry, 39 trial-balance rows.
- **Browser (Playwright, production build, 390 px + 1280 px): 18/18** — anonymous → `/login`; owner held on `/login/mfa` after the email code and bounced back there from `/sales` and `/`; enrolment shows QR + typed key; wrong code refused, right code lets in; aal2 owner sees the posted invoice and opens Settings → Users; second sign-in on a fresh device asks only for the code; sign-out lands on `/login`; counter goes straight in, sees the invoice, is turned away from `/settings/users`; no sideways scroll; no page errors.
  - This is the login-flow part of change 08's 29-check walk-through (the part this change can affect: the proxy and `/login/mfa` read the owner's own row at step 1). Not re-run: add/duplicate/disable/re-enable users, language persistence, unknown-email and rate-limit checks — all run at `aal2` or before sign-in and do not go through anything this change touched.
- No `src/` change; `npm run build` clean. vitest/tsc/lint not re-run (nothing they cover changed).

## Known limitations
- Functions that lock the document before the role check (sales / challan / purchase / payment / expense / transfer / adjustment / receive) answer a step-1 owner `DN_NOT_DRAFT` (or `DN_TRANSFER_STATE`) for a wrong or already-posted id instead of `DN_FORBIDDEN`, and hold the row lock until the refusal rolls back. They still refuse; the only leak is "does this UUID exist", which needs a guessed UUID and is the same for any counter user today. Not changed (it would reorder reviewed posting logic).
- In `00012`, four view assertions (`v_employee_ledger`, `v_employees`, `v_open_sales_invoices`, `v_party_interest`) are empty for the fixture at any level, so they would pass without the fix; the other 19 views and the tables are proven non-empty for the aal2 owner.
- Local DB now holds throw-away users (`owner@`, `owner-b@`, `counter@example.test`) and one posted invoice from the proofs; `supabase db reset` clears them.

## Before go-live
- Push this migration to hosted with the others (`supabase db push`) — **not done**.
- Change 08 gap 5 still stands: confirm TOTP enrolment works on the hosted Free plan. If MFA is unavailable there, owners could never reach `aal2` and, after this change, **the database would refuse every owner** — verify before pushing.
- Review: fresh-context Opus reviewer with `daksh-review` (auth + RLS + posting), then `/security-review` before go-live.
