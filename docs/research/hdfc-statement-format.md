# HDFC Bank current-account statement format (for importer + reconciliation)

Researched 2026-10-02. No real HDFC CSV/XLS was available. Evidence tiers:
- **[HDFC]** HDFC's own FAQ (search-result snippet; the page itself would not load).
- **[REAL-PDF]** A real HDFC *current-account* PDF (Oct 2024-Feb 2025, 20 pages) that a business published on a vendor CDN. Read for layout only; no personal data is reproduced here.
- **[SYNTH]** Third-party *synthetic* HDFC-style files in `Dhanu2626/refundradar` (`samples/realistic/`). The author says they imitate HDFC downloads and have not been checked against a real file.
- **[CODE]** Independent open-source parsers: `anoop142/hdfc-st` (Go), `MalayPalace/Bank-Statement-Utility` (Python), `vipul-sharma20/hdfc-analytics` (Python), `akhilnarang/bank-statement-parser` (PDF).
- UNVERIFIED = not confirmed by a primary or real file.

## 1. Download formats

- [HDFC] NetBanking offers 5 formats: **PDF, Excel, Text, Delimited, MS Money**. Delimited is "a csv (comma separated values) format file". PDF can also be emailed; Delimited and MS Money are direct download only.
- There is no format literally named "CSV". The CSV people mention is either the Excel file saved as CSV, or the "Delimited" `.txt`. The old `.xls` is a legacy BIFF file, not `.xlsx` ([CODE] hdfc-analytics says "HDFC provides bank statement in XLS format"). UNVERIFIED: whether current NetBanking still serves `.xls` or has moved to `.xlsx`.
- Two distinct table layouts exist, with different headers (section 2):
  - **Excel** has a big preamble (customer block), `****` rules, the table, a `STATEMENT SUMMARY`, and a footer. [SYNTH], and the preamble fields match [REAL-PDF].
  - **Delimited `.txt`** is the table only. Its header row is `Date, Narration, Value Dat, Debit Amount, Credit Amount, Chq/Ref Number, Closing Balance`, with fields space-padded. Three sources agree on this column order: [SYNTH], hdfc-st reads Debit=col 3 and Credit=col 4, and Bank-Statement-Utility's HDFC processor uses the keys `Debit Amount`, `Credit Amount`, `Value Dat`, `Chq/Ref Number`.
- **Best to parse: Delimited `.txt`** for clean machine rows, with Excel as the second choice.
  - Delimited has no preamble or footer, a row-level Debit/Credit pair, and no thousands separators.
  - Excel has Indian-grouped numbers and Excel date quirks (section 4).
  - Do not parse PDF unless forced. PDF narrations are hard-wrapped (section 4), though PDF is the only format whose layout we have seen first-hand.
- Encoding, line endings, BOM, quoting, and the exact delimiter: UNVERIFIED (assume UTF-8/ASCII, but detect and strip BOM, and accept CRLF or LF). [SYNTH] uses a plain comma with space padding.
- Date-range or row limits on download: UNVERIFIED.

## 2. Columns, dates, numbers

Excel / PDF layout, confirmed by [REAL-PDF] (PDF header), [SYNTH] (XLS/CSV) and [CODE] (hdfc-analytics `column_mapping.toml`, hdfc-st sample CSV):

| # | Column | Notes |
|---|---|---|
| 1 | `Date` | transaction date |
| 2 | `Narration` | |
| 3 | `Chq./Ref.No.` | 16 chars, see section 3 |
| 4 | `Value Dt` | |
| 5 | `Withdrawal Amt.` | debit, blank when not applicable |
| 6 | `Deposit Amt.` | credit, blank when not applicable |
| 7 | `Closing Balance` | per row (running balance) |

- The seven column names and their order are **confirmed**. The header row is not at row 1 in Excel. Find it by matching `Date` + `Narration` + `Chq./Ref.No.`, never by index.
- Delimited uses different names: `Value Dat`, `Debit Amount`, `Credit Amount`, `Chq/Ref Number`, with Value Dat before the amounts and Chq/Ref after them. Match headers by name set, not position, and support both.
- Dates:
  - **`dd/mm/yy`** (two-digit year) in [REAL-PDF], [SYNTH] and [CODE] (hdfc-st parses `DD/MM/YY`, expanding to `20YY`). `dd/mm/yyyy` appears only in the Excel preamble (`Statement From : 01/06/2026`) and in some PDF parsers' notes.
  - Accept both; never assume `mm/dd`.
- Debit and credit are **separate columns**. [SYNTH] shows blank for the unused side in Excel/CSV and **`0.00` in Delimited** [also hdfc-st/hdfc-analytics samples use `0`]. Treat blank, `0` and `0.00` as zero. Do not infer direction from narration.
- Numbers:
  - **Excel/CSV: Indian grouping, quoted**, e.g. `"1,47,418.35"` ([SYNTH]).
  - The real PDF shows Western grouping (`104,389.50`) while the synthetic XLS uses Indian grouping, so grouping is inconsistent across formats. Strip all commas and parse with a decimal library.
  - Delimited has no separators (`147418.35`).
  - No negative signs seen; the sign is carried by the column. Closing balance could in principle be negative on an overdraft/OD account: UNVERIFIED.
