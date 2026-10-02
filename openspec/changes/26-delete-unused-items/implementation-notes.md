# 26 — implementation notes (database half)

Files: `supabase/migrations/20261007100000_items_delete.sql`, `supabase/tests/database/00033_items_delete.test.sql` (31 assertions). Gates: `supabase db reset` + `supabase test db` on an empty database, 33 files / 2463 tests, PASS.

## What changed
- `audit_master_change()` gains a DELETE branch first (`action = 'delete'`, `before` = the old row minus `created_at`/`updated_at`/pay columns, `after` null, `entity_id` = old id). INSERT and UPDATE paths unchanged (`v_new` is now computed after the DELETE branch because NEW is null there).
- `audit_master_items` is recreated as `after insert or update or delete`. The other master triggers stay insert/update (those tables have no delete).
- Policy `delete_admin on items for delete using (current_app_role() = 'admin')`. Same pattern as `insert_admin`/`update_admin`: `current_app_role()` returns 'admin' only at aal2 (change 19), so no separate aal check.
- `grant delete on public.items to authenticated`. service_role and anon untouched (00026 catalog guard passes).

## Checked before building
- Catalog: exactly nine FKs reference `items(id)` (stock_movements, opening_lines, sales/purchase invoice lines, credit/debit note lines, challan/transfer/adjustment lines). All NO ACTION, none CASCADE or SET NULL. 00033 asserts this so a future cascade fails the build.
- `items` has no unique index on name (only the PK), so reusing a deleted name is not a database issue. Any duplicate-name check lives in the app.

## Defaults taken
- **"Used" includes drafts.** A draft invoice line or a draft opening line also blocks the delete (plain FK). Conservative: the owner removes the draft line first, or disables the item.
- **A failed delete leaves no audit row.** The FK check fails the statement and rolls back the audit insert with it. Only successful deletes are logged.
- **A delete that is refused by RLS returns 0 rows, not an error** (counter user, owner at aal1, non-member). The server action should treat "0 rows deleted" as not-found/forbidden. `requireAdmin` blocks those users before the call anyway.

## Error the app should map
A used item comes back from PostgREST as HTTP 409, and supabase-js `error.code === '23503'`, with
`message` = `update or delete on table "items" violates foreign key constraint "<table>_item_id_fkey" on table "<table>"` and
`details` = `Key (id)=(<uuid>) is still referenced from table "<table>".`
Map on `code === '23503'` only, never on the message text.

## Surprise (fixed in review)
_Review finding 2: now revoked in this migration (section 3), and 00033 asserts it._ Original note:
`authenticated` holds a DELETE privilege on `accounts` and `warehouses` (from `20260930110000_explicit_grants.sql`). No DELETE policy exists on either table, so RLS still refuses every delete. But the "second lock" (revoked privilege) that parties/items/organisation have is missing on those two tables. 00033 asserts that no delete policy exists on them. A revoke can go into a later hardening change.
