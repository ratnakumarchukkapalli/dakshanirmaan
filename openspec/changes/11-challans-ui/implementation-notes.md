# Change 11 — challans UI: implementation notes

Status: built, all gates green, **not committed, not pushed**. Follow-up session (same day) fixed
two bugs found by a real local-Docker walkthrough and closed the concurrency gap flagged below with
one small migration — see "Follow-up fixes" at the end.

Brief: `daksh-ui`, frontend spec "Route structure" (sales/challans), api spec "Action catalog
extensions" (`challans.ts`). Acceptance scenario: "challan conversion is idempotent" (api spec).

## What was built
- **Routes**: `/sales/challans/new` (challan form + Open challans panel, one screen); `?id=<uuid>`
  resumes an existing draft (there is no separate `challans/[id]` route — see "Deliberately not
  built" below). `/sales` gained a `challan` segment (its own query against `delivery_challans`)
  and a "+ Challan" button.
- **Actions** `src/app/actions/challans.ts`: `saveDraftChallan`, `postChallan`,
  `convertChallanToInvoice`. Schema `src/schemas/challans.ts` (reuses `invoiceLineSchema` from
  `sales.ts` — a challan line is the same snapshot shape minus tax). Loader addition
  `loadOpenChallans` in `src/lib/sales-data.ts`; shapes added to `src/lib/sales-types.ts`
  (`ChallanFormValues`, `ChallanFormInitial`, `OpenChallan`). The challan form reuses
  `loadInvoiceFormContext` for parties/items/today — a challan needs a subset of what an invoice
  needs, so no separate loader was written for that part.
- **UI**: `src/components/sales/{ChallanForm,ChallanLineRow,OpenChallansPanel}.tsx`. `ChallanForm`
  is one plain `Card` (matches the prototype's `#challan` screen), *not* the invoice form's
  `.bill`/floating-summary layout — a challan has no tax and no credit check to justify a separate
  sticky panel, and nesting that layout inside the page's own `grid2` would have doubled up on
  columns. `OpenChallansPanel` is the right-hand card; "Invoice →" calls `convertChallanToInvoice`
  and pushes to `/sales/<id>` (the existing draft invoice edit screen — no new screen needed).
- **Messages**: new `challans` namespace (en + te) plus `sales.challans`/`newChallan`/
  `emptyChallans` and two `errors.validation.*` keys (`no_such_challan`, `item_not_stock`), both
  languages.
- **Shared code touched**: `src/lib/action-result.ts` gained `DN_CONVERTED: 'validation'` in
  `DB_CODES` — change 10's implementation notes flagged this exact gap ("DN_CONVERTED (challan) |
  internal | not mapped: unreachable until change 11"). It is now reachable: posting a stray
  duplicate draft invoice (see idempotency note below) whose challan was converted elsewhere in
  the meantime gets the generic validation sentence instead of an "internal error" console log.

## How `convertChallanToInvoice` is idempotent
Per the acceptance scenario, calling it twice for the same open challan must not create a second
draft. The database has no unique constraint on `sales_invoices.challan_id` (change 05 only added a
plain index), so idempotency is enforced in the action, in this order:
1. Challan not found → `validation.no_such_challan`. Not `posted` → `not_posted` (a draft challan
   has moved no stock yet; there is nothing to convert).
2. `challan.invoice_id` already set → return that id. Nothing is queried further. This also
   covers "converted, then that invoice was cancelled" correctly: cancelling reopens the challan
   (`invoice_id` back to `null`, per change 05), so a *new* conversion is rightly allowed again.
3. Otherwise, look for an existing **draft** invoice with `challan_id = <this challan>` — the
   button pressed twice before that draft was posted. If found, return it; create nothing.
4. Otherwise, create the draft: header from the challan (`party_id`, `warehouse_id`,
   `place_of_supply` from the challan's site snapshot state or else the party's own
   `state_code`, `billing_address` from the party's default address, `shipping_address` = the
   challan's own site snapshot, `challan_id`), lines copied verbatim from
   `delivery_challan_lines` (same item/hsn/uom/gst_rate/qty/rate/discount the challan already
   carries). **Correction (Opus review, 2026-09-25):** "not re-read from `items`" only holds for
   this first insert. The first `saveDraftInvoice` on the draft re-snapshots every line from
   `items` (name, HSN, GST rate, UoM), like any invoice save. That is harmless: the challan-match
   check in `post_sales_invoice` compares only `item_id` and quantity (for stock items), never the
   snapshot columns or the rate.

**Race window — fixed in the follow-up session (see below).** Step 3's select-then-insert
originally had a race window: two genuinely simultaneous clicks could each pass step 3 before
either insert lands, producing two draft invoices for one challan. Never a books-integrity risk
(`post_sales_invoice`'s existing `DN_CONVERTED` check means only one of the two could ever post),
but a real gap. Migration `20260922100000_challan_invoice_unique_draft.sql` adds
`sales_invoices_one_draft_per_challan`, a partial unique index on `(challan_id) where status =
'draft'`, and the action now catches the resulting `23505` and returns the winner's draft id
instead of failing — see "Follow-up fixes".

## Conservative defaults taken (no owner interview for this change)
1. Only items with `is_stock = true` can go on a challan line — refused at save time with a
   friendly message, not left to fail only at posting. A challan is a goods-out note; freight/
   loading-charge lines belong on the invoice.
2. **Driver field deferred.** `delivery_challans.driver_party_id` references a `parties` row of
   type `employee`, but there is currently no screen that can create an employee-type party (the
   masters party form only offers customer/supplier/both) — that arrives with change 13
   (`parties-stock-staff-ui`, staff screen). Building a driver picker now would point at an always
   -empty list. `driver_party_id` stays `null`; the form has no driver field. Revisit in 13.
3. Discount is accepted by the schema (reusing `invoiceLineSchema` as-is) but has no input on the
   challan line row — the prototype's challan table has no discount column either, and it rarely
   matters before the invoice exists. Defaults to 0; adjustable once the person opens the
   converted draft invoice.
4. No `deleteDraftChallan` action — the api spec's `challans.ts` row names exactly three actions
   (`saveDraftChallan`, `postChallan`, `convertChallanToInvoice`). An unwanted draft is simply left
   unposted; deleting it is not in this brief.
5. No dedicated view screen for a posted or cancelled challan. The frontend spec's route tree lists
   only `sales/challans/new/` (unlike `purchases/`, which explicitly lists `new/, [id]/`) — read as
   deliberate: a posted, open challan is *seen* via the Open challans panel, and once converted it
   is seen via the invoice it became. The `/sales` list's new "Challans" segment shows all of them
   (draft/posted/cancelled) for browsing and search; only a draft row is a link (back to the form).
6. `/sales/challans/new?id=` resumes a draft (mirrors invoice's `[id]/` edit route) rather than a
   separate path, again because the frontend spec names only the one route for challans.
7. After posting, the form resets to blank on the same page (`router.refresh()`) rather than
   navigating away — there is nowhere to navigate *to* (no view screen, see 5), and staying here
   lets the person immediately start the next challan or click into the one just posted from the
   Open challans panel.
8. The challan form is any active member's to fill, save and post (same as `post_delivery_challan`
   already allows — change 05's own note: "a challan grants strictly less authority than the
   invoice that follows it").

## Follow-up fixes (same day, after Docker was started and a real browser walkthrough was run)

Ratna asked for the flagged gap to be fixed and for the change to actually be tested against a
live database before moving to change 12. Local Supabase was started, all migrations applied
clean (`supabase db reset`), and a scripted Chromium walkthrough (Playwright, installed
temporarily with `--no-save` and removed afterward — not a project dependency) signed in as a
counter-staff account, filled and posted a real challan, converted it to an invoice, and — the
point of the exercise — clicked "Invoice →" on the *same still-open* challan a second time and
confirmed it landed on the exact same draft invoice URL both times. That is the acceptance
scenario proven end to end against a live database and a real browser, not just a mocked test.

Two real bugs turned up, both fixed:

1. **Open challans panel was always empty, from the very first load — a genuine bug, not a
   refresh-timing issue.** `delivery_challans` has *two* foreign keys to `parties` (`party_id` and
   `driver_party_id`), so PostgREST refuses the ambiguous embed `party:parties(name)` outright
   (`PGRST201`). Both queries that used it — `loadOpenChallans` in `src/lib/sales-data.ts` and the
   Challans-segment query in `src/app/(app)/sales/page.tsx` — were silently swallowing that error
   (`const { data } = await ...` with no `error` check) and rendering "no open challans" instead of
   surfacing anything wrong. Fixed by embedding the explicit constraint name,
   `parties!delivery_challans_party_id_fkey(name)`, and `loadOpenChallans` now logs (and still
   degrades to an empty list) if the query ever errors again rather than failing silently forever.
2. **The "reset to a blank form" after posting only cleared component state, not the actual form
   values** — `draftId`/`updatedAt` went back to `null`, but react-hook-form's `reset()` was never
   called, so the just-posted challan's party/items stayed visible as if unsaved. Fixed by calling
   `reset({ partyId: '', challanDate: ctx.today, siteId: '', vehicleNo: '', lines: [emptyLine()] })`
   in `ChallanForm.tsx` right after a successful post.

Schema/test changes from closing the race window (daksh-schema territory, done with Ratna's
explicit go-ahead since it's outside the original `daksh-ui` brief):
- `supabase/migrations/20260922100000_challan_invoice_unique_draft.sql` — the partial unique index.
- `supabase/tests/database/00016_challan_invoice_unique_draft.test.sql` — 4 new pgTAP assertions.
- `supabase/tests/database/00007_posting_challan_transfer_adjust_dayclose.test.sql` — change 05's
  own fixture created two draft invoices against the same challan in a row (one left over from an
  earlier mismatch assertion, still `draft`, when a second one was created for a different
  mismatch). Added one `delete from sales_invoices where id = ...` between them, matching what a
  person would actually do (delete the bad draft, try again) — the two assertions the fixture
  exists for are otherwise unchanged.
- `src/app/actions/challans.ts` / `.test.ts` — `convertChallanToInvoice` now catches the
  `sales_invoices_one_draft_per_challan` unique-violation and re-selects the winning draft instead
  of failing; two new tests cover the recovery and the (near-impossible) case where the winner
  still isn't visible.

Verified after the fixes: `supabase db reset` + `supabase test db` → **941/941 pgTAP** (937 + 4
new); `tsc`, `lint`, `next build` clean; **325/325 vitest** (20 in `challans.test.ts`); the browser
walkthrough above, 10/10 checks green, including the live idempotency proof. Local DB was reset
again afterward to clear the walkthrough's test data (a throwaway `staff-browsertest@...` account
and a few demo challans/invoices) — nothing from this session's manual testing persists.

Still not done: a real look at both themes and 390px width (the walkthrough ran at 1280px in one
theme). The component-level review earlier in this file (matching `globals.css` classes by hand)
is the only check that width/theme fidelity has had.

## Review fixes (Opus review of 11, 2026-09-25)

An independent Opus review found the items below. All are app-side fixes; no database change.

1. **MAJOR: a converted draft could be edited into a mismatch, and posting then said only "some
   details are not valid".** Fixed in three parts.
   - *Messages.* `errors.validation.challan_mismatch`, `invoice_before_challan`,
     `challan_not_posted` (en + te, key parity kept). The error mapping already passed
     `DN_VALIDATION:<detail>` through (`parseDbError` -> `dbFailure`); the keys were simply
     missing, so it fell back to `validation.generic`. **Telugu needs native-speaker review**,
     like the earlier changes' strings.
   - *Draft UI.* `sales/[id]/page.tsx` reads `challan_id` and the challan's number/date and passes
     `initial.challan` to `InvoiceForm`. When set, the form shows a "From challan DC/... (date)"
     banner (plain text: there is no challan view route, see default 5) and locks exactly what
     `post_sales_invoice` compares: the **customer** (party picker disabled), and for every
     **stock-item line** the item (picker disabled), quantity and pieces (read-only), and remove.
     Rate, discount, notes, transport, site and place of supply stay editable, because the DB does
     not compare them. New lines may be added, but the item list is limited to non-stock items
     (freight, hamali), which the DB check excludes. `Picker` gained a `disabled` prop and
     `LineRow` a `locked` prop.
   - *Invoice date: deliberately not locked.* The brief asked to lock the date input, but the DB
     only requires `invoice_date >= challan_date` (`invoice_before_challan`), and a draft that sits
     for a day should be re-datable to today. So the form does not lock it: "Post" is stopped with
     the `invoice_before_challan` sentence when the date is earlier than the challan's; the DB stays
     the authority. Easy to lock instead if the owner prefers.
   - *Not enforced server-side in `saveDraftInvoice`.* Only the form locks; the DB check at post
     time is the real guard (it is what the review found unhandled), and `sales.ts` was left
     untouched.
   - *Test.* `sales.test.ts` (postInvoice): the three details map to their own sentence, never
     `validation.generic`.
2. **MINOR: race-recovery could return a draft that was not ready.** The loser of the `23505` race
   used to return the winner's draft id straight away, which could be before the winner inserted
   its lines, or a draft the winner then deleted after a failed line insert. Now the loser looks
   up to 3 times (120 ms apart) for a draft that still exists **and** has at least one line;
   otherwise it returns `conflict` with `errors.validation.convert_in_progress` ("being turned into
   an invoice right now, press Invoice again"). Four tests in `challans.test.ts` (ready, lines
   arrive late, never gets lines, draft deleted). **Cleaner fix for later:** an atomic
   `convert_challan_to_invoice` RPC (header + lines in one transaction) removes the window entirely;
   not done because the database was off-limits in this round.
3. **Docs.** The "copied verbatim, not re-read from items" statement above is corrected;
   `docs/STATUS.md` no longer says "reviewed, no findings".
