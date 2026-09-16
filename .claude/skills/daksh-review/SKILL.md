---
name: daksh-review
description: Review protocol for Daksha Nirmaan changes. Load whenever asked to review, check, audit, or sign off a change (migration, posting function, server action, screen) before commit or before `supabase db push`. Encodes the judgment rules Fable applied in the first reviews so Sonnet/Opus reviewers reach the same verdicts. Trigger on "review", "check change", "sign off", "is this safe", "before push", "audit".
---

# Daksha Nirmaan — Reviewing a change

You are a **fresh** reviewer: you did not write this change. Read the change's `proposal.md`, `implementation-notes.md`, the diff, and the one spec section the proposal names. Nothing else unless a finding requires it.

## The one question
**Can this change let a wrong number into the books, or let the wrong person in?** Everything below serves that. The family keeps its own books with no accountant behind them, so the database must make wrong entries *impossible*, not merely reversible.

## Judgment rules (apply these; do not re-derive)
1. **Ambiguity resolves toward blocking.** If the spec is silent on an edge (missing period row, missing party, unknown series, zero lines), the correct default is RAISE, never "allow". A blocked valid action costs a minute; an allowed invalid one corrupts history.
2. **A conservative default in `implementation-notes.md` is a review item, not a done item.** Each one gets a verdict: accept, or turn into a fix now. Never leave one "for a later change" if it touches ledger tables, RLS, or numbering.
3. **Spec gaps are bugs of the spec.** When the implementer worked around a contradiction (e.g. two series on one enum key), fix the spec in the same commit so the next change inherits the truth.
4. **Every invariant gets a trigger or a CHECK, and a pgTAP test that proves the raise.** "The function will validate it" is not enough; the function can be bypassed by the next function.
5. **Immutability is absolute.** No UPDATE/DELETE path on `journal_entries`, `journal_lines`, `stock_movements` except the single documented `reversed_by` transition.
6. **Money never floats.** NUMERIC only; TS carries money as strings; no `parseFloat`, no arithmetic in TS beyond display previews.
7. **Numbers are assigned inside the posting function under a row lock,** never in TS, never at draft time. Cancelled numbers are kept.
8. **Roles are enforced twice** (server action and DB function). A gate present in only one place is a finding.
9. **RLS on every new table; no grants to `anon`/`authenticated` on ledger tables.** Views that expose P&L/BS are admin-only.
10. **Snapshots on document lines** (item name, HSN, UOM, rate, tax) must be written at post time and never re-joined for posted documents.
11. **Concurrency:** drafts carry `updated_at` and stale writes are rejected; two simultaneous posts cannot produce duplicate or gapped numbers.
12. **Secrets:** service-role key never in client code or `NEXT_PUBLIC_*`; no `.env` committed.

## Checklist by change type
- **Migration:** types per skill; RLS enabled; policies match the role matrix; indexes for new query paths; seed idempotent; `SET search_path = public, pg_temp` on every SECURITY DEFINER function; no `ALTER TYPE ADD VALUE` used in the same transaction it is created in.
- **Posting function:** one transaction; validates `status = 'draft'`; recomputes tax from snapshots and place of supply (client totals ignored); Σdebit = Σcredit by construction; stock never negative unless admin override flag; audit row written; idempotent on non-draft (`DN_NOT_DRAFT`); every RAISE uses a `DN_*` prefix the API maps.
- **Server action:** zod schema from `src/schemas/`; role check; `.rpc` for post/cancel; envelope with mapped codes; `revalidatePath`; a test for happy path, `forbidden`, and one `DN_*` mapping.
- **Screen:** matches prototype in both themes and at 390 px; tokens only; strings through i18n; numeric columns `tabular-nums` and right-aligned; ledger rows Enter-activatable; no business math beyond preview.

## Output format
Findings first, most severe first, each as: file:line · what is wrong · concrete failure scenario · fix. Then the list of conservative defaults with your verdict on each. End with exactly one of: **APPROVE**, **APPROVE AFTER FIXES (listed)**, **REJECT (reason)**. Never approve with open findings on rules 1–8.

## Escalation
Escalate to Fable (owner-approved, budget-limited) only for: a spec contradiction you cannot resolve from these rules; anything in `post_*`/`cancel_*` math you are not certain about; a security finding involving keys, RLS bypass, or auth. Everything else you decide.
