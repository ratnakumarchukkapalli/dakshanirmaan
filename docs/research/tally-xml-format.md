# Tally XML import format (ledger masters + accounting vouchers) for the Tally exporter

Researched 2026-10-02. No Tally was available to test against. Evidence tiers:
- **[PRIMARY]** Tally's own TallyHelp pages. Fetched through a summarising tool, so wording is paraphrased, not quoted: `help.tallysolutions.com/xml-interface/`, `/sample-xml/`, `/import-data-from-xml-or-json/`, `/import-data-faq/`, `/docs/te9rel66/Data_Management/import-data.htm`, `/docs/te9rel65/Data_Management/DM_Import_Vch.htm`, `/article/DeveloperReference/integration-capabilities/case_study_1.htm`, `/docs/te9rel53/Data_Management/DM_Import_Masters.htm`, `/pre-requisites-for-integrations/`.
- **[LIVE]** Third-party notes that record measurements against a real TallyPrime 7.x, sent over the HTTP gateway (port 9000), not the Gateway > Import menu. `ComplyEaze/bridge` `docs/tally/TALLY_PROTOCOL_REFERENCE_{ENVIRONMENT_AND_REQUESTS,WRITE_RESPONSES_AND_MASTERS,VOUCHER_WRITES,READS_AND_DATES}.md`; `puneetkeshav/tally-integration` `quirks.md` + `tally-general-guide.md` (650+ vouchers, TallyPrime, June 2026); `anpixelartist/MigrationEase` `backend/app/pipeline/conversion/{builder,voucher_builder}.py`.
- **[CODE]** Open-source generators that emit the XML but whose Tally runs are not documented: `chetan137/WallnutB_AWS` `scripts/importToTally.js` (Sales and Credit Note, accounting mode), `ronakkitpathsolutions/tally-connector` `src/xml/buildMastersXml.ts` (ledger masters incl. GST), `frappe/tally_migrator` `tally/mappings.py` (default group names).
- UNVERIFIED = not confirmed by [PRIMARY] or [LIVE].

Caveat: every [LIVE] finding was observed over the HTTP gateway. The file import (Gateway of Tally / TallyPrime Import) uses the same import engine, but whether it behaves identically is UNVERIFIED.

## 1. Envelope

[PRIMARY] `ENVELOPE > HEADER > TALLYREQUEST "Import Data"`, then `BODY > IMPORTDATA > REQUESTDESC (REPORTNAME + STATICVARIABLES) > REQUESTDATA > TALLYMESSAGE`. `REPORTNAME` is `All Masters` for masters and `Vouchers` for vouchers. `TALLYMESSAGE` carries `xmlns:UDF="TallyUDF"`. The other spelling, `HEADER > VERSION 1 / TALLYREQUEST Import / TYPE Data / ID Vouchers`, with `BODY > DESC > STATICVARIABLES` and `BODY > DATA > TALLYMESSAGE`, is also in [PRIMARY] (case study 1). It is the HTTP-gateway form. Use the `IMPORTDATA` form for a downloaded file.

- Put masters and vouchers in **separate envelopes**: the REPORTNAME differs, and masters must exist before vouchers [PRIMARY]. Whether one file can carry both is UNVERIFIED. Recommendation: the endpoint emits two files, `tally-masters.xml` then `tally-vouchers.xml`, and the README says to import in that order.
- `SVCURRENTCOMPANY` must equal the open company's exact name over HTTP, else `Could not set 'SVCurrentCompany'` [LIVE]. Whether the file import validates it is UNVERIFIED. Recommendation: emit it only when `&company=` is given, so the default imports into whichever company is open.
- Each voucher gets its own `TALLYMESSAGE` [LIVE]. At scale over HTTP, one voucher per request was the only reliable way (multi-voucher requests failed with `Voucher date is missing ... retry Split`) [LIVE]. Whether a single file of 10,000 vouchers is safe in the file import is UNVERIFIED. This is the biggest risk for a year-sized file, so ask the CA to test a full year.

