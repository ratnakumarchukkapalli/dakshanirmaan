# 26 — delete-unused-items (owner request 2026-09-26)

Skill: daksh-schema (delete policy, audit trigger, pgTAP) + daksh-ui (button, confirm dialog, i18n). Model: Opus for the policy, Sonnet for the button.
Spec section: openspec/specs/db-architecture/spec.md → RLS write policies for masters (items are admin-write) and the master-edit audit trail (change 18). Run this AFTER the 2026-09 attack test and the review fixes, because it changes RLS.
Context: items can only be edited or disabled today (no DELETE grant or policy). Ratna wants an admin **delete** so a mistaken or test item can be removed. Nine tables reference `items(id)` with plain foreign keys (sales/purchase/credit/debit/challan/transfer/adjustment lines, `stock_movements`, `opening_lines`), so the database already refuses to delete an item that has ever been used.
Do not: cascade anything; delete parties or any document (parties are a possible later request — same pattern, ask first); weaken immutability of posted rows.

## Scope
1. `grant delete on public.items to authenticated` and a `delete_admin` policy (`current_app_role() = 'admin'`, so aal2 owners only). Extend the `audit_master_items` trigger to also fire on DELETE and record the old row.
2. A "Delete" button on Settings → Items, shown only on an item with no history, behind a confirm dialog naming the item. If the database still refuses (foreign-key violation) show: "This item has been used. Disable it instead." (new error mapping, en + te).
3. Server action `deleteItem` (requireAdmin, zod id, envelope), like `deactivateItem`.
4. pgTAP: admin at aal2 deletes an unused item and an audit row is written; a used item (invoice line, stock movement, opening line each) cannot be deleted; a counter user and an admin at aal1 cannot delete anything; the deleted item's name can be reused.
Out: deleting parties, accounts, warehouses; a "recently deleted" undo (the audit row keeps the details).

## Done when
Gates green on an empty database; real-browser: create an item, delete it; sell an item, confirm Delete is hidden or refused with the friendly message.
