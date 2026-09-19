# Implementation notes — 05 posting-challan-transfer-adjust-dayclose

## What was built

Two migrations, in the order the enum rule requires.

**A. `supabase/migrations/20260918140000_source_type_enum_extensions.sql`** — nothing but
`alter type source_type add value if not exists` for `delivery_challan`, `stock_transfer`,
`quotation`, `day_close`. Its own file because Postgres forbids *using* a new enum value in the
transaction that added it, and the Supabase CLI applies each migration file in its own
transaction. `stock_adjustment` was verified already present from change 01.

**B. `supabase/migrations/20260918140100_posting_challan_transfer_adjust_dayclose.sql`** —

1. **Schema**: `warehouses.is_transit`; `delivery_challans` + `delivery_challan_lines`;
   `sales_invoices.challan_id` and the circular `delivery_challans.invoice_id` FK (added after
   both tables exist); `stock_transfers` + `stock_transfer_lines` (own `draft/in_transit/
   received/cancelled` state machine, `CHECK (from_warehouse_id <> to_warehouse_id)`);
   `stock_adjustments` + `stock_adjustment_lines` (signed qty, `rate NULL` = use average);
   `day_closes`; ten indexes for the query paths these introduce (including the two partial
   indexes change 06's `v_attention` needs for un-invoiced challans and in-transit transfers);
   `touch_updated_at` on the three new document headers.
2. **Seeds**: the hidden `In Transit` warehouse (`is_transit = true`, never default) and three
   `doc_sequences` rows — `DC`, `TR`, `ADJ` for FY 2026-27. **No new accounts**: every
   `system_key` this change needs (`inventory`, `goods_in_transit`, `stock_loss`,
   `cash_over_short`, `cash`, `bank`) was already seeded by change 01, so `00002`'s frozen
   system-key list is untouched by this change.
3. **RLS**: change 01's pattern exactly — members SELECT, both roles INSERT/UPDATE/DELETE while
   `status = 'draft'`, line tables following their header. `day_closes` gets SELECT only: there
   is no draft stage for a cash count, and `post_day_close` is its only writer.
4. **`post_delivery_challan(id)`** — stock OUT of the challan's warehouse at weighted-average
   cost; journal Dr `goods_in_transit` / Cr `inventory`. `DC` series.
5. **`post_sales_invoice`** (change 03's body carried over — it now lives in the internal
   `_post_sales_invoice`, see "Owner decisions applied" below) — challan hook:
   lock + validate the challan, require an exact item/quantity match, write **no** stock
   movement, take COGS from the challan's carried cost and credit `goods_in_transit` instead of
   `inventory`, mark the challan converted.
6. **`post_stock_transfer(id)` / `receive_stock_transfer(id)`** — OUT of source / IN to the
   transit warehouse at the source average, then OUT of transit / IN to destination at the same
   rate. No journal entry in either direction. `TR` series.
7. **`post_stock_adjustment(id)`** — admin only; decreases at the average (Dr `stock_loss` /
   Cr `inventory`), increases at the line rate or the average (Dr `inventory` / Cr `stock_loss`),
   both directions posted gross. `ADJ` series.
8. **`post_day_close(p_date, p_counted, p_note)`** — expected derived from the cash ledger, the
   difference posted to `cash_over_short`, one live close per date.
9. **`cancel_document`** (`CREATE OR REPLACE`, changes 03 + 04's four branches carried over) —
   new `delivery_challan`, `stock_transfer`, `stock_adjustment` and `day_close` branches.

Every function follows changes 03/04 exactly: `v_actor := auth.uid()` inside the function (never
a parameter), `SECURITY DEFINER` + `SET search_path = public, pg_temp`, lock order
document → party → items ascending by id → `doc_sequences`, a missing fiscal period blocked the
same as a locked one, `DN_*` error codes, exactly one `audit_log` row per post/cancel,
`REVOKE … FROM public, anon, service_role` + `GRANT EXECUTE … TO authenticated`.

pgTAP: `supabase/tests/database/00007_posting_challan_transfer_adjust_dayclose.test.sql`,
**194 assertions** (132 for the scope above, + 25 for the owner decisions, + 37 for the review
fixes below), every
`post_*`/`receive`/`cancel` call under `set local role authenticated` with real JWT claims. Both
named acceptance scenarios are covered end to end, plus the whole "Done when" list and a global
sweep asserting no journal entry anywhere in the database is unbalanced or has fewer than two
lines.

`supabase db reset` clean, `supabase test db`: **7 files, 467 tests, all green** (273 from
changes 01–04, including change 04's owner decisions and review fixes, + 194 here). **Not pushed to hosted `daksha-nirmaan`** — `supabase db push` intentionally not
run. `npm run build` does not apply: the Next.js app does not exist until change 07.

## Live verification (beyond pgTAP)

pgTAP runs as `postgres`, which owns every function and bypasses both RLS and GRANT/REVOKE, so
neither of these could be proven there:

- **Grants.** `SET ROLE anon` then calling `post_delivery_challan`, `post_stock_transfer`,
  `receive_stock_transfer`, `post_stock_adjustment`, `post_day_close` and `cancel_document` →
  `permission denied for function …` on all six.
- **The internal function is unreachable.** `_post_sales_invoice`'s ACL is `{postgres=X/postgres}`
  — `SET ROLE anon`, `authenticated` and `service_role` each get `permission denied for function
  _post_sales_invoice`, for both the 2-argument and 3-argument call shapes. `post_cash_sale` is
  `authenticated` only (`anon` and `service_role` denied).
- **Concurrent double-receive.** Two real `psql` sessions against the running container, both
  under `role authenticated` with the same admin claims, on one `in_transit` transfer of 100
  bags. Session A called `receive_stock_transfer` and held its transaction open for 4 s; session
  B blocked on A's `FOR UPDATE` for exactly that 4 s (start 09:49:08.3, error 09:49:12.3), then
  saw A's committed `status = 'received'` and raised `DN_TRANSFER_STATE`. Final state: status
  `received`, 4 stock movements (2 from the post, 2 from the single receive), destination 100
  bags @ 300 = ₹30,000, transit warehouse empty, **0** journal entries for `stock_transfer`.
  The local DB was reset afterwards, so neither fixture is left behind.

## Spec conflicts found

1. **`post_day_close(p_date, p_counted, p_note, p_actor)`** — the older spec text (Schema
   extensions → `day_closes`) still passes an actor parameter. Superseded by the
   pre-implementation audit's "Actor and grants" clarification, which binds every
   `post_*`/`cancel_*` to `auth.uid()` because a caller-supplied uuid lets a `user` act as the
   admin. Implemented as `post_day_close(p_date date, p_counted numeric, p_note text default
   null)` with the actor derived inside, exactly as change 04 did for `bounce_cheque`.
2. **Transit bucket.** The `stock_transfers` paragraph says stock moves into "a per-transfer
   transit bucket"; the later "Transit for transfers" clarification says one seeded system
   warehouse `In Transit` with `warehouses.is_transit`. Implemented the clarification (the
   later, more specific text). A per-transfer bucket would mean a warehouse row per transfer,
   which nothing else in the schema or the UI is built for.
3. **`day_closes.close_date date UNIQUE`** vs "reopening is admin-only and audit-logged."
   A plain UNIQUE makes a date unclosable forever once it has been reopened, unless the reopen
   deletes the row — which would destroy the audit trail the same sentence asks for. Resolved by
   adding `day_closes.status doc_status default 'posted'` (not in the spec's column list) and a
   **partial** unique index `on day_closes (close_date) where status <> 'cancelled'`. A reopen
   sets `status = 'cancelled'`, keeps the row, and frees the date.
4. **"stock IN to `goods_in_transit`"** (proposal scope item 2). `goods_in_transit` is an
   *account*, not a warehouse, and the acceptance scenario is explicit that on-hand "drops once
   (at challan time)" while the invoice adds no movement. So the challan writes exactly one
   stock movement — OUT of the godown — and the value moves Inventory → Goods in Transit in the
   journal only. Putting a movement into a warehouse at challan time would leave that stock
   stranded forever, since the invoice writes no movement to take it out again. The stock
   ledger's total value therefore still reconciles to the Inventory GL balance.
5. **Numbering series.** The spec's "Seed data" requirement freezes seven series for FY 2026-27;
   this change's scope names three more (`DC`, `TR`, `ADJ`). Seeded here, which forces the
   `00003` edit logged below.

## Decisions (conservative defaults taken; each is a judgement, not a spec quote)

1. **`post_delivery_challan` is open to both roles.** The role matrix enumerates what `user` may
   post and a challan is not named — but a challan grants *strictly less* authority than the
   sales invoice the same user is explicitly allowed to post: it recognises no revenue and no
   COGS, moves value between two asset accounts, and is fully reversible while un-invoiced.
   Gating it above the invoice would block counter deliveries for no security gain. Flagged
   below anyway.
2. **`post_day_close` is open to both roles; reopening is admin-only.** The spec singles out
   *reopening* as admin-only, which reads as the close itself being ordinary counter work.
   Reopening goes through `cancel_document`, which is admin-only for every document type, so no
   extra gate was needed.
3. **Transfers (post and receive) are admin-only**, following change 04's precedent for the
   cheque transitions: not in the `user` list, no argument from the sales flow to override it.
   Flagged below.
4. **A challan whose goods have no cost basis is refused (`DN_VALIDATION:zero_cost`)**, as is a
   wholly zero-valued adjustment (`DN_VALIDATION:zero_value`). Both would produce a journal entry
   with zero-amount lines (rejected by `journal_lines`' CHECK anyway) and, for the challan,
   would park nothing in Goods in Transit for the invoice to relieve. Refusing ambiguous input
   beats posting a document that silently means nothing.
5. **A rate on a *decrease* adjustment line raises `DN_VALIDATION:rate_on_decrease`.** The spec
   says shrinkage is valued at the average; a supplied rate is ambiguous input, so it is refused
   rather than silently ignored (change 04 decision #2's philosophy).
6. **A mixed adjustment posts both directions gross** (Dr stock_loss / Cr inventory for the
   decreases *and* Dr inventory / Cr stock_loss for the increases), not one netted pair. It reads
   as what it was, and it handles the net-zero reclassification case that a netted entry cannot
   express at all.
7. **Non-stock items are refused on challans and adjustments** (`DN_VALIDATION:non_stock_line`),
   matching change 04's rule for purchase invoices. Freight and hamali have nothing to deliver
   and no stock to adjust; they belong on the invoice or an expense voucher. Sales invoices keep
   change 03's non-stock path unchanged, and a non-stock invoice line is excluded from the
   challan match precisely so a challan + freight-line invoice still converts cleanly.
8. **Cancelling a converted invoice reopens its challan.** This is the one edit inside a
   pre-existing `cancel_document` branch: the `sales_invoice` branch now locks the challan right
   after the invoice (keeping `post_sales_invoice`'s order: invoice → challan → party → items)
   and sets `invoice_id = NULL` after the reversal. The reversal has already put the cost back
   into Goods in Transit (Dr GIT / Cr COGS), which is exactly the state the challan left behind,
   so the challan is genuinely re-invoiceable. Nothing else in changes 03/04's branches moved.
9. **Transfers cancel from `draft` or `in_transit` only** (`DN_TRANSFER_STATE` otherwise). From
   `draft` nothing has moved, so the cancel is status + audit only. From `in_transit` the
   movements are mirrored (`reversal_of` set) and the goods return to the source godown. Once
   `received` the stock is physically in the destination godown; the correction is a new transfer
   the other way, not a reversal that would silently teleport stock.
10. **`post_stock_transfer` and `receive_stock_transfer` return `void`**, following change 04's
    `mark_cheque_cleared`: there is no `journal_entry_id` to return, and returning the document
    id instead would be a different contract from every other function in the engine. The
    `stock_transfer` branch of `cancel_document` likewise returns NULL.
11. **Reversing a stock adjustment is negative-stock checked** (`DN_NEGATIVE_STOCK`,
    unconditional, no `allow_negative_stock` override) — same rule as cancelling a purchase:
    reversing a found-stock adjustment removes stock that may since have been sold.
12. **`post_stock_transfer` / `post_stock_adjustment` honour `organization.allow_negative_stock`
    without the admin qualifier** that `post_sales_invoice` carries, because both functions are
    already admin-only, so the extra `and v_role = 'admin'` would be dead code.
13. **The transit warehouse can never be named on a document** — challans, adjustments and both
    ends of a transfer raise `DN_VALIDATION:transit_warehouse`. It is a system bucket owned by
    `post_stock_transfer`, not a godown anyone can post to.
14. **`receive_stock_transfer` dates its movements "today" in the org timezone**, not the
    transfer date: the goods arrive when the destination godown says so, which may be days later.
    `post_stock_transfer` uses the transfer date. Both use
    `(now() at time zone organization.timezone)::date`, never `current_date`.
15. **Day-close arithmetic.** `expected = opening_cash + cash_in − cash_out − deposited`, where
    `cash_in` is the day's debits to `cash`, `deposited` is the day's credits to `cash` whose
    entry also debits `bank`, and `cash_out` is every other credit. Deposits are broken out for
    the counter's benefit and subtracted exactly once — `cash_out` excludes them, which is what
    "expected excludes deposits per spec formula" is asserted as in the tests (₹1,200 out, not
    ₹3,200, on a day with a ₹2,000 banking). `expected` is, by construction, the cash ledger's
    closing balance for the day.
16. **A zero difference posts no journal entry** (`day_closes.journal_entry_id` stays NULL). The
    close still exists as the record that the count was done — and a two-line entry of ₹0 is
    impossible under `journal_lines`' CHECK anyway. `cancel_document`'s `day_close` branch
    handles the NULL and returns NULL.
17. **`post_day_close` refuses a future date** (`DN_VALIDATION:future_date`) and a negative count
    (`DN_VALIDATION:invalid_counted`); a same-date race loses on the partial unique index and is
    mapped to `DN_VALIDATION:already_closed` rather than surfacing a raw constraint error
    (change 03's `next_doc_no` pattern).
18. **The challan → invoice match compares aggregated quantities per item**, not line for line,
    and also requires the same party and the same warehouse. Splitting one challan line into two
    invoice lines for the same item is therefore allowed; changing what or how much was delivered
    is not.
19. **Challan lines snapshot `gst_rate` and `discount_pct`** alongside the usual item/HSN/UOM/
    rate columns, even though a challan carries no tax. "Same snapshot shape as sales lines minus
    tax" is the spec wording, and the conversion needs a rate to compute the e-way-bill `value`
    the spec asks the line to carry. Tax *amounts* are not stored.

## Owner decisions applied after the change-04 review (commit `e2dc52e`, spec §"Decisions from change 04 review")

Two of that section's decisions name change 05 as their owner. Both are in
`20260918140100_posting_challan_transfer_adjust_dayclose.sql`. (The other two are change 04's and
were applied in its own migration — cheque banking for `user`, and `expense_vouchers.period_month`.)

### Credit-limit semantics: NULL = unlimited, 0 = no credit

`parties.credit_limit` drops its `NOT NULL` and its `DEFAULT 0`; existing `0` rows migrate to
`NULL` **except** the walk-in party, which keeps `0`. The sales credit check is now
`credit_limit IS NOT NULL AND balance + grand_total > credit_limit`. This closes change 03's
long-standing open question — the one party that should have been strictly cash-only was the only
party that could never trip the check.

- No change-03 test needed editing. `00005`'s credit-limit fixtures set an explicit limit
  (₹50,000), and its other parties relied on `0` meaning "unlimited", which `NULL` now means
  instead — same behaviour, same assertions, all still green.
- The new semantics are asserted in `00007`: a party created without a limit reads `NULL`; the
  walk-in party reads `0`; and an ordinary `post_sales_invoice` to the walk-in party now raises
  `DN_CREDIT_LIMIT`, which is the point of the fix — and exactly the invoice `post_cash_sale`
  then posts.

### `_post_sales_invoice` + `post_cash_sale`

`post_sales_invoice`'s body (with this change's challan hook already in it) moved into
`_post_sales_invoice(p_invoice_id uuid, p_skip_credit bool, p_override_credit bool default false)`,
which gets **no grant to any role** — `REVOKE … FROM public, anon, authenticated, service_role`.
Verified live: its ACL is `{postgres=X/postgres}` and `anon`, `authenticated` and `service_role`
all get `permission denied`. The public `post_sales_invoice(p_invoice_id, p_override_credit)`
keeps change 03's exact signature and is now a two-line wrapper calling it with
`p_skip_credit = false`.

`post_cash_sale(p_invoice_id uuid, p_account_id uuid) RETURNS uuid` — `authenticated`, both roles
(it is the invoice + receipt a `user` may already post separately, and strictly weaker because
the money is collected in full in the same transaction). It validates the money account, posts the
invoice with the credit check skipped, creates a full-amount receipt allocated to that invoice,
posts it, and writes its own `post_cash_sale` audit row on top of the two the inner functions
write. Returns the **invoice's** journal entry id, matching `post_sales_invoice`'s contract.

Conservative calls inside this item, each a judgement:

20. **`p_override_credit` is a third parameter** on the internal function, which the spec's
    two-argument signature does not name. Change 03's admin credit-limit override has to live
    somewhere and is tested; it defaults to `false`, so the specced call shape
    `_post_sales_invoice(id, false)` stays valid.
21. **The money account must be the `cash` or `bank` system account.** Anything else —
    `cheques_in_hand` included — raises `DN_VALIDATION:invalid_account`. When the business opens a
    second bank ledger this check needs an `accounts.is_money` flag rather than a longer list;
    flagged below.
22. **The allocation row is written before `post_payment` runs**, so change 04's cap trigger
    validates it against the just-posted invoice and `post_payment` re-checks the total. Both
    caps therefore apply to the cash-sale path exactly as they do to a hand-entered receipt.
23. **Atomicity is the transaction, not a compensating write.** Both legs are ordinary function
    calls inside one statement, so a failure in the receipt rolls the invoice back with it —
    asserted in `00007` by removing the `RCPT` numbering series so the receipt leg fails *after*
    the invoice has posted: the invoice ends up still `draft`, with no number burned, no journal
    entry, no stock movement and no payment row. This is what supersedes the two-transaction
    `postAndReceiveCash` note in api-architecture (change 07's action becomes a single
    `rpc('post_cash_sale')`).
24. **`post_cash_sale` returns the invoice entry, not the receipt entry**, and writes a third
    audit row rather than suppressing the inner ones — the ledger reads as two documents, because
    it is two documents.

## Files outside this change that were edited (one, forced, logged)

- `supabase/tests/database/00003_review_fixes.test.sql` — change 01's frozen assertion that
  FY 2026-27 has exactly 7 `doc_sequences` rows. This change seeds `DC`, `TR` and `ADJ` (proposal
  scope item 2), so the count moves 7 → 10 and the `set_eq` list gains the three series. Same
  shape of edit, and the same justification, as change 04's `00002` system-key edit: the count is
  a completeness assertion over a seed that a later change was always specced to extend. No other
  line of that file moved.
- `00002_seed_creates_system_keys.test.sql` and `00005_posting_sales.test.sql` also show as
  modified in `git status` — **those are change 04's edits** (33 system keys, the
  `DN_HAS_ALLOCATIONS` fixture amount), logged in change 04's own notes. Change 05 did not touch
  either file, and change 05's own migration adds no new `system_key`.

## Open questions for the owners (not guessed at — these need a decision)

- **Who may post a delivery challan?** Implemented as both roles (decision #1). If the owners
  want goods-out slips to need an admin, it is a one-line change — but it would mean the counter
  cannot dispatch a lorry without one of the family present.
- **Who may move stock between godowns?** `post_stock_transfer` and `receive_stock_transfer` are
  admin-only (decision #3). In practice the godown keeper at the receiving end is the person who
  knows the lorry arrived; if so, `receive_stock_transfer` at least should move to the
  `user`-permitted set.
- **Should a cancelled challan's number be reusable?** It is not: the number is burned like an
  invoice number. Challans are not GST documents in the way invoices are, so the owners may
  prefer gapless challan numbering with reuse. Flagging rather than changing it.
- **How long may a challan stay un-invoiced?** `v_attention` (change 06) will surface challans
  older than 7 days, but nothing *blocks* posting an invoice against a six-month-old challan at
  a cost basis that no longer resembles anything. Worth a policy before change 06.
- **A partial delivery.** One challan must be invoiced in full — the quantities have to match
  exactly (decision #18). If the business regularly delivers 100 bags and invoices 60 now and 40
  later, that needs a partial-conversion design, which is a bigger change than a validation
  tweak.
- Change 03's and change 04's previously-open questions are now **all answered** by the change-04
  review (walk-in `credit_limit`, who may bank a cheque, our own bounced cheque, refunds, salary
  period) — see the "Owner decisions applied" sections in this file and in change 04's notes.

## Fixes from the fresh-context review of this change (verdict: APPROVE AFTER FIXES)

**Blocker — the day-close reversal is dated on `close_date`, not today.** Every other reversal in
this engine is dated today on purpose (the original period may since have been locked). A day
close is the exception: `post_day_close` derives `expected` from the cash ledger *as at*
`close_date`, so a reversal dated later leaves the cancelled over/short entry sitting inside the
very day it cancelled. Reproduced before and after by reverting the one line and re-running
`00007`: re-closing the reopened 16 Jul computed `expected = 2,650` and `difference = 0` — the
recount silently "agreeing" with a figure that included an entry which had been cancelled. With
the fix both entries sit on 16 Jul and cancel exactly, and the re-close reproduces
`expected = 2,600`, `difference = 50`. The period check for the reopen now also tests
`close_date`'s month rather than today's, and `00007` asserts that too.

Also applied: **(2)** a stock-adjustment *increase* valued at zero raises
`DN_VALIDATION:zero_rate` per line — a rate-less line for an item with no stock to average would
otherwise add quantity without value and drag the weighted average down for every later sale.
**(3)** the spec corrections listed below. **(4)** tests for `DN_PERIOD_LOCKED` on all five new
functions (including `receive_stock_transfer`, whose date is *today*, and the day-close reopen,
whose date is the closed day) and for every previously untested `RAISE`: `zero_cost`,
`zero_value`, `non_stock_line`, `no_transit_warehouse`, `challan_not_posted`, `no_lines`
(challan/transfer/adjustment), `missing_account`, `invalid_party`, `invalid_date`. **(6)** a
partial unique index so only one transit warehouse can exist. **(7)** an invoice dated before its
challan raises `DN_VALIDATION:invoice_before_challan` (a dedicated code rather than overloading
`challan_mismatch`, so the UI can say what is actually wrong). **(8)** `CHECK (qty > 0)` on
`delivery_challan_lines` and `CHECK (counted >= 0)` on `day_closes`, both tested at the table.
**(10)** `post_day_close` keeps returning the journal entry id (NULL when the difference is zero),
matching every other posting function's contract; the `day_closes` row is found by `close_date`,
which is unique among live closes. Documented rather than changed. **(11)** the stock-vs-GL
invariant, in the form that is actually true under this design — see the disagreement below.
Finding 9 was accepted as-is and is documented.

### Where I did not do what the review asked, and why

- **The invariant "Σ `stock_movements.value` = Inventory GL + Goods-in-Transit GL" does not hold
  here, and should not.** It belongs to a design where a challan moves stock *into* a transit
  warehouse. This change deliberately does not (decision #4): the invoice writes no stock
  movement, so goods parked in a transit warehouse could never leave it. `00007` asserts the
  stronger true pair instead — **A.** post-opening movement value equals the Inventory GL
  balance, and **B.** Goods in Transit holds exactly the cost of posted, un-invoiced challans and
  nothing else. Together they say no rupee of stock value is lost or invented anywhere in the
  challan → invoice → cancel → transfer → adjust → cash-sale flows.
- **`DN_VALIDATION:invalid_qty` on a challan line is now unreachable** by design: finding 8's
  `CHECK (qty > 0)` rejects the row at the table, before any function sees it. The guard stays in
  `post_delivery_challan` as defence in depth; the test asserts the constraint instead.

## Owner decisions recorded (Ratna, 2026-09-19)

- **`post_delivery_challan` stays open to `user`**, confirming decision #1. Added to the spec's
  role matrix with the reasoning, so the next reviewer does not re-open it.
- **Day closes may be made out of order**, and a closed day may be reopened and re-closed. The
  stored `opening_cash`/`cash_in`/`cash_out`/`deposited`/`expected` are therefore **informational
  snapshots** of what the ledger said at the moment of the close — the ledger is the truth, and a
  back-dated entry can leave an older close's stored numbers stale. Written into the spec's
  `day_closes` paragraph; reports must read the ledger, never these columns.
- **Table grants tightened** (this change's migration): `anon` now holds no privilege on any table
  in `public`, and `ALTER DEFAULT PRIVILEGES` keeps that true for tables created later;
  `authenticated` *and* `service_role` lost INSERT/UPDATE/DELETE on `journal_entries`,
  `journal_lines`, `stock_movements` and `audit_log`. The posting functions are `SECURITY DEFINER`
  and are unaffected. No test relied on direct ledger writes — `00004`'s immutability tests run as
  `postgres`, which is the table owner — so nothing had to be rewritten, and `00007` now asserts
  the denials under real roles.
- The `accounts.is_money` flag (change 04, finding M4) also answers this change's own open
  question about a second bank ledger, which is removed from the list below.

## Open questions the reviewers raised and I did not close

- **An un-invoiced challan can be double-counted against stock.** Nothing stops a second challan,
  or an ordinary sales invoice with no `challan_id`, from being posted for goods that have
  already physically left on an earlier challan — each decrements on-hand again. The stock ledger
  is right about what is in the godown either way, but the operator gets no warning. A warning in
  change 06's `v_attention` (challans out > 7 days already surfaces there) is probably the right
  home; a hard block is not, because part-loads do happen.
- **No credit check at challan time.** `post_delivery_challan` does not test the party's credit
  limit — goods can leave on a challan for a customer who would be refused at invoice time, and
  the block then lands after the lorry has gone. Whether the check belongs at challan time is a
  business call, not a technical one.

## Next step

Fresh-context review (`daksh-review`), then the Fable milestone review brief: the posting engine
(changes 03–05) is complete.