- Closing balance is present on every row in all formats. The PDF footer says "*Closing balance includes funds earmarked for hold and uncleared funds" [REAL-PDF].

## 3. Narration patterns and reference tokens

Reference in the **`Chq./Ref.No.` column is always 16 chars**, left-padded with zeros when numeric ([REAL-PDF], [SYNTH]). Strip the zero padding to compare. An all-zero value means "no reference".

Examples are anonymised. Real-sourced patterns are marked [R]; synthetic-only patterns are marked [S] and need confirmation on the owner's file.

| Type | Example narration | Ref col | Where the identifier is |
|---|---|---|---|
| UPI [R] | `UPI-ACME TRADERS-acmetr01@okicici-ICIC0DC0099-427510653284-NA` | `0000427510653284` | 12-digit **RRN** is the 5th dash segment and equals the ref col minus padding. Suffix is the remark (`NA` if none). Payer name is truncated; VPA may be cut mid-token. Masked-card/account payers appear as `UPI-XXXXXX1568-BARB0VJKANA-<rrn>-NA`. |
| UPI reversal [R] | `REV-UPI-<acct>-<vpa>-...` | its own 16-digit number | Reversal is a **separate row** (credit) with a different ref in the real file. [S] reuses the original RRN. UNVERIFIED which is typical. |
| NEFT in [R] | `NEFT CR-YESB0000001-ACME ENTERPRISES FOR PAYEE-OWN CO NAME-YESIB42752289400` | `YESIB42752289400` | **UTR** (bank code + 1 char + digits, 16 chars) is in the ref col **and** the last narration segment. Segments: `NEFT CR-<remitter IFSC>-<remitter name>-<remark/beneficiary>-<UTR>`. |
| NEFT out [R] | `NEFT DR-RBIS0GSTPMT-GST-NOIDA SECTOR-N29...` | `0000000000000021` (GST payment) | The GST-payment example carries only a small sequence number, **not a UTR**. [S] shows `NEFT DR-SBIN0000999-PAYEE-NETBANK, MUM-N199262615`, ref `N199262615`; this pattern has an unquoted comma, see section 4. |
| RTGS | `RTGS CR-...` / `RTGS DR-...` | UNVERIFIED | Not in any HDFC sample. Assume the NEFT shape with a 22-char UTR beginning with the IFSC prefix. |
| IMPS [R] | `IMPS-428708302983-ACME CREATIONS-HDFC-XXXXXXXXXX1234-NA` | `0000428708302983` | 12-digit RRN is the 2nd segment and equals the ref col. Order: `IMPS-<rrn>-<name>-<bank>-<masked acct>-<remark>`. |
| Cheque deposit [R] | `CHQ DEP MICR CLG CITY - MICR 1 CLG - NO...` (also `CHQ DEP - TRANSFER OW 1 - CITY WBO: PAYER`) | `0000000000819021` | The cheque number (zero-padded, stripped to `819021`) is in the **ref col only**. **Value date is the next business day** (date 21/10 -> value 22/10; Fri 27/12 -> Mon 30/12). Payer is often truncated or absent. |
| Cheque issued | `CHQ PAID-MICR CTS-...` | cheque no. | UNVERIFIED; not in any sample. Expect the cheque number in the ref col. |
| Cash deposit | `CASH DEPOSIT BY - SELF - CITY` [S] | all zeros | No identifier at all. Match by amount + date. UNVERIFIED on a real file; branch deposits may use a different text, e.g. `CASH DEP-...` |
| ATM / card cash [R] | `ATW-403875XXXXXX7200-00009045-CITY` | RRN-like 16 digits | `ATW` is the withdrawal; `NWD` is another bank's ATM [S]. Card number masked. |
| POS [S] | `POS 416021XXXXXX4321 MERCHANT CITY` | RRN or zeros | Not in the real PDF. |
| Own-account transfer [R] | `50200095292444-TPT-JOB WORK-PAYEE NAME` | 16 digits | `<acct>-TPT-<remark>-<name>`: HDFC-to-HDFC. Name truncates. Also `FT - CR - <acct> - <NAME>` for internal credits. |
| Auto-debit [R] | `ACH D- TP ACH IIL-1584396947` | 16 digits | `ACH D- <scheme> <biller>-<id>`. The id sits in narration; ref col is a different number. Credits: `ACHC-<scheme>-<ref>` (per hdfc-counterparty code). |
| Bank charge [R] | `FEE-ATM CASH(1TXN)08/11/24-AOR2531733136` | `AOR2531733136080` | Charge row; ref is alphanumeric. |
| Charges [S] | `.IMPS P2A CHARGES <rrn> INCL GST`, `SMS CHARGES FOR QTR ENDED JUN 2026 INCL GST`, `DC ANNUAL FEE <card> INCL GST` | rrn or zeros | **GST is bundled in the same row** ("INCL GST"). A leading dot is used. A separate `GST` row is also possible: UNVERIFIED. |
| Interest credit [S] | `INTEREST PAID TILL 30-JUN-2026` | zeros | A current account normally pays no interest; ignore unless it appears. |
| Statutory / TDS | UNVERIFIED | | |

