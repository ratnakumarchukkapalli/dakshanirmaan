# Change 12 — payments UI: implementation notes

Status: built, all automated gates green, **not committed, not pushed**. Live-browser walkthrough
**not done this round** (see "Not done" below) — Ratna chose to skip it rather than work around a
permission block on creating a local test account.

## Fresh-context review (same day) — APPROVE AFTER FIXES, all three applied
A second agent reviewed the diff cold with `daksh-review`, re-ran every automated gate itself
(confirmed 343/343 vitest, 945/945 pgTAP, clean `tsc`/`lint`/`build` independently), and found:
1. **`PaymentForm.tsx`'s "Auto-allocate oldest first" used `Number`/`Math.min`/`.toFixed(2)`** —
   a real hard-rule violation (money must never float) sitting right next to `AllocationGrid.tsx`,
   which already did the same kind of fill correctly with the exact-decimal helpers. Never a
   books-integrity risk (`post_payment` re-validates every allocation under lock regardless of
   what the client computed), but a real bug: enough rows with awkward amounts could drift the
   auto-fill by a paisa. **Fixed** by extracting both the per-row cap and the auto-allocate fill
   into `src/lib/payments-alloc.ts` (`capAllocationInput`, `autoAllocateOldestFirst`), built
   entirely on `compareDecimal`/`addDecimal`, and having both `AllocationGrid.tsx` and
   `PaymentForm.tsx` call the shared functions instead of each having its own inline version.
2. **No test exercised that logic at all**, despite the proposal's scope explicitly asking for it
   ("Vitest for the allocation-cap math… exact decimal, no floats") — exactly the test that would
   have caught #1. **Fixed**: `src/lib/payments-alloc.test.ts` (9 cases), including one that fills
   seven rows of ₹333.33 against ₹1,666.66 and asserts the sum comes back to the paisa with no
   drift — the scenario a naive float version would eventually get wrong.
