# API Architecture Specification

## Purpose

Define how the Next.js app talks to Supabase: server actions, RPC contracts, validation, authorization, and exports. There is no separate backend — Postgres functions are the write API; views are the read API.

## Requirement: Access layers

1. **Reads** — React Server Components query views/tables via the server Supabase client (`@supabase/ssr`, cookie-bound, RLS enforced). No client-side data fetching for business data in v1 (no SWR/React Query until a real need appears).
2. **Writes** — Server Actions only (`'use server'`). Every action: (a) parses input with a zod schema, (b) checks the caller's `app_users.role`, (c) calls the matching Postgres function via `.rpc()` **passing only document ids and flags — never the actor; the function reads `auth.uid()`** — or performs draft-table writes, (d) `revalidatePath` for affected routes, (e) returns the result envelope.
3. The browser SHALL never hold the service-role key. Server actions use the user-scoped client so RLS applies; only the posting RPCs (SECURITY DEFINER) escalate.

## Requirement: Action catalog

One module per capability under `src/actions/`:

```
parties.ts    createParty, updateParty, addPartyAddress, deactivateParty
items.ts      createItem, updateItem, deactivateItem
sales.ts      saveDraftInvoice(header+lines), postInvoice(id), cancelInvoice(id)
purchases.ts  saveDraftBill, postBill(id), cancelBill(id)
notes.ts      saveDraftNote, postNote(id)   -- credit/debit
payments.ts   saveDraftPayment(+allocations), postPayment(id), cancelPayment(id, reason)   -- cancel admin only
expenses.ts   saveDraftVoucher, postVoucher(id)   -- salaries, advances, wages, freight
admin.ts      lockPeriod, unlockPeriod (owner), updateOrganization, manageUsers
```

