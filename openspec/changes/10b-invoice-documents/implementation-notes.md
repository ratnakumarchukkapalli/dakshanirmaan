# Change 10b — invoice documents: implementation notes

Status: **built, all gates green, NOT reviewed.** A library-layer WIP commit (`285d477`) is pushed; the actions, UI, strings, env names and tests below are uncommitted on top of it. Nothing is applied to the hosted database (the one migration ran locally only).

## What exists
- **Migration** `supabase/migrations/20260920140000_invoice_ewb.sql`: `record_invoice_ewb(...)`, security definer, any active member, posted invoices only, changes only the transport and e-way-bill columns, audits (before and after). pgTAP `00013_invoice_ewb.test.sql` (16). Full `supabase test db`: **818 pass** (802 + 16).
- **PDF**: `GET /api/invoices/[id]/pdf` (`@react-pdf/renderer`, Noto Sans under OFL, `src/assets/fonts/`). Posted and cancelled only (draft 409, unknown 404, signed-out 401 / sign-in redirect). Every figure is a stored value. Amount in words (`amountInWords`, 24-case golden table). UPI QR for the *open* amount only; PAID text and no QR when nothing is owed; CANCELLED watermark and no QR on a cancelled invoice. English only, by spec. Sample renders (cash, 45-line inter-state, cancelled, paid) were rasterised and looked at: header, table, totals, QR, watermark and pagination are correct.
- **Signed link** `src/lib/share-link.ts`: HMAC-SHA256 over `<id>.<expiry>`, 24 h, constant-time check. The plain PDF route accepts `?exp=&sig=` in place of a session; the signature is checked first, then that one invoice is read with the service client. Every refusal is a bare 403; a per-IP limiter (20 bad signatures / 10 min) returns 429. `access.ts` has exactly one public shape (`/api/invoices/<uuid>/pdf` with a `sig` param), unit-tested.
- **Actions**: `src/app/actions/share.ts` `whatsappInvoiceLink` (any active member); `recordInvoiceEwb` and the transport fields on `saveDraftInvoice` in `src/app/actions/sales.ts`. Schemas in `src/schemas/sales.ts` (`recordEwbSchema`, `TRANSPORT_MODES`).
- **UI**: posted-view header has PDF (download), Print (opens the PDF in a new tab) and WhatsApp (dialog: Open WhatsApp / Copy link, 24-hour note). Cancelled invoices keep PDF only. New `EwbPanel` on the posted view (transport + e-way bill, edit dialog, threshold hint). The draft form's transport disclosure gained mode, distance and transporter GSTIN, the ₹50,000 hint, and the UPI note (three variants). `@media print` hides the shell. English and Telugu strings for all of it.
- **Env names** in `.env.example`: `INVOICE_LINK_SECRET` (>= 32 chars, server-only) and `APP_ORIGIN`. Values are in `.env.local` only.

## Verified
- `npx tsc --noEmit`, `npm run lint` (0 warnings), `vitest` **261 tests / 23 files**, `npm run build` (react-pdf builds), `supabase test db` 818.
- Real Chrome walk-through against the production build and the local database: **54 of 54 checks**. Counter user, signed in by email code. Covered: transport fields save on a draft and reload; draft PDF refused (409); post; e-way-bill dialog refuses a short number, a number without dates, and valid-until before the date; recording leaves status, total and journal untouched (compared in the database) and writes one audit row; PDF text (via `pdftotext`) matches the stored grand total, taxable and CGST, and carries amount in words, customer GSTIN, ship-to site, vehicle and e-way bill; wa.me goes to the customer's WhatsApp number; the signed link opens the PDF signed-out, and fails (403) with one character changed, a changed expiry, a missing expiry, another invoice's id, or an expired but correctly signed link; the plain URL signed-out does not serve the PDF; a signed link opens no other path; 25 bad signatures give 429; a customer with no WhatsApp number gets Copy link and no Open WhatsApp; a fully paid invoice says PAID with no QR; print media hides the shell; no sideways scroll at 390 px (posted view, dialog open, form with transport open); taps >= 44 px; Telugu strings render; a cancelled invoice keeps PDF only, its PDF says CANCELLED with no QR, and the database refuses `record_invoice_ewb` on it (`DN_NOT_POSTED`).
- Screenshots inspected (1280 and 390 px, light and dark, Telugu): posted view, WhatsApp dialog, e-way-bill dialog with its error, form with the transport panel.

