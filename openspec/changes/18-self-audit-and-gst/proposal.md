Skill: daksh-schema + daksh-posting (read functions), daksh-api (route handlers, actions), daksh-ui (screens)
Spec section: openspec/specs/api-architecture/spec.md → "GSTR-1 (change 18)" clarification and `GET /api/reports/gstr1`; db-architecture → "Views (change 06)" (TB/P&L/Balance sheet) and `audit_log`; frontend-architecture → reports + settings (period locks, audit trail)
Context: The family files GST and validates the books themselves — there is no accountant. So the app must show them the trial balance, P&L and balance sheet, produce GSTR-1 in the portal's JSON (plus Excel) and a GSTR-3B summary they can key into the portal, let them lock a month once filed, and show who changed what.
Do not: write GST math in TypeScript (the database builds every figure); post anything; read the party master for anything but the buyer's GSTIN; push to hosted; commit.
Prerequisite done: `docs/research/gstr1-schema.md` (portal JSON shape, sources, confidence — verify by uploading one real file before the first filing).

## Scope

1. **Database (one migration `20260930100000_self_audit_and_gst.sql`).**
   - `gstr1_data(p_month)` (admin, aal2) → `jsonb`: `b2b`, `b2cl`, `b2cs`, `cdnr`, `nil`, `hsn_b2b`, `hsn_b2c`, `doc_issue` in the portal's key names, plus `totals` and `warnings` (sale with no HSN, unmapped unit, place of supply 96/97, buyer GSTIN missing where B2B intended…). Posted invoices only in the sections; cancelled ones counted in `doc_issue`.
   - `gstr3b_summary(p_month)` → rows (3.1(a), 3.1(c), 3.1(d), 3.2 by state, 4(A)(3), 4(A)(5), 4(D)) + a books reconciliation (document figures vs the output-tax ledger).
   - `set_period_lock(p_month, p_locked, p_reason)` (admin, aal2, audited); unlocking needs a reason.
   - Audit trail for master edits (owner decision 4): AFTER INSERT/UPDATE triggers on `parties`, `party_addresses`, `items`, `organization`, `accounts` writing `audit_log` (changed columns only; **never** the pay columns of a party); those rows readable by owners only.
2. **Route handlers** (owner, aal2): `GET /api/reports/gstr1?period=YYYY-MM[&format=xlsx]` → `GSTR1-YYYY-MM.json` (or workbook); `GET /api/reports/[name]/xlsx` gains `trial-balance`, `pnl`, `balance-sheet`, `gstr3b`. `exceljs` only.
3. **Screens.** Reports: Trial balance, Profit & loss, Balance sheet (as-at date), GST (GSTR-1 preview with the sections' counts/totals + warnings + download buttons; GSTR-3B table). Settings: **Period locks** (month list, lock/unlock with reason, "create next financial year") and **Audit trail** (filter by entity/person/date, before → after for master edits). English + Telugu.
4. **Tests.** pgTAP (`00025`): golden-file shape of `gstr1_data` for a month of posted documents (B2B, B2CL, B2CS intra/inter, cancelled invoice, nil-rated line, credit note fixture), 3B rows, reconciliation, period lock function + audit, master-edit audit (and that pay columns never appear, counter cannot read those rows). Vitest: envelope wrapper, UQC map, workbook, route handler roles.
5. **Docs.** db-architecture, RUNBOOK (monthly GST checklist), STATUS.

## Conservative defaults (log in `implementation-notes.md`)
- Buyer GSTIN is read live from the party master (invoices do not snapshot it); a later edit changes older exports, and the audit trail records the edit. Snapshot column = owner decision.
- `gt`/`cur_gt` (turnover) are written as 0 and the screen says to enter them in the portal.
- Not built: exports/SEZ, e-commerce, advances (Table 11), amendments; the exporter warns instead of guessing. Credit-note sections are built and tested with fixtures, but nothing posts a credit note until change 20.
- 3B is a summary to key in, not a filing; it does not compute the cash payable after ITC utilisation.
- A month can be locked while it still has drafts; the screen lists them.

## Done when
- "TB Σdr = Σcr on screen" (all three statements agree with the views); "GSTR-1 JSON validates against the portal schema for a month of posted invoices" as far as this environment can prove: the golden file matches `docs/research/gstr1-schema.md` and the section totals equal the ledger's output tax (or the difference is explained by the reconciliation row).
- Locked month refuses posting (existing trigger) and the lock/unlock is in the audit trail.
- pgTAP, vitest, `tsc`, lint, `npm run build` clean; live browser walk; Opus review before push.
