---
name: daksh-posting
description: Posting-engine patterns for Daksha Nirmaan. Load whenever code touches money movement or stock math — post_*/cancel functions, new document types, journal entries, GST/tax computation, weighted-average cost, reversals — even for a "small" change to an amount or rounding, because a wrong posting corrupts the books silently. Trigger on "posting", "journal", "invoice", "voucher", "stock movement", "GST", "tax", "COGS", "reversal", "plpgsql".
---

# Daksha Nirmaan — Posting Engine

Contract: `openspec/specs/db-architecture/spec.md` (functions section) + worked examples in `docs/DESIGN.md` §3. Business math lives HERE (plpgsql), never in TypeScript — client totals are display previews only.

**Token rule:** your brief names one spec section — read that section only, plus `references/post-function-skeleton.sql` when writing a new function. Don't read other specs unless briefed.

## The post_* function pattern (every document type)

Start new functions from `references/post-function-skeleton.sql` — don't re-derive the pattern.
1. `SELECT ... FOR UPDATE` the document; assert `status = 'draft'` else RAISE `DN_NOT_DRAFT`.
2. Role check (**actor = `auth.uid()` inside the function — never a parameter**; look up `app_users.role`): user may post sales invoices + receipts + advances ≤ ₹5,000; everything else admin. RAISE `DN_FORBIDDEN`.
3. Assert entry date in unlocked `fiscal_periods` else RAISE `DN_PERIOD_LOCKED`.
4. Recompute money from line snapshots — never trust stored totals from the client.
5. Assign document number NOW via `next_doc_no()` (row-locked, gapless per FY series) — never at draft time.
6. Insert `journal_entries` + `journal_lines` (Σdebit = Σcredit — deferred trigger verifies), `stock_movements` if goods moved.
7. Update document: `status='posted'`, `journal_entry_id`, computed totals.
8. Insert `audit_log` row. Return `journal_entry_id`.

## Tax determination
`place_of_supply = org.state_code` → CGST+SGST (rate/2 each); else IGST. Rates come from the **line snapshot** (`gst_rate`), not the item master. Round-off: grand total rounded to whole rupee, difference → `round_off` account (max ±₹0.50 sanity check).

## Stock valuation (weighted moving average)
- IN (purchase): `new_avg = (on_hand_value + line_value) / (on_hand_qty + qty)`; movement stores rate + value.
- OUT (sale): COGS = qty × current avg; journal gets Dr `cogs` / Cr `inventory`; RAISE `DN_NEGATIVE_STOCK` if on-hand would go below zero (admin override flag param).
- Qty always in item's `base_uom` (TMT = kg); alt-qty (pieces) stored on the line for display.

## Cancellation = reversal, never delete
`cancel_document`: post a mirror-image journal entry + opposite stock movements, link `reversed_by`, set `status='cancelled'`. Original number stays (GST requires reporting cancelled numbers).

## Special flows
- Receipt with cash discount: Dr cash/bank + Dr discount_allowed / Cr AR(party).
- Employee advance: Dr `employee_advance`(party=employee) / Cr cash. Salary: Dr salary expense / Cr advance recovered + Cr cash net.
- RCM freight (GTA 5%): expense line flags `rcm` → additionally Cr `rcm_payable`, Dr input GST.
- Credit note: proportional reversal of revenue + tax; stock back IN at the original issue cost, not current avg.

## Error codes (map to API envelope)
`DN_NOT_DRAFT, DN_FORBIDDEN, DN_PERIOD_LOCKED, DN_NEGATIVE_STOCK, DN_UNBALANCED, DN_CREDIT_LIMIT`

## Done means
The db-architecture acceptance scenarios pass + a pgTAP test per new function covering: happy path, each RAISE, idempotency (second post attempt fails cleanly).