3. **`.tile.hero` in `globals.css` had a hardcoded `#0e1a26`/`#fff`**, and `StatTile`'s `hero` prop
   that turned it on was never actually used anywhere in this change (added "for later," per the
   skill's own reviewer). Review-blocking either way ("no hardcoded hex") and dead code besides.
   **Fixed** by dropping the `hero` prop and the `.tile.hero` rule entirely — whichever of changes
   13/14 first wants a hero tile can add it then, with tokens, exercised by an actual call site.

All three were small, mechanical, client-side changes — nothing in a migration or posting function
moved. Re-ran the full gate set after the fixes: still 352/352 vitest (9 new), 945/945 pgTAP, clean
`tsc`/`lint`/`build`.

Brief: `daksh-ui` + `daksh-api` (a small `daksh-schema` addition too, Ratna's explicit go-ahead —
see "Schema addition"). Spec: frontend "Route structure" (`payments/`, `payments/new/`) + the
allocation-grid clarification line; api `payments.ts` action list + extensions; db "Payment
allocations" / "Payments: discount and cheques" (change 04). Acceptance: "allocation cap +
auto-allocate"; "bounce flow".

## Schema addition
`v_open_purchase_invoices` (`supabase/migrations/20260922110000_open_purchase_invoices.sql`) — an
exact mirror of `v_open_sales_invoices` (change 06), reading `purchase_invoices` + `debit_notes`
instead of `sales_invoices` + `credit_notes`. Needed because the allocation grid has to show open
invoices for **both** payment directions, and nothing covered the outgoing side (purchase-invoice
creation itself has no UI until change 21). No interest/ageing-rate column — `v_party_interest` is
customer-side only, nothing in the spec charges the business interest on its own payables.
pgTAP: `supabase/tests/database/00017_open_purchase_invoices.test.sql` (4 assertions: fully open,
partial allocation reduces it, allocation + debit note zeroes it out and the row leaves the view,
a draft bill never appears). Also bumped `00008_read_views.test.sql`'s hardcoded view count
(17 → 18) and its grants-loop assertion now covers the new view too (it iterates every `v_*`
view, so the new one had to get the same `revoke all / grant select to authenticated` pair as
every other view or that test fails generically — caught this by actually running the suite, not
by inspection).

## What was built
- **Routes**: `/payments` (list + tiles), `/payments/new` (`?id=` resumes a draft — no separate
  `[id]/` route, matching the frontend spec's route tree and change 11's challan precedent: a
  posted payment has no view screen of its own, its status and cheque actions live on the list
  row).
- **Actions** `src/app/actions/payments.ts`: `saveDraftPayment`, `postPayment`, `depositCheque`,
  `markCleared`, `bounceCheque`. Schema `src/schemas/payments.ts`. Loaders
  `src/lib/payments-data.ts` (`loadPaymentFormContext`, `loadPaymentsList` + the four tile sums,
  all exact-decimal — no `Number` arithmetic on money, even for display aggregation). Types
  `src/lib/payments-types.ts`.
- **UI**: `src/components/payments/{PaymentForm,AllocationGrid,PaymentRowActions}.tsx` +
  `src/components/ui/StatTile.tsx` (a genuinely generic tile primitive, added to `ui/` rather than
  a payments-only component since changes 13/14 will want the same tile shape for ageing and
  dashboard tiles — `AllocationGrid`/`PaymentRowActions` stayed in `components/payments/` instead,
  following the actual precedent already set by `EwbPanel` living in `components/sales/` rather
  than the skill doc's aspirational `ui/` listing).
- **CSS**: `.tiles`/`.tile`/`.tile.hero`, `.alloc`/`.progress`/`.mdue` ported verbatim from the
  prototype's `<style>` block into `globals.css` (same tokens — none of these classes existed
  before this change; changes 07–11 never needed a stat tile or an allocation grid).
- **`errors.cheque_state`** (`ErrorCode` + `DB_CODES['DN_CHEQUE_STATE']` in `action-result.ts`) —
  the api spec named this code as "added" back in change 10's notes but it stayed unmapped until
  something could actually raise it. New `validation.*` detail keys for every `DN_VALIDATION:*`
  `post_payment` can raise, both languages. Reworded the existing shared `validation.invalid_party`
  string (previously "cannot be billed... choose an active customer", invoice-specific) to be
  direction-neutral, since `post_payment`'s own internal party-type check reuses that same DB
  detail string for a supplier context too.

## Role gates (read directly off the database, not guessed)
- **Receipts**: any active member may create, save-draft and post one.
- **Outgoing payments** (`direction = 'payment'`) and **any payment with `discount > 0`**: post
  is admin-only — `post_payment` itself refuses a `user` role on either. `postPayment` reads the
  draft's own `direction`/`discount` and checks `isVerifiedAdmin` *before* calling the RPC, so a
  counter-staff session gets a translated refusal instead of a raw database error; the database
  re-checks regardless. The **form itself never offers what it can't post**: the direction toggle
  and the discount field render only for a verified admin session — not disabled, not shown, per
  the same "don't show what the database will reject" rule change 10 used for the credit-limit
  override.
- **Deposit / mark cleared**: any active member (moves money between our own accounts, or changes
  a status only — change 04's own note: "cheque banking is counter work").
- **Bounce**: admin only (`requireAdmin()`), reverses a receipt.

## Allocation cap + auto-allocate
The grid's per-row cap and the auto-allocate-oldest-first fill are display logic only
(`AllocationGrid.tsx`), built with the exact-decimal helpers (`compareDecimal`/`addDecimal`), never
`Number` arithmetic on a stored value. `post_payment` re-validates every allocation under the
payment's row lock at post time (grouped by invoice, same shape as change 04's own re-validation
for the two-draft race) — that re-validation is the only authority; nothing here trusts the form's
cap. Allocations are held as local component state (`Record<invoiceId, amount>`), not a
react-hook-form field array, because they are a derived selection over an already-known,
server-loaded list of open invoices (same data for both directions, loaded once and filtered
client-side by party + direction) rather than lines a person adds and removes one at a time — a
field array would have fought that shape for no benefit.

## Conservative defaults taken (no owner interview for this change)
1. No dedicated view screen for a posted payment — the frontend spec's route tree lists only
   `payments/new/` (and `reconcile/`, change 22) for this section, same reading as change 11 gave
   the challan route tree.
2. No `deletePaymentDraft` action — the api spec's `payments.ts` row names exactly
   `saveDraftPayment`/`postPayment` plus the three cheque-lifecycle extensions.
3. `v_open_purchase_invoices` carries no interest/ageing columns (see "Schema addition").
4. The bounce reason has no format requirement beyond "not empty, at least 3 letters" (reused the
   existing `reason_required` field message from `cancelInvoice`) — the database takes free text.
5. Cheque bank name is a free-text field shown for both directions when `mode = 'cheque'` — the
   column is generic on `payments` and useful for either a received or an issued cheque.

## Not done
- **Live-browser walkthrough was skipped this round.** Local Supabase came up clean
  (`supabase db reset` applied the new migration with no errors), and demo data was attempted but
  the session hit a permission block exporting the local dev secret key to create a throwaway test
  admin account — Ratna chose to skip the walkthrough rather than work around that block. This
  means the acceptance scenarios ("allocation cap + auto-allocate", "bounce flow") are verified by
  the action tests and by reading the posting functions, **not** by watching them happen against a
  live database and a real browser, unlike change 11's own verification. Recommend this happens
  before or during review, the same way change 11's gap was caught by actually running the app.
- 390px / dark-theme visual check not done (no browser session this round, for the same reason).

## Verified
`supabase db reset` + `supabase test db` → **945/945 pgTAP** (941 + 4 new); `tsc`, `lint`,
`next build` clean; **352/352 vitest** (18 in `payments.test.ts`, 9 in `payments-alloc.test.ts`);
i18n key parity (en/te) checked with a script, zero drift either direction.

## Milestone review fixes (Opus milestone review: APPROVE AFTER FIXES)
1. **BLOCKER: `payments.note` did not exist.** `/payments/new?id=` selected it, so resuming any draft
   404ed (untyped client + mocked tests hid it). New migration
   `20260925100000_payments_note.sql` (`alter table payments add column note text`, plain nullable;
   payments has only row-level RLS, no column grants/allow-lists/freezing triggers, so nothing else
   needed the column). `saveDraftPayment` now writes `note: v.note ?? null`. pgTAP
   `00018_payments_columns.test.sql` (40 assertions): `has_column` for every column the payments
   pages/actions/loaders read or write (payments, payment_allocations, the two open-invoice views,
   `v_party_balances`) plus a note round-trip on a draft. This is the drift guard; extend it when a
   payments query gains a column.
2. **Auto-allocate ignored discount.** New `settleAmount(amount, discount)` in `payments-alloc.ts`
   (exact decimal). Used for auto-allocate, the grid's `amount` prop (remainder + progress bar), the
   "on account" row, "Outstanding after", and the list's "unallocated" tile (which now also selects
   `discount`). Vitest: 900 + 100 discount settles a 1,000 invoice. The grid's progress percentage
   is now computed on scaled BigInts instead of `Number`.
