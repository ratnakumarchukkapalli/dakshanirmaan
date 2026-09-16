# Implementation notes — 01 foundation-schema

## What was built

5 migrations (`supabase/migrations/2026091608533{0,1,3,5,8}_*.sql`... actually timestamps
`20260916085328` → `20260916085335`, in order):
1. `enums_and_reference_types` — the 6 base enums from "Enums and reference types".
2. `core_tables` — every table in "Core tables": masters, ledger core, all Phase-1 documents
   (+lines), `audit_log`, `app_users` (base shape).
3. `baseline_indexes` — the 11 indexes from "Indexes (baseline, Phase 1)".
4. `rls_and_roles` — `is_active_member()` / `current_app_role()` helper functions (SECURITY
   DEFINER, `set search_path = public, pg_temp`), RLS enabled on every table, SELECT policy for
   active members everywhere, INSERT/UPDATE-while-draft policies for both roles on the six
   document header tables + their line tables.
5. `seed_foundation` — organization placeholder, one warehouse, full CoA (25 `system_key`
   accounts + groups/leaves per DESIGN.md §2.2), FY 2026-27 fiscal periods (Apr 2026–Mar 2027),
   7 `doc_sequences` rows.

pgTAP: `supabase/tests/database/00001_rls_denies_non_member.test.sql`,
`00002_seed_creates_system_keys.test.sql`, `00003_review_fixes.test.sql` (doc_sequences series
count, organization singleton, `updated_at` touch on draft update, draft DELETE). All must-pass
checks green on a clean `supabase db reset` + `supabase test db`. **Not pushed to hosted
`daksha-nirmaan`** — `supabase migration list` confirms all 5 are local-only (empty `remote`
column).

## Conservative defaults taken (surprises, per project.md §Build process)

1. **Resolved in review: `doc_sequences` keyed by series.** `doc_sequences` now has a `series
   text` column (`DN, PB, CN, DB, RCPT, PAY, EXP`) with `UNIQUE(series, fy_label)`, plus
   `doc_type source_type` kept as a reference column (not part of the uniqueness). All 7 seed
   rows are present, including `PAY` for outgoing payments alongside `RCPT` for receipts — no
   collision. `next_doc_no` takes `p_series text` instead of `p_doc_type source_type`.
2. **`cheques_in_hand` system_key not seeded.** The "Schema extensions" section's bulleted
   "New system_key accounts" list (10 items) doesn't include `cheques_in_hand`, even though it's
   named inline under the `payments` (columns added) paragraph. Left it out of this change's CoA
   seed since it belongs with the cheque-lifecycle columns, which land in change 04. Change 04
   should add the account (and the `cheque_status` enum + payments columns) together.
3. **Enum extensions deferred.** Did not add `ALTER TYPE source_type ADD VALUE
   'delivery_challan'/'stock_transfer'/'quotation'/'day_close'` or `CREATE TYPE cheque_status`
   here — those are in "Schema extensions", tied to tables this change doesn't create (changes
   05 and 24). `ALTER TYPE ... ADD VALUE` must be committed before use, so adding it now with no
   consumer is unnecessary risk.
4. **RLS write-policy granularity beyond the spec's two bullets.** Spec's RLS section only
   states "SELECT on business tables" and "INSERT/UPDATE on draft documents: both roles" as
   granular rules; everything else (masters writes, `app_users` writes, ledger-core writes) is
   implied "admin-only" / "functions only" but not spelled out per-table. Took the most
   conservative reading: **no** INSERT/UPDATE/DELETE policy at all on masters
   (`organization, accounts, parties, party_addresses, items, warehouses, fiscal_periods,
   doc_sequences`), `app_users`, `payment_allocations`, or the ledger core — all deny until the
   change that actually owns that write path (09 `masters` for admin writes on masters/settings,
   08 `auth-users` for `app_users` provisioning, 02+ for ledger-core `SECURITY DEFINER`
   functions, 04 for `payment_allocations` via `post_payment`) adds the policy or grant it needs.
   This may be too strict for change 09's actual UX (e.g. can a `user`-role staff member add a
   walk-in customer to `parties` without an admin?) — flagged for that change to revisit, not
   assumed here.
5. **`credit_notes`/`debit_notes` header shape is a judgment call.** Spec says lines are "same
   line shape" as sales/purchase lines (implemented as such) but doesn't specify the header
   columns beyond `against_invoice_id, reason`. Modeled the header close to `sales_invoices`
   (note_no, note_date, party_id, place_of_supply, status, tax totals, round_off, grand_total,
   journal_entry_id) minus the transport/e-way-bill/IRN fields, since notes don't move goods on
   their own and don't need those. `place_of_supply` was added (not explicitly listed) because
   the GST return views (`v_gstr1_b2b` etc., change 06) will need it on notes the same way they
   need it on invoices.
6. **`organization` seed row left `gstin` and `address` NULL.** Real GSTIN/address are open
   owner-interview unknowns (DESIGN.md §9); the placeholder row exists so `fy_start_month` and
   `state_code` (needed by tax-direction logic in the posting engine) are available from day one.
