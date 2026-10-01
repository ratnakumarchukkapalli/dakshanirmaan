# 20 — notes: implementation notes (database half)

Built 2026-09-29 by the Opus session, database scope only (brief items 1–6). Screens, `notes.ts`, zod and i18n are the later Sonnet session, after the independent review of this half. Nothing committed, nothing pushed, the hosted project untouched.

## What was built

- **Migration** `supabase/migrations/20261003100000_notes.sql`
  1. `credit_notes.stock_effect`, `debit_notes.stock_effect` (`boolean not null default true`): goods return vs value-only adjustment (brief default 1).
  2. `credit_note_lines.against_line_id` → `sales_invoice_lines(id)`, `debit_note_lines.against_line_id` → `purchase_invoice_lines(id)`, both nullable, `on delete restrict` (review fix 4). Indexes on these, on `against_invoice_id` and on `note_id`.
  2b. Trigger `note_lines_guard` (BEFORE INSERT/UPDATE/DELETE on both line tables, SECURITY DEFINER, no grants): locks the header `FOR SHARE` and raises `DN_NOT_DRAFT` unless it is a draft, for every writer including the table owner (review fix 4). A header that no longer exists (cascade from deleting a draft) lets its lines go.
  3. RLS: insert/update/delete on `credit_notes`, `debit_notes` and both line tables now require `current_app_role() = 'admin'` (so admin at aal2) as well as draft-only. SELECT unchanged (members).
  4. `post_credit_note(p_note_id uuid) returns uuid`, `post_debit_note(p_note_id uuid) returns uuid`: `SECURITY DEFINER`, `search_path = public, pg_temp`, EXECUTE revoked from public/anon, granted to authenticated only.
  5. `cancel_document`: new `credit_note` / `debit_note` branch; the `sales_invoice` and `purchase_invoice` branches gain one guard (see "Found in the blast radius"). Every other branch was copied from the live definition unchanged.
  6. `refuse_cancel_in_locked_period` now also covers `debit_notes` (it only had `credit_notes`), plus the trigger on `debit_notes`.
  7. `_gst_out_lines`: a value-only credit note reports quantity 0 (lowers value, not quantity, in the HSN summary). `gstr3b_summary`: 4A5 and 4D are net of posted debit notes.