Draft saves upsert document + lines in one action (delete-and-reinsert lines is acceptable for drafts). Post/cancel actions are thin RPC wrappers — **no business math in TypeScript**. Client-side totals (like the billing screen's live GST) are display-only previews; the DB recomputes and is authoritative.

## Requirement: Validation contract

- zod schemas in `src/schemas/`, shared by client forms and server actions (single source).
- Money/qty parsed as strings → validated decimal (regex `^\d+(\.\d{1,4})?$`) → passed to Postgres as text, cast to NUMERIC. **Never `parseFloat` for stored values.**
- GSTIN: `^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$` + state-code prefix must be a valid state code; optional (B2C).
- Invoice line: qty > 0, rate ≥ 0, discount 0–100; header: party exists and active, date parseable `DD-MM-YYYY` → ISO.

## Requirement: Result envelope and errors

Every action returns:

```ts
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ErrorCode };
type ErrorCode = 'validation' | 'forbidden' | 'period_locked' | 'negative_stock'
               | 'credit_limit' | 'not_draft' | 'conflict' | 'internal';
```

Postgres RAISE messages use `ERRCODE`-style prefixes (`DN_PERIOD_LOCKED`, `DN_NEGATIVE_STOCK`, `DN_UNBALANCED`, `DN_CREDIT_LIMIT`) which actions map to `ErrorCode`. Raw Postgres errors never reach the UI. Errors are user-fixable sentences: "June is locked — GSTR-1 already filed. Ask the owner to unlock." Unknown errors log server-side (with entry context) and return `internal`.

## Requirement: Authorization

- Middleware guards `/(dashboard)` routes: session required + active `app_users` row.
- Two roles only, gates enforced in actions AND in DB functions — defense in depth:
  - `user` (general): create/edit drafts, post sales invoices and receipts, record employee advances (≤ ₹5,000 per voucher), read all screens except P&L/Balance Sheet and settings
  - `admin`: everything — cancellations, credit/debit notes, purchase & expense/salary posting, period locks, negative-stock override, user management, org settings, all reports
- Supabase Auth public signup disabled; the admin provisions accounts. No OAuth providers in v1 — email OTP only, with TOTP MFA enforced for the admin account.

## Requirement: Route handlers (non-action endpoints)

```
GET /api/invoices/[id]/pdf     GST invoice PDF (@react-pdf/renderer, server), role-gated
GET /api/reports/gstr1?period= GSTR-1 export: portal JSON + exceljs workbook
GET /api/reports/[name]/xlsx   tabular exports (party ledger, stock, aging) via exceljs
```

Streaming responses; filenames `DN-<doc-no>.pdf`, `GSTR1-<YYYY-MM>.json`. No other public API surface in v1; e-way bill / IRN API integration is Phase 3 and gets its own spec.

## Requirement: Concurrency and idempotency

- Document numbers are assigned **inside** `post_*` (via `next_doc_no`'s row lock), not at draft time — drafts have provisional ids only, so concurrent posting cannot duplicate or gap a GST series.
- Post/cancel actions are idempotent: posting a non-draft returns `not_draft` rather than double-posting.
- Draft saves carry `updated_at` and reject stale writes with `conflict` (last-write-wins is not acceptable for invoices).

#### Scenario: general user cannot cancel
- WHEN a `user`-role account calls `cancelInvoice` or posts a purchase bill
- THEN the action returns `{ ok:false, code:'forbidden' }` and the DB function independently rejects if called directly

#### Scenario: client math never becomes truth
- WHEN a tampered client submits an invoice draft with a wrong GST split
- THEN `post_sales_invoice` recomputes tax from line snapshots and place of supply; stored totals come from the DB computation

## Requirement: Action catalog extensions (added 2026-09-16, matches prototype v2)

```
challans.ts    saveDraftChallan, postChallan(id), convertChallanToInvoice(id) -> draft invoice id
quotes.ts      saveQuote, markQuote(id, status), convertQuoteToInvoice(id)            [Phase 2]
transfers.ts   saveDraftTransfer, postTransfer(id), receiveTransfer(id)
payments.ts    + depositCheque(id), markCleared(id), bounceCheque(id)   -- admin for bounce; cancelPayment -> cancel_document('payment') maps DN_CHEQUE_STATE/DN_NOT_POSTED/DN_PERIOD_LOCKED
bank.ts        importStatement(csv) -> statementId, matchLine(lineId, paymentId|entryId),
               ignoreLine(lineId), createFromLine(lineId, kind: 'receipt'|'expense')
dayclose.ts    postDayClose(date, counted, note), reopenDayClose(date)  -- reopen admin only
rebates.ts     upsertRebateSlab, accrueRebate(id), settleRebate(id, debitNoteId)   [Phase 2]
attachments.ts getUploadUrl(entity, entityId, mime, bytes), deleteAttachment(id)
admin.ts       + inviteUser(email, role), disableUser(id), setLocale(locale)
share.ts       whatsappInvoiceLink(invoiceId) -> wa.me deep link with signed PDF URL (24h)
```

- **Uploads:** client uploads directly to Supabase Storage using a short-lived signed upload URL from `getUploadUrl` (server validates mime ∈ {jpeg,png,pdf}, bytes ≤ 5 MB, caller role); the attachment row is written by the action after the upload completes.
- **CSV import:** parsed server-side (no `xlsx`); supported banks' column maps live in `src/lib/bank-formats.ts`; unknown formats fall back to a header-mapping step in the UI.
- **WhatsApp share (Phase 3 lite):** no Business API in v1 — `wa.me/<phone>?text=` with a signed, expiring PDF link is enough for owners. The overdue nudge uses the same mechanism from the party ledger.
- **Route handlers added:** `GET /api/challans/[id]/pdf`, `GET /api/parties/[id]/statement.(pdf|xlsx)`, `GET /api/reports/tally.xml?fy=` (voucher export), `GET /api/backup/books.xlsx` (admin; full-books workbook), `GET /api/manifest.webmanifest`, `/sw.js`.
- **Error codes added:** `'cheque_state'` (invalid lifecycle transition), `'already_closed'` (day close exists), `'upload_rejected'`.

#### Scenario: challan conversion is idempotent
- WHEN `convertChallanToInvoice` is called twice for the same open challan
- THEN the second call returns the existing draft invoice id and creates nothing new

## Requirement: Implementation clarifications (pre-implementation audit, 2026-09-16)

- **Auth (change 08):** login = `signInWithOtp({ email, options: { shouldCreateUser: false } })`; TOTP via `auth.mfa.enroll/challenge/verify`, enforced in middleware for admin (`aal2` required). Invite = server action with the service client: `auth.admin.inviteUserByEmail` then `rpc('admin_set_user')`. Middleware: session + active `app_users` row, redirect to `/login` otherwise; `/login` redirects to `/` when signed in.
- **Draft creation sets `warehouse_id`** to the default warehouse and `place_of_supply` to the party's default address state; the form may change both.
- **Cash sale:** `postAndReceiveCash(invoiceId, accountId)` = `postInvoice` then `saveDraftPayment`+`postPayment` for the full amount; returns both ids; if the second step fails the envelope carries `code: 'partial'` with the posted invoice id so the UI shows "Invoice posted, receipt failed — record it from Payments".
- **PDF (change 10):** `@react-pdf/renderer` in a Node runtime route handler (`export const runtime = 'nodejs'`); UPI QR generated server-side with the `qrcode` package from `upi://pay?pa=<vpa>&pn=<legal name>&am=<grand_total>&tn=<invoice_no>&cu=INR`; amount-in-words from `src/lib/format.ts`.
- **GSTR-1 (change 18):** before implementing, a research task fetches the current GST portal offline-tool JSON schema for B2B, B2CS, CDNR, HSN, DOC sections and saves it under `docs/research/gstr1-schema.md`; the exporter validates against that shape in a unit test with a golden file.
- **Excel exports:** `exceljs` streaming; numbers written as numbers with `numFmt '#,##0.00'`, dates as dates; never pre-formatted strings.
- **Error codes added:** `'partial'` (multi-step action stopped midway), `'no_period'` (maps `DN_NO_PERIOD`).

## Requirement: Parties, stock and staff actions (change 13, added 2026-09-25)

```
stock.ts   recordAdjustment(header+lines)  -- saves the draft and calls post_stock_adjustment in one action; a refused post deletes the draft. Admin (aal2) only.
           recordTransfer(header+lines)    -- same shape over post_stock_transfer. Admin only.
           receiveTransfer(id)             -- receive_stock_transfer. Admin only; DN_TRANSFER_STATE -> 'transfer_state'.
staff.ts   recordAdvance / recordSalary / recordWages -- draft expense voucher + post_expense_voucher in one action (draft deleted on a refused post). Admin only.
           createEmployee / updateEmployee -- parties rows of type 'employee' with the pay rates. Admin only.
```

- These collapse the catalog's `saveDraft*` + `post*` pairs (`saveDraftTransfer`/`postTransfer`, `saveDraftVoucher`/`postVoucher`): the modals never keep a draft, so one action per modal is the whole contract. Adjustments (no row in the original catalog) follow the same shape.
- **Role gates mirror the database exactly.** `post_stock_adjustment`, `post_stock_transfer` and `receive_stock_transfer` are admin-only; so are the actions, and the controls are not rendered for a counter session. The database lets `user` post an advance voucher up to Rs 5,000; the owner decision (salary/wages owner-only) means there is **no staff screen or action for a counter user** — the route is refused by the proxy and the page, the pay rates and salary/wage vouchers are unreadable to `user` in the database (`20260926100000_staff_salary_owner_only.sql`).
- **Route handlers implemented:** `GET /api/parties/[id]/statement.xlsx?fy=` (exceljs; money as numbers with `#,##0.00`, dates as dates) and `statement.pdf?fy=` (`@react-pdf/renderer`, English). `fy` = a start year or `all`; default the current FY (April–March). Any active member; row-level security decides what is readable.
- **Error code added:** `'transfer_state'` (maps `DN_TRANSFER_STATE`).
- **Never `select *` on `parties`:** the two pay columns are not granted to `authenticated`, so `select *` (or `parties(*)`) fails with `permission denied`. Select columns by name; owner-only pay rates come through `employee_pay_rates()` / `v_employees`.
- **Schemas run twice** (form resolver, then the action): a schema must not `.transform` into a shape it would then reject.
