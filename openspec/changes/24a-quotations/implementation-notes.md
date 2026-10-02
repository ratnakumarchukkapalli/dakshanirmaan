# 24a quotations: implementation notes (DB half)

Built 2026-10-02 (Opus, DB half only; `src/` untouched). An independent Opus review returned APPROVE AFTER FIXES; fixes 1–7 are applied in place in the same uncommitted migration and in 00037 (see "Review fixes"). The app half (Sonnet) builds against the contract table at the end.

## What was built
- `supabase/migrations/20261009100000_quotations.sql` (one file; `source_type 'quotation'` already existed):
  - **Tables** `quotations` and `quotation_lines`, described in the spec section and in the proposal (item 1). Header columns: `quote_no UNIQUE`, `quote_date`, `party_id`, `warehouse_id`, `place_of_supply`, `valid_until (>= quote_date)`, `status`, `converted_invoice_id`, `converted_at`, `note (<= 500)`, `updated_at`, `created_by`. CHECKs: status is `converted` exactly when `converted_invoice_id` is set, and `converted_at` is set exactly when `converted_invoice_id` is set. Lines carry the snapshot columns `item_name`, `hsn_code`, `uom` (= base_uom) and `gst_rate`, plus `qty (12,3) > 0`, `alt_qty`, `rate (14,4) >= 0`, `discount_pct 0..100` and `UNIQUE(quote_id, line_no)`. They store no tax amounts. Triggers are `set_created_by` and `touch_updated_at`. The FK to `items` is NO ACTION, so a quoted item can't be deleted, and change 26's guarantee still holds.
  - **RLS:** members read (`is_active_member()`). There's no INSERT, UPDATE or DELETE grant for `authenticated`. Every write goes through the three definer functions. `service_role` keeps table DML, matching `cash_deposits`.
  - **Guards** (they fire for every writer, including definer functions and the DB owner):
    - `quotations_guard`: a quote can never be deleted (`quote_no_delete`), and `quote_no` and `created_at` never change.
    - A converted quote is immutable (`quote_converted`). The one exception is below.
    - `quotation_lines_guard`: lines change only while the quote is `open` (`quote_not_open`).
  - **Views** `v_quotation_lines` (per-line taxable/CGST/SGST/IGST) and `v_quotations` (totals, round-off, `effective_status`, party name, converted invoice no/status). Both are `security_invoker`, and only `authenticated` can SELECT them.
  - **Functions** `save_quotation`, `mark_quotation` and `convert_quotation_to_invoice`. All are SECURITY DEFINER with `search_path = public, pg_temp`. Each is revoked from public, anon and service_role and granted to `authenticated`, and each writes an `audit_log` row.
- `supabase/tests/database/00037_quotations.test.sql`: 147 assertions, listed under Gates.
- `supabase/tests/database/00008_read_views.test.sql`: the view count went from 25 to 27, as change 22 did when it added its views. No other existing test changed.

