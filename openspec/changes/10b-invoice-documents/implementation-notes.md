# Change 10b — invoice documents: implementation notes (IN PROGRESS, not committed)

10a is committed as `97761bc`. Everything below is uncommitted in the working tree.

## Done and verified
- **Migration** `supabase/migrations/20260920140000_invoice_ewb.sql`: `record_invoice_ewb(...)`, security definer, any active member, posted invoices only, changes only transport + e-way-bill columns, audits. Applied to the LOCAL database with `supabase migration up` (not pushed). pgTAP `supabase/tests/database/00013_invoice_ewb.test.sql`: 16/16 pass when run alone. Full `supabase test db` NOT re-run yet.
- `amountInWords` in `src/lib/format.ts` (+ 24-case table test).
- `src/lib/share-link.ts` HMAC sign / verify (+ test). `src/lib/access.ts` + `src/proxy.ts`: exactly one public shape, `/api/invoices/<uuid>/pdf` with a `sig` param (+ tests).
- `EWAY_BILL_THRESHOLD` in `src/lib/gst.ts`.
- PDF: `src/lib/invoice-pdf/{data,fonts,upi,InvoiceDocument}.ts(x)`, route `src/app/api/invoices/[id]/pdf/route.ts`, fonts in `src/assets/fonts/` (Noto Sans, OFL), `next.config.ts` tracing include. `InvoiceDocument.test.ts`: renders, paginates, cancelled/paid differ, QR decodes back to the exact UPI link. Sample PDFs were rasterised and inspected; four layout defects found and fixed (header overlap, missing "≈" glyph so alt qty is NOT printed, narrow Tax column, page number). The re-rendered images have NOT been looked at yet.
- New dev dependencies: `jsqr`, `pngjs`, `@types/pngjs`, `@types/qrcode`, `@fontsource/noto-sans`. New dependencies: `@react-pdf/renderer` 4.9.0, `qrcode` 1.5.4.

## Not done yet (in order)
1. Look at the re-rendered sample PDFs (cash / long / cancelled / paid).
2. Actions: `src/app/actions/share.ts` (`whatsappInvoiceLink`), `recordInvoiceEwb` (calls the RPC; zod schema in `src/schemas/sales.ts`), and extend `saveDraftInvoice` + `InvoiceForm` with transport mode / distance / transporter GSTIN. Tests (ok / forbidden / no phone / missing secret / DB refusal).
3. UI: posted-view buttons (PDF, Print, WhatsApp dialog with Copy link), EWB panel on the posted view, ₹50,000 hint, UPI note on the form's totals panel, `@media print` block; en + te strings (errors.validation.* for the new DN_VALIDATION details: transport_mode, distance, transporter_gstin, vehicle_no, ewb_no, ewb_incomplete, ewb_dates, transporter_name).
4. `.env.example`: add `INVOICE_LINK_SECRET` (>= 32 chars) and `APP_ORIGIN`; set both in `.env.local`.
5. Gates: lint, tsc, full vitest, build (react-pdf under Next build), `supabase test db` on a clean reset (expect 802 + 16).
6. Real-browser walk-through (1280 + 390 px, light/dark, Telugu), including the signed link opened signed-out, tampered link, expiry.
7. Review (Opus, narrow): signed route + service-client read, access.ts exception, `record_invoice_ewb`. Ask Ratna first.

## Deviations from the proposal (decided while building)
- E-way-bill number / dates are recorded on the posted view only (an e-way bill is made from the posted invoice). The draft form gets only the transport fields (mode, distance, transporter name / GSTIN, vehicle).
- Signed-out request to the plain PDF URL is redirected to /login by the existing gate (not a 401); the route's own 401 covers an owner who has not passed the authenticator step.
- The PDF does not print the alternate-unit quantity (pieces): the line snapshot has no alt-unit name and the font lacks the "≈" sign. Owner question if TMT bills should show pieces.

## Also requested (Ratna, 2026-09-20): a demo with sample data
After 10b works, make a re-runnable demo seed (NOT a migration, never for hosted production): `supabase/demo/demo-data.sql`, run with psql against the LOCAL database as the owner (same `set local role authenticated` + `request.jwt.claims` with `"aal":"aal2"` trick the pgTAP tests use), so every figure goes through the real `post_*` functions. Contents: organisation details (legal name, GSTIN, address, UPI ID, bank details, footer), 2 suppliers, ~6 customers incl. the walk-in and one with a credit limit and delivery sites, cement + TMT items (TMT with pcs<->kg), opening stock via purchase invoices, then 4-6 sales (credit, cash, an IGST one, one cancelled), a receipt. Then a click-through script for the demo. Only built screens can be shown live (sales, parties, items, settings, sign-in); payments, challans, dashboard and reports UIs are changes 11-15.
