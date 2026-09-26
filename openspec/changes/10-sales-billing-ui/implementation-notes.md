# Change 10a — sales billing UI: implementation notes

Status: built, all gates green, **not committed, not pushed**. No migration or posting function was touched.

## What was built
- **Routes**: `/sales` (list), `/sales/new` and `/sales/[id]` (same `InvoiceForm`), `/sales/[id]/view` (posted / cancelled record).
- **Actions** `src/app/actions/sales.ts`: `saveDraftInvoice`, `deleteDraftInvoice`, `postInvoice`, `postCashSale`, `cancelInvoice`. Schemas in `src/schemas/sales.ts`. Loader `src/lib/sales-data.ts`; shapes `src/lib/sales-types.ts`.
- **Exact math**: `src/lib/decimal.ts` (BigInt scaled decimals), `src/lib/invoice-math.ts` (preview), `src/lib/units.ts` (pcs to kg and back).
- **UI**: `src/components/sales/{InvoiceForm,LineRow,TotalsPanel,CancelInvoice,RowLink}.tsx`; new shared primitives `ui/Picker.tsx` (searchable dialog chooser, used for customer and item) and `ui/DateField.tsx` (DD-MM-YYYY text field, ISO on the wire). Styles appended to `globals.css` (tokens only, both themes).
- **Messages**: `sales` namespace plus new `errors.*` keys, English and Telugu (parity test passes). Four existing shared error messages were made more specific (`period_locked`, `negative_stock`, `not_draft`, `has_allocations`).
- **Shared code touched**: `parseDbError` (a `journal_lines_check` violation becomes `validation` / `zero_total`), `src/test/harness.ts` (delete op and a few more chain methods).

## Rounding rules mirrored (from `_post_sales_invoice`, migration 20260918140100)
`round()` is Postgres numeric round: half away from zero.
1. per line: `taxable = round(qty * rate * (1 - discount_pct/100), 2)`
2. intra-state (place of supply = organisation state): `cgst = round(taxable * gst_rate / 2 / 100, 2)`, `sgst = cgst`, `igst = 0`
3. inter-state: `cgst = sgst = 0`, `igst = round(taxable * gst_rate / 100, 2)`
4. tax is rounded per line, then summed; `raw = sum(taxable)+sum(cgst)+sum(sgst)+sum(igst)`
5. `grand = round(raw)` (whole rupees), `round_off = grand - raw`; the database raises `DN_UNBALANCED` if `|round_off| > 0.50` (cannot happen with rule 5).
6. Non-stock lines (freight) use the same maths and go to `freight_recovered`; stock lines go to cement / steel / other by item category. COGS is weighted-average at post time and is never previewed.

Proof: `src/lib/invoice-math.test.ts` (13 hand-computed cases incl. TMT, half-paisa tie, half-rupee tie, negative round-off, 12.50% GST, discount 3.25%, a Rs 128 crore bill) and a real-database check: `node openspec/changes/10-sales-billing-ui/parity-check.mjs` posts 13 cases (single and multi-line, intra and inter, category mix, up to 12 lines) through the **real** `post_sales_invoice` in a rolled-back transaction and compares stored totals and per-line taxable values with the preview. Result: all 13 equal. It is a documented manual step, not a dependency of build or tests. It also found the zero-total gap below.

## DN code to message map (all in `errors`, en + te)
| Database says | Code | Sentence shown |
|---|---|---|
| DN_FORBIDDEN | forbidden | You do not have permission to do this. |
| DN_PERIOD_LOCKED (locked **or missing** month) | period_locked | That month is locked, or not set up for accounting. Ask an owner. |
| DN_NEGATIVE_STOCK | negative_stock | There is not enough stock in the godown for one of the items. Reduce the quantity. |
| DN_CREDIT_LIMIT | credit_limit | This would go over the party's credit limit. (owner also gets the Override dialog) |
| DN_NOT_DRAFT (also raised when the invoice does not exist) | not_draft | This is no longer a draft. It may already be posted or cancelled. |
| DN_NOT_POSTED | not_posted | This is not posted, or it is already cancelled. |
| DN_HAS_ALLOCATIONS | has_allocations | A payment is already recorded against this, so it cannot be cancelled. Cancel that payment first. |
| DN_UNBALANCED / DN_NO_PERIOD | unbalanced / no_period | existing sentences |
| DN_VALIDATION:no_lines, invalid_party, invalid_account, no_cost_basis, missing_account, no_sequence | validation | one plain sentence each (`errors.validation.*`) |
| journal check violation (zero total) | validation / zero_total | The invoice total is zero. Enter a rate, or remove the empty item. |
| 22003 | validation / number_too_large | That number is too large. |
| stale `updated_at` (action-level) | conflict | Someone else changed this invoice while you were editing. Reload it... |
| lines could not be restored after a failed replace | partial | The invoice may not have been fully saved. Reload it and check the items... |
| DN_CONVERTED (challan) | internal | not mapped: unreachable until change 11 |

