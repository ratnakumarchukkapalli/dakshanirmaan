# Implementation notes — 02 integrity-triggers

## What was built

One migration: `supabase/migrations/20260916092055_integrity_triggers.sql`.

- `check_journal_balanced()` — `AFTER INSERT OR UPDATE OR DELETE ... DEFERRABLE INITIALLY
  DEFERRED` constraint trigger on `journal_lines`, sums debit/credit per `entry_id` and raises
  on mismatch. Fires once per row but all firings for the same transaction resolve to the same
  final aggregate, so redundant firings are harmless.
- `check_journal_entry_immutable()` — `BEFORE UPDATE OR DELETE` on `journal_entries`: DELETE
  always raises; UPDATE raises unless `reversed_by` transitions NULL → non-NULL and every other
  column is unchanged (explicit column-by-column `IS DISTINCT FROM` comparison, so a sneaky
  UPDATE that also tweaks `narration` alongside `reversed_by` still gets caught).
- `reject_mutation()` — generic `BEFORE UPDATE OR DELETE` trigger, reused on both `journal_lines`
  and `stock_movements` (always raises, no exceptions for either table).
- `check_period_not_locked()` — `BEFORE INSERT` on `journal_entries` and `stock_movements`,
  reused via `tg_table_name` branching to pick `entry_date` vs `movement_date`. No matching
  `fiscal_periods` row is **blocked** (RAISE), not treated as unlocked — see resolved item below.
- `check_leaf_account()` — `BEFORE INSERT` on `journal_lines`, raises if the referenced
  `accounts.is_group` is true.
- `check_journal_has_lines()` — `AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED` constraint
  trigger on `journal_entries`, raises at transaction end if the entry has fewer than 2
  `journal_lines` rows.
- `check_line_party()` — `BEFORE INSERT` on `journal_lines`, raises if `party_id` is null on a
  control account (`accounts.is_control`) or non-null on a non-control account.

Item 4 ("No negative stock") was **not** implemented — spec places it inside the `post_*`
functions (change 03+), not as a trigger. Nothing to add here.

pgTAP: `supabase/tests/database/00004_integrity_triggers.test.sql`, covering all three named
must-pass scenarios plus DELETE immutability, the `reversed_by` one-time exception,
`stock_movements` immutability, an unlocked-period contrast, both leaf-only directions, the
missing-period block, minimum-lines, and both party-rule directions. Verified green on a clean
`supabase db reset` + `supabase test db`. **Not pushed to hosted `daksha-nirmaan`** —
`supabase migration list` shows all 6 migrations local-only.

## Conservative defaults / surprises

1. **Resolved in review: missing period ⇒ blocked.** Change 17 (cutover) must seed the fiscal
   periods for opening-balance dates before importing.
2. **Test-harness gotcha, not a schema decision, but worth recording:** testing a *successful*
   `SET CONSTRAINTS ALL IMMEDIATE` inside a `DO` block leaves the session in immediate mode for
   the rest of the transaction (PL/pgSQL's exception-handler savepoint only undoes a *failed*
   attempt). The pgTAP file explicitly resets to `SET CONSTRAINTS ALL DEFERRED` right after the
   balanced-insert contrast test so later `journal_lines` inserts in the same test file aren't
   checked mid-statement. Anyone adding more deferred-constraint tests to this file (or a future
   one in the same transaction) needs the same reset after any *non-raising* `SET CONSTRAINTS
   ALL IMMEDIATE` call.
3. **`journal_lines_balanced` fires once per row, not once per statement.** This is the standard
   pattern for row-level deferred constraint triggers and is correct (each firing re-derives the
   same final SUM for the entry), but it does mean an entry with N lines re-runs the aggregate
   query N times at commit — fine at Phase-1 volumes (≤50k lines/year per the spec's own
   indexing note), not revisited here.