3. **Reversing a posted payment.** Admin-only `cancelPayment(id, reason)` -> `cancel_document('payment')`
   (`cancelPaymentSchema`, same reason rule as bounce). `DN_CHEQUE_STATE`/`DN_NOT_POSTED`/
   `DN_PERIOD_LOCKED` already map to `cheque_state`/`not_posted`/`period_locked` with en+te strings.
   List row action "Cancel payment" (verified admin, posted rows only; hidden for cheques that reached
   the bank: deposited/cleared/presented, which the database refuses; a received cheque goes through
   Bounce) with a reason + confirm modal. The `has_allocations` sentence ("Cancel that payment
   first") now has a real path. api-architecture spec `payments.ts` rows updated in this change.
   Tests: 4 new in `payments.test.ts`.
   **OPEN ITEM (out of scope): re-allocating a posted receipt without reversing it** is not offered;
   the only route is cancel + re-enter.
4. `PaymentForm`: a resumed draft's allocations to invoices no longer in `openForParty` are neither
   counted nor sent (`liveAllocations`), so a hidden row cannot cause `allocation_exceeds_invoice`.
   Dropped silently, no "stale" indicator.
5. Added `errors.validation.{allocation_direction, allocation_amount, allocation_payment_cancelled,
   allocation_payment_missing, allocation_invoice_type}` (en + te) and made `errors.conflict` /
   `errors.partial` document-neutral. New `payments.cancel*` strings too. en/te key parity kept.
6. `Number()` on money replaced by `compareDecimal`/`decimalText` in `payments.ts` (post gate),
   `new/page.tsx`, `schemas/payments.ts` (amount > 0 checks), `AllocationGrid.tsx`.
7. Cheque tiles ("in hand", "issued") now filter `status = 'posted'`.

**Needs native-speaker review (Telugu, written by the agent):** the five new `errors.validation.*`
allocation strings, the reworded `errors.conflict` / `errors.partial`, and `payments.cancelBtn`,
`cancelTitle`, `cancelBody`, `cancelReasonLabel`, `cancelConfirm`.

**Not done / not verified:** Docker Desktop was not running, so `supabase start`, `db reset`,
`supabase test db` (the new migration and `00018` are unexecuted) and the live draft-resume check
could not run. No `payments-data.ts` unit test exists for the tile filters.