## How the pieces behave
- **Save draft** (any active member): inserts or updates the header (stale guard: `where updated_at = <loaded value> and status = 'draft'`, 0 rows = `conflict`) then replaces the lines. The action snapshots item name / HSN / uom / GST rate **from the items table at save time** and both addresses (billing = the `is_default` address, shipping = chosen site or billing) as jsonb. No total is ever sent or stored by the app (asserted in a test and in the browser: the request body carries no totals).
- **Post** and **Post as cash sale** both save the draft first (so snapshots are fresh), then call `post_sales_invoice` / `post_cash_sale` on the user-scoped client, after a confirmation dialog. Number, journal, stock movements and totals all come from the database; the form then navigates to the posted view, which shows stored values.
- **Override**: `postInvoice({overrideCredit:true})` is refused with `forbidden` for a counter user (not silently downgraded); only a verified owner is shown the "Post anyway" dialog after a `credit_limit` refusal.
- **Cancel**: owner only (`requireAdmin`; DB also admin-only), reason required (3-200 chars, kept in `audit_log.after.reason`). The button is hidden when a posted receipt is allocated to the invoice, because the database would refuse.
- Saves deliberately do **not** `revalidatePath`: a revalidate re-renders the current route, and after the first save the address bar is already `/sales/<id>`, which swapped the form out from under the user and lost an error message (found in the browser walk-through). Pages are dynamic, so nothing goes stale. Post / cancel / delete do revalidate.

## Conservative defaults (owner unknowns, as briefed) and additional ones taken
1. Any active member creates, edits and posts; cancel is owner-only (what the database allows).
2. Over-limit credit sales are refused; only an owner can override, by a deliberate second click. NULL limit = no limit, 0 = no credit (per change 09).
3. Walk-in customer: "Post as cash sale" is the primary button.
4. Date defaults to today (organisation time zone); back-dating allowed within an open period; future dates refused (form and action).
5. Rate and discount editable by every member. **Owner question: should counter staff be price-locked?**
6. Drafts have no number ("Draft" in the list; "Number is given when you post").
7. Only active customer / both parties and active items are offered. An existing draft keeps a party or item disabled since (it stays selectable and savable).
Additional, mine:
- A draft needs at least one line to be saved (an empty draft is not useful and would need a "no lines" state).
- Cancel needs a typed reason. Cash sales ask for the account (Cash or Bank / UPI: the two seeded `is_money` accounts) in the confirm dialog, Cash pre-selected.
- Posting always asks for confirmation (one extra tap) because only an owner can undo it.
- Vehicle number is stored upper-case.
- Drafts show "—" as total in the list (the database stores 0 until post; the form preview is not repeated in the list).
- List shows the latest 200 rows with a hint; segments are All / Invoices (posted + cancelled) / Drafts. Challans and Credit notes segments come with their own changes.
- On-hand hint per line is the **default godown** only, display only.
- Amount in words is not built (not required for 10a; belongs to the PDF in 10b). Literal tax labels `CGST`/`SGST`/`IGST`/`HSN`/`GST` and the `DD-MM-YYYY` placeholder are not translated (statutory / format terms).

## Verified (gates)
- `npx tsc --noEmit` clean; `npm run lint` 0 warnings; `vitest`: **203 tests, 20 files** pass (new: 21 invoice-math/units, 24 sales action tests, +1 action-result); `npm run build` clean; `supabase test db` on a clean reset: **802 pass**.
- Real-browser walk-through (playwright-core + Chrome, 1280 and 390 px, light and dark, Telugu): **112 checks, 0 failures** across the full clean run. Covered: draft create / edit / reload, stale-save conflict, pcs to kg both ways, preview == stored, DOM-tamper (no totals in the request; stored total used), post with number DN/26-27/0001, journal + stock effect from views, credit_limit refusal, owner override (audit `override: true`), counter sees refusal and no override / no cancel / no Settings, cash sale into Bank and into Cash, cancel by reversal (banner, no button, reversal entry, stock restored, reason in audit), cash sale cancel blocked with explanation, IGST invoice, non-stock line, negative_stock refusal, zero total, future date, impossible date, period lock, delete draft, list search / segments / hostile search text / Enter on rows, Escape closes dialogs and returns focus, phone flows for a walk-in cash sale and a credit sale by touch (no sideways scroll on any step, all tap targets >= 44 px, action bar clear of the tab bar).
- Screenshots inspected and fixed after seeing them: picker Escape needed two presses (search input clears first: switched to a text box); Override dialog never appeared (a programmatic dialog close fired `onClose` and reset the state: per-dialog guarded `onClose`); place-of-supply select truncated; transport disclosure had no caret; address text read "Head office:, Plot 9" (fixed); payment showed "Bank . Bank"; list total was off-screen at 390 px (date and status now fold under number and party on phones); redundant green + red banners on a just-cancelled invoice.
- The Next dev overlay's "1 Issue" seen in phone screenshots is a hydration warning about `style="caret-color: transparent"` that Playwright's touch emulation injects into search inputs. Not app code.

