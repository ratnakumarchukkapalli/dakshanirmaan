# Implementation notes — 03 posting-sales

## The arc (read this first — it explains why the migration looks the way it does)

1. **First implementation** (Sonnet): `next_doc_no`, `post_sales_invoice`, `cancel_document`
   (sales_invoice only), `stock_on_hand`, `p_actor uuid` passed as a parameter to every function,
   per the spec as it read at the time. 32 pgTAP assertions, all green locally.
2. **Fresh review** (Opus, `daksh-review` skill, no shared context with the implementer):
   **REJECT**. Two proven, live-reproduced findings — `anon` had `EXECUTE` on every posting
   function via Postgres/Supabase default grants and could post an invoice directly; any
   authenticated session could pass a different `p_actor` and cancel a document as the admin,
   with `audit_log` recording the impersonated actor. Plus a proven TOCTOU race: two concurrent
   posts of the same item could both pass the on-hand check and drive stock negative, because the
   only lock (`doc_sequences FOR UPDATE`) was acquired after the stock read.
3. **Fixes applied**, verified live against the running DB (not just pgTAP, which runs as
   `postgres` and never exercises real grants): `REVOKE`/`GRANT` closing `anon`; an
   `auth.uid()`-vs-`p_actor` binding check; the `doc_sequences` lock moved earlier. Re-check:
   **APPROVE AFTER FIXES** (only documentation-sync items outstanding).
4. **Mid-session discovery**: a *separate*, concurrent Claude Code session (the user's own,
   running Fable) had been auditing changes 03–18 against the spec in parallel, and committed two
   commits directly to `main` — `fdec371` "Pre-implementation audit" and `b04c889` "System-design
   audit" — that rewrote `db-architecture/spec.md`'s posting-engine contract. Its `git add`/commit
   also swept up this session's own uncommitted change-03 files, including the **pre-fix** draft
   from step 1 (the one step 2 rejected), which is why `main`'s history contains a vulnerable
   version of this migration that this session never intended to commit. Flagged to the user;
   directed to redo against the new spec rather than reconcile the old one.
5. **Full rebuild** against the audited spec: actor is now `auth.uid()` derived *inside* every
   function — never a parameter at all, which is a strictly stronger fix than step 3's binding
   check (there is no parameter left to bind). Added the audit's lock-ordering protocol,
   credit-limit enforcement, non-stock items, `warehouse_id` on documents, IST-aware dates, and
   locked down every function from changes 01–02 that had never had its grants reviewed. Both of
   the review's original critical findings were re-verified live against this rewritten version.
6. **Second fresh review of the rebuild** (same reviewer, new context): **APPROVE AFTER FIXES**.
   It independently re-verified both original exploits closed and the new lock protocol correct
   (including proving, with a discriminating `NOWAIT` probe across three concurrent sessions,
   that item locks are acquired in ascending-id order and not merely returned in that order — see
   "Live verification"). Two required fixes: a named README deliverable
   (`organization.allow_negative_stock`) had been silently dropped rather than logged as a
   decision; `cancel_document` didn't follow the lock-ordering protocol this change introduces,
   which change 04 inherits by extending this same function. Plus one strongly-recommended fix
   (a `service_role` grant on `post_sales_invoice`/`cancel_document` that can never succeed, since
   `auth.uid()` is NULL under that key) and three low-severity ones, all applied — see "Round 2
   fixes" below.

## What was built

One migration, `supabase/migrations/20260916110000_posting_sales.sql`. In order:

1. **Function exposure lockdown**: `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON
   FUNCTIONS FROM public`, plus explicit `REVOKE`/`GRANT` on every function created by changes
   01–02 that never had one. Trigger functions (`touch_updated_at`, the seven change-02 checks)
   get no grant to any role — verified live that revoking `authenticated` too doesn't stop a
   normal `UPDATE` from firing a trigger; the mechanism doesn't check the DML role's function
   privileges. `is_active_member`/`current_app_role` keep `authenticated` — verified live that
   *removing* it breaks every RLS-gated read for a real session, since these are called directly
   inside `USING()` policy expressions, unlike a trigger invocation.