## 4. Gotchas

- **Wrapped rows.** In the PDF every narration is hard-wrapped at about 40 characters onto continuation lines that have no date. The text is joined without a separator (`...ICICI` + `-ICIC0DC0099...`). VPAs and names can be cut at the wrap point. Excel/Delimited rows are probably single-line, but UNVERIFIED; the Excel `Narration` field may be truncated at the same width (the terra-insight site claims ~100 chars: low-quality source, UNVERIFIED).
- **Unquoted comma in Delimited narrations** (`NETBANK, MUM`). Per [SYNTH] author this shifts every later column. The author inferred it, they did not observe it on a real file. Defend: parse from both ends. Date at the left, the last 4 numeric fields at the right, and everything between is narration.
- **Excel file as CSV:** preamble ~16 lines, a `****` row before and after the header, trailing `****`, `STATEMENT SUMMARY :-` (Opening Balance, Dr Count, Cr Count, Debits, Credits, Closing Bal), `Generated On`, `This is a computer generated statement...`. Stop at the second `****` line or at the first row whose Date cell is not a date. The summary's first number (opening balance) can sit in the Date column and parse as an Excel serial date.
- **Dates:** as XLS/CSV they may be text `dd/mm/yy` or true date cells; some parsers see `datetime` in Excel but text in the CSV. Handle strings, datetimes and serials. Two-digit year -> 20YY.
- **Value date vs date:** differs for cheque clearing (T+1 or later) and occasionally for others. Use `Date` for the books period and `Value Dt` as the clearing hint. A cheque deposited on 31 March can have a value date in April.
- **Same-day identical amounts** are normal (the real file shows several `10,000.00` rows per day with different refs, and two rows with the same amount and the same closing balance back-to-back). Ref and running balance distinguish them, so never dedupe on date+amount alone.
- **Order:** rows are oldest-first in all samples. Chronological order within a day is the only tie-break; keep file order. A "newest first" variant is only seen in a [SYNTH] test, so UNVERIFIED.
- **Overlapping ranges:** nothing in the statement identifies a statement as such; dedupe by key (section 5).
- **Opening/closing balance rows:** there is no opening-balance transaction row in the table. The opening balance is derived from summary (Excel) or as `first closing +/- first amount`. Check continuity: `prev closing + deposit - withdrawal = closing`.
- **Leading apostrophes** on numbers or refs (Excel text-forcing): UNVERIFIED. Strip a leading `'` defensively. Keep the ref as a **string** (zero padding, alphanumeric UTRs, `AOR...`).
- **Charges and GST** have to be booked as expenses (Bank Charges, plus GST input). If the GST is inside the row ("INCL GST"), the 18% split is: base = amount / 1.18, GST = amount - base.
- **Reversals** appear as new credit rows (`REV-UPI-...`, `REVERSAL-...`). Do not net them silently; book them as returns of the original.

## 5. Matching and dedupe

Matching order against the books:
1. **Reference token**: UPI/IMPS 12-digit RRN, NEFT/RTGS UTR, cheque number (from the ref col with zeros stripped). Normalise (strip padding, upper-case) and store it on the bank line.
2. **Amount + date window**: exact amount, `Date` within +/-3 days (use `Value Dt` for cheque deposits), unique candidate wins. Cash deposits (all-zero ref) match only here, against the "cash deposit" entries.
3. **Narration tokens**: counterparty name or VPA fragment, as a tie-breaker only. Names are truncated.
- A bank line with no match is proposed as a new entry (charges, interest, ACH debits), never auto-posted.

Dedupe key for re-imports: `(date, withdrawal, deposit, closing_balance, ref_normalised)` plus a per-key occurrence counter within the file (to survive two rows identical in everything). Closing balance is the strongest discriminator because it is a running total. Store `narration` and `value_date` but keep them out of the key (narration may differ between Excel and Delimited downloads for the same row). Warn if the balance chain breaks across an import boundary.

## 6. Questions for the owner's real file

1. Which format(s) does the NetBanking download offer for the current account today (Excel `.xls`/`.xlsx`, Delimited `.txt`, anything named CSV)? Please supply Excel **and** Delimited for the same short period.
2. Header row, preamble length, `****` rules, summary block: confirm against the sample, and whether dates are text or real date cells.
3. Is the narration cut at a fixed width in the Excel/Delimited files, and are rows single-line?
4. Do unquoted commas occur in narrations in the Delimited file?
5. How do RTGS and cheque-issued (`CHQ PAID`) rows read, and what is in their ref column?
6. How does a branch cash deposit read, and does it carry any reference or slip number?
7. How do bank charges and GST on them appear: one row "INCL GST", or a charge row plus a separate GST row? Any `TDS`, `SMS CHARGES`, `MIN BAL`, `CHRG` rows?
8. Are UPI reversals/refunds on the original RRN or on a new one?
9. Is the sign of closing balance ever shown differently (OD account), and is there any `Dr`/`Cr` suffix?
10. Encoding / BOM / line endings of the files.
