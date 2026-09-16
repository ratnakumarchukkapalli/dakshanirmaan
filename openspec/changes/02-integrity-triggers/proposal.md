Skill: daksh-schema
Spec section: openspec/specs/db-architecture/spec.md → "## Requirement: Integrity triggers"
Context: Change 01 created the ledger core (`journal_entries`, `journal_lines`, `stock_movements`) with no triggers on it — RLS denies direct writes to any app role, but nothing yet enforces the invariants that keep the books honest even for the `SECURITY DEFINER` `post_*` functions arriving in change 03+. This change adds those four DB-level guarantees so a bug in a future posting function can't silently corrupt the ledger. It matters because everything downstream (posting engine, reports, GST filings) assumes these invariants hold unconditionally.
Do not: read other specs; write business math in TS; touch journal tables directly; implement item 4 ("No negative stock") — the spec places that check inside the `post_*` functions themselves, not a trigger, so it belongs to change 03+ (posting-sales), not here.

## Scope

Four triggers from the "Integrity triggers" requirement (items 1, 2, 3, 5 — item 4 is explicitly not a trigger, see Do-not above):
1. **Balanced entries** — deferred constraint trigger on `journal_lines`.
2. **Immutability** — `journal_entries` (UPDATE restricted to the one-time `reversed_by` transition; DELETE always rejected), `journal_lines` and `stock_movements` (UPDATE and DELETE always rejected).
3. **Period lock** — `journal_entries` and `stock_movements` INSERT rejected when the row's date falls in a locked `fiscal_periods` month.
4. **Leaf-only postings** — `journal_lines` INSERT rejected when `accounts.is_group` is true for the referenced account.

## Done when

- pgTAP: "unbalanced insert raises" — a `journal_lines` insert whose entry doesn't sum to zero net raises once the deferred constraint is checked (`SET CONSTRAINTS ALL IMMEDIATE`).
- pgTAP: "UPDATE on posted line raises" — `UPDATE journal_lines` on an existing (posted) row raises.
- pgTAP: "locked period raises" — `INSERT` into `journal_entries` or `stock_movements` dated inside a locked `fiscal_periods` month raises.
- Also covered (same requirement section, not calling out separately in the brief but needed for real coverage): DELETE on `journal_lines`/`journal_entries`/`stock_movements` raises; UPDATE on `journal_entries` unrelated to `reversed_by` raises; setting `reversed_by` from NULL once succeeds and a second time raises; UPDATE/DELETE on `stock_movements` raises; leaf-only rejects a group-account posting and accepts a leaf-account one; an unlocked-period insert succeeds (contrast).
- `supabase db reset` clean, `supabase test db` all green (change 01's 3 files + this change's new file).
- Hard rules hold: no floats, parameterized SQL (triggers use bound `NEW`/`OLD`, no string concatenation), ledger tables stay writer-agnostic (functions still SECURITY DEFINER-only, unaffected by this change).
- Migration has **not** been pushed to the hosted `daksha-nirmaan` project — local verification only.