2. **`audit_log`** gets the same `reject_mutation` insert-only trigger as the ledger tables — it
   was previously insert-only by omission (no INSERT/UPDATE/DELETE policy for any role), not by a
   DB-level guarantee that survives a `SECURITY DEFINER` bug.
3. **Schema additions**: `organization.timezone` (`Asia/Kolkata` default), `items.is_stock`,
   `parties.is_walk_in` + one seeded walk-in party, `warehouse_id` on `sales_invoices` and
   `purchase_invoices` (`NOT NULL`, no DB default — see decision #1), `stock_movements.reversal_of`,
   `sales_invoice_lines.taxable_value DEFAULT 0`, a partial unique index enforcing exactly one
   default warehouse, and `system_key` retroactively assigned to 7 accounts.
4. **`stock_on_hand`** — unchanged logic, now `SECURITY INVOKER`.
5. **`next_doc_no`** — row-locked per `(series, fy_label)`; auto-creates the next FY's row for an
   existing series (inherits `doc_type` from that series' most recent row), so 1 April needs no
   manual numbering seed. No grant to any role.
6. **`post_sales_invoice(p_invoice_id uuid, p_override_credit bool DEFAULT false)`** — no
   `p_actor`; `v_actor := auth.uid()`, `DN_FORBIDDEN` if null. Lock order: document → party
   (`FOR UPDATE`, also source of the `is_active`/`type`/`credit_limit` checks) → every distinct
   item on the invoice, locked one at a time in ascending-id order via a `FOREACH` loop (**not** a
   single `SELECT ... ORDER BY id FOR UPDATE`: Postgres does not guarantee a query's `ORDER BY`
   matches its lock *acquisition* order, only its result order — ORDER BY sits above the LockRows
   node in the plan; a loop of individual statements is what actually guarantees acquisition
   order, which is the entire point of a deadlock-avoidance protocol) → `doc_sequences` (inside
   `next_doc_no`, last, once the invoice's own money is fully known). Per line: recompute
   taxable/tax from `qty/rate/discount_pct/gst_rate` (overwrites the line's own stored amounts —
   never trusts client math); non-stock lines (`is_stock = false`) credit `freight_recovered` and
   write no `stock_movements` row; stock lines route by `items.category` and value OUT at the
   on-hand weighted average (item already locked, so this is race-free). After the loop: round-off
   (±₹0.50 sanity, `DN_UNBALANCED`), then credit-limit check against net AR balance
   (`Σdebit − Σcredit` on `ar` control lines for the party) — `DN_CREDIT_LIMIT` unless
   `p_override_credit` and the actor is admin, in which case `audit_log.after.override = true`.
7. **`cancel_document(p_source_type, p_source_id, p_reason text)`** — no `p_actor`; same
   `auth.uid()` binding, admin-only. `sales_invoice` branch: `DN_NOT_POSTED` if not posted (covers
   both "already cancelled" and "never posted"), `DN_HAS_ALLOCATIONS` if any `payment_allocations`
   row references it, `DN_PERIOD_LOCKED` if *today's* (IST) fiscal period is locked. Mirrors every
   journal line (debit/credit swapped) and every un-reversed stock movement
   (`WHERE reversal_of IS NULL`, so a reversal can never itself be picked up and re-reversed),
   dates the reversal `(now() AT TIME ZONE organization.timezone)::date` — never `current_date`,
   per the audit's time-zone rule — sets `reversed_by` on the original entry (the one-time
   exception change 02's immutability trigger allows).

pgTAP: `supabase/tests/database/00005_posting_sales.test.sql`, 66 assertions. Every
`post_sales_invoice`/`cancel_document` call runs under `SET LOCAL ROLE authenticated` with real
JWT claims (`set local request.jwt.claims`), not as `postgres` — necessary now that there's no
`p_actor` to pass directly, and a side benefit is that every "happy path" assertion doubles as
proof a genuine session can use these functions (both `admin` and plain `user`), closing the
"permit path untested" gap the reviewer flagged in the earlier draft. Temp-table fixtures read
inside a role-switched block need `GRANT SELECT ... TO authenticated` first (matches the pattern
already in `00003_review_fixes.test.sql`) — a session-role switch does not carry the querying
session's own implicit access to `postgres`-owned temp tables.

Also touched: `00002_seed_creates_system_keys.test.sql` (count 25 → 32, see decision #6) and
`00003_review_fixes.test.sql` (its fixture invoice needed `warehouse_id` once that column became
`NOT NULL`) — both are change 01's frozen files, both edits are load-bearing consequences of this
change's schema additions, not scope creep.

`supabase db reset` + `supabase test db`: all 5 files, **95 tests, green**. **Not pushed to
hosted `daksha-nirmaan`** — local verification only, `supabase db push` intentionally not run.

No `npm run build` gate yet — the Next.js app doesn't exist until change 07.

## Live verification (beyond pgTAP)

pgTAP runs every statement as `postgres`, which owns every function and table and therefore
bypasses both RLS and `GRANT`/`REVOKE` — it cannot prove `anon` is actually blocked or that a
concurrency fix actually holds under real overlapping transactions. Both were reproduced directly
against the running local Postgres container:

- `SET ROLE anon; SELECT post_sales_invoice(gen_random_uuid());` → `permission denied for
  function post_sales_invoice`.
- Two concurrent `psql` sessions, one item with 100 on hand, both invoices selling all 100:
  session B blocked ~2.4s on session A's item-row lock, then correctly saw A's committed
  depletion and raised `DN_NEGATIVE_STOCK` — final on-hand qty `0`, not `-100`.
- The reviewer independently re-ran the same scenario and additionally proved lock *acquisition*
  order (not just result order) is ascending-by-item-id: a three-session probe held `FOR UPDATE`
  on the low-id item, posted an invoice whose *line order* put the high-id item first, then
  confirmed via a third session's `FOR UPDATE NOWAIT` that the high-id item was still unlocked
  while the function was blocked — only possible if locking follows item id, not line order.
- `service_role` confirmed dead for `post_sales_invoice`/`cancel_document`: under
  `SET ROLE service_role` with service-role JWT claims, `auth.uid()` is `NULL` → `DN_FORBIDDEN`.
  Grant dropped (decision below).

## Decisions (surprises, per project.md §Build process)

1. **`warehouse_id` has no DB-level default, despite the spec saying "default = the default
   warehouse."** Tried `DEFAULT (SELECT id FROM warehouses WHERE is_default LIMIT 1)` on the
   column — Postgres rejects a bare subquery in a column `DEFAULT` expression outright
   (`cannot use subquery in DEFAULT expression`, verified live). The spec's own wording — "set by
   the action" — reads as application-layer responsibility (change 10's draft-creation server
   action), not a DB default, so this isn't a workaround, it's the literal reading. Every fixture
   in this change's own tests supplies `warehouse_id` explicitly, same as the app will.
2. **`system_key` retrofit — reversed a decision, then reversed it back.** The first fix pass
   (post-review) tried assigning `system_key` to the three sales accounts and hit change 01's
   frozen `00002` test (`exactly 25` via `set_eq`), so it reverted to a `code`-based lookup +
   NULL-check instead. The audited spec then *explicitly* directs the same retrofit ("Add
   `system_key` to seeded accounts via `UPDATE accounts SET system_key = …` in change 03's
   migration"), naming 7 accounts, not 3. Since this is now spec-directed rather than a
   convenience shortcut, `00002`'s frozen count was updated to 32 — a deliberate, spec-authorized
   change to another change's acceptance criteria, not the accidental break the first attempt
   would have been.
3. **The `challan_id` hook the audit assigns to "change 03" was not implemented.** The audit's
   "Challan → invoice" clarification says `sales_invoices.challan_id uuid NULL REFERENCES
   delivery_challans` and a conditional COGS path belong to "change 05 + 03 hook." `delivery_challans`
   doesn't exist — it's created by change 05, which hasn't run. A `REFERENCES` to a table that
   doesn't exist is impossible, and coding the conditional branch against a column that can't
   exist yet would be dead code with no way to verify it. Left for change 05, which is where the
   table and the column can land together and actually be tested.
4. **`ensure_fiscal_year(p_label text)` was not implemented.** Named in the system-design audit's
   "Fiscal-year rollover" note, but not listed in the README's enumeration of what change 03
   specifically owns (which names lock order, default-privileges revoke, `audit_log` immutability,
   and `organization.timezone` as this change's additions — no `ensure_fiscal_year`). `next_doc_no`
   auto-creating its own row *is* in that list and is implemented. Left the periods-admin function
   for whichever change ends up owning fiscal-period administration.
5. **Credit-limit "current AR balance" reads `journal_lines` directly, not a view**, since
   `v_party_balances`/`v_party_aging` don't exist until change 06. `SUM(debit) − SUM(credit)` on
   the party's `ar`-control-account lines, read after the party row is already locked (lock order
   step 2), so two concurrent invoices to the same party can't both read a stale balance and both
   pass the check.
6. **`doc_sequences`' unique-row race on FY rollover: resolved in round 2, not accepted as-is.**
   First pass accepted the raw `unique_violation` a rollover-instant race would surface (correct
   on the safety axis — no duplicate number, no silently wrong one — but an unmapped error for
   change 07's envelope on the predictable morning of 1 April). `next_doc_no`'s auto-create branch
   now catches `unique_violation` in a nested block and falls back to the normal
   `SELECT ... FOR UPDATE` + increment path, so the loser gets a real document number instead of a
   raw constraint error.

## Round 2: fixes from the rebuild's own review (same reviewer, APPROVE AFTER FIXES)

7. **`organization.allow_negative_stock` — implemented, not just logged.** Named verbatim in
   `openspec/changes/README.md`'s change-03 row and specced at `db-architecture/spec.md`'s COGS
   clarification, but had been silently dropped rather than deferred-with-reasoning like decisions
   #3/#4 above. The everyday case it exists for — stock physically arriving before its purchase
   bill is entered — would otherwise hard-block a counter sale with no admin escape hatch. Column
   added (default `false`); `post_sales_invoice`'s negative-stock guard is now
   `if v_onhand_qty - v_line.qty < 0 and not (v_allow_negative and v_role = 'admin')`.
8. **`cancel_document`'s sales_invoice branch now follows the same lock order** `post_sales_invoice`
   introduced (document → party → items ascending-id), added right after the `DN_NOT_POSTED`
   check and before `DN_HAS_ALLOCATIONS`/`DN_PERIOD_LOCKED`. It didn't need this for correctness
   *today* (a sales reversal only adds stock back and only reduces AR exposure, both safe
   directions), but change 04 extends this exact function with a `purchase_invoice` branch via an
   `IF`, per this function's own header comment — and cancelling a purchase whose stock has since
   been sold *does* need to decrement stock safely under concurrency. Fixing the protocol now,
   while it's fresh, means change 04 inherits a body that already knows how to lock, instead of
   re-discovering the exact race that got this change rejected in round one.
9. **`service_role` grant dropped from `post_sales_invoice`/`cancel_document`** (kept on
   `stock_on_hand`, a legitimate trusted-read path with no actor derivation to fail). Verified live
   that a service-role session's `auth.uid()` is `NULL`, so the grant was a dead path that would
   fail every call with an opaque `DN_FORBIDDEN` — indistinguishable from a real auth bug to
   whoever hits it first in change 07/08. Documented in the `daksh-api` skill: every RPC call to
   these functions must use the user-scoped client, never the service-role client.
10. **Missing fiscal period now blocks, in both functions, matching change 02's trigger.** The
    period pre-checks previously tested `AND is_locked` only; a month with no `fiscal_periods` row
    at all (the exact state every month is in before someone runs the not-yet-built
    `ensure_fiscal_year`, decision #4) silently passed the pre-check and fell through to the
    trigger's own unmapped message. Both pre-checks now read `is_locked` into a variable and
    `raise DN_PERIOD_LOCKED` on `coalesce(v_period_locked, true)` — missing is blocked, same as
    locked.

## Open question for the owners (not fixed — needs a decision, not a guess)

- **The walk-in customer (`is_walk_in = true`) has an unlimited credit limit.** The spec seeds it
  with `credit_limit = 0`, and the credit-limit check only fires when `credit_limit > 0` — so `0`
  means "unlimited" everywhere else in the schema, but the one party that should be strictly
  cash-only is the only party that can never trip the check. Two ways to resolve it: make `NULL`
  mean unlimited and `0` mean "never extend credit," or special-case `is_walk_in` in the check
  directly. Flagging rather than picking one, since change 07's billing screen will be built
  assuming whichever semantics land here.