## Could NOT verify
- `allow_negative_stock = true` behaviour for an owner (setting is off; DB branch untouched).
- Real phone hardware (only Chrome emulation); PWA/offline.
- Hosted Supabase (nothing pushed).
- Concurrent posting of the same draft from two tabs (relies on the database row lock; only the stale-save path was exercised).
- The action tests use the mock client; the browser walk-through is what exercised RLS for drafts as admin and as counter.

## Database observations (nothing patched)
1. **Zero-total invoice posts fail with a raw check violation** (`journal_lines_check`, SQLSTATE 23514: the AR line has debit 0) instead of a `DN_VALIDATION:zero_total`. UI blocks it before posting and the action maps the violation to a friendly message, so users never see it, but a `DN_VALIDATION` raise in `_post_sales_invoice` would be cleaner.
2. **A cash sale cannot be cancelled** until its receipt is cancelled (`DN_HAS_ALLOCATIONS`), and there is no receipt-cancel screen yet (payments change). Owners meeting a wrong cash sale have no in-app route today. **Owner question / hand-off:** which change delivers cancel-receipt, and should `cancel_document` be allowed to reverse a cash sale together with its receipt?
3. **No atomic "replace draft lines" function.** Saving a draft is header update + delete lines + insert lines over three PostgREST calls, with a compensating re-insert if the insert fails (and a `partial` error if that too fails). A `save_sales_draft(jsonb)` function (one transaction) would remove the window. Not blocking.
4. `sales_invoices` has no column for the chosen delivery site, only the `shipping_address` jsonb snapshot; the edit form re-derives the chip by matching label + line1 + pincode. Adding `ship_to_address_id` would be more robust.
5. `DN_NOT_DRAFT` is also raised when the invoice id does not exist; the UI message covers both.
6. `DN_CONVERTED` (challan already invoiced) is not in `parseDbError`; add it with change 11.

## 10b hand-off
PDF route (`/api/invoices/[id]/pdf`), WhatsApp share link, print layout, EWB panel (vehicle number and transporter are plain fields now; `distance_km`, `transport_mode`, `transporter_gstin`, `ewb_*` columns are untouched), UPI QR on the totals panel, amount in words, "against challan" (change 11, needs `challan_id` and the challan screens), credit notes segment, receipt-cancel path for cash sales (see 2), optional `save_sales_draft` RPC (see 3). The posted view already has the header area where PDF / WhatsApp / Print buttons belong.

## Review
Not yet reviewed. Per the brief: screens and actions to a Sonnet reviewer with `daksh-review`; the parts that decide how totals reach the database and the credit override (`saveDraftInvoice`, `postInvoice`, `postCashSale`, the override path in `InvoiceForm`) to Opus. Ask Ratna before launching.

## Files
Added: `src/app/actions/sales.ts`, `src/app/actions/sales.test.ts`, `src/app/(app)/sales/new/page.tsx`, `src/app/(app)/sales/[id]/page.tsx`, `src/app/(app)/sales/[id]/view/page.tsx`, `src/components/sales/*`, `src/components/ui/Picker.tsx`, `src/components/ui/DateField.tsx`, `src/lib/{decimal,invoice-math,invoice-math.test,units,sales-data,sales-types}.ts`, `src/schemas/sales.ts`, `openspec/changes/10-sales-billing-ui/{implementation-notes.md,parity-check.mjs}`.
Changed: `src/app/(app)/sales/page.tsx` (placeholder replaced), `src/app/globals.css`, `src/messages/{en,te}.json`, `src/lib/action-result.ts` + test, `src/test/harness.ts`.

## Review fixes (Opus review of 10a)

Migration `supabase/migrations/20260925110000_posting_snapshot_warehouse_guards.sql`, pgTAP `supabase/tests/database/00019_posting_snapshot_warehouse_guards.test.sql` (25 tests). The functions are CREATE OR REPLACE on their existing signatures. Each body is carried over verbatim from its source migration, generated by exact-match substitution, not retyped. SECURITY DEFINER, `search_path` and ACLs were re-checked in `pg_proc` after the reset and are unchanged. Lock order is unchanged: the new UPDATEs touch only the document's own line rows, after the item locks.

