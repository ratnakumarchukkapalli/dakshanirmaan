# GSTR-1 portal JSON — what the exporter follows (research for change 18)

Researched 2026-09-26. **Confidence: medium-high, not official.** The GST portal's own JSON schema ships inside the Returns Offline Tool download (a Windows zip) and the developer portal (`developer.gst.gov.in`) is login/GSP-gated, so neither could be fetched. What follows is taken from the key names in **India Compliance** (`resilient-tech/india-compliance`, the open-source ERPNext GST app that files real returns), read on 2026-09-26 from
`india_compliance/gst_returns/fields/gstr1.py` and `india_compliance/gst_india/utils/gstr_1/sections/*.py`, cross-checked against the layout every GST tool documents. **Final proof is the portal itself: upload the generated file to the GST portal (Returns → GSTR-1 → Prepare offline → Upload) or import it in the Returns Offline Tool before the first real filing.** The golden-file test in change 18 pins our output to the shape below, so a change of shape must be a deliberate edit of the golden file.

## Envelope
```json
{ "gstin": "37AAPFU0939F1ZU", "fp": "092026", "gt": 0, "cur_gt": 0, "version": "GST3.2.2", "hash": "hash" }
```
`fp` = filing period `MMYYYY`. `gt` (last FY turnover) and `cur_gt` (current-FY cumulative) are declared aggregate turnover; the offline tool tolerates them as entered. **Owner input needed** (not derivable from the books alone if the books start mid-year); the exporter writes `0` and the screen says so. `hash` is the fixed literal `"hash"` in offline-tool output. `version` is not verified — kept as the value the offline tool writes at the time of research; **check on first upload**.

## Sections (portal key → shape)
Dates `DD-MM-YYYY`. `pos` = 2-digit state code as text (`"37"`). Money = JSON numbers, 2 dp. Rates = numbers (`18`, `28`, `2.5`).

| Section | Key | Shape |
|---|---|---|
| Table 4 B2B | `b2b` | `[{ctin, inv:[{inum, idt, val, pos, rchrg:"N", inv_typ:"R", itms:[{num, itm_det:{rt, txval, iamt, camt, samt, csamt}}]}]}]` — one `itms` entry per tax rate (`num` = 1,2,… per invoice); `inv_typ` codes: `R` regular, `SEWP`/`SEWOP` SEZ, `DE` deemed export |
| Table 5 B2CL | `b2cl` | `[{pos, inv:[{inum, idt, val, itms:[{num, itm_det:{rt, txval, iamt, csamt}}]}]}]` — inter-state, unregistered buyer, invoice value **> ₹1,00,000** (threshold lowered from ₹2.5 lakh by Notification 12/2024-CT, effective 01-08-2024) |
| Table 7 B2CS | `b2cs` | `[{sply_ty:"INTRA"|"INTER", pos, typ:"OE", rt, txval, iamt, camt, samt, csamt}]` — aggregated per (supply type, place of supply, rate); `typ` `OE` = other than e-commerce |
| Table 9B CDNR | `cdnr` | `[{ctin, nt:[{ntty:"C"|"D", nt_num, nt_dt, val, pos, rchrg, inv_typ, itms:[{num, itm_det:{rt, txval, iamt, camt, samt, csamt}}]}]}]` |
| Table 8 Nil/exempt/non-GST | `nil` | `{inv:[{sply_ty:"INTRB2B"|"INTRB2C"|"INTRAB2B"|"INTRAB2C", expt_amt, nil_amt, ngsup_amt}]}` |
| Table 12 HSN | `hsn` | From the **May 2025** return period the table is split: `{hsn_b2b:[…], hsn_b2c:[…]}` (older files: `{data:[…]}`); row `{num, hsn_sc, desc, uqc, qty, rt, txval, iamt, camt, samt, csamt}`. HSN digits required: 4 if last-FY aggregate turnover ≤ ₹5 cr, 6 above (Phase-3 of Table 12, effective May 2025 return period) |
| Table 13 Documents issued | `doc_issue` | `{doc_det:[{doc_num:<1..12>, docs:[{num, from, to, totnum, cancel, net_issue}]}]}`; `doc_num` natures: 1 invoices for outward supply · 4 debit notes · 5 credit notes · 6 receipt vouchers · 9–12 delivery challans (job work / approval / liquid gas / other purposes) … `totnum` = issued (incl. cancelled), `cancel` = cancelled, `net_issue = totnum − cancel` |

`itms[].num` and top-level `num` fields only need to be unique and positive within their list.

## Units (`uqc`)
GST UQC codes are upper case and from a fixed list (from memory of the portal list — **verify against the portal's UQC table on first upload**): bag → `BAG`, kilogram → `KGS`, tonnes → `TON`, pieces → `NOS`, bundles → `BDL`, metre → `MTR`, square metre → `SQM`. Our items carry a free-text `base_uom`; the exporter maps the ones this business uses (bag, kg, tonne/mt, nos/pcs) and reports any other unit as a warning rather than guessing (`OTH`).

## What this business needs (decisions for the exporter)
- Sales are B2B (buyer has a GSTIN) or B2C. Inter-state B2C above ₹1 lakh per invoice → `b2cl`; every other B2C → `b2cs`.
- Cancelled invoices are **not** in b2b/b2cs but **are** counted in `doc_issue` (`cancel`).
- Buyer GSTIN (`ctin`) is the snapshot taken when the invoice or credit note was posted (`buyer_gstin`), so a later edit of the party master does not change a filed month; the master-edit audit trail records such edits.
- Exports, SEZ, e-commerce (Table 15), advances (Table 11), amendments (B2BA…) are **not** built; the exporter warns when it meets something it cannot represent (e.g. place of supply `96`/`97` on a sale, a sale with no HSN).

## Sources
- India Compliance field names: https://github.com/resilient-tech/india-compliance (`gst_returns/fields/gstr1.py`, `gst_india/utils/gstr_1/sections/`)
- B2CL threshold: Notification 12/2024-Central Tax (10-07-2024), effective 01-08-2024; see https://help.tallysolutions.com/b2c-large-invoices-5a-5b/
- Table 12 HSN phase-3 (May 2025): GST portal advisory, summarised at https://help.tallysolutions.com/tally-prime/gstr-1/export-gstr-1-in-json-format-update-rate-wise-hsn-sac-summary/
- Returns Offline Tool manual (sections list, JSON name `Month_YYYY-YY_GSTR1_SupplierGSTIN`): https://tutorial.gst.gov.in/downloads/invoiceuploadofflineutility.pdf
