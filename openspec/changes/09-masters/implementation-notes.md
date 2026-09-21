# Change 09 — masters: implementation notes

Status: built, all gates green, **not committed, not pushed, not yet independently reviewed** (RLS + a money-adjacent guard → Opus fresh-context review recommended; screens can be reviewed by Sonnet).

## What exists
- **Migration** `20260920120000_masters.sql`: `parties.whatsapp_phone` / `default_site_id`; `organization.upi_vpa` / `invoice_bank_details` / `invoice_footer`; checks (GST state code, GSTIN shape + state prefix, unique GSTIN, phone / WhatsApp / UPI patterns, HSN 4–8 digits, non-negative rates, second-unit pair, one billing address per party); guard triggers (`parties_guard`, `items_guard`, `organization_guard`); write policies (parties + addresses: any active member; items + organisation: owners; no DELETE; organisation cannot be inserted) with matching privilege revokes.
- **App**: `/parties` (list, segments, search by name or GSTIN, New party modal), `/parties/[id]` (details, delivery sites, edit, disable), `/settings/{organisation,users,items,chart-of-accounts}` under an owner-only tabbed layout (`/settings` redirects to Organisation), Items with a pieces↔kg pair, read-only chart of accounts.
- Shared: `src/lib/gst.ts` (state list, GSTIN check digit), `src/lib/phone.ts`, `inr`/`inr2`, zod schemas `common/gstin/parties/items/organization`, actions `parties.ts`/`items.ts`/`organization.ts`, UI `Modal` (native `<dialog>`), `Segmented`, `SearchInput`, `KeyValue`, `Field`; constraint-failure mapping (unique / check / FK / permission) in `parseDbError`.

## Verified
- `supabase db reset` + `supabase test db`: **756 pgTAP green** (705 existing + 51 new in `00011_masters.test.sql`).
- `npm run lint`, `npx tsc --noEmit`, `npm test` (89), `npm run build`: clean.
- Real browser (production build, local Supabase, both roles): **31 of 32 automated checks pass; the 32nd is a timing flaw in the check itself** (the "billing address" chip is read before the page refresh lands) and was confirmed directly in the database: first site = billing address, second = default site. Covered: settings tabs and redirect; organisation save + persistence + bad UPI; items (bad HSN + missing factor explained, pieces↔kg pair shown, disable/enable, show-disabled toggle); chart of accounts read-only; New party modal (Escape closes, focus returns); wrong GSTIN check digit; GSTIN prefix auto-selects the state; state/GSTIN mismatch refused; WhatsApp must be a 10-digit mobile; credit terms saved; duplicate GSTIN refused in plain words; suppliers filter; search by name and by GSTIN; counter user adds a party with no credit fields and no disable button, and cannot open Items settings; Telugu; 390 px list and modal (light/dark), no sideways scroll.
- A weak check of mine ("default site chip" matched the button text) proved nothing on its own; the database query is the evidence.

## Bugs the tests caught in my own first draft (fixed)
1. UPI check used `{2,256}` — PostgreSQL's regex limit is 255, so every UPI edit failed.
2. The "second unit needs a factor" check silently passed: with a missing factor the condition is NULL, which a CHECK accepts. Wrapped in `coalesce(..., false)`.
3. Items table action cell was a flex container, breaking row lines (screenshot review).