**Finding 1: snapshots trusted from client-writable columns (MAJOR).** Each post function that owns item lines now re-copies `item_name, hsn_code, uom (= items.base_uom), gst_rate` from `items` right after locking the item rows, before anything is computed. Tax is then computed from those values.
- Design: post-time overwrite, with **no** BEFORE INSERT/UPDATE snapshot triggers. The rule says to snapshot at post time. A save-time trigger would still need the post-time copy, because the master can change between saving and posting. It would only make a tampered draft's preview agree with the master, and no number depends on the preview. The overwrite cannot be bypassed: a line becomes financial only through these SECURITY DEFINER functions, and after posting RLS refuses every line write.
- Composite-supply freight: the spec said the function "trusts the line's gst_rate" for non-stock lines. That was exactly the hole. Non-stock lines now take the freight item's own master rate. This matches what `sales.ts` already writes. `openspec/specs/db-architecture/spec.md` was updated in the same change (rule 3).
- `_post_sales_invoice` also refuses `qty <= 0` (`invalid_qty`), `rate < 0` (`invalid_rate`) and `discount_pct` outside 0..100 (`invalid_discount`). No table CHECK bounds these client-writable inputs. A negative qty became a stock-in with no Inventory debit.

Survey, table by table:
| Line table / path | Verdict |
|---|---|
| `sales_invoice_lines` / `_post_sales_invoice` (covers `post_sales_invoice` and `post_cash_sale`) | **Fixed**: snapshot overwrite plus qty/rate/discount checks |
| `delivery_challan_lines` / `post_delivery_challan` | **Fixed**: snapshot overwrite. The challan's `gst_rate` moves no money, but the challan is a GST document that prints it. Qty already had a CHECK. `rate`/`discount_pct` only feed the display `value` (the EWB threshold): left alone. |
| `purchase_invoice_lines` / `post_purchase_invoice` | **Fixed**: snapshot overwrite. Only master facts are overwritten: a tampered `gst_rate` could otherwise inflate input-tax credit. `rate` and `discount_pct` are the supplier's bill and stay user inputs. Qty was already checked. Admin-only. |
| `stock_transfer_lines` / `post_stock_transfer` | **Fixed**: `item_name`, `uom` re-copied. Display only, no money. |
| `stock_adjustment_lines` / `post_stock_adjustment` | **Fixed**: `item_name` re-copied. `rate` is a user input by spec (NULL = average) and is already guarded. |
| `credit_note_lines`, `debit_note_lines` | **No posting path exists yet.** The change that adds `post_credit_note` / `post_debit_note` must copy the same UPDATE. A credit note's rate should come from the original invoice line's snapshot, not from `items`. |
| `expense_voucher_lines` | No item snapshot. `account_id` and `amount` are inputs. Not in scope. |

**Finding 2: In Transit warehouse on a draft header (MAJOR).** `_post_sales_invoice` and `post_purchase_invoice` now raise `DN_VALIDATION:invalid_warehouse` when the header warehouse `is_transit`. `post_delivery_challan`, `post_stock_adjustment` and `post_stock_transfer` already refused it with `DN_VALIDATION:transit_warehouse`. They keep that detail so their tests stay unchanged, and both details now have en and te messages.

**Minor items (all done):**
- `record_invoice_ewb` refuses `p_ewb_date < invoice_date` (`DN_VALIDATION:ewb_before_invoice`, with en and te messages).
- New CHECK constraints on `sales_invoices`: `transport_mode`, `distance_km`, `transporter_name`, `transporter_gstin`, `vehicle_no` (same shapes as `record_invoice_ewb` and the zod schema). The e-way-bill triple must be all-or-none, 12 digits, and not before the invoice date. It is **not allowed on a draft at all**, because it is only ever recorded on a posted invoice via `record_invoice_ewb`. This makes direct PostgREST writes to a draft fail with 23514. The demo seed and all existing tests conform.
- `_post_sales_invoice` raises `DN_VALIDATION:zero_total` when the recomputed grand total is `<= 0`. `parseDbError`'s `journal_lines_check` mapping stays in place as a backstop. Both map to the same `zero_total` message.

**Gates:** `supabase db reset` + `supabase test db`: **1010 tests / 18 files** pass (was 985 / 17). `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` 362 / 29 pass. These app gates ran on a tree that includes the concurrent app-side edits.

**Not done / open:**
- `place_of_supply` on the draft header is also client-writable and decides CGST+SGST vs IGST. The total tax is the same either way, but the split and the GSTR bucket are not. It was not constrained because a place of supply can legitimately differ from the party's state (the shipping site). Candidate rule: it must equal the state of the billing or shipping snapshot. **Owner / review question.**
- The `invalid_discount` message reads "Discount cannot be negative", which is shared with payments. It is accurate enough for the >100% case and was left unchanged.
- The `daksh-posting` skill still says "Rates come from the line snapshot, not the item master". That stays true (tax is computed from the line, which is now snapshotted at post time), but the skill could say so explicitly.
- Nothing was pushed to hosted. Hosted needs this migration after 20260925100000.
