# 27b — address-state-owner-only (follow-up to change 27, from its independent review 2026-09-26)

Skill: daksh-schema (+ daksh-posting only to read `_post_sales_invoice`; do not edit it). Model: Opus, fresh session (RLS/guard trigger). One new migration + additions to the existing `00026_attack_test_fixes.test.sql` or a new pgTAP file, next free number.
Spec section: openspec/specs/db-architecture/spec.md → "Masters write policies (change 09)" and the sales tax paragraph "Which state decides" (~line 254). Context: `openspec/changes/27-attack-test-fixes/implementation-notes.md` and the reviewer's finding below. Do not read other specs.
Context: change 27 made `_post_sales_invoice` derive the place of supply from the shipping state **if that state is one of the party's own `party_addresses` states**, else the party's state. But counter staff may INSERT and UPDATE `party_addresses`, including `state_code`, and `party_addresses_guard` is BEFORE UPDATE only and locks only `party_id`. So F2 is only half closed: a counter user adds (or edits) a state-36 site for an in-state customer, saves the draft with that site, posts, and the invoice posts as IGST (or the reverse). Total tax is unchanged; the tax head is wrong on the ledger and in GSTR-1; the only trace is `audit_master_change`, which counter staff cannot see. The attack test missed it because it tested `parties.state_code` but not `party_addresses.state_code`.
**Owner decision (Ratna, 2026-09-26): out-of-state delivery sites are added by the owner only.**
Do not: change posting math/numbering/stock/journal behaviour; edit `_post_sales_invoice`; edit an applied migration (new file only); push to hosted; commit (Ratna commits). K1–K4 stay accepted and out of scope.

## Scope
1. **Guard.** Extend `party_addresses_guard` to `BEFORE INSERT OR UPDATE` (keep the `party_id` lock). For an app session that is not an admin (`auth.uid() is not null and coalesce(current_app_role() = 'admin', false) = false`):
   - UPDATE: refuse any change to `state_code` → `DN_VALIDATION:admin_only_field`.
   - INSERT: `state_code` must equal the party's `parties.state_code`, else `DN_VALIDATION:admin_only_field`. (A counter user can still add a same-state site — the normal walk-in and new-site case.)
   - Admin at aal2, seeds and `service_role` (no `auth.uid()`): unchanged. Keep `SECURITY DEFINER` and `SET search_path = public, pg_temp`.
2. **Form preview (reviewer finding 2).** `src/components/sales/InvoiceForm.tsx` previews the tax head from `party.stateCode` and ignores a chosen billing site, while the server (`src/app/actions/sales.ts`) uses the chosen site, else the default address, else the party state. Make the form mirror the server rule exactly (chosen site → default address → party state), or, if simpler and correct, state the rule once in a small shared helper both use. No business math beyond the existing preview. Strings through i18n in both `en.json` and `te.json`.
3. **State-code list (reviewer finding 3).** The CHECK constraints accept `99` (same regex as `parties`). Keep the constraints as they are; correct `implementation-notes.md` of change 27 and the spec sentence to say "01–38, 97, 99 (same as parties)". For sales `99` is harmless because the value is re-derived at post time.
4. **Tests.** pgTAP: a counter user cannot UPDATE an address's `state_code` and cannot INSERT an address whose state differs from the party's (both raise `DN_VALIDATION:admin_only_field`); can still INSERT a same-state address and UPDATE label/lines; an admin at aal2 can do both; an admin at aal1 and a deactivated user still get nothing; an end-to-end case that a counter user **cannot** obtain IGST for an in-state customer by any address route, and the owner adding a state-36 address for that customer then works. Vitest for the form preview if there is a test file for it.
5. **Harness.** Add rows to `scripts/attack-test/tamper.mjs`: counter INSERT of an out-of-state address for Kishore, counter PATCH of an address `state_code`, then post — both must be refused; expectation that posted `igst_total` stays 0. Also add `party_addresses` `state_code` variants to `matrix.mjs`. No other expectation weakened.
6. **Docs.** `db-architecture` "Masters write policies": counter staff may add same-state sites; changing a site's state or adding an out-of-state site is owner-only. `docs/STATUS.md`; mark F2 in `docs/reviews/2026-09-attack-test.md` as closed by 27 + 27b.

## Conservative defaults (log in `implementation-notes.md`)
- Block, do not audit-only. Existing hosted addresses are not changed by this migration; check whether any existing counter-created out-of-state address exists (`select` only) and report it, do not delete.
- The counter keeps the ability to choose among the party's existing sites.

## Done when
- pgTAP, vitest, `tsc`, lint, build green; `bash scripts/attack-test/run-all.sh` ends with no FAIL rows (KNOWN K1–K6 remain).
- Fresh-context reviewer with `daksh-review` (RLS/guard → ask Ratna before launching). Not pushed to hosted until reviewed; **not committed**.
