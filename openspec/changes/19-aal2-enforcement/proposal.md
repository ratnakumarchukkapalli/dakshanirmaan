Skill: daksh-schema + daksh-posting (posting functions are being edited; keep every existing behaviour and test intact)
Spec section: openspec/specs/security-deployment/spec.md → "## Requirement: Non-functional clarifications" (Sessions bullet: admin actions require `aal2`); openspec/changes/08-auth-users/implementation-notes.md → "KNOWN GAPS" item 1
Context: Change 08 made owners sign in with an email code (lock 1) and an authenticator-app code (lock 2). The app's pages and the user-management function enforce both, but the database's own role checks do not: 18 places in the posting functions read `app_users` directly and never look at the session's authentication level, and `is_active_member()` (behind every read policy) ignores it too. Someone holding only an owner's email inbox can get a lock-1 session and call the database API by hand as that owner. This change closes that in the database, in one place.
Do not: change any posting logic, numbering, tax, stock, or journal behaviour; touch the app UI beyond what tests need; push to hosted; commit (Ratna commits).

## Scope

1. **One rule, in one place.** New migration (new file only). Make the two helpers aal-aware:
   - `is_active_member()` → false for an `admin` whose session is not `aal2` (claim `auth.jwt() ->> 'aal'`). This shuts every row-level read policy (≈25 tables) and every view with one edit.
   - `current_app_role()` → NULL (not `'user'`) for such an admin. Conservative: an owner who has not passed the second step gets no business access at all, not even counter rights.
   - `user` role: unaffected. No JWT (migrations, `service_role`, tests running as `postgres`): unchanged.
2. **Replace the 18 direct lookups** `select role into v_role from app_users where user_id = v_actor and is_active` with `v_role := current_app_role()` (or an equivalent that goes through the same rule) via `CREATE OR REPLACE FUNCTION` in the new migration: `post_sales_invoice`, `cancel_document`, and the purchase / payment / cheque / expense / challan / transfer / adjustment / day-close / cash-sale functions from changes 03–06 (2 + 7 + 8 + 1 occurrences across `20260916110000`, `20260918120000`, `20260918140100`, `20260919130000`). Copy bodies exactly; change only the lookup. Find them all with `grep -n "from app_users where user_id = v_actor"` across `supabase/migrations/` and confirm the count is zero in the *latest definition* of each function.
3. **Do not break the login flow.** The proxy and the `/login/mfa` page read the caller's *own* `app_users` row through the `select_own_or_admin` policy (`user_id = auth.uid()`), which must keep working for an owner at step 1. Verify with a real session (the browser walk-through from change 08 still passes unchanged).
4. **Tests.** (a) Mechanical, scripted edit: add `"aal":"aal2"` to every impersonated session in `supabase/tests/database/0000{1,3,5,6,7,8,9}_*.test.sql` (≈390 statements; `00010` and `00011` already carry `"aal":"aal2"`; JSON claim strings, some multi-line). Do it with a script, review the diff for shape only. (b) New `00012_aal2_enforcement.test.sql` (next free number after change 09's `00011_masters`): for an owner at `aal1` — every `post_*` / `cancel_document` / `receive_stock_transfer` / day-close function raises `DN_FORBIDDEN`; a sample of tables and every `v_*` view returns zero rows; own-row read of `app_users` still works. Same owner at `aal2` — all of them work. `user` role — identical results at `aal1` and `aal2`.
   (c) Change 09's write policies (parties, addresses, items, organisation) and `parties_guard` are built on the same two helpers, so this change closes their database half too — add cases to `00012` proving an owner at `aal1` cannot insert/update a party, item or the organisation row. The app half (change 09's server actions) was closed during 09's Opus review with `requireAdmin` / `requireMember` (`src/lib/auth/require.ts`); leave those in place — the database and the app each check (rule 8).
5. **Docs.** Update `db-architecture` (role helpers) and `security-deployment` (state that TOTP is enforced by the database as well); add a line to change 08's notes that gap 1 is closed.

## Conservative defaults (log in `implementation-notes.md`)
- Owner at step 1 = no access (NULL / not a member), not "downgraded to user". A stolen lock-1 session should be worth nothing.
- No change to how `aal` is minted or how long sessions last.
- If any function's latest definition still has a direct lookup, fix it too and list it in the notes; do not leave a straggler.

## Done when
- **"owner at step 1 cannot post, cancel, or read the books through the API"**: pgTAP `00012` green, plus one manual proof — sign in as an owner, stop before the authenticator step, and call `/rest/v1/rpc/post_sales_invoice` and `/rest/v1/sales_invoices` with that session's token: refused / empty.
- All existing pgTAP green after the mechanical claim edit (`supabase db reset` + `supabase test db`); the change-08 browser walk-through still 29/29.
- `grep` shows no `from app_users where user_id = v_actor` in the latest definition of any function.
- Reviewed by a fresh-context Opus reviewer with `daksh-review` (auth + RLS + posting → Opus; ask Ratna before launching). Not pushed; **not committed**.