Ledger master (minimal, complete):
```xml
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>
 <STATICVARIABLES><SVCURRENTCOMPANY>Daksha Nirmaan Traders</SVCURRENTCOMPANY>
  <IMPORTDUPS>@@DUPIGNORECOMBINE</IMPORTDUPS></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
 <LEDGER NAME="Ram &amp; Sons" ACTION="Create"><NAME>Ram &amp; Sons</NAME>
  <PARENT>Sundry Debtors</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
```
Voucher (Sales, Dr party 11,800.00 / Cr Sales 10,000.00 / Cr CGST 900.00 / Cr SGST 900.00):
```xml
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>
<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
 <VOUCHER REMOTEID="dn-inv-2627-0001" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
  <DATE>20260915</DATE><EFFECTIVEDATE>20260915</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>INV/26-27/0001</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Ram &amp; Sons</PARTYLEDGERNAME><ISINVOICE>No</ISINVOICE>
  <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><NARRATION>Invoice INV/26-27/0001</NARRATION>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Ram &amp; Sons</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
   <ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
```
`IMPORTDUPS` tokens are `@@DUPCOMBINE` [PRIMARY case study], `@@DUPMODIFY` [CODE: MigrationEase], and `@@DUPIGNORECOMBINE` (UNVERIFIED spelling; it matches the UI choice "Ignore duplicates"). Whether the file import honours the tag, or only the menu choice, is UNVERIFIED.

## 2. Sign rule