- **pgTAP** `supabase/tests/database/00028_notes.test.sql`: 341 tests (203 first round + 55 review round 1 + 55 review round 2 + 28 review round 3). Full suite on an empty DB after `supabase db reset`: **28 files, 2181 tests, all pass**, including the 00026 catalog guard.
- **Review round 3:** (a) `cancel_document` refuses to cancel a note while a later-posted, un-cancelled note stands on the same invoice/bill (`DN_VALIDATION:later_notes`; order = the notes' journal `entry_no`, strictly increasing). Cumulative rounding is exact only while the posted notes are an unbroken prefix of the posting order; a middle cancel could leave e.g. +0.99 of extra credit and make the next return unpostable (round-off −1.48). (b) The invoice-level total cap is reachable on its own and now tested. (c) `post_credit_note` / `post_debit_note` are not executable by `service_role` (authenticated only, like the other post functions).
- **Mutation check (review round 2).** Five mutations of the posting functions were each run against 00028 inside the test's own rolled-back transaction (copies in the scratchpad, never in the repo) and each is caught: credit-note taxable non-cumulative (2 failures), debit-note taxable non-cumulative (2), credit-note priors counting cancelled notes (4), debit-note priors counting cancelled notes (3), credit-note stock-value prior counting cancelled notes (4). Round 3: dropping the `later_notes` guard is caught (5 failures).
- **Fixture edits forced by the line guard:** `00025_self_audit_and_gst.test.sql` inserted lines onto already-posted credit-note fixtures; it now inserts them as drafts, adds the lines, then sets `posted` / `cancelled` (same end state, same assertions). `scripts/attack-test/matrix.mjs` builds its posted-note fixture the same way (draft → line → posted). `npm run lint`: 0 errors, the same 29 pre-existing warnings. No TypeScript changed; tsc and vitest not re-run.

## Posting maths (what the reviewer should check)

**Credit note** (lock order: note → invoice → party → items ascending, one statement each → `doc_sequences`):
- Dr sales income per line (`sales_cement` / `sales_steel` / `sales_other` by the item's current category; `freight_recovered` for a non-stock line), Dr output CGST+SGST or IGST, Cr AR (party) = rounded grand total. Round-off: Dr when positive, Cr when negative (the mirror of the invoice, because here AR is *credited* with the rounded total).
- Goods returned (`stock_effect = true`, stock items): stock movement IN to the **invoice's warehouse**, dated the note date, at the **original cost of that invoice's goods**: C = Σ(−value), Q = Σ(−qty) of the invoice's own un-reversed `sales_invoice` movements for that item (or the challan's `delivery_challan` movements when converted from a challan). The value is **cumulative per item on that invoice** (review fix 1): `round(C × (already_returned_qty + qty) / Q, 2) − already_returned_value`, where "already returned" = the credit-note movements of posted, un-cancelled notes against this invoice plus earlier lines of this note. Rate = round(value / qty, 4). Returns that reach Q restore exactly C (proved: 33.33 + 33.34 + 33.33 = 100.00, not 99.99). Dr Inventory / Cr COGS for the same total. Never the current average (pgTAP proves 300 is used when the average has moved to 309.2166).
- `buyer_gstin` of a note against an invoice = the **invoice's** snapshot (review fix 3), so a customer who registers later cannot pull the note into CDNR against an invoice filed as B2C. A stand-alone note keeps the party snapshot from the trigger.
- Tax: CGST = SGST = round(taxable × rate / 200, 2) or IGST = round(taxable × rate / 100, 2), exactly as the invoice.
- **Grand total, note against an invoice (both note types, review round 2 F1): rounded cumulatively per invoice.** `grand_total = round(Σ raw of posted, un-cancelled notes on the invoice + this note's raw) − Σ their grand totals`; `round_off = grand_total − raw`, cap **±1.00** (a carried residue plus its own), else `DN_UNBALANCED`; and Σ notes' grand totals may never exceed the invoice's (`DN_VALIDATION:value_exceeds_invoice`). Why: each note rounding its own total let a 149 invoice (3 × 42 at 18%) returned in thirds come to 50 + 50 + 50, so the last return was refused as over the open amount (and splitting further hit `zero_total`). Now 50 + 49 + 50 = 149, and any full return, in one note or several, credits exactly the invoice's grand total. Chosen over the fallback (a 1.00 tolerance on the open check) because it keeps notes = invoice to the paisa and clears the ±1 rupee residue. GSTR is unaffected: `gstr1_data` uses `grand_total` only as the note's `val`, taxes and taxable come from the lines, and `gstr3b_summary` never reads round-off; the journal carries the round-off line as before (balanced by construction, asserted on every note). A stand-alone note rounds on its own (cap ±0.50) as before.

**Debit note** (lock order: note → purchase invoice → party → items → `doc_sequences`):
- Dr AP (party) = rounded grand total; Cr Inventory for a return (with stock movement OUT from the bill's warehouse); Cr `discount_received` for a value-only note (no stock movement); Cr input CGST/SGST/IGST (ITC reversed) only when the bill was `itc_eligible`. Round-off: Cr when positive, Dr when negative (AP is *debited* with the rounded total).
- The cost that leaves stock is the note line's share of what the bill capitalised: taxable, plus the line's tax when the bill was not ITC-eligible (exactly `post_purchase_invoice`'s landed cost). Rate = round(cost / qty, 4) = the purchase's own rate.
- `DN_NEGATIVE_STOCK` when on-hand qty would go below zero, or when a positive quantity would be left with zero/negative value. No admin override (it is itself the remedy, not something to force).
- **A return that empties the godown takes out ALL the remaining value** (review fix 2), never leaving zero quantity still carrying value. The difference from the bill's cost goes to **COGS** (Dr when more value remained than the bill's cost, Cr when less): it is the weighted-average error already booked through COGS on earlier sales. Example (pgTAP): 100 @ 300 + 100 @ 320, sell 100 at 310, return the first bill's 100 → Cr Inventory 31,000, Dr COGS 1,000, Dr AP 35,400, Cr input tax 5,400; stock 0 / 0. The cancel reversal mirrors it, COGS line included. The audit row carries `cogs_true_up`.

**Proportional taxable and tax for returns (both notes).** The client's rate is ignored on a return. The line's taxable is computed cumulatively: `round(invoice_line.taxable × (prior_returned_qty + qty) / invoice_line.qty, 2) − prior_returned_taxable`. **Each tax component is cumulative too** (review fix 1): `round(cumulative_taxable × rate / 200, 2) − Σ that component on prior posted, un-cancelled returns on the line` (IGST: rate / 100). Partial returns that reach the invoiced quantity therefore reverse exactly the invoiced taxable value and tax (proved with the reviewer's numbers: 3 × 33.39, CGST 9.02, returned in thirds → 3.01 + 3.00 + 3.01; on an ITC bill the ITC reversed is 9.02, not 9.03; on a no-ITC bill the capitalised cost 118.21 leaves as 39.41 + 39.39 + 39.41 and the last third no longer raises `DN_NEGATIVE_STOCK`). The line's `rate` is overwritten with `round(invoice_line.taxable / invoice_line.qty, 4)` for display. Value-only notes tax their own taxable as the invoice does.

**Value-only lines** take the user's `qty × rate` (rate > 0), like an invoice line takes the user's rate.

## Guards and error codes (for the UI mapping)

All raised as `P0001` with these messages; `parseDbError` already maps them (`DN_VALIDATION:<detail>` → `validation` + detail; the rest via `DB_CODES`). No new top-level code was introduced.

| Message | When |
|---|---|
| `DN_FORBIDDEN` | no session, not a member, `user` role, or admin below aal2 (post and cancel) |
| `DN_NOT_DRAFT` | posting a note that is not a draft (idempotency); **any insert/update/delete of a line of a non-draft note** (`note_lines_guard`) |
| `DN_NOT_POSTED` | cancelling a note that is not posted |
| `DN_PERIOD_LOCKED` | note date's month locked or missing (post and cancel) |
| `DN_NEGATIVE_STOCK` | debit note returns more than is on hand / would leave bad value; cancelling a note after another document has moved that item/godown on or after the note date |
| `DN_UNBALANCED` | round-off out of range: ±0.50 for a stand-alone note, **±1.00 for a note against an invoice/bill** (cumulative rounding). A backstop: unreachable while notes on an invoice are cancelled last-posted-first (`later_notes`) |
| `DN_VALIDATION:future_date` | note date after today (Asia/Kolkata) |
| `DN_VALIDATION:reason_required` | blank reason (brief default 5) |
| `DN_VALIDATION:no_lines` | no lines |
| `DN_VALIDATION:note_needs_invoice` | `stock_effect = true` with no `against_invoice_id` (brief default 3) |
| `DN_VALIDATION:invoice_not_posted` | the invoice/bill is draft or cancelled |
| `DN_VALIDATION:party_mismatch` | note party ≠ invoice party |
| `DN_VALIDATION:note_before_invoice` | note dated before the invoice |
| `DN_VALIDATION:line_not_on_invoice` | a line's `against_line_id` is null, belongs to another invoice, or its item differs; or a stand-alone note carries an `against_line_id` |
| `DN_VALIDATION:duplicate_line` | two note lines on the same invoice line |
| `DN_VALIDATION:invalid_party` | party inactive or wrong type (customer/both; supplier/both) |
| `DN_VALIDATION:invalid_qty` | qty null or ≤ 0 |
| `DN_VALIDATION:invalid_rate` | value-only line with rate null or ≤ 0 |
| `DN_VALIDATION:qty_exceeds_invoice` | return qty + earlier posted, un-cancelled returns on that invoice line > invoiced qty |
| `DN_VALIDATION:value_exceeds_invoice` | taxable of all posted notes on that invoice line (returns and value-only) + this one > the line's taxable; **or** the posted notes' grand totals on the invoice + this one > the invoice's grand total (can fire on its own: value-only notes whose per-note tax rounds up, proved in pgTAP) |
| `DN_VALIDATION:later_notes` | **cancel_document on a note** while a later-posted, un-cancelled note stands on the same invoice/bill. UI message: "Cancel the later notes on this invoice first" |
| `DN_VALIDATION:exceeds_open_amount` | note grand total > the invoice's open amount while that open amount is still > 0 |
| `DN_VALIDATION:zero_total` | grand total ≤ 0 |
| `DN_VALIDATION:no_cost_basis` | credit-note return on an item whose invoice carried no cost |
| `DN_VALIDATION:non_stock_line` | debit-note return of a non-stock item |
| `DN_VALIDATION:missing_account` | a system account is missing |
| `DN_VALIDATION:has_notes` | **new on `cancel_document` for invoices**: a posted note stands against the invoice/bill |

## For the Sonnet UI session

- RPCs: `post_credit_note(p_note_id uuid) → uuid`, `post_debit_note(p_note_id uuid) → uuid` (journal entry id), `cancel_document('credit_note' | 'debit_note', id, reason) → uuid` (reversal entry id). All admin at aal2.
- **Draft columns the form writes.** Header: `note_date`, `party_id`, `place_of_supply` (NOT NULL + CHECK, but ignored and overwritten at posting; write the invoice's value for a credit note, the org state for a debit note), `against_invoice_id` (null only for a value-only note), `reason` (required at post), `stock_effect` (the "goods returned to stock?" switch). Lines: `line_no`, `item_id` (must equal the invoice line's item), `against_line_id` (the invoice line; required when the header has an invoice), `qty`, `rate` (used only on value-only lines), and the NOT NULL snapshot columns `item_name`, `hsn_code`, `uom`, `gst_rate`, `taxable_value` (write the invoice line's values or zeros; the server overwrites them).
- **Server-derived at posting (never trust or compute in TS beyond a preview):** `note_no`, `place_of_supply`, `journal_entry_id`, every total and round-off, each line's `rate` (returns), `taxable_value`, `cgst_amt`/`sgst_amt`/`igst_amt`, and the snapshot columns; `buyer_gstin` (credit notes, trigger). Read them back after posting, as the invoices do.
- **Remaining-returnable qty for the form** = invoice line qty − Σ qty of lines of *posted* notes with `stock_effect` on that `against_line_id`. Remaining creditable value = line taxable − Σ taxable of all posted notes on it. Plain reads (`credit_note_lines` join `credit_notes`); a view could be added later if the form needs it.
- Counter (`user`) can read notes but gets RLS 42501 on insert, silently 0 rows on update/delete. The action must gate to admin as well (roles enforced twice).
- `against_line_id` is `ON DELETE RESTRICT`: while a draft note points at a line of a **draft** invoice, deleting that invoice line fails with 23503 (mapped to `validation`). The invoice form's save must not delete-and-reinsert lines a note draft points at (in practice notes are only made against posted invoices, whose lines are never deleted).
- An invoice or bill with a posted note can no longer be cancelled (`has_notes`): the UI should say "cancel the credit/debit note(s) first".
- **Cancelling a note** raises `DN_VALIDATION:later_notes` while a later-posted note on the same invoice/bill stands: notes on one invoice are cancelled newest first (message: "Cancel the later notes on this invoice first"). It raises `DN_NEGATIVE_STOCK` once any later stock movement of that item in that godown exists from another document, **even if that later document (for example a later note) was itself cancelled** — same rule as purchases, because its movements stay in the ledger. The UI must show `DN_NEGATIVE_STOCK` on a note cancel as "cancel the later documents first / this note can no longer be cancelled", not as "not enough stock".
- The debit-note entry point: the purchases screens exist (change 21a); log in the UI notes which view hosts the button.

## Deviations from the brief and conservative defaults (each is a review item)

1. **Debit-note series is `DB`, not `DBN`.** The spec's seed paragraph names `DB` (debit_note) and the seed already created `DB/26-27/`; `CN` likewise existed. `next_doc_no` creates later FYs' rows itself. Nothing added.
2. **Linking a note line to an invoice line: nullable `against_line_id` column** (not item matching, which is ambiguous when an invoice has two lines of one item at different rates). Required on linked notes; item must match; one note line per invoice line (`duplicate_line`). `ON DELETE RESTRICT` after review (was `SET NULL`).
3. **Snapshots on linked notes come from the invoice line, not the item master.** A note reverses what that invoice charged; if the GST rate or HSN changed in the master since, the note must still reverse the invoiced rate. Stand-alone notes snapshot from the master, like invoices.
4. **Return value is proportional and server-derived** (the client's rate is ignored on a return), cumulative so full return = full invoiced value. Brief: "proportionally to the note lines".
5. **Value cap across kinds** (owner decision 2026-09-29: keep). A return after a rate-difference note on the same line can exceed the line's value (e.g. 1,000 rate difference then return all 100 bags → 11,000 credited on a 10,000 line); this is refused (`value_exceeds_invoice`). **Owner question:** a full return after a rate-difference note is therefore impossible until the rate-difference note is cancelled; the accountant's answer is to return at the reduced rate. Acceptable, or should a return after a rate difference credit the reduced value automatically?
6. **Open-amount rule exactly as the brief states it** (owner decision 2026-09-29: keep): refused when the note exceeds a still-positive open amount; allowed in full when nothing is open (fully paid). **Owner question:** on a part-paid invoice a return larger than the unpaid part (e.g. 2,560 bill, 2,000 received, return everything) is refused, and there is no API path to un-allocate a posted receipt. The views and the payment cap handle a negative open amount correctly (proved for the fully-paid case: open rows disappear, the credit shows as `other_ar`), so relaxing the rule to "always allowed; the excess is a credit balance" is safe for the books. Recommend asking Ratna.
7. **Warehouse of a return** = the invoice's / bill's own warehouse (notes have no warehouse column). A return to a different godown is a return plus a stock transfer.
8. **Income account of a credit-note line** follows the item's *current* category, as `post_sales_invoice` reads it at posting. If an item's category changed between invoice and note, the note debits the new category's income account. Rare; not snapshotted on sales lines today either.
9. **Value-only debit note credits `discount_received` (4500), not Inventory** (owner decision 2026-09-29: keep). The goods may already be sold, and crediting Inventory without a stock movement would break the Inventory-GL = stock-value tie. **Owner question:** acceptable (it is how a Tally user posts a supplier's rate difference), or should it reduce COGS?
10. **Stand-alone value-only debit note treats ITC as claimed and reverses it** (Cr input GST). With no bill to say otherwise, reversing is the direction that can only raise tax payable. Stand-alone credit note: place of supply = the customer's state (party rule), tax from the master.
11. **Debit-note tax split** follows the bill (`igst_total = 0` → CGST+SGST), not today's supplier master, so the reversal matches what was claimed. `debit_notes.place_of_supply` is set to our own state (inward supply; informational, as for purchases).
12. **Cancel reversal is dated on the note's own date** (brief item 5), unlike the invoice/payment branches which date today. Consequences, all intended: the note's month must be open (explicit check + the trigger); a note and its reversal cancel inside the same month, so GSTR-3B `recon_output`/`recon_input` stay 0 (proved); and because a back-dated stock reversal would re-price later history, the cancel is refused as soon as another document has moved that item/godown on or after the note date (`DN_NEGATIVE_STOCK`, same rule as purchases). This makes a credit note hard to cancel once the returned goods are sold again: the correction then is a new document.
13. **Future dates refused** (`future_date`) for notes. The invoice functions do not check this today; not changed there.
14. **Counter cannot draft notes** (brief default 4) — confirmed before tightening: no pgTAP fixture or demo data inserts note drafts as a `user` session (00011, 00017, 00025 insert notes as `postgres`, which bypasses RLS; `supabase/demo/demo-data.sql` has no notes; `src/` has no note writes yet). `scripts/attack-test/matrix.mjs` lists the note tables in `USER_WRITES`, but that constant is never read, so the matrix is unaffected; left untouched.
15. The quantity and value caps live in the posting function only (cross-row sums, read under the invoice lock). After review, the rows they read are protected by `note_lines_guard`: a posted note's lines cannot change for any writer, and a line save racing a post waits on the header lock and is then refused.
16. **Zero-quantity true-up goes to COGS** (review fix 2), not to a separate "stock revaluation" account. COGS is where the average-cost error was booked when the goods were sold, so the P&L effect lands on the same line.

## Found in the blast radius (fixed here)

- **An invoice could be cancelled underneath a posted note.** Cancelling I1 after a return would have credited the customer twice and restocked the goods twice. `cancel_document('sales_invoice' | 'purchase_invoice')` now raises `DN_VALIDATION:has_notes` while any posted note stands against it (checked after the allocation check, under the invoice lock). No existing behaviour changes, because no note could be posted before this change.
- **GSTR-3B 4A5/4D ignored debit notes** while `books_input` already counted them, so the first debit note would have shown a false `recon_input` difference. Now netted.
- **The locked-period cancel trigger did not cover `debit_notes`.** Added.
- **HSN summary** would have lowered quantity for a value-only credit note. Fixed in `_gst_out_lines` (qty 0 for those lines).
- `v_open_sales_invoices` **already** subtracts posted credit notes (`credit_noted`); `post_payment` and `check_payment_allocation` already cap net of posted notes; `v_party_aging`, `v_party_balances`, `v_party_ledger` are journal-based. All proved by pgTAP, none needed changes.

## Revisit later (owner decisions of 2026-09-29, kept as built)

- **Part-paid invoice returns.** The reviewer recommends allowing a note larger than the unpaid part, with the excess becoming a customer credit (the views already handle a negative open amount; proved for the fully-paid case). Kept refused for now by owner decision.
- Value-only debit notes to Discount Received; refusal of a full return after a rate-difference note: kept.

## Later (logged, no code in this change)

- 40P01 (deadlock) / 40001 (serialization) are not mapped in `parseDbError`; they show as `internal`. A retry message would be kinder.
- GST Section 34(2) time limit: a credit note's tax can only be reduced if issued by 30 November after the FY end (or the annual return, if earlier). No date check today.
- Credit notes without GST (commercial / discount notes, no tax adjustment) are not supported; every note reverses tax.
- Rate-difference-then-return crediting (see item 5).
- The same draft-only lines trigger for `sales_invoice_lines` / `purchase_invoice_lines` (today only RLS protects them).

## Observations, not changed

- `post_payment` locks party → invoice, while `cancel_document` (and now the note functions) lock invoice → party. Two such calls at the same moment can deadlock; Postgres detects it and aborts one (no corruption, a retry succeeds). Pre-existing; not in this change's scope.
- Not covered by pgTAP: true concurrency (two sessions posting notes against one invoice line at the same moment). The design serialises them on the invoice row lock, which is taken before any cap is read.
- Not verified: behaviour on the hosted project (no push, per the brief).

## Screens (built 2026-10-01, Sonnet session; independently reviewed by a second Sonnet agent: APPROVE AFTER FIXES, all fixed)

- **Routes.** Credit: `/sales/credit-notes/new?invoice=<id>`, `/sales/credit-notes/[id]` (draft edit), `/sales/credit-notes/[id]/view`. Debit: the same under `/purchases/debit-notes/`. New/draft pages are owner-only (`requireOwnerPage`); the credit-note **view** is readable by any signed-in member (sales data, like an invoice; the Cancel button is owner-only); debit views sit under owner-only `/purchases`.
- **Entry points.** A "Credit notes" / "Debit notes" card (`NotesCard`) on the posted invoice / bill view lists every note against it and holds the `+ Credit note` / `+ Debit note` button (owner only). A "Credit notes" segment on the sales list (`?status=note`) and a "Debit notes" segment on the purchases list. A counter session sees posted/cancelled notes, never drafts.
- **Cancel blocks.** An invoice/bill with a posted note shows a warning and no Cancel button ("cancel the note first"; the DB's `has_notes` stays the backstop).
- **One form for both kinds** (`NoteForm`, `kind` switch; `notes.ts` actions `saveDraftNote` / `deleteDraftNote` / `postNote` / `cancelNote`, schema `src/schemas/notes.ts`). The person adds invoice lines from a chip list and types the quantity (value-only: also an amount per unit). Hints for "can return up to" / "value still adjustable" come from `loadNoteSource` (posted notes only), display only. **No totals or tax are shown or computed before posting** — the posted view shows what the database stored. The action writes the invoice line's snapshot columns and `taxable_value = 0`, party from the invoice, place of supply = the invoice's (credit) / our own state (debit).
- **Bug found by a unit test:** `remaining()` clamped with `compareDecimal` against a negative text (returns null) so a over-credited line showed a negative remaining value; now `signOf`.
- **Messages.** `notes` namespace (`notes.credit` / `notes.debit` for kind-specific text), `errors.field.*` + `errors.validation.*` for every `DN_VALIDATION` detail in the table above, en + te. `errors.validation.reason_required` reworded from "for unlocking" to a generic "Give a reason." because the note functions raise the same detail. `DN_NEGATIVE_STOCK` on a note **cancel** shows `validation.note_cancel_stock_moved`, not "not enough stock".
- **Verified.** tsc, lint 0 errors, vitest 674 (37 new: `notes.test.ts`, `notes-data.test.ts`), `npm run build`. Live browser walk (Playwright, owner with real TOTP + a counter): partial return of 0.5 kg posted, over-limit refused, draft save/reload, value-only note, "cancel later notes first" message, cancel newest then older (AR back to exactly 2,52,048.00), debit note on a bill (AP, stock, input tax all moved and restored on cancel), counter redirected from new-note pages and sees no button, 390 px and dark theme with no horizontal overflow, no console errors. pgTAP not rerun (no SQL changed).
- **Not built (log):** stand-alone notes with no invoice (credit notes without an invoice, value-only debit note with no bill) — every note starts from a posted invoice/bill; note PDF; the Section 34(2) date check; 40P01 retry message.
- **Review fixes (2026-10-01).** (1) A draft whose invoice/bill was cancelled afterwards used to bounce back to the invoice with no way to delete it; it now opens a "can no longer be posted" page with a Delete-draft button (`StaleDraft`), walked live. (2) The add-item chips no longer offer lines with nothing left to return/adjust. (3) Tests tightened (exact error assertions, "partial save" branch, no-insert on future date). Gates after fixes: tsc, lint 0 errors, vitest 675, build. Raised by the reviewer, not part of this change: a counter can already see stock cost rate/value on posted invoices (and so now on credit notes) - this is owner decision 1 ("stock cost hidden from counter", change 28), still open.
