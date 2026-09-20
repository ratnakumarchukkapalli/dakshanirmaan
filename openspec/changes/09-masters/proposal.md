Skill: daksh-api + daksh-ui (also daksh-schema for the migration + pgTAP conventions)
Spec section: openspec/specs/db-architecture/spec.md → "### Masters write policies (change 09)" + "### parties (columns added)" + the parties / party_addresses / items / organization table definitions; openspec/specs/api-architecture/spec.md → "## Requirement: Action catalog" (parties.ts, items.ts, admin.ts `updateOrganization`) + "## Requirement: Validation contract"; openspec/specs/frontend-architecture/spec.md → route structure for `parties/` and `settings/`
Context: Changes 01–08 gave the database its books, posting engine, read views and sign-in. Nothing lets anyone enter the business's own data yet. This change is the first data-entry screens: **parties** (customers, suppliers, delivery sites), **items** (with the pieces↔kg pair for TMT steel), **organisation settings** (GSTIN, address, UPI ID, bank line and footer for invoices, the negative-stock switch) and a read-only **chart of accounts**. It also opens the database write door for exactly those tables, no wider. Every later screen (billing, payments, ledgers) picks parties and items from what this creates.
Do not: read other specs; touch the posting functions or any migration 01–08; build the party ledger / ageing tiles (13), employees (staff screen, 13), warehouses / fiscal periods / accounts editing (no screen yet), the invoice form (10); push to hosted; commit (Ratna commits).

## Scope