- Debit line: `ISDEEMEDPOSITIVE` = `Yes`, `AMOUNT` **negative**. Credit line: `ISDEEMEDPOSITIVE` = `No`, `AMOUNT` **positive**. The signed amounts of a voucher sum to zero.
- [PRIMARY] TallyHelp sample XML: party ledger `Yes` / `-215476.00`, Sales ledger `No` / positive; "total debits must equal total credits". (The sample's own numbers are mistyped and do not balance. Take the rule from the signs, not the figures.)
- [LIVE] confirmed it on real postings: Receipt = income Cr (`No`, +) and bank Dr (`Yes`, -) [puneetkeshav guide §4/§5]. Credit Note = party Cr (`No`, +), Sales Returns Dr (`Yes`, -) [CODE: WallnutB].
- So the exporter has no per-voucher-type special case: map each journal line by its own side. Dr gives `Yes` and `-amount`; Cr gives `No` and `+amount`.
- Zero-amount lines: omit them (UNVERIFIED how Tally treats a 0.00 line). Never emit `-0.00`.
- `ISPARTYLEDGER` `Yes` on the party line is in the [PRIMARY] sample. `ISLASTDEEMEDPOSITIVE` appears in real day-book exports and is not needed.

## 3. Voucher fields

| Field | Status |
|---|---|
| `DATE` `YYYYMMDD` | mandatory [PRIMARY]. Must lie inside the company's financial year/books range or the voucher is rejected, with the misleading `Voucher date is missing` [LIVE] |
| `VOUCHERTYPENAME` | mandatory [PRIMARY]. Matched case-insensitively [LIVE] |
| ledger entries (`LEDGERNAME`, `AMOUNT`) | mandatory. Case study 1's minimal voucher lacks `ISDEEMEDPOSITIVE`; always send it [LIVE] |
| `VOUCHERNUMBER` | in every [PRIMARY] sample. **Discarded** if the voucher type's numbering is Automatic (Tally assigns its own); preserved only for Manual numbering [LIVE]. Put the document number in `NARRATION` as well |
| `NARRATION` | optional |
| `PARTYLEDGERNAME` | optional for Journal/Receipt/Payment. For Sales/Purchase/Credit/Debit Note, send it plus `ISPARTYLEDGER` Yes on that line. Effect of omitting it is UNVERIFIED |
| `EFFECTIVEDATE` | optional; use the same value as `DATE` [LIVE] |
| `ACTION="Create"` / `VCHTYPE` attributes | `ACTION` per [PRIMARY]. `VCHTYPE` is carried by every [LIVE]/[CODE] example; always send it equal to `VOUCHERTYPENAME` |
| `ISINVOICE` | `No` for an accounting-mode voucher (no stock) [PRIMARY]. With `Yes`, Tally wants inventory and party/tax lines under `LEDGERENTRIES.LIST`, and a failure is silent (`EXCEPTIONS=1`, no `LINEERROR`) [LIVE]. Keep `No` plus `PERSISTEDVIEW` "Accounting Voucher View" |
| list tag | use `ALLLEDGERENTRIES.LIST` for accounting-mode vouchers [LIVE]. TallyHelp's Prime sample spells it `LEDGERENTRIES.LIST`. Whether Prime accepts both for `ISINVOICE=No` is UNVERIFIED |
| `REMOTEID` attribute | idempotency: re-sending the same `REMOTEID` with `ACTION="Create"` alters in place (`CREATED=0, ALTERED=1`) and never duplicates [LIVE]. Without it, a resend duplicates, and the voucher cannot be altered or deleted later. Use the journal-entry id. A `GUID` tag and the TallyHelp option "Overwrite voucher when a voucher with the same GUID exists" [PRIMARY FAQ] are the alternative; the file import's handling of `REMOTEID` is UNVERIFIED |

Voucher type names (Indian Tally): `Sales`, `Purchase`, `Receipt`, `Payment`, `Journal`, `Contra`, `Credit Note`, `Debit Note` [PRIMARY/LIVE class list]. In GST Tally, a Credit Note is a sales return/price reduction and a Debit Note is a purchase return. Whether Credit/Debit Note vouchers must first be enabled in the company (F11 "Use Debit/Credit Notes") is UNVERIFIED. Source-type mapping to flag for the CA:
- Journal vouchers that touch **Bank/Cash** ledgers: Tally's UI limits Journal to non-bank/cash ledgers (UNVERIFIED for import). Safer mapping: any entry with a Bank or Cash line is Receipt (net Dr to bank/cash), Payment (net Cr), or Contra (bank/cash on both sides, e.g. `cash_deposit`). Keep Journal for the rest. This refines the proposal's "cash_deposit & everything else is Journal".

## 4. Ledger master

- Tags: `LEDGER NAME="..." ACTION="Create"`, inner `<NAME>` (**mandatory** even though `NAME` is also an attribute [LIVE]), `<PARENT>` (mandatory [PRIMARY]; must be an existing group). Optional tags: `ISBILLWISEON` Yes/No [CODE] (set `No` explicitly: with `Yes`, Tally expects bill allocations on voucher lines, which we do not emit; the default for Sundry groups via XML is UNVERIFIED), `PARTYGSTIN`, `GSTREGISTRATIONTYPE`, `LEDSTATENAME`, `COUNTRYNAME` [CODE], `MAILINGNAME.LIST`, `ADDRESS.LIST`, `PINCODE`, `EMAIL` [PRIMARY].
- Default groups [CODE frappe/tally_migrator mappings.py; exact names with punctuation]: `Capital Account`, `Reserves & Surplus`, `Loans (Liability)`, `Secured Loans`, `Unsecured Loans`, `Bank OD A/c`, `Bank OCC A/c`, `Current Liabilities`, `Duties & Taxes`, `Provisions`, `Sundry Creditors`, `Suspense A/c`, `Branch / Divisions`, `Fixed Assets`, `Investments`, `Current Assets`, `Bank Accounts`, `Cash-in-Hand`, `Deposits (Asset)`, `Loans & Advances (Asset)`, `Stock-in-Hand`, `Sundry Debtors`, `Misc. Expenses (ASSET)`, `Sales Accounts`, `Direct Incomes`, `Indirect Incomes`, `Purchase Accounts`, `Direct Expenses`, `Indirect Expenses`. TallyHelp's own full list was not retrievable; treat as UNVERIFIED against [PRIMARY]. `&` must be escaped even here: `Duties &amp; Taxes` [LIVE].
- GST attributes can be omitted: [CODE: tally-connector] creates Sales/expense ledgers with only NAME+PARENT. Optional on tax ledgers: `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>Central Tax|State Tax|Integrated Tax</GSTDUTYHEAD>` ([LIVE] vocabulary; any other spelling is silently dropped). Default: omit and let the CA classify. Behaviour if GST is not enabled in the target company is UNVERIFIED.
- Duplicates: over HTTP, re-sending `ACTION="Create"` for an existing ledger is a **silent Alter** (`CREATED=0, ALTERED=1`, existing master overwritten) [LIVE]. The file import offers three choices [PRIMARY]: Combine opening balances / Ignore duplicates / Modify with new data. Name matching is case-insensitive, ignores trailing/leading/collapsed spaces, and treats hyphen = space = slash [LIVE, 7.1]. So the exporter must **de-duplicate ledger names under that folding** (two accounts "Ram-Sons" / "Ram Sons" would merge). It rejects en dash, underscore, and `AND` for `&` [LIVE].
- Do not emit any ledger Tally already reserves (`Profit & Loss A/c`, `Cash`, ...). Use the app's names but skip reserved ones.

## 5. Opening balances

- Ledger-master `OPENINGBALANCE` sign is **contradictory across sources**: [PRIMARY] case-study sample shows Bank `-12500`; MigrationEase [LIVE] says Debit = positive, Credit = negative (imported `+12345` read back as Debit), the **opposite** of voucher `AMOUNT`. UNVERIFIED which is right for the file import. Tally also shows a "Difference in opening balances" if they do not net to zero.
- Voucher amounts are the one sign rule confirmed by many sources. Recommendation (matches the proposal): masters with no opening balance, plus one **opening Journal voucher** with `VOUCHERNUMBER` `OPENING`, `REMOTEID` `dn-opening-<fy>`, and `NARRATION` "Opening balances brought forward", carrying each balance-sheet ledger as a signed line.
- Date: a voucher dated the day before FY start is rejected unless the Tally company's books begin earlier [date-range rule, LIVE]. Use the **first day of the FY (1 April)**. Educational mode allows only the 1st, 2nd and last day of a month [LIVE], and 1 April is allowed.
- Trade-offs: Tally's "Opening balance" column then shows 0 and the Day Book shows an entry on 1 April, but closing balances and the trial balance tie. If the CA prefers true openings, they can restate once the sign is confirmed on a real import. Do not emit P&L ledgers in the opening journal (the app's carry-forward is balance-sheet only).

