---
name: daksh-schema
description: Database conventions for Daksha Nirmaan. Load for ANY work touching Postgres — migrations, tables, enums, RLS policies, indexes, seeds, pgTAP tests, supabase CLI — even a "one-line SQL change", because conventions here are review-blocking. Trigger on "migration", "table", "schema", "RLS", "postgres", "supabase", "seed", "index", "pgTAP", "database".
---

# Daksha Nirmaan — Schema Work

Contract: `openspec/specs/db-architecture/spec.md`. This skill is the distilled rulebook; the spec wins on conflict.

**Token rule:** your brief names one spec section — read that section only. This skill + that section is enough context. Don't read other specs or `docs/DESIGN.md` unless the brief says so.

## Every table
- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at timestamptz DEFAULT now()`; documents add `created_by UUID REFERENCES auth.users`.
- snake_case names. Money `NUMERIC(14,2)`, quantities `NUMERIC(12,3)`, unit rates `NUMERIC(14,4)`. **Float types are a review-reject.**
- RLS ENABLED on every new table, deny-by-default, policies check active `app_users` membership (not just `auth.uid()`). Two roles: `admin`, `user`.

## Ledger core — do not touch casually
- `journal_entries`, `journal_lines`, `stock_movements` are immutable once written (triggers enforce). No direct INSERT grants to any role — writes go through `SECURITY DEFINER` `post_*` functions with `SET search_path = public, pg_temp`.
- `journal_lines`: CHECK (debit=0 OR credit=0), party_id only on control accounts (`is_control`). Postings only on leaf accounts (`is_group = false`).
- Balanced-entry constraint trigger is deferred to transaction end — never bypass with direct writes in tests; use the posting functions.

## Enums (existing — extend only via spec change)
`account_type, party_type ('customer','supplier','both','employee'), doc_status ('draft','posted','cancelled'), source_type, payment_mode, app_role ('admin','user')`

## System accounts
Resolve via `accounts.system_key`, never by name: `ar, ap, inventory, cogs, output_cgst/sgst/igst, input_cgst/sgst/igst, round_off, salary_payable, employee_advance, cash, rcm_payable`.

## New objects (pgTAP 00026 fails the build if you forget)
- Every new function: `revoke all ... from public, anon` then grant to the roles that need it. Supabase's default hands `anon` EXECUTE on new functions.
- Every new table: `enable row level security` in the same migration. Defaults give `authenticated` full DML.
- Every table with `created_by` gets the `set_created_by` trigger (`create trigger set_created_by before insert or update ... execute function public.set_created_by()`).

## Migrations
- `supabase` CLI, files committed, **never edited after apply**. Apply to staging project first, production only after verification.
- Every new query path gets an index consideration: existing baseline `journal_lines(party_id, entry_id)`, `journal_entries(entry_date)`, `stock_movements(item_id, warehouse_id, movement_date)`.
- Seeds: CoA + system_key accounts, Head Godown warehouse, FY periods, doc_sequences. Demo data → staging only.

## Snapshots rule
Document line tables (`*_invoice_lines`, note lines) carry `item_name, hsn_code, uom, gst_rate` copies. Never "normalize" these away — history must survive master edits.

## Done means
pgTAP invariants pass: balanced entries, immutability rejects UPDATE/DELETE, locked period rejects posting, role gates enforced, RLS denies non-members.
