# Change 18 — self-audit-and-gst: implementation notes

Built 2026-09-26 (Sonnet 5), same session as 17. Live browser walk done (all four report pages, downloads, lock/unlock + audit trail, 390 px; GSTR-3B agreed with the ledger on the demo data). Opus-reviewed (APPROVE AFTER FIXES, fixed below). Proposal: `proposal.md`. Research: `docs/research/gstr1-schema.md`.

## What was built
- Migration `20260930100000_self_audit_and_gst.sql`:
  - `gstr1_data(p_month)` → jsonb in the portal's key names (`b2b`, `b2cl`, `b2cs`, `cdnr`, `nil`, `hsn.hsn_b2b/hsn_b2c`, `doc_issue`) + `totals`, `summary` (per-section counts and sums for the screen) and `warnings`; internal helper `_gst_out_lines`; `gst_uqc(uom)`.
  - `gstr3b_summary(p_month)` rows 3.1a / 3.1c / 3.1d / 3.2:NN / 4A3 / 4A5 / 4D plus ledger reconciliation rows.
  - `set_period_lock(month, locked, reason)` (owner, aal2, audited; unlock needs a reason).
  - Master-edit audit triggers (owner decision 4) on parties, party_addresses, items, organization, accounts — changed columns only, **never** `monthly_salary`/`daily_wage`; those rows and period-lock rows readable by owners only (audit_log policy extended).
  - `trial_balance_asat`, `pnl_range`, `balance_sheet_asat` (security invoker, owner-only via the views) so screens get summed figures, not one row per account per day.
- App: `/reports/trial-balance`, `/reports/pnl`, `/reports/balance-sheet`, `/reports/gst` (GSTR-1 section table, warnings, JSON + Excel download, GSTR-3B table + "agrees with the books" check); `GET /api/reports/gstr1?period=&format=`; Excel for TB/P&L/BS/3B via `/api/reports/[name]/xlsx`; Settings tabs **Period locks** (lock/unlock with reason, drafts per month, create next FY) and **Audit trail** (filters, before → after). en + te messages. Actions `src/app/actions/periods.ts`.

## Gates (2026-09-26)
pgTAP **1769** (new `00025_self_audit_and_gst`: 113 assertions — golden GSTR-1 for a month of real posted documents, 3B rows and reconciliation, period lock + audit, master-edit audit, statements); vitest **575**; `tsc`, lint, `npm run build` clean. (Vitest output is swallowed by the RTK hook: use `rtk proxy npx vitest run`.)

## Decisions taken (conservative; Ratna can overrule)
1. Buyer GSTIN is snapshotted onto `sales_invoices.buyer_gstin` / `credit_notes.buyer_gstin` by trigger at the moment a document becomes posted (review fix; documents posted earlier are backfilled from the master). Later master edits do not move filed invoices between sections.
2. `gt`/`cur_gt` are written as 0 (screen says to enter turnover on the portal). `version` = `GST3.2.2` (unverified).
3. Downloads are **withheld** (422 / buttons hidden) when the month has `no_hsn`, `unmapped_uom`, `export_not_supported` or `org_gstin_missing`; `hsn_short` is advisory (needs 6 digits only above ₹5 cr turnover).
4. Rate-0 lines go to Table 8 (`nil`), not b2b/b2cs; nil/exempt/non-GST are not distinguished (all `nil_amt`).
5. B2C credit notes net off `b2cs` as negative rows (assumed accepted by the portal — unverified); B2B notes go to `cdnr`. Nothing posts a credit note until change 20, so these paths are tested with fixture rows only.
6. Cancelled invoices are excluded from sections but counted in `doc_issue.cancel`. A challan counts as nature 12.
7. 3B is a summary to key in; it does not compute cash payable after ITC utilisation. Reconciliation rows compare document figures with the ledger (a cancellation dated in a later month is the usual legitimate difference).
8. A month can be locked with drafts in it; the screen shows the count.
9. Not built: exports/SEZ, e-commerce, advances (Table 11), amendments, CDNUR, debit notes on sales.

## Review fixes (Opus, 2026-09-26)
1. Cancelling a document dated in a **locked** month is refused (`DN_PERIOD_LOCKED`) by a trigger on sales invoices, purchase invoices, credit notes, challans and expense vouchers — the cancel functions only checked today's period, so a filed month could silently change. The correction for a locked month is a credit note (change 20).
2. 3.1d / 4A3 reverse-charge tax now comes from the voucher entry's `rcm_payable` credit (halved into CGST/SGST), so an input-tax expense line on the same voucher is not counted as RCM (pgTAP covers it; it shows up in `recon_input`).
3. Buyer GSTIN snapshot (above); pgTAP proves removing a party's GSTIN later leaves the filed return unchanged.
4. `org_gstin_missing` also fires for an empty GSTIN.
5. Declined: warning on place of supply `97` (Other Territory is valid inter-state; only `96` = other countries is blocked).
6. New blocking warning `cdnur_not_supported`: a credit note to an unregistered inter-state buyer against an invoice over ₹1,00,000 (belongs in CDNUR, not built) instead of netting it into b2cs.
Gates after fixes: pgTAP 1779 (00025: 122 assertions), vitest 576, tsc/lint clean. Not re-reviewed after the fixes.

## Left to do / for Ratna
- Upload one generated `GSTR1-YYYY-MM.json` to the GST portal (or the Returns Offline Tool) — the schema in `docs/research/gstr1-schema.md` is from India Compliance's key names, not the official schema; **verify before the first real filing**, including UQC codes and `version`.
- The dashboard "Create FY" attention row (from 1 March) is still not built; Period locks has the create button.