## Bugs found by testing (fixed)
- `validUntilDate` was exported from a `'use client'` file and called by the server page: the build was clean but the posted view crashed at runtime. Moved to `src/lib/ewb.ts`.
- Header buttons were under 44 px on a phone (rule added).
- Landline versus mobile: see deviation 2.
- `renderToBuffer` typing (`invoiceDocument()` helper), a lint warning on the react-pdf `Image`.

## Deviations from the proposal (decided while building)
1. E-way-bill number and dates are recorded on the posted view only. The draft form carries transport fields only (mode, distance, transporter name and GSTIN, vehicle).
2. **WhatsApp uses the party's `whatsapp_phone` only, never `phone`.** The proposal said "else phone". The database stores phones as bare digits, so a landline entered as `0863 2345678` is stored as `8632345678`, indistinguishable from a mobile. Falling back to it could send an invoice to a stranger. A customer with no WhatsApp number gets "Copy link". The action returns ok with `whatsappUrl: null` instead of a refusal, so the link is still available to copy.
3. "Valid until" is entered as a date and stored as the end of that day at +05:30 (India has no daylight saving).
4. A signed-out request to the plain PDF URL is redirected to /login by the existing gate rather than answered with 401; the route's own 401 covers an owner who has not passed the authenticator step.
5. The PDF does not print the alternate-unit quantity (pieces): the line snapshot has no alt-unit name and the font lacks the "≈" sign. **Owner question:** should TMT bills show pieces?
6. Vehicle numbers are now validated on the draft as well (`^[A-Z0-9 -]{4,20}$`, after upper-casing), because the database function re-checks the same shape and would otherwise refuse an e-way-bill edit for a draft that saved fine.

## Owner questions (defaults taken)
- Any active member may download, print, WhatsApp and record e-way-bill details (nothing here changes the books). Should counter staff send invoices on WhatsApp?
- The link shows the invoice to anyone who has it for 24 hours (including a CANCELLED watermark if it was cancelled since). Acceptable?
- The QR asks for the open amount at the time the PDF is made, so a part-paid invoice never asks for the whole total.
- The e-way-bill threshold text is advice, never a block.

## Known limits
- **`INVOICE_LINK_SECRET` rotation is the only kill switch for share links.** There is no per-link revocation: every issued link stays valid until its 24-hour expiry unless the secret is changed, which invalidates all live links at once (and needs a redeploy). The bad-signature rate limiter is per server instance (memory), so it slows guessing but is not a global limit. **Open owner question:** is "rotate the secret to revoke everything" acceptable, or should links be revocable one by one (a small table of issued link ids)? (Opus review of 10b/11, 2026-09-25.)
- The rate limiter for bad signatures is in memory per server instance (the same accepted limit as sign-in).
- `record_invoice_ewb` and the PDF route check membership, not the authenticator step, in the database (change 19 covers all functions; the route and action check it in the app).
- The function's `search_path` is `public, pg_temp`, like the posting functions (the proposal said `''`).
- Not done (out of scope, per the proposal): challan PDF and "against challan" (change 11), IRN and e-way-bill portal APIs, Telugu PDF, HSN-wise tax summary (needed by change 18), credit-note PDF, emailing invoices.

## Local database note
The walk-through left TEST data in the local database (parties, items, two customers with posted invoices, a test counter account now deactivated). Organisation settings were restored. `supabase db reset` clears it, but wipes the sign-in accounts (recreate the owner with `npm run create-admin`).

## Review (not done; ask Ratna first)
Narrow Opus review with `daksh-review` of exactly: the signed public link route and its service-client read, the `access.ts` exception, `record_invoice_ewb`, and `whatsappInvoiceLink`.

## Files
Added: `src/app/actions/share.ts` (+ test), `src/components/sales/{InvoiceActions,EwbPanel}.tsx`, `src/lib/ewb.ts`, `src/lib/share-link.ts` (+ test), `src/lib/invoice-pdf/*`, `src/app/api/invoices/[id]/pdf/route.ts`, `src/assets/fonts/*`, the migration and its pgTAP test.
Changed: `src/schemas/sales.ts`, `src/app/actions/sales.ts` (+ test), `src/components/sales/InvoiceForm.tsx`, the posted-view and draft pages, `src/lib/{format,gst,access,phone,sales-data,sales-types}.ts` (+ tests), `src/proxy.ts`, `src/app/globals.css`, `src/messages/{en,te}.json`, `next.config.ts`, `.env.example`, `package.json`.
