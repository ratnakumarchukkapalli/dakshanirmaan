# Implementation notes — 04 posting-purchase-payment

## What was built

One migration, `supabase/migrations/20260918120000_posting_purchase_payment.sql`, in this order:

1. **Schema extensions** — `cheque_status` enum; the six `payments` columns the spec names
   (`cheque_status`, `cheque_bank`, `deposited_on`, `cleared_on`, `bounced_on`,
   `bounce_reversal_entry_id`); four `expense_vouchers` columns (`voucher_type`,
   `pay_account_id`, `advance_recovered`, `purchase_invoice_id` — see decision #3); account
   `1130 Cheques in Hand` with `system_key = 'cheques_in_hand'`; two indexes
   (`payment_allocations(payment_id)` for the per-payment cap sum, and a partial
   `journal_entries(source_id) WHERE source_type = 'payment'` for the bounce/cancel entry lookup).
2. **`check_payment_allocation()` trigger** on `payment_allocations` (BEFORE INSERT OR UPDATE) —
   amount > 0, `invoice_type ∈ (sales_invoice, purchase_invoice)`, direction must match
   `payments.direction`, Σ per payment ≤ `payments.amount`, each allocation ≤ that invoice's open
   amount (`grand_total − prior allocations − posted credit/debit notes against it`), and the
   invoice must be posted. Plus the three RLS write policies the app needs (decision #4).
3. **`post_purchase_invoice(p_invoice_id uuid)`** — Dr Inventory (taxable, or taxable + tax when
   `itc_eligible = false`), Dr input CGST/SGST or IGST when eligible, round-off on the debit side,
   Cr AP(party) grand total; stock IN at landed cost, weighted average derived from movements
   after the item lock. Numbering from the `PB` series.
4. **`post_payment(p_payment_id uuid)`** — receipt: Dr cash/bank (or Cheques in Hand when
   `mode = 'cheque'`) + Dr `discount_allowed`, Cr AR(party) `amount + discount`. Payment:
   Dr AP(party) `amount + discount`, Cr `discount_received`, Cr the money ledger. Cheque receipt
   lands at `cheque_status = 'in_hand'`, cheque payment at `'issued'`. `RCPT`/`PAY` series.
5. **`post_expense_voucher(p_voucher_id uuid)`** — generic expense, employee advance, salary with
   advance recovery, named daily wages through `salary_payable`, unnamed hamali with no party,
   and RCM freight lines. `EXP` series.
6. **Cheque lifecycle** — `deposit_cheque(id)` (Dr bank / Cr cheques_in_hand), `mark_cheque_cleared(id)`
   (status only, `returns void`), `bounce_cheque(id, p_reason)` (one reversal entry mirroring every
   un-reversed entry of the receipt, allocations deleted, `bounce_reversal_entry_id` set). Invalid
   transitions raise `DN_CHEQUE_STATE`.
7. **`cancel_document` extended** by `CREATE OR REPLACE` on the same signature — change 03's
   `sales_invoice` branch carried over verbatim, plus `purchase_invoice` (with
   `DN_HAS_ALLOCATIONS` and `DN_NEGATIVE_STOCK`), `payment` (allocations deleted, cheque-state
   guard) and `expense_voucher` branches.

Every function follows change 03 exactly: `v_actor := auth.uid()` inside the function (never a
parameter), `SECURITY DEFINER` + `SET search_path = public, pg_temp`, lock order
document → party → items ascending by id → `doc_sequences`, a missing fiscal period blocked the
same as a locked one, `DN_*` error codes, exactly one `audit_log` row, `REVOKE … FROM public, anon,
service_role` + `GRANT EXECUTE … TO authenticated`.

pgTAP: `supabase/tests/database/00006_posting_purchase_payment.test.sql`, **177 assertions**
(141 as first written, + 5 for the owner decisions, + 31 for the review fixes below), every
`post_*`/`cancel_*`/cheque call under `set local role authenticated` with real JWT claims. Includes
the acceptance scenario "cheque bounce re-opens the invoices" end to end, and a global sweep
asserting no journal entry anywhere in the database is unbalanced.

`supabase db reset` clean, `supabase test db`: **6 files, 236 tests, all green** (95 from changes
01–03 + 141 new) when this change was written; **467 tests across 7 files** once change 05, the
owner decisions and the review fixes below landed. **Not pushed to hosted `daksha-nirmaan`** — `supabase db push`
intentionally not run. `npm run build` does not apply: the Next.js app does not exist until
change 07.

## Live verification (beyond pgTAP)

- `SET ROLE anon` then calling each of `post_purchase_invoice`, `post_payment`,
  `post_expense_voucher`, `deposit_cheque`, `mark_cheque_cleared`, `bounce_cheque` and
  `check_payment_allocation` → `permission denied for function …` on all seven.
- **Concurrent double-post of the same payment**, two real `psql` sessions against the running
  container, both under `role authenticated` with the same admin claims: session A posted and held
  its transaction open; session B blocked on A's `FOR UPDATE` on the `payments` row, then saw A's
  committed `status = 'posted'` and raised `DN_NOT_DRAFT`. Final state: one journal entry, one
  voucher number (`RCPT/26-27/0001`), status `posted`. The local DB was reset afterwards so this
  fixture is not left behind.

## Spec conflicts found

1. **`bounce_cheque(p_payment_id, p_actor)`** — the older spec text (Schema extensions → payments)
   still passes an actor parameter. Superseded by the pre-implementation audit's "Actor and grants"
   clarification, which binds *every* `post_*`/`cancel_*` to `auth.uid()` because a caller-supplied
   uuid lets a `user` act as the admin. Implemented as `bounce_cheque(p_payment_id uuid,
   p_reason text)` with the actor derived inside. Same reasoning applies to `deposit_cheque` and
   `mark_cheque_cleared`, which the spec never gave signatures for.
2. **`service_role` grant.** The proposal's scope item 7 says the cheque transitions and `post_*`
   should be granted to `authenticated` **+ `service_role`**. Not done — change 03 verified live
   that `auth.uid()` is `NULL` under a service-role session, so the grant is a dead path that fails
   every call with an opaque `DN_FORBIDDEN`. Followed change 03's decision #9 (the later, verified
   one) rather than the proposal's wording. `stock_on_hand` keeps its `service_role` grant.
3. **`system_key` count.** Change 01's frozen `00002_seed_creates_system_keys.test.sql` asserted
   exactly 32 keys; adding `cheques_in_hand` moves it to 33. Change 01's own seed comment already
   records that this one key was deliberately deferred to change 04, and the "Payments: discount
   and cheques" clarification explicitly assigns it here ("add system_key + account 1130 in change
   04"), so the edit is the planned completion of that deferral. Count, list and comment updated.

## Decisions (conservative defaults taken; each one is a judgement, not a spec quote)

1. **Purchase tax split follows the *supplier's* state, not the header's `place_of_supply`.**
   On an inward bill the place of supply is our own state in both the intra- and the inter-state
   case, so it cannot distinguish CGST+SGST from IGST; the supplier's state can. The Tax
   clarification's own wording is "party/place-of-supply state = org state", which permits this
   reading. `post_sales_invoice` is untouched and still uses `place_of_supply`.
2. **A non-stock item on a purchase invoice raises `DN_VALIDATION:non_stock_line`.** The RCM
   freight clarification is explicit that inward services are a linked expense voucher, not a
   purchase-invoice line. Silently capitalising a service into Inventory would corrupt every
   later weighted average, so refusing is the conservative option. (Sales invoices keep change
   03's non-stock path unchanged.)
3. **`expense_vouchers` needed four new columns to express the specced journal shapes.** The base
   table had no way to say what kind of voucher it is, which ledger pays it, or how much advance
   to recover — but "Salaries, advances, wages" requires four different entry shapes from that one
   table. Added `voucher_type` (`expense`/`advance`/`salary`/`wages`, default `expense`),
   `pay_account_id` (NULL resolves to the `cash` system account at posting time),
   `advance_recovered` (NULL = recover the maximum, i.e. `min(advance balance, gross)`; a value
   above that maximum raises `DN_VALIDATION:recovery_exceeds_advance`), and the spec-named
   `purchase_invoice_id`. Gross is always Σ of the voucher's own lines, so the line table stays
   the source of truth.
4. **`payment_allocations` got INSERT/UPDATE/DELETE RLS policies.** Change 01 left the table
   SELECT-only on the assumption that `post_payment` would write the rows. It does not — which
   invoices a receipt settles is the operator's choice (change 12's AllocationGrid), made before
   posting. Without a write policy nothing but a definer function could ever allocate, and there
   is no such function. Policies allow active members to write allocations for any payment that
   is not `cancelled` (not just drafts), because an allocation never moves money — it only points
   at which invoice a party's payment settles — and `DN_HAS_ALLOCATIONS`'s stated remedy ("the
   receipt must be re-allocated or reversed first") presumes re-allocation after posting. Both
   caps are enforced by the trigger regardless of who writes the row.
5. **RCM tax: `rcm_payable` is credited with exactly `cgst + sgst`, not a separately rounded 5%.**
   `round(x × 0.05, 2)` and `2 × round(x × 0.025, 2)` can differ by one paisa (e.g. x = 1000.10),
   which would produce an unbalanced entry. Crediting the sum of the two computed halves is both
   arithmetically safe and the correct GST reading (the payable *is* the two components).
6. **`bounce_cheque` sets `payments.status = 'cancelled'` as well as `cheque_status = 'bounced'`.**
   The receipt has been fully reversed, so `cancel_document` must not be able to reverse it a
   second time; setting the document status makes the existing `DN_NOT_POSTED` check do that with
   no special-casing. The bounce is still identifiable as a bounce via `cheque_status`,
   `bounced_on` and `bounce_reversal_entry_id`.
7. **`cancel_document` on a payment whose cheque is past `in_hand` raises `DN_CHEQUE_STATE`.**
   (The proposal explicitly asked for a conservative call here.) A cheque that has reached the
   bank — `deposited`, `cleared`, `presented` — either brought money in or is about to; reversing
   it with a book entry would desynchronise the bank ledger from reality and break change 15's
   reconciliation before it is written. The correct paths are `bounce_cheque` (which reverses both
   the receipt and the deposit and re-opens the invoices) or a bank-reconciliation correction.
   A `bounced` cheque is already `cancelled`, so `DN_NOT_POSTED` fires first; the check remains as
   defence in depth.
8. **`bounce_cheque` handles received cheques only.** The spec describes only the receipt case
   ("reversal of receipt, or of deposit + receipt if deposited"). Our own issued cheque being
   returned is a different correction; `direction = 'payment'` raises `DN_CHEQUE_STATE`. Flagged
   below as an owner question.
9. **`deposit_cheque` / `mark_cheque_cleared` / `bounce_cheque` are admin-only.** The RLS-and-roles
   matrix enumerates what `user` may do and cheque handling is not in it. Flagged below — in a
   small shop the counter staff is who physically banks the cheques.
10. **`post_payment` role gate: `user` may post receipts, not outgoing payments.** Straight from
    the role matrix ("post sales invoices and receipts"); `direction = 'payment'` requires admin.
11. **Party-type gate on payments is strict:** receipt → `customer`/`both`, payment →
    `supplier`/`both`, else `DN_VALIDATION:invalid_party`. This means a *refund* to a customer
    (direction `payment` against AR) is not modelled in change 04 — it would need to route to the
    AR control account, not AP. Deliberately out of scope rather than silently mis-posted; the
    documented path for a refund today is a credit note (change 20).
12. **Cheque hygiene checks:** `mode = 'cheque'` requires a non-blank `instrument_no`; a cheque
    *payment* may not name the cash account; `deposit_cheque` refuses if `payments.account_id` is
    the Cheques-in-Hand account itself. All `DN_VALIDATION:*`/`DN_CHEQUE_STATE`, all cheap, all
    catching data that could only arrive from a UI bug.
13. **Cancelling a purchase has no negative-stock override.** Unlike `post_sales_invoice`, which
    honours `organization.allow_negative_stock` for an admin, the Cancellation-edge-cases rule is
    unconditional: "the fix is a debit note for the quantity still on hand, never a forced
    reversal." Implemented as a hard raise after the item locks.
14. **`discount` is not allocatable.** *(SUPERSEDED by change 06 / migration 20260919130000_allocation_discount.sql: the cap is now `Σ allocations ≤ amount + coalesce(discount, 0)`. Text below kept as history.)* The cap is `Σ allocations ≤ payments.amount`, exactly as
    specced, even though a receipt with a discount relieves `amount + discount` of AR. The
    remainder sits as an on-account balance, which is what the spec calls for.
15. **`mark_cheque_cleared` returns `void`** (no journal entry exists to return), unlike
    `deposit_cheque`/`bounce_cheque` which return their entry id. There is no `present_cheque`
    function: `presented` is informational per the spec and nothing in Phase 1 sets it, but
    `mark_cheque_cleared` accepts it as a valid predecessor state for an issued cheque.

## Files outside this change that were edited (both forced, both logged)

- `supabase/tests/database/00002_seed_creates_system_keys.test.sql` — 32 → 33 keys, plus
  `'cheques_in_hand'` in the `set_eq` list. See spec conflict #3.
- `supabase/tests/database/00005_posting_sales.test.sql` — the `DN_HAS_ALLOCATIONS` fixture
  allocated ₹1,000 against a ₹101 invoice, which change 04's new cap trigger now rejects at
  INSERT, so the fixture would never have reached the `cancel_document` call it exists to test.
  The allocation now takes the invoice's own `grand_total`. The assertion it feeds is unchanged;
  no other line of that file moved.

## Owner decisions applied after the change-04 review (commit `e2dc52e`, spec §"Decisions from change 04 review")

Both items were folded into this change's own migration
(`20260918120000_posting_purchase_payment.sql`) rather than a follow-up file: it is uncommitted
and has never been applied to hosted, so editing it in place keeps the change readable as one
unit. They answer two of the open questions below, which are struck through accordingly.

1. **Cheque banking is counter work.** `deposit_cheque` and `mark_cheque_cleared` now accept any
   active member, not only `admin` — depositing moves money between two of our own accounts and
   clearing changes a status. `bounce_cheque` stays admin-only (it reverses a receipt). This
   reverses decision #9 above, on the owners' instruction. In `00006`, the `_chq2`
   deposit + clear pair now runs under the plain `user` session (so those two assertions prove the
   new permission), and the existing "a user-role session cannot bounce a cheque" assertion is
   unchanged and still green.
2. **Salary period.** `expense_vouchers.period_month date NULL` added, with a CHECK that it is the
   first of a month. `post_expense_voucher` **sets** it on the salary/wage paths: an explicit
   value on the draft is kept (June salary paid on 31 July stays `2026-06-01`), and a NULL one
   defaults to the voucher's own month rather than being left NULL, which would silently drop the
   row out of `v_employee_ledger`'s grouping (change 06). A `period_month` on any other voucher
   type raises `DN_VALIDATION:period_month_not_allowed` — it can only be a UI bug, and refusing
   ambiguous input is this change's standing habit. Five new assertions in `00006` (141 → 146).

Conservative call inside item 2: the *defaulting* is not literally in the spec text ("the
salary/wage voucher sets it"). Leaving it NULL when the draft omits it was the alternative;
defaulting to the voucher month is the only defensible value and makes the column reliable for
change 06 to group by.

## Fixes from the fresh-context review of this change (verdict: REJECT)

All applied to this change's own migration, which is uncommitted and has never reached hosted.

**B1 — `check_payment_allocation()` is now `SECURITY DEFINER`.** The trigger fires as the role
doing the INSERT and reads RLS-protected tables to enforce its caps. Reproduced live before and
after: with the trigger left `SECURITY INVOKER`, an allocation written by a *real* authenticated
session against a genuinely posted invoice fails with
`DN_VALIDATION:allocation_invoice_not_posted` — because the trigger's
`SELECT … FROM sales_invoices … FOR UPDATE` is checked against the UPDATE policy, whose `USING`
is `status = 'draft'`, so a posted invoice is invisible to it. Every allocation test previously
ran as `postgres`, which bypasses RLS, which is why nobody saw that allocation was broken for
every real session. Worth noting precisely: the live failure mode is *closed* (refuses a valid
allocation), not the open cap-bypass the review hypothesised — but the fix is the same and it
also removes the policy dependency the review objected to. Every allocation INSERT in `00006`
now runs under `set local role authenticated` with real JWT claims, so this cannot regress
quietly.

**B2 — cancelling a purchase whose stock has moved.** Quantity alone was not enough. The review's
worked example is now a failing-first test: opening 10 @ 100, purchase 10 @ 200 (avg 150), sell 5.
On hand is 15, so the old check passed, and the reversal would have left 5 units carrying Rs 250
instead of Rs 500. `cancel_document` now also refuses when any non-reversal movement from another
document exists on or after the purchase's movement date for those (item, warehouse) pairs, and
when the reversal would leave negative value. Dates are the ordering used because `created_at` is
frozen inside a transaction. An escalated case (value driven negative while quantity lands on
zero) is tested too. Related: `_post_sales_invoice` now raises `DN_VALIDATION:no_cost_basis`
instead of posting a zero-COGS sale when `qty > 0` and `avg_rate <= 0` — change 03's tests are
unaffected because its override fixture stocks at Rs 100.

**M3** allocation party match (`DN_VALIDATION:allocation_party_mismatch`), in the trigger and
re-checked in `post_payment`. **M4** money accounts: `accounts.is_money` + `is_money_account()`
now gate `post_payment`, `post_expense_voucher.pay_account_id`, `deposit_cheque` and
`post_cash_sale`; a cheque receipt may not name the cash account. **M5** cancelling an advance the
salary already recovered raises `DN_VALIDATION:advance_already_recovered`; no mirror guard is
needed for the salary side, because its reversal *debits* `employee_advance` and can only raise
that balance — the two together force the only safe order (salary first, then advance), which the
tests walk through. **M6** a cancelled payment can never be allocated, in the trigger as well as
the policy. **M7** (owner decision) only a *posted* payment's allocations consume open amount or
raise `DN_HAS_ALLOCATIONS`; `post_payment` re-validates every allocation under lock, so two drafts
racing for one invoice are resolved at posting time — tested with two drafts, both allowed to
allocate, the second refused at post. **M8** `rcm = true` on a purchase invoice raises
`DN_VALIDATION:rcm_purchase_unsupported`. **M9** inter-state (or party-less) RCM freight raises
`DN_VALIDATION:rcm_interstate`, since the posting hard-codes the intra-state GTA split.

**m10** advance/salary/wages require a party of type `employee`; **m11** the party must be active;
**m12** a `salary` voucher with no party raises `DN_VALIDATION:missing_party` — deliberately *not*
extended to `wages`, because the spec models unnamed casual hamali as exactly that, a wage voucher
with no party (the existing hamali test still posts). **m13** allocation INSERT/UPDATE/DELETE now
writes an `audit_log` row with `auth.uid()` as actor, through a `SECURITY DEFINER` AFTER trigger
(`audit_log` takes no client INSERT). **m14** dropped the redundant partial
`journal_entries(source_id)` index — the baseline `(source_type, source_id)` already serves those
lookups. **m15/m16** spec wording corrected: the round-off Dr/Cr direction stated in the Tax
clarification is the *sales* side and reverses on a purchase, and `place_of_supply` on a purchase
is not authoritative — the supplier's state is.

## Open questions for the owners (not guessed at — these need a decision)

- ~~**Who may bank a cheque?**~~ **Answered** by the change-04 review: both roles may deposit and
  clear, admin only may bounce. Applied above.
- ~~**A cheque *we* issued that bounces.**~~ **Answered**: no dedicated function in Phase 1. The
  admin cancels the payment via `cancel_document` (a reversal) and records a new payment on
  re-issue. Revisit only if it recurs. Decision #8 stands as implemented.
- ~~**Customer refunds / supplier refunds**~~ **Answered**: Phase 2, as a `payments.direction`
  value `'refund'` with mirrored posting. Phase 1 handles them as credit/debit notes plus, if cash
  actually moves, a manual admin journal. Decision #11 stands as implemented; the roadmap carries
  the Phase-2 item.
- ~~**Salary period.**~~ **Answered**: `period_month` added, above.
- ~~Change 03's walk-in `credit_limit = 0` question~~ **Answered**: `credit_limit` becomes
  nullable, `NULL` = unlimited and `0` = no credit. The migration and the check live in change 05
  — see that change's notes.

No open questions remain from this change.