## 6. Encoding, escaping, numbers

- Tally mirrors the request charset in its reply: a UTF-8/ASCII request returned `?` for Devanagari, a UTF-16LE (BOM `FF FE`, `charset=utf-16`) request returned exact text [LIVE]. [PRIMARY]: UTF-8, UTF-16 or ASCII accepted; UTF-16 recommended for special symbols. Nine hostile names (Devanagari, Tamil, Bengali, Gujarati, `₹`, curly quotes, `&`) written in UTF-16 read back byte-identical [LIVE].
- Recommendation for the Telugu names: **UTF-16LE with BOM and `<?xml version="1.0" encoding="UTF-16"?>`**. Fallback: ASCII-only UTF-8 with numeric character references (`&#xC15;`); [PRIMARY] shows Tally needing `&#8387` style entities in an XML import for currency symbols. Whether file import reads plain UTF-8 Telugu correctly is UNVERIFIED.
- Escape `&` `<` `>` in every name and narration. A raw `&` makes the whole file malformed (`Unknown Request, cannot be processed`, no counters) [LIVE].
- Strip C0 control characters except tab/LF/CR. Tally itself emits illegal `&#4;` references [LIVE]; do not copy them. Emoji (astral characters) in names/narrations: UNVERIFIED, so replace with a space in ledger names and keep out of narrations.
- Max ledger-name length: UI allows 75 characters (secondary source, UNVERIFIED); the bridge project has a 128 assumption it never measured. Truncate to 75 and append a numeric suffix if truncation would collide.
- Amounts: plain decimal, `.` separator, exactly 2 places, `-` prefix for debit, no thousands separators, no currency symbol [PRIMARY samples: `-215476.00`, `-12000.00`]. Quantities are not exported.
- Dates `YYYYMMDD` [PRIMARY]. File line endings and a missing `<?xml?>` declaration: UNVERIFIED (UTF-8 without BOM and `\n` worked over HTTP [LIVE]).

