# 27b — address-state-owner-only: implementation notes (database half)

Migration `20261004100000_purchase_attachments_and_address_guard.sql` (shared with 21b's database half; section 4 is 27b). pgTAP `00030_address_state_owner_only.test.sql` (27 tests). Local only, not committed, not pushed.
Scope 2 (invoice form preview, `InvoiceForm.tsx`) is app-side and **not** in this session.

## What was built

- `party_addresses_guard()` is now `BEFORE INSERT OR UPDATE` (trigger dropped and recreated), still `SECURITY DEFINER`, `SET search_path = public, pg_temp`, no grants.
  - "Counter" = `auth.uid() is not null and coalesce(current_app_role() = 'admin', false) = false` (an admin below aal2 counts as a counter here, but RLS already gives that session nothing).
  - UPDATE: `party_id` change → `DN_VALIDATION:address_party_locked` (everyone, unchanged); `state_code` change by a counter → `DN_VALIDATION:admin_only_field`. A PATCH that repeats the unchanged state passes.
  - INSERT by a counter: `state_code` must equal `parties.state_code` of the row's party, else `DN_VALIDATION:admin_only_field` (also when the party does not exist — the FK would refuse it anyway).
  - Owner at aal2, seeds, migrations, `service_role` with no `auth.uid()`: unchanged.
- The app already maps `admin_only_field` (`validation.admin_only_field`, en + te). Its current text ("Only an owner can change a party's type, GSTIN or state, …") fits; the 27b UI session may want a site-specific sentence.

## Paths checked (read-only) that insert `party_addresses` as a counter

- `src/app/actions/parties.ts` `addPartyAddress` is the only app write; party creation (`createParty`) does not insert an address. Same-state sites keep working; an out-of-state site now returns `validation.admin_only_field` for a counter.
- No RPC / posting function writes `party_addresses`. Demo data and pgTAP fixtures insert addresses as the database owner (unaffected). All 28 earlier pgTAP files stayed green.

## Decisions (spec silent → conservative)

- **Block, not audit-only** (brief default).
- **A counter user can still create a NEW party whose own state is another state, and give it a site in that state.** The rule compares the site with the party's state, as briefed; `parties.state_code` is owner-only once the party exists (change 09 guard). So the remaining counter route to IGST is "a new, separate customer registered in another state", which is a different customer on GSTR-1, not a steer of an existing one. Say if new-party state should also be owner-only (would affect walk-in / new-site customers at the counter).
- `99` is still a valid code (constraints unchanged, per brief); a counter cannot add a `99` site to a `37` party (it differs from the party's state).
- Existing hosted addresses are not touched. **Not checked on hosted** (no hosted access in this session). Read-only queries to run before push:
  - every site whose state differs from its party's (owner eyeballs the list): `select p.name, p.state_code as party_state, a.label, a.state_code as site_state, a.created_at from party_addresses a join parties p on p.id = a.party_id where a.state_code <> p.state_code order by a.created_at;`
  - of those, the ones a counter user created or re-stated (audit exists only since migration `20260930100000`): `select l.action, l.at, u.name, l.entity_id, l.after->>'state_code' from audit_log l join app_users u on u.user_id = l.actor and u.role = 'user' where l.entity = 'party_addresses' and l.after ? 'state_code';`

## Tests

- pgTAP `00030`: counter UPDATE state refused; counter INSERT 36 and 99 sites for a 37 party refused; counter same-state INSERT, label/lines UPDATE and unchanged-state PATCH allowed; party lock holds; counter's own new 36 party can take a 36 site; owner aal1 and deactivated user get nothing; the in-state customer still has only 37 sites. End to end: draft shipped to a 36 site the customer does not have → `DN_VALIDATION:place_of_supply`; forged `place_of_supply` 36 → posts CGST+SGST; same-state site → CGST+SGST; no posted IGST for that customer; then the owner adds the Hyderabad site (and changes another site's state) and the counter posts the same draft → `36 0.00 0.00 180.00`. Seeds (no session) can add / change any state.
- Harness: `tamper.mjs` B1d (counter POST of a 36 site for Kishore, then post a draft shipped to 36) and B1e (counter PATCH of a Kishore site 37 → 36, then post): both refused, posted `igst_total` stays 0. `matrix.mjs` `party_addresses`: INSERT state 36 / 99 for an in-state party (owner only, a throwaway party each time so the owner control row does not give Kishore a real 36 site), UPDATE state 37 → 36 (owner only), UPDATE label with unchanged state (owner + counter).

## Not done

- Scope 2 (form preview) and vitest: app-side session.
- Fresh-context `daksh-review` (RLS/guard → ask Ratna).
- `docs/STATUS.md`: Ratna updates it.