## Conservative defaults taken (owner may overrule)
1. Counter staff can create parties but **not** set credit limit / days / interest, salary, or disable one. A counter user's new party is forced to no credit (limit 0) by the database, whatever the request says. *(Spec only said "user may INSERT/UPDATE parties".)*
2. **One GSTIN = one party** (unique index).
3. A party with a non-zero balance on any control account **cannot be disabled**.
4. **Units locked once used**: base/second unit, factor, category and stock flag cannot change after an item appears on any stock movement or document line (including drafts).
5. **Any GST rate 0–100** accepted (no slab list); HSN 4–8 digits.
6. **Organisation state and FY start locked** after the first non-draft invoice.
7. **GSTIN check digit** verified in the app only; the database checks shape + state prefix, so an unusual but real number can never be blocked by a wrong algorithm.
8. Phones stored as digits (`+91`, spaces, leading 0 stripped); WhatsApp must be a 10-digit mobile starting 6–9; ordinary phone may be a landline (6–13 digits).
9. **Employees are not creatable here** (staff screen, change 13); the parties list hides them; type cannot switch to/from employee.
10. Both address flags kept: `is_default` (billing / place of supply; a party's first address gets it automatically) and `default_site_id` (pre-selected delivery site).
11. Walk-in customer is protected from everyone (no disable, type or GSTIN change); an app session cannot create another walk-in.
12. `warehouses`, `accounts`, `fiscal_periods`, `doc_sequences` writes stay closed (no screen yet).
13. State list in the app has the 38 current GST codes (25 and 28 excluded as retired); the database regex is broader (01–38, 97, 99) so it never rejects a code the portal might accept.

## Opus review (2026-09-20) — findings and fixes
Two fresh-context Opus reviews (database; app) covered changes 08 + 09. Both: approve after fixes. Fixes applied by Sonnet, re-verified by the lead (802 pgTAP, 157 vitest, lint/tsc/build clean, browser walk-through 34/35 — the one miss is a test-timing flake, data confirmed in the database).

**Fixed — database** (`20260920120000_masters.sql` edited in place; `20260920130000_review_fixes.sql` new)
- A counter user could hide a customer's dues by flipping the party `type` (balance view is a CASE on type), and could change `gstin` / `state_code` (decide B2B vs B2C and CGST+SGST vs IGST). Now `type`, `gstin`, `state_code` are owner-only on update; a type change is refused for **everyone** while the party has a balance, unless the new type is `both` (`DN_VALIDATION:party_type_has_balance`).
- `parties_guard` failed open when the role lookup returned NULL (non-member). Now `coalesce(..., false)`.
- Counter user could create an already-disabled party; the insert now forces active.
- New `party_addresses_guard`: an address can never move to another party (`address_party_locked`).
- 08/09 "second lock" revokes omitted `TRUNCATE` (not subject to RLS, skips row triggers). Now revoked on `app_users`, the four masters tables, and swept for **all** public tables + default privileges for the migration role. (`supabase_admin`'s own defaults cannot be changed by the migration role; our migrations never create tables as that role.)
- `admin_set_user`: duplicate email now `DN_VALIDATION:email_taken` instead of a bare 23505.
- Test 23 of `00010` was not hermetic (failed whenever a real owner row existed locally); fixed. Added tests for every arm of `items_guard` and all 8 history tables, disabled-member writes, anon on `set_my_locale`, direct insert into `app_users`, truncate refusals. Each new guard test was mutation-checked (fails when the guard is removed).

**Fixed — app**
- The change-09 actions (organisation, items, party edit/disable) only checked `role === 'admin'`; an owner at step 1 could call them by hand. New `src/lib/auth/require.ts`: `requireAdmin` (admin **and** aal2) and `requireMember` (refuses an admin at aal1; counter staff fine). Used by every action. (Change 19 closes the database half; the app half is done here — each layer checks.)
- Per-IP sign-in-code limit could be dodged with a forged `X-Forwarded-For`: now `x-real-ip`, else right-most forwarded entry; limiter memory bounded (sweep + 10,000-key cap).
- Credit limit: "No credit limit (unlimited)" checkbox (NULL = unlimited, 0 = no credit); blank on create = 0, blank on edit = unchanged; NULL now displays "No limit" instead of "—".
- Items list showed ₹62.50 as ₹63: new `inrRate()` (2–4 decimals). Item disable/enable no longer fails silently. Party errors say "party" not "person". Zero-row updates report `no_such_party` / `no_such_item`.
- Counter staff see type / GSTIN / state read-only on edit; the action also strips them.
- Range errors: interest capped 999.99, `boundedDecimal` per column precision, SQLSTATE 22003 → friendly validation.
- Party search now escapes instead of deleting characters ("Sri Rama & Co. (Guntur)" matches); `*` is treated as a one-character wildcard because PostgREST cannot escape it. Proven not to alter filter structure.
- `Field` wires `aria-describedby` / `aria-invalid` itself; `ThemeToggle` has `aria-pressed`; `inviteUser` uses `zodFailure`.
- Server-action tests added (parties, items, organisation, admin: ok / forbidden with zero DB calls / DN mapping / payload stripping).

**Logged, not done** (reviewer's discretion / later)
- List pages are unbounded (`v_party_balances` is read whole) — paginate when parties grow; item and party names have no uniqueness rule (duplicate "OPC 53 Grade" would split stock — decide at change 10/12); `supabase/config.toml` `additional_redirect_urls` scheme mismatch (dead config); locale cookie not `httpOnly` (nothing reads it client-side); `listUsers` reads the first 200 accounts only (fine at ≤10 users); an admin can still rename the walk-in party or change its state (harmless — posting reads the organisation's state).
- Stale comment in `20260916110000_posting_sales.sql` (~line 414) still says `credit_limit > 0`; the engine is `credit_limit is not null` (NULL = no limit, 0 = no credit). Applied migrations are not edited; do not read that comment as current.

## Not built (out of scope, logged)
Switching an existing party's billing address; party CSV import (17); merging duplicates; price lists; GST scheme (regular/composition); editing warehouses / accounts / periods; the party ledger and ageing tiles (13); a shared `Toast` and `DataTable` primitive (rows link through the party name, which is natively keyboard-activatable).

## Not verified
- Review by a second agent; hosted project; real-phone use; Telugu on a real device; contrast by tool.
- The read views' "To collect / To pay" columns are wired but only show `—` here (no invoices exist in the test data); they will exercise properly with change 10.
- A party disabled with a balance is covered in pgTAP, not in the browser (no invoice can be created yet).

## Needs native-speaker review
All new Telugu in `parties.*`, `items.*`, `org.*`, `coa.*`, `settings.*`, `address.*`, `common.*`, and the new `errors.*` entries.

## For later changes
- 10 (billing): party/item pickers read these tables; `default_site_id` pre-selects the site; `whatsapp_phone` powers the WhatsApp link; the UPI ID feeds the invoice QR; `is_stock=false` items skip stock.
- 13: party ledger goes above the details card on `/parties/[id]`; employee parties get created from the staff screen.
- 17: party / opening-balance import must go through the same checks.
- 19: change 19's test numbering moved to `00012` (this change took `00011`).


## Second Sonnet review (2026-09-21) — database + app, and what was done

Four fresh Sonnet reviewers (08+09 database, 08+09 app, 06 views, 07 shell). Owner asked for Sonnet only. Everything below is fixed and verified unless listed under "Left open".

**Fixed — database** (`20260921100000_masters_review_round2.sql`, `20260921110000_read_views_admin_gates.sql`; tests `00014`, `00011` fixtures, `00008` counts)
- Walk-in party: credit limit / days / interest rate / state now locked for everyone (an owner could set `credit_limit = NULL`, which posting reads as unlimited credit).
- `parties_guard`: a counter user's update is a WHITELIST (name, phone, whatsapp_phone, default_site_id); every other column, including columns added later, is owner-only.
- `organization_guard`: state / FY start lock once ANY journal entry exists or ANY number was issued (was: a posted sales/purchase invoice only). `fy_start_month` CHECK 1–12.
- GSTIN check digit enforced by the database (`gstin_checksum_ok`, same mod-36 rule as `src/lib/gst.ts`) on parties and the organisation. Default 7 ("app only") is superseded. PAN shape and the `Z` in position 14 are deliberately NOT enforced: government / TDS registrations do not follow them.
- HSN is 4, 6 or 8 digits (5 and 7 do not exist). Second unit cannot be blank or the same as the first ignoring case.
- Change 06: `v_employee_ledger`, `v_bank_recon`, `bank_statements`, `bank_statement_lines` are owner-only to read. Spec updated.
- New tests (00014, 56): each item above, plus the previously missing arms — last-admin demotion, another admin disabling an admin, 10-person cap on create AND re-enable (function and direct write), credit-side balance blocks disable / settled party can be disabled, sales-line arm of `items_guard` isolated, address writes by stranger / anon / disabled member.

**Fixed — app**: see the "Second Sonnet review — app half" section of change 08's notes (credit-limit edit trap, whole-rupee balances, counter-staff edit of legacy parties, sign-in lock-out by strangers, session-age check inside `getCurrentMember`, modal drag-select, `auth.ts` tests) and change 07's notes (sticky topbar, 44 px targets, token test, language button, dates, reduced motion).
Also: `formatDate` now accepts a date only (a timestamp's calendar day depends on the time zone); the invoice PDF converts the e-way-bill expiry to an India date once, in `data.ts`.

**Left open — owner decisions**
1. **Stock cost visible to counter staff.** `v_stock_summary` / `v_stock_ledger` expose weighted-average cost and per-movement rate/value to any member; with the sale rate that gives margin. The posted-invoice page reads `rate, value` from `v_stock_ledger` for the journal panel. Hide cost from counter staff (needs an owner-only cost view and a change to that page), or accept and record it in the spec.
2. **Employee salary/wage on `parties`** is readable by every active member (`select_active_members`). Decide before change 13 builds the staff screen (column-level grant, or an owner-only view).
3. **FY start** stays a month selector (1–12). Locking it to April matches the hard rule "FY April–March"; say so if wanted.
4. **No audit trail on master edits** (credit limit, GSTIN, state, item rates, UPI / bank text). `admin_set_user` audits; nothing else does. Propose a small AFTER UPDATE audit trigger in change 19 or 16.
5. Owner at step 1 (email code only) can still write masters through the API — closed by change 19 (item 4c of its brief), not duplicated here.
6. Organisation identity (`legal_name`, `gstin`, `address`) is editable after invoices post; confirm the invoice PDF path reads what was snapshotted at post time or accept re-join.
7. Item disable does not check stock on hand (parties are checked for balance).
8. Draft-line vs unit-change race in `items_guard` is tiny; accepted.
9. Party GSTIN can equal the organisation's own GSTIN; add a check when it matters.