## 7. Import results and failure modes

- Response [LIVE] is a bare `<RESPONSE>` with `CREATED ALTERED DELETED LASTVCHID LASTMID COMBINED IGNORED ERRORS CANCELLED EXCEPTIONS` (the [PRIMARY] case study lists the same minus `DELETED/CANCELLED/EXCEPTIONS`). A rejected line adds `<LINEERROR>`. **`ERRORS=0` is not success**: a rejected voucher returned `CREATED=0, ERRORS=0, EXCEPTIONS=1` plus a `LINEERROR`. Success = created count correct, `ERRORS=0`, `EXCEPTIONS=0`, no `LINEERROR` [LIVE]. `LINEERROR` text can mislead (a bad date gave "Voucher date is missing").
- File import: errors go to `Tally.imp` in the Tally installation folder [PRIMARY]. The "Ignore errors during import" setting lets the good vouchers through (secondary, UNVERIFIED).
- Known failures: ledger missing or spelled differently (`Ledger 'X' does not exist`; the voucher is rejected, often with a poor message) [LIVE]; unbalanced voucher (`Voucher totals do not match`); date outside the books period; raw `&`; Automatic numbering discards the number and a resend duplicates; stock-style `ISINVOICE=Yes` with no inventory gives silent `EXCEPTIONS=1`; company features must match [PRIMARY: "features enabled while exporting should be enabled in the importing company"]; Educational mode accepts only the 1st/2nd/last day of a month ("Voucher date is missing") [LIVE]; a jammed import engine after sustained bulk runs [LIVE]; no valid licence means all writes fail [LIVE].
- Masters failure: unknown `PARENT` group, or a missing inner `<NAME>` [LIVE].

## 8. Only a real Tally test-import can confirm

1. File import (not HTTP) accepts our two files and a full year's size (10,000 vouchers), versus per-voucher requests.
2. Master `OPENINGBALANCE` sign (we avoid it), and the opening journal on 1 April: balances in Trial Balance match the app.
3. Voucher numbering: does `VOUCHERNUMBER` survive, and how to switch Sales/Purchase/... to Manual numbering (README step).
4. `REMOTEID` re-import behaves as ALTER in the file import; the duplicate-mode token `@@DUPIGNORECOMBINE` and `SVCURRENTCOMPANY` handling when the name differs.
5. Credit/Debit Note vouchers import without enabling a feature; Journals with Bank/Cash lines, versus the Receipt/Payment/Contra mapping.
6. Missing `PARTYLEDGERNAME`, `LEDGERENTRIES.LIST` vs `ALLLEDGERENTRIES.LIST`, and GST attributes with GST disabled.
7. UTF-16 Telugu and emoji names; 75-char name limit; zero-amount lines; the `<?xml?>` declaration.
8. Per-ledger totals of the imported company equal the app's trial balance (the real acceptance test).
9. Ledgers under Stock-in-Hand: when a company has accounts integrated with inventory, does Tally refuse them in plain accounting vouchers (which would reject almost every Sales/Purchase voucher)? The exporter avoids the question by putting Inventory and Goods in Transit under Current Assets; the CA can move them after the import. UNVERIFIED either way.
