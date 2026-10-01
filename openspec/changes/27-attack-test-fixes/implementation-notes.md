# 27 — attack-test-fixes: implementation notes

Migration `20261001100000_attack_test_fixes.sql`, pgTAP `00026_attack_test_fixes.test.sql`. Local only, not committed, not pushed.

## Decisions that differ from, or go beyond, the brief

- **F2 derives instead of raising on a mismatch.** `_post_sales_invoice` computes the place of supply itself (shipping snapshot state when it is one of the party's own `party_addresses` states, else `parties.state_code`) and writes it back, so a forged draft value (`36`, `99`) is ignored and the posted document, PDF and GSTR-1 show the true one. It raises `DN_VALIDATION:place_of_supply` only when the shipping snapshot names a state that is not one of the party's (a forgery, or an address edited since the draft was saved). Chosen over "raise when the column disagrees" because Ratna's review note offered derive-at-post as the fix and it closes the `99` case too. No trigger on draft writes: the column is only a display value until posting; CHECK constraints on all four document tables reject non-GST codes on any write. *(Corrected by 27b:)* the accepted set is 01–38, 97, 99 — the same regex as `parties` / `party_addresses`, not the brief's "01–38 and 97"; `99` is harmless on a sale because the value is re-derived at post time.
- **The app *could* legitimately send a different value**: the invoice form had a free Place-of-supply dropdown. It is now a read-only display of the delivery site's state (else the customer's), and `saveDraftInvoice` derives the column the same way instead of reading `placeOfSupply` from the form. To supply to a state the customer has no address in, add that address to the customer first. Say if a manual override is wanted back (it would need an admin-only path).
- **Default ACL for new functions is NOT changed.** The brief's `alter default privileges in schema public revoke execute on functions from anon` removes only the explicit anon entry; new functions stay open to anon through PUBLIC's implicit EXECUTE (verified in a rolled-back transaction). Closing that needs the database-wide `alter default privileges for role postgres revoke execute on functions from public`, which also removes `authenticated` EXECUTE from every `pg_temp` helper that the existing pgTAP files call under `set local role authenticated` (verified: `auth_pgtemp_fn = false`). The guard is therefore the catalog test (`no function in public is executable by anon`), which fails the build for a forgetful migration. Event trigger to auto-enable RLS: not attempted (hosted `postgres` cannot be assumed to create event triggers); the "every table has RLS" test covers it.
- Guards asserted in 00026: no anon-executable function, RLS on every table, every view `security_invoker`, no anon table privilege, `set_created_by` on every table with `created_by`.
- `hidden_payroll_*`: `current_app_role() = 'user'` (admin and non-member both get nothing). `set_my_locale` writes only when `is_active_member()`; for a non-member it stays a silent no-op (existing test 00010 #26 asserts a disabled member's call does not raise), so the harness checks that nothing was written rather than judging by HTTP status.

## Not done / still open

- **F2 was only half closed here:** counter staff could still add/edit a `party_addresses.state_code` and steer the split through a delivery site. Closed by change 27b (`openspec/changes/27b-address-state-owner-only/implementation-notes.md`).

- Re-allocating a posted receipt (needs a reverse-and-re-apply function with an audit row).
- Debit/credit notes have no posting function yet: derive place of supply the same way when they are written.
- Hosted ACLs and `pg_default_acl` never compared with local (needs Ratna's go-ahead for a read-only comparison).
- Spec-accepted limits K1–K4 (counter can derive bank/cash/profit/stock cost/supplier prices): separate owner decision, untouched.
- Review by a fresh-context Opus reviewer with `daksh-review` (RLS + posting): ask Ratna before launching.