**In**
1. **Migration `…_masters.sql`** (new file only):
   - `parties` gains `whatsapp_phone text`, `default_site_id uuid` (must be one of that party's own addresses); `organization` gains `upi_vpa`, `invoice_bank_details`, `invoice_footer` (text, all nullable).
   - Validity checks in the database as well as the app: state code is a real GST state/UT code (01–38, 97, 99); a party's GSTIN, when present, matches the 15-character pattern **and its first two digits equal the party's state code** (a mismatch would silently turn CGST/SGST into IGST); GSTIN unique across parties; UPI ID pattern; at most one default address per party; alt unit needs a positive conversion factor and a different name from the base unit; `sale_rate ≥ 0`, `gst_rate` 0–100, `reorder_level ≥ 0`, HSN 4–8 digits.
   - **Write policies** (RLS) — parties and party addresses: any active member inserts/updates; items and organisation: admin only (organisation: update only, it is a single row). No DELETE anywhere; deactivate instead. `warehouses`, `accounts`, `fiscal_periods`, `doc_sequences` stay closed until they get a screen.
   - **Guard triggers**: a counter user (`user`) cannot set or change credit limit, credit days, interest rate, salary/wage, or deactivate a party (admin only); the walk-in party cannot be edited into something else or deactivated; a party with a non-zero balance cannot be deactivated; an item's base unit, alt unit, conversion factor, category and stock/non-stock flag cannot change once the item appears on any stock movement or document line; the organisation's state and financial-year start cannot change once any posted invoice exists. Each raises a `DN_*` code the app maps to a friendly sentence.
2. **Shared pieces**: `src/lib/gst.ts` (state list; GSTIN pattern **and check-digit** validation), phone normaliser, `src/schemas/{parties,items,organization}.ts` (zod, shared by forms and actions), UI primitives `Modal` (native `<dialog>`: focus trap, Escape closes), `Segmented`, `SearchInput`, `DataTable` (right-aligned number columns, rows Enter-activatable), `KeyValue`.
3. **Actions** (`src/app/actions/{parties,items,organization}.ts`, envelope + role gate + revalidate; user-scoped client only): `createParty`, `updateParty`, `addPartyAddress`, `setDefaultSite`, `deactivateParty`/`reactivateParty`, `createItem`, `updateItem`, `deactivateItem`/`reactivateItem`, `updateOrganization`.
4. **Screens**:
   - `/parties`: list (segmented All / Customers / Suppliers; search by name or GSTIN in the URL: `?type=&q=`), columns Party, Balance, Credit limit, Status, from `v_party_balances`; **New party** modal per the prototype (name, type, GSTIN, state, phone, WhatsApp, credit limit/days/interest for admins).
   - `/parties/[id]`: master details + delivery sites (add, mark default) + edit + deactivate. Change 13 adds the ledger above it.
   - `/settings/{organisation,users,items,chart-of-accounts}` under a tabbed settings layout (admin only); `/settings` redirects to Organisation. Items tab: table (alt unit shown as "pc = 10.660 kg"), New item / Edit in a modal, show-disabled toggle. Chart of accounts: read-only tree with system keys.
5. English and Telugu strings for everything; both themes; 390 px.
6. Tests: pgTAP `00011_masters.test.sql`; Vitest for GSTIN check-digit, phone normaliser, zod schemas, error mapping; real-browser walk-through.

**Out (log in notes)**: employees as parties (staff screen, change 13), party import from CSV (change 17), editing warehouses / accounts / periods / sequences, merging duplicate parties, item categories beyond cement/steel/other, price lists, GST scheme (regular vs composition) selector, party ledger and ageing tiles.

## Conservative defaults (owner unknowns — log each in `implementation-notes.md`)
1. **Counter staff can create parties but not set credit terms.** A counter user could otherwise raise a customer's limit and then bill past it. Admin sets credit limit, credit days, interest rate. A new party made by a counter user starts with no credit (limit 0).
2. **One GSTIN, one party.** Duplicate customers are the classic trading-book mess. A shop with two GSTINs is two parties.
3. **A party that owes or is owed money cannot be disabled**, so no receivable/payable disappears from the pickers.
4. **Units are locked once used.** Quantities are stored in the base unit; changing it, or the pieces↔kg factor, after stock exists would silently rescale history.
5. **Any GST rate 0–100 is accepted** (no fixed slab list, because slabs change by notification). HSN must be 4–8 digits.
6. **Organisation state / FY start locked after the first posted invoice**: they decide intra- vs inter-state tax.
7. **GSTIN check digit** is verified in the app only; the database checks pattern + state prefix (a wrong check digit is a typo the app can explain; the database stays lenient toward unusual but legitimate numbers).
8. **Phones** are stored as digits (country code and spaces stripped); WhatsApp number must be a 10-digit mobile starting 6–9; plain phone may also be a landline.
9. **Employee parties** are not creatable here (the staff screen owns them); the parties list hides them.
10. **Both address flags kept**: `is_default` = billing/place-of-supply address; `default_site_id` = pre-selected delivery site on billing.

## Done when
- **"zod GSTIN/state validation"**: unit tests — a known valid GSTIN passes; a wrong check digit, wrong pattern, and a state prefix that disagrees with the chosen state are each refused with a clear message; the same rules are refused by the database when the app is bypassed (pgTAP).
- **"new party modal matches prototype"**: real-browser check at 1280 and 390 px, both themes; Enter/Escape/Tab behave (focus trapped, Escape closes, focus returns).
- pgTAP `00011`: `user` can create a party but cannot set credit terms, salary, or disable one; admin can; `user` cannot write items or organisation; nobody can delete; anonymous and non-members cannot write; walk-in party protected; party with a balance cannot be disabled; item units locked after use; organisation state locked after a posted invoice; duplicate GSTIN refused; default site must belong to the party. Existing 705 pgTAP still green after `supabase db reset`.
- Real-browser walk-through: admin creates a supplier and a customer with a delivery site, an item with pieces↔kg, edits the organisation UPI ID; a counter user sees no Items/Organisation/Settings, can add a party but the credit fields are absent/refused.
- Gates: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`; no hardcoded hex or user-visible literal; no `NEXT_PUBLIC_` beyond the two allowed; `implementation-notes.md` written; not pushed; **not committed**.
- **Review**: touches RLS + a money-adjacent guard (party balance) → Opus fresh-context review with `daksh-review` on the migration + actions (ask Ratna before launching); screens can be reviewed with Sonnet.
