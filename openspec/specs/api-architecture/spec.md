# API Architecture Specification

## Purpose

Define how the Next.js app talks to Supabase: server actions, RPC contracts, validation, authorization, and exports. There is no separate backend — Postgres functions are the write API; views are the read API.

## Requirement: Access layers

1. **Reads** — React Server Components query views/tables via the server Supabase client (`@supabase/ssr`, cookie-bound, RLS enforced). No client-side data fetching for business data in v1 (no SWR/React Query until a real need appears).
2. **Writes** — Server Actions only (`'use server'`). Every action: (a) parses input with a zod schema, (b) checks the caller's `app_users.role`, (c) calls the matching Postgres function via `.rpc()` or performs draft-table writes, (d) `revalidatePath` for affected routes, (e) returns the result envelope.
3. The browser SHALL never hold the service-role key. Server actions use the user-scoped client so RLS applies; only the posting RPCs (SECURITY DEFINER) escalate.

## Requirement: Action catalog

One module per capability under `src/actions/`:

```
parties.ts    createParty, updateParty, addPartyAddress, deactivateParty
items.ts      createItem, updateItem, deactivateItem
sales.ts      saveDraftInvoice(header+lines), postInvoice(id), cancelInvoice(id)
purchases.ts  saveDraftBill, postBill(id), cancelBill(id)
notes.ts      saveDraftNote, postNote(id)   -- credit/debit
payments.ts   saveDraftPayment(+allocations), postPayment(id)
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
payments.ts    + depositCheque(id), markCleared(id), bounceCheque(id)   -- admin for bounce
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