## Decisions and conservative defaults
1. **Function-only writes, not RLS inserts.** This puts the server-side snapshot, the stale-write check, the replacement of all lines and the number assignment in one transaction. It also means "nobody writes a converted row except the conversion" holds by construction. Verdict: keep.
2. **Totals helper was not extracted from `post_sales_invoice`.** Its tax arithmetic sits in the same loop as the stock-out and COGS logic, so extracting it would mean rewriting the posting function. Instead, `v_quotation_lines` repeats its four expressions verbatim (taxable = `round(qty*rate*(1-disc/100),2)`, CGST = SGST = `round(taxable*gst/2/100,2)`, IGST = `round(taxable*gst/100,2)`; grand = `round(raw)`, round-off = grand - raw). 00037 converts an intra-state quote and an inter-state quote, posts both invoices through `post_sales_invoice`, and asserts that the header totals and every line's amounts are equal. **Anyone who changes the invoice tax arithmetic must change the view too; 00037 will fail if they don't.**
3. **Place of supply** follows the invoice form's rule, implemented once in the internal `quote_supply(party)` (no client EXECUTE). The delivery site is the party's `default_site_id` when it points at a non-billing address. Place of supply is the site's state, else the default (billing) address's state, else the party's own state. Billing is the default address, and shipping is the site, else billing. The value is stored on the quote at every save. Conversion derives it again and refuses a mismatch with `quote_pos_changed`: an address or site changed since the quote was priced, so the user re-saves the quote and sees the new totals. I chose this over deriving it live in the view, so the quote keeps showing the tax head it was priced on.
4. **QT numbering** (side effect: the first QT number of any FY sets `doc_sequences.next_no > 1`, so from then on `organization_guard` locks the organisation's state and FY start month, exactly as the first invoice does): `next_doc_no('QT', quote_date)`, assigned at the first save. The `QT` row in `doc_sequences` is created lazily per FY inside `save_quotation` (`insert … on conflict do nothing`). It is not seeded, because 00003 asserts exactly ten seeded series and a seed would only cover one FY anyway. A new FY therefore gets the series on its first quote (`QT/yy-yy/0001`). Numbers are never reused. A save that fails rolls its number back, so the series is also gapless in practice.
5. **Dates:**
   - `quote_date` can't be in the future (org time zone), and can't be more than 365 days back (`invalid_date`), so an old date can't open an arbitrary FY's series.
   - `valid_until` defaults to `quote_date + 7` and may be at most `quote_date + 365`.
   - An edit may not move the date into another FY (`quote_fy_change`), because the number carries the FY.
6. **Editing:** only a stored-`open` quote can be edited, and that includes one whose validity has already passed. Extending `valid_until` is how a quote is renewed. An accepted quote must be moved back to open first.
7. **Inactive item or party:** refused at every save, including the edit of an old quote, and again at conversion. This is stricter than the draft invoice, which keeps an already-present inactive item. A quote has no history worth preserving that way. The item or party name goes in the Postgres error `DETAIL` (PostgREST `details`), so the `DN_VALIDATION:<code>` message stays parseable.
8. **Zero and oversized quotes are refused**, using the view's own arithmetic:
   - A grand total of zero after rounding to the rupee is refused (`zero_total`). Examples: rate 0, or 0.4 × ₹1 at 0% GST. The invoice it would become can't post.
   - A line whose taxable value reaches 10^12, or a grand total that reaches 10^12, is refused (`amount_too_large`). Without this, `v_quotations`' `numeric(14,2)` casts could raise an overflow error for every reader.
9. **Pieces** (`alt_qty`) are kept only for items that have an `alt_uom`. They're dropped silently otherwise, as in the invoice form.
10. **Marking:**
    - Allowed transitions: `open ↔ accepted`, and `open|accepted → expired`.
    - `expired` is final (`invalid_transition`). Nobody sets `converted` by hand (`invalid_status`), and a converted quote can't be marked (`quote_converted`).
    - Accepting a quote past its validity is refused (`quote_expired`). `accepted → open` is always allowed, and the later edit re-validates `valid_until`.
    - Marking the status a quote already has is a no-op: no audit row, and it returns the current `updated_at`.
    - Marking takes no `updated_at` (it matches the proposal's two-argument signature). A status move doesn't overwrite content, so last-writer-wins is acceptable here.
11. **Conversion:**
    - Allowed from `open` or `accepted`. Refused when the quote is stored `expired` or its `valid_until` is before today in the org time zone (both raise `quote_expired`).
    - The draft invoice is dated today. It writes the columns `saveDraftInvoice` writes: party, warehouse (the quote's; refused if it's the transit warehouse), and `status 'draft'`, with `created_by` stamped by the trigger. Place of supply, billing (the default address) and shipping (the default site, else billing) come from `quote_supply`, using the same keys as the app's `snapshot()`. If the freshly derived place of supply differs from the quote's, conversion is refused (`quote_pos_changed`).
    - Lines use the quoted qty, pieces, rate and discount, with name, HSN, UOM and GST copied from the current item master. `post_sales_invoice` re-copies these at posting anyway.
    - Nothing posts. Credit limit and stock checks happen at posting as usual.
12. **Concurrency and idempotency:** the quote's row lock (`FOR UPDATE`) serialises callers. Once a quote is converted, any later call returns the same `converted_invoice_id`. I checked this by hand on the local stack with two sessions: A converts and sleeps 2 s before committing, and B runs meanwhile. B blocked, then returned A's invoice id, and exactly one invoice existed. 00037 covers the sequential repeat.
13. **Added beyond the brief: deleting the draft invoice re-opens the quote.** `converted_invoice_id` is `ON DELETE SET NULL`. When the draft is deleted (a member may delete drafts), the guard turns the quote back to `accepted`, clears `converted_at`, and writes an audit row (`action 'reopen'`). It allows that transition only when the referenced invoice is really gone and nothing else on the row changed. Without this, either the draft could never be deleted (an FK RESTRICT would surface a raw 23503), or the quote would point at nothing. Once the invoice is posted, the link is permanent, because a posted invoice can't be deleted. A cancelled invoice leaves the quote `converted`.
14. **v_attention:** I skipped the "quotes expiring within 2 days" row. The view has nine UNION branches, and adding one means re-creating the whole view, which is more than a one-line change. Expiry is shown through `v_quotations.effective_status`, and the app can tile "expiring soon" from `valid_until`.
15. Any active member (counter included) creates, edits, accepts and converts quotes. No stock is reserved, no cost or margin is stored or shown, and there's no portal or e-signature. These are the proposal's defaults, kept as written.

## Review fixes (2026-10-02, APPROVE AFTER FIXES)
1. The place of supply and shipping follow the default delivery site (item 3 above). A pgTAP case covers a party billed in the org state with a Telangana default site: the quote and the converted draft are inter-state with IGST, shipping is the site, billing is the head office. The posted converted invoice equals a hand-made invoice for the same lines, and both equal the quote.
2. Overflow cap (`amount_too_large`), tested with the largest qty × the largest rate, and with two lines that are each under the cap but whose grand total reaches 10^12.
3. A zero grand total after rounding is refused (0.4 × ₹1 at 0% GST).
4. `quote_pos_changed` at convert. Tested: the quote stays open, and re-saving re-derives the place of supply and the quote then converts.
5. `accepted → open` is allowed past validity; accepting again is refused until an edit renews `valid_until`.
6. `quote_date` can be at most 365 days back.
7. New pgTAP:
   - FY boundary, using the latest 1 April and the day before (computed from today): 31 March opens the previous FY's series at 0001, and 1 April continues the current one. Edits in either direction across the boundary are refused.
   - The DB owner setting `converted_invoice_id = null` while the invoice exists raises `quote_converted`.

## Gates (2026-10-02)
`supabase db reset` (empty database, no seed file) then `supabase test db`: **37 files, 2900 tests, all pass** (after the review fixes; 00037 now has 178 assertions). That includes 00026 (catalog guard) and 00033 (items FKs NO ACTION).

00037 (originally 147 assertions, now 178 with the review-fix cases above) covers:
- shape, RLS, and grants (no direct DML, anon has no EXECUTE)
- the counter user creating a quote with snapshots (client name/GST ignored), the number, and created_by
- the worked intra-state totals (taxable 64,425.27, CGST = SGST 7,598.27, round-off +0.19, grand 79,622) and inter-state IGST 15,196.55
- every save refusal (supplier, inactive party, inactive or unknown item, future date, validity before date or over a year, note length, no lines, qty, rate and discount format, zero total)
- the 7-day default validity
- the stale write (`DN_CONFLICT`, including a null `updated_at`), a successful edit replacing lines, and a refused edit changing nothing
- per-FY numbering, the FY-change refusal, and effective expiry with no job
- non-member, deactivated user and owner at aal1 seeing and doing nothing
- the mark transitions and their audit rows
- the counter user converting: draft invoice shape and lines, repeat convert returning the same invoice, one invoice in total
- the converted quote being immutable, even for the DB owner; no quote ever deleted
- expired refused (marked expired, and stored open but past its date), inactive item or party refused at convert
- the owner converting an accepted inter-state quote with the address snapshot
- zero journal entries and stock movements from quote operations
- both converted invoices posting with totals and lines equal to the quote's
- draft delete re-opening the quote, and the quote converting again

## Open
- Review (Opus or Fable) before the commit and the hosted `db push`.
- App half: map `DN_CONFLICT` → `conflict` in `src/lib/action-result.ts`. It isn't mapped today and would surface as `internal`.
- Spec: record items 3, 4 (including the `organization_guard` side effect), 5, 7, 8, 10, 11 and 13 under "quotations + quotation_lines" when the change is closed. I added no spec paragraph in this change.

## Contract for the app half

All three functions are called with `supabase.rpc(...)` as the signed-in user. "Member" means `is_active_member()`: an active `app_users` row, and aal2 for an owner. A counter user (`user`) may do **everything** in this table. Errors arrive as Postgres `RAISE` messages, `DN_FORBIDDEN`, `DN_CONFLICT` or `DN_VALIDATION:<detail>`. For `item_inactive` and `invalid_party`, the offending name is in the error's `details`.

| Object | Args | Returns | Errors | Counter user |
|---|---|---|---|---|
| `save_quotation` | `p_id uuid \| null` (null = create), `p_expected_updated_at timestamptz \| null` (required on edit: the `updated_at` last read or returned), `p_party_id uuid`, `p_quote_date date`, `p_valid_until date \| null` (null = date + 7), `p_note text \| null` (trimmed, ≤ 500), `p_lines jsonb`: array of 1–100 `{item_id, qty, rate, discount_pct?, alt_qty?}`. Numbers may be JSON numbers or decimal strings: qty ≤ 3 dp > 0, rate ≤ 4 dp ≥ 0, discount 0–100 ≤ 2 dp. Name, HSN, UOM and GST are taken from `items`; anything else sent is ignored. | `jsonb {id uuid, quote_no text, updated_at timestamptz}` | `DN_FORBIDDEN`; `DN_CONFLICT` (stale or missing `updated_at`); `DN_VALIDATION:` `invalid_date`, `future_date`, `valid_until_before_date`, `valid_until_too_far`, `note_too_long`, `amount_too_large`, `no_such_quote`, `quote_not_open`, `quote_fy_change`, `invalid_party`, `no_default_warehouse`, `no_lines`, `too_many_lines`, `invalid_line`, `no_such_item`, `item_inactive`, `invalid_qty`, `invalid_rate`, `invalid_discount`, `invalid_alt_qty`, `zero_total` (grand total rounds to 0) | yes: create and edit (open quotes only) |
| `mark_quotation` | `p_quote_id uuid`, `p_status text` (`'open'`, `'accepted'` or `'expired'`) | `timestamptz` (the quote's new `updated_at`; unchanged on a no-op) | `DN_FORBIDDEN`; `DN_VALIDATION:` `invalid_status`, `no_such_quote`, `quote_converted`, `invalid_transition` (from expired), `quote_expired` (accepting past validity; `accepted → open` is always allowed) | yes |
| `convert_quotation_to_invoice` | `p_quote_id uuid` | `uuid`: the **draft** `sales_invoices.id` (the same id on every repeat call). Open `/sales/<id>`. | `DN_FORBIDDEN`; `DN_VALIDATION:` `no_such_quote`, `quote_expired`, `invalid_party`, `invalid_warehouse`, `no_lines`, `item_inactive`, `quote_pos_changed` (re-save the quote) | yes (posting the invoice keeps the normal rules) |
| `v_quotations` (view, read) | filter by `id`, `party_id`, `status` / `effective_status`, `quote_date` | `id, quote_no, quote_date, valid_until, status, effective_status ('expired' once valid_until < today and status is open/accepted), party_id, party_name, party_gstin, warehouse_id, place_of_supply, is_intra, note, converted_invoice_id, converted_at, converted_invoice_no, converted_invoice_status, line_count, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, created_by, created_at, updated_at` | none (non-members get 0 rows) | yes, read |
| `v_quotation_lines` (view, read) | filter by `quote_id`, order by `line_no` | `id, quote_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct, taxable_value, cgst_amt, sgst_amt, igst_amt` | none | yes, read |
| `quotations` / `quotation_lines` (tables) | read-only | the raw rows (no totals) | direct INSERT, UPDATE or DELETE → `42501` | read only |

Notes for the app:
- Show totals only from `v_quotations` and `v_quotation_lines`. TypeScript arithmetic is for live form previews only.
- There's no delete call. An unwanted quote is `mark_quotation(id, 'expired')`.
- After a convert, `converted_invoice_status` tells "converted, draft" apart from "converted, posted". If the user deletes that draft, the quote comes back as `accepted` and can be converted again.
- Quotes never touch journals, stock or the `DN` series. Nothing on the quote screens needs a period or stock check.

## App half

Built 2026-10-02 (Sonnet, `src/` only; no migration, pgTAP or database change). Not committed. No browser walk yet (the coordinator does it).

### What was built
- `src/schemas/quotes.ts` (`saveQuoteSchema`, `markQuoteSchema`, `quoteIdSchema`): lines reuse `invoiceLineSchema`; money, qty and rates are strings; wire dates are ISO. Also checks `valid_until >= quote_date` and that an edit carries `expectedUpdatedAt`.
- `src/app/actions/quotes.ts`: `saveQuote` → `save_quotation`, `markQuote` → `mark_quotation`, `convertQuoteToInvoice` → `convert_quotation_to_invoice` (returns `{ invoiceId }`).
  - Role gate is `requireMember()` (any active member; an owner at aal1 is refused). It runs before any parsing or database call.
  - The action sends only ids, qty, rate, discount and pieces. Names, HSN, GST and every total come from the database.
  - It revalidates `/sales`, `/sales/quotes` and `/sales/quotes/<id>`. It does not revalidate `/sales/quotes/new`, the same reasoning as `saveDraftInvoice`.
  - `updated_at` is passed back as the exact string the database gave, never through a Date. A test covers this with microsecond digits.
- `DN_CONFLICT` is now mapped to `conflict` in `src/lib/action-result.ts` (with a test). That also covers any future caller.
- `dbFailure(error, { scope })` in `src/lib/action-errors.ts`:
  - A screen can word a validation detail its own way (`errors.<scope>.<detail>`) before falling back to the shared `errors.validation.*` text.
  - It also uses `errors.<scope>.<detail>_named` with `{name}` when the database put the offender in the error's `details` (a disabled item or party).
  - Every detail in the contract has a sentence under `errors.quote.*`, en and te. That includes the later additions `amount_too_large` and `quote_pos_changed`, plus the guard details `quote_immutable` and `quote_no_delete`.
- Screens (all under Sales; no change to `proxy.ts` / `access.ts`, because quotes are not owner-only; a test records that a counter user reaches them):
  - `/sales/quotes`: tiles (open count, accepted value, expiring in 2 days), status segments driven by `effective_status`, search by quote number or party, and rows that link to the view. Phone layout is the invoice list's.
  - `/sales/quotes/new` and `?id=`: edit is for stored-`open` quotes only. Anything else redirects to the view. The form reuses the pickers, `DateField`, the pieces↔kg logic and `TotalsRows`.
    - `QuoteLineRow` is a stock-free copy of `LineRow` (the typed `register` prevents sharing the component).
    - There are no stock, credit-limit, payment or transport fields.
    - The side panel is labelled "Estimate", using the same `previewTotals` math the invoice form uses.
    - After a successful save the form navigates to the view with `?saved=1`, so the totals the person sees are the database's own.
  - `/sales/quotes/[id]`: a print-friendly document titled **Quotation** (organisation header, quote no, date, valid until, prepared for, lines, totals from `v_quotations`, note/terms, "For <org>" sign-off line). Status chip uses `effective_status`.
    - Buttons are chosen by `quoteActions()` in `src/lib/quotes-view.ts`: Edit (stored open); Mark accepted (open, in date); Reopen (accepted, any date, matching the DB change); Mark expired (open or accepted, behind a confirm); Convert to invoice (open or accepted, in date, behind a confirm); Print.
    - Convert navigates to `/sales/<draft invoice id>`.
    - A converted quote shows a banner linking to its invoice (draft → `/sales/<id>`, otherwise `/sales/<id>/view`, with the invoice number).
  - Sales page: a "Quotes" segment in the existing segmented control, which links to `/sales/quotes`. The side rail and tab bar stay on Sales, because the route is under `/sales`.
- Messages: new `quotes` namespace, `errors.quote.*` and two `errors.field` keys, en and te (te written by hand in the app's existing vocabulary; worth a native read-through). `sales.quotes` added.
- CSS: `textarea` shares the `.field input` styling, `.qdoc*` classes for the document, and a print rule that re-pins ink-on-white tokens inside `.qdoc` so printing from the dark theme stays readable.

### PDF / share: reuse did NOT work cleanly, so the deliverable is the print stylesheet
`InvoiceDocument` hard-codes "TAX INVOICE", "Invoice No", cancelled watermark, transport and e-way-bill block, UPI QR and "PAID", bank details, per-line tax/amount columns and a title built from `InvoicePdfData` (loaded from `sales_invoices` and `payment_allocations`). Reusing it would mean threading a "quotation" mode through every one of those in a posted-tax-document component. I did not touch it. The Print button calls `window.print()` on the view page; the shell is hidden by the existing print rule and the document prints as ink on white. There is no PDF download and no WhatsApp link for quotes. A later `QuotationDocument` (react-pdf, same fonts) would be the clean way to add both.

### Defaults chosen
1. Valid-until is left blank by default: the database fills quote date + 7 days. The form says so under the field.
2. The tiles count and add up figures the database already stored (exact decimals, `addDecimal`). No tax or total is recalculated in TypeScript. The tiles read up to 2000 open/accepted rows; the list shows the latest 200.
3. "Expiring in 2 days" means effective open/accepted with `valid_until` from today to today + 2 (a quote is still valid on its `valid_until` day, as in the view). The org time zone decides today.
4. Reopen is offered for an accepted quote even past its date (the database now allows it); Mark accepted and Convert are hidden past the date.
5. A walk-in customer can be quoted (the picker lists them like on the invoice form); the database decides.
6. Disabled customers/items an old quote still carries stay selectable on the edit form (tagged "disabled"), so the person sees the line the database will name in its refusal.

### Gaps / not done
- No browser walk, no PDF/share (above), no `v_attention` row (DB half skipped it).
- Place-of-supply is shown from the form's customer default address (preview only); the database decides the stored value.
- The te strings have not had a native-speaker read.
