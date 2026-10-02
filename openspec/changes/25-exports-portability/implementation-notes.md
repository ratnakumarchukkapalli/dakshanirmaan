# 25 — exports-portability: implementation notes (parts A and D; B and C at the end)

Built: **A** the full-books workbook, **D** the Export screen and the export audit row, plus the shared
export layer that parts B (Tally) and C (archive) reuse. B and C were built afterwards: see "Parts B and C" at the end.

## What exists

| Piece | Where |
|---|---|
| Route `GET /api/backup/books.xlsx?fy=2026` (nodejs, dynamic, `maxDuration` 300) | `src/app/api/backup/books.xlsx/route.ts` -> `src/lib/export/books-handler.ts` |
| Audit function `log_export(p_kind, p_fy)` + export rows hidden from counter sessions | `supabase/migrations/20261010100000_log_export.sql`, pgTAP `supabase/tests/database/00038_log_export.test.sql` (26 tests) |
| Screen `/settings/export` (tab "Export & backup") | `src/app/(app)/settings/export/page.tsx`, `src/components/settings/ExportCards.tsx`, `ExportYearSelect.tsx`, `SettingsTabs.tsx` |
| `EXPORTS_READY` per kind | `EXPORT_READY` in `src/lib/export/kinds.ts` (`books: true, tally: false, archive: false`) |
| Strings | `settings.export.*`, `settings.tabs.export`, audit labels (`settings.audit.actions.export`, entities `books`/`tally`/`archive`) in `en.json` and `te.json`; audit trail shows `fy` (`audit-view.ts`) |
| Tests | `src/lib/export/*.test.ts` (59), `src/components/settings/export.test.ts` (9), access + audit-view additions; fake client `src/test/export-fake.ts` |

Request order in the route, so nothing is sent unless everything is right:
1. gate (owner at aal2, else **403**, no database read; `getCurrentMember` is the only lookup) -> organisation -> `?fy=` (missing = current FY if set up else newest; not a year in `fiscal_periods` = **400**)
2. trial balance (`trial_balance_asat`) and the 12 months of GST summaries -> **500** on failure (GST alone failing only skips its two sheets, noted on the README)
3. head counts of every sheet; any over **200,000** -> **422** plain message, no audit row
4. `log_export('books', fy)` -> **500** `Something went wrong and nothing was sent` and no file if it fails
5. stream the workbook. A failure after this point destroys the stream (the download fails; it never ends as a file that looks complete).

## Workbook (27 sheets, in this order)
README, Chart of accounts, Trial balance, Journal, Party ledger, Parties, Sales invoices, Sales invoice lines,
Purchase invoices, Purchase invoice lines, Credit notes, Credit note lines, Debit notes, Debit note lines,
Payments, Allocations, Cash deposits, Expense vouchers (one row per voucher line), Stock movements, Stock on hand,
Items, Warehouses, GST monthly (3B), GSTR-1 HSN summary, Day closes, Bank statement lines, Checks.

* Streamed with exceljs `WorkbookWriter` straight into the response; one sheet at a time, committed before the next, so memory does not grow with the book while the client keeps up. exceljs/archiver ignore back-pressure, so a very slow client lets already-produced bytes pile up in the response buffer (bounded by the file size, a few tens of MB for a realistic year); not mitigated. Frozen bold header, autofilter over the data, widths, footer rows (trial balance totals + check, journal totals) after a gap and outside the filter.
* **README first** (FY, generated-at and as-of in the organisation time zone, the trial-balance check, per-sheet description and row count, what is not included, skipped sheets). The row counts are head counts taken before sending, so README can be first and still be streamed. Everything only known after reading (journal Σdr = Σcr, every entry balances, rows written against rows expected, documents changed during the export) is on the **Checks** sheet at the end.
* Trial balance is the database's own `trial_balance_asat(FY end)`; Σdr = Σcr is recomputed in exact decimals (`loadTrialBalance`). Journal is one row per line for entries dated in the FY, all statuses, with `Reversed later` / `Is a reversal` flags (the reversal ids are read across all years so a reversal of last year's entry is flagged). Cancelled documents stay, flagged in Status columns.
* Party ledger and Stock on hand are aggregates computed in BigInt over the exact decimal text (opening = entries before the FY; closing = to FY end; stock average rate = value / qty rounded half away from zero to 4 places, same as `v_stock_summary`). Checked against `v_party_balances` and `v_stock_summary_all` on the demo data: equal.
* **Numbers**: every NUMERIC is selected as text (`col::text`, PostgREST keeps the digits) and stays text; `exactCellNumber` turns it into a number only at the cell and only when the JS number prints back as the same digits (the file then holds `<v>1234567.89</v>`; tested on the raw XML). Anything that would not round-trip is written as text instead (never rounded). RPC/jsonb figures (trial balance, GST) arrive as JSON numbers and are accepted only when exact at 2/3/4 places (`decimalString`); otherwise the export fails rather than round.
* **Injection guard**: a leading `'` on any text starting with `=`, `+`, `-`, `@`, tab or CR (all text cells, README and Checks too); characters XML 1.0 cannot hold are removed. A phone such as `+919848012345` therefore shows with a leading apostrophe; that is the cost of the rule, accepted.
* Dates are real dates (`dd-mm-yyyy`); instants are written as the organisation's wall clock (a workbook has no zone).

## Defaults taken (conservative; owner interview still open)
1. Owner-only (admin at aal2) on the route; counter, aal1 owner and signed-out all get 403 from the route. **In the running app the proxy answers first**: a signed-out visitor is redirected to `/login` and an owner at aal1 to `/login/mfa` (same as every other route); a counter session reaches the route and gets the 403. `/settings/export` is turned away by the existing `/settings` prefix rule for counters (test added).
2. As-of: `asOf` is taken once from the server clock and the journal and document tables are read with `created_at <= asOf`. **It is not a database snapshot**: a document *cancelled* during the few seconds of the export changes status without a new `created_at`, and the trial balance / GST sheets come from reports (RPCs) that have no as-of parameter and are read moments earlier or later. The Checks sheet counts documents with `updated_at > asOf` and bank lines matched after it and says "export again". Cash deposits and day closes keep no change time, so a change to those cannot be detected (stated on the sheet). The README says all this; it no longer claims the sheets are mutually consistent. Server-vs-database clock skew of a second or two is not compensated.
3. Drafts are not exported (never posted, not books); cancelled documents are.
4. No attachments, no auth data, no per-person salary rates (`parties.monthly_salary/daily_wage` left out), no quotations / challan / transfer headers (their effect is in Journal and Stock movements). Stock cost comes from `stock_movement_cost()` (owner only); the table's cost columns are not readable directly.
5. Party and godown names are today's master names (documents do not snapshot them); item name / HSN / UOM / GST rate are the posted snapshots. GSTIN: sales invoices and credit notes show only the `buyer_gstin` saved on the document (empty = unregistered, never filled from the party master); purchase invoices and debit notes keep none, so their column is headed "Party GSTIN (master today)" and the README says so.
6. FY choices come from `fiscal_periods.year_label`.
7. No "last nightly backup" line on the screen: nothing cheap in the database tells it.
8. `log_export` validates kind in (`books`,`tally`,`archive`) and FY between 2000 and next calendar year. Beyond the brief the migration also adds `books`/`tally`/`archive` to the audit_log policy's owner-only entity list, so a counter session cannot read who exported what (pgTAP covers it).
9. Downloads open in a new tab (`target=_blank`) so an error message (403/422/500, plain text) never replaces the Settings page.

## Measured
Local demo books plus 3,000 extra entries (6,131 journal lines): whole workbook ~3.5 s, Journal sheet 2.1 s, party pass 0.7 s. A year of <= 10,000 documents (~50k lines) is estimated at 20-40 s; `maxDuration = 300`. A year past 200,000 lines on one sheet is refused with 422 (no partial export option exists yet).

## Shared layer for parts B and C (`src/lib/export/`)
* `types.ts`: `ExportTable { name, description, columns[{key,header,type,width?}], rows(): AsyncIterable<ExportRow>, expectedRows?(), footer?() }`, `ColumnType` (`text|int|money|qty|rate|date|datetime|bool`), `ExportContext { supabase, asOf, fy, timeZone, orgName, generatedBy }`, `RowCapError`, `EXPORT_ROW_CAP`, `PAGE_SIZE`. A row is positional (money/qty/rate = decimal text, date = ISO text).
* `session.ts` `openExport(fyParam)` -> `{ ctx } | { response }`: gate + organisation + FY + `asOf`. Start every export route with it; `guard.ts` has `requireExportOwner`, `recordExport(supabase, kind, fy)` (the `log_export` call: call it before streaming and send nothing when it returns false) and `textResponse`.
* `paged.ts` `readPaged(ctx, spec)` / `countRows` / `readRpcPaged` / `collect`: pages of 1,000, stable order, FY range, `created_at <= asOf`, fails loudly. Spec `select` must cast NUMERIC to text (`debit::text`). `journalEntriesSpec(ctx)` (in `books-tables.ts`) is the journal entries with their lines embedded, in entry order: Tally vouchers should read exactly this.
* `table.ts` `queryTable`, `memoryTable`, `col`, `rowObjects(table)` (keyed objects for the JSON files of the archive).
* `books-tables.ts` `prepareBooks(ctx)` + `buildBooksTables(ctx, prep)` -> `{ tables, journalStats, skipped }`: the whole table list; the archive's `data/*.json` is `rowObjects` over `tables` (money stays decimal text), `schema.json` is `tables[].columns`. `Lookups` (accounts, parties, items, warehouses, users, document numbers) is reusable for Tally ledger masters.
* `books-workbook.ts` `writeBooksWorkbook(ctx, prep, built, expected, out: Writable)` writes the xlsx into any writable (a zip entry for the archive); `countExpected` is the cap pre-check.
* `period.ts` (`fiscalYear`, `listFiscalYears`, `resolveFiscalYear`, `fyMonths`, `generatedAtText`, `exportFileName('books'|'tally'|'archive', fy, ext)`), `decimal.ts` (`decimalString`, `toScaled`/`fromScaled`/`sumDecimal`/`divideDecimal`, `exactCellNumber`), `xlsx.ts` (`safeText`, `cellValue`, `writeTableSheet`, `writeTextSheet`).
* To enable the other two cards: build the routes, then set `EXPORT_READY.tally` / `.archive` to `true` in `kinds.ts` (card tests cover the flip). Paths already fixed: `/api/reports/tally.xml?fy=`, `/api/backup/archive.zip?fy=`.

## Not done / for the reviewer
* (Parts B and C: built, see below.)
* No browser walk (coordinator). The local database was reset for the gates, so it is empty again (the demo data used for the live check is gone; reload with `supabase/demo/demo-data.sql`).
* `jszip` (a transitive dependency of exceljs) is imported by `xlsx.test.ts` only, to inspect the raw sheet XML; no package.json change.
* Hosted PostgREST must keep `max_rows >= 1000` (default); a lower limit would shorten a page. Every `readPaged` / `readRpcPaged` call (sheets, aggregates, lookups, reversal ids) asks for the exact count on its first page and throws `ShortReadError` when the rows yielded differ, and the sheet writer also compares rows written with the rows counted before sending; either aborts the download, so a short read cannot become a complete-looking file or a wrong aggregate. (Tests: `short-read.test.ts`.)
* New migration needs `supabase db push` to hosted before the route works there (the route returns 500 until `log_export` exists).

## Parts B and C

Built: **B** the Tally XML (two files), **C** the year archive ZIP, and the two cards flipped live (`EXPORT_READY` = all true). The research file `docs/research/tally-xml-format.md` was followed wherever it differs from the proposal (the research wins): separate masters and vouchers files, UTF-16LE with BOM, `REMOTEID` on every voucher, document number also in the narration, Receipt/Payment/Contra for Bank/Cash entries, opening balances as a 1 April Journal, `SVCURRENTCOMPANY` only when `&company=` is given.

### B. Tally: `GET /api/reports/tally.xml?fy=2026&part=masters|vouchers[&company=Name]`

| Piece | Where |
|---|---|
| Route (nodejs, dynamic, `maxDuration` 300) | `src/app/api/reports/tally.xml/route.ts` -> `src/lib/export/tally-handler.ts` |
| Text/number rules (escape, strip, fold names, 75-char names, amounts, UTF-16) | `tally-xml.ts` |
| Model: ledgers + groups, voucher types, opening voucher, balance guard | `tally-model.ts` (`buildTallyModel`) |
| Envelope + voucher XML as text chunks, UTF-16 chunking | `tally-render.ts` |
| Tests (31) + shared fixture | `tally.test.ts`, `src/test/tally-fixture.ts` |

Order in the route (nothing is sent unless everything is right): gate (403, zero database reads) -> organisation and FY (400) -> `part` required (400) -> the whole model is built and every voucher checked (422 naming the entry, 500 otherwise, plain text, no database wording) -> `log_export('tally', fy)` (500 and no file when it fails) -> the file streamed. The model is built in memory before the first byte (a year is a few thousand vouchers: 10,000 documents = a 20 MB UTF-16 file, ~0.2 s of CPU) so "no partial file" is a guarantee, not a hope; only the rendering is streamed. Each download (masters, vouchers) writes its own audit row.

* **Ledgers.** Every leaf chart account and every party, opening balance omitted (= 0). Groups (Tally defaults): cash -> Cash-in-Hand (the master is *not* written: Tally owns "Cash"; vouchers still name it), bank -> Bank Accounts, receivables -> Sundry Debtors, payables -> Sundry Creditors, GST in/out and RCM and TDS -> `Duties & Taxes` (escaped), inventory and goods in transit -> Stock-in-Hand, cheques in hand and rebate receivable -> Current Assets, employee advance -> Loans & Advances (Asset), salary payable -> Current Liabilities, loans -> Loans (Liability), all equity incl. drawings and the opening-balance equity -> Capital Account, 4100/4200/4300 -> Sales Accounts, other income -> Indirect Incomes, COGS/freight inward/loading -> Direct Expenses, other expenses -> Indirect Expenses. Parties: customer and "both" -> Sundry Debtors, supplier -> Sundry Creditors, employee -> Current Liabilities. One extra ledger, `Profit and Loss brought forward` (Reserves & Surplus), carries prior years' profit. A control account (receivables, payables, advances, salary payable) line that names a party is posted to the **party's ledger**; a control-account line with no party goes to the account's own ledger.
* **Names.** One clean line, <= 75 characters (never cut inside a Telugu cluster), emoji/astral characters -> space, C0/C1 controls removed; uniqueness under Tally's folding (case-insensitive, spaces collapsed, hyphen = space = slash): the later one becomes `Name (2)`; accounts are named before parties, parties in creation order, so adding a party later never renames another. `Profit & Loss A/c` is reserved; a party called "Cash" becomes "Cash (2)".
* **Voucher types.** Sales/Purchase/Credit Note/Debit Note by source (not for a reversal); otherwise any entry with a Cash or Bank (`is_money`) ledger is Contra (only money lines), Receipt (net debit to money) or Payment (net credit); everything else Journal. A reversal of a sales invoice is therefore a Journal (or Payment for a cancelled cash sale), never a Sales voucher with its signs turned round. The go-live `opening` entry is always a Journal. Cheques in Hand is not Cash/Bank, so a cheque receipt is a Journal until the cheque clears (then a Receipt). UNVERIFIED in a live Tally: Journals that carry Cash/Bank lines (the opening vouchers).
* **Numbers.** `VOUCHERNUMBER` = the document number, else `JE-<entry no>`; a reversal gets `<doc>/REV`; any repeat within a voucher type (a cheque's posting and clearing share a document number) gets `/2`, `/3`. The document number leads the narration: `DN/26-27/0002 [Reversed later] - narration` or `[Reversal entry]`. Narrations are one clean line, capped at 500 characters (own cap; the research found no limit).
* **Sign and amounts.** Debit = `ISDEEMEDPOSITIVE` Yes + negative amount; credit = No + positive; two decimals; same ledger and side merged into one line; `ISPARTYLEDGER` Yes on the customer/supplier line; `PARTYLEDGERNAME` only on Sales/Purchase/Credit/Debit Note/Receipt/Payment.
* **Opening voucher** (`OPENING`, `REMOTEID dn-opening-<fy>`, dated 1 April, Journal): from `trial_balance_asat(day before the FY)`; balance-sheet accounts only; control accounts split by party from a pass over party lines before the year (the account's remainder, if any, stays on the account ledger); income and expense closings are netted into the single `Profit and Loss brought forward` line, which is what makes it balance. If the prior trial balance does not balance the export stops (422, with the gap). **First year**: nothing is before the FY, the trial balance is empty, no synthetic voucher is made, and the cutover `opening` entry is exported as an ordinary voucher (tested: nothing counted twice).
* **What is exported.** Posted entries dated in the FY, including reversed originals and their reversals (flagged). Per ledger: for balance-sheet ledgers opening voucher + year = the app's trial balance at the FY end; for income/expense ledgers the year's vouchers = trial balance at FY end minus the day before (the app's trial balance is cumulative and does not close P&L; tested on a two-year fixture).
* **Guards.** Every voucher: debits = credits in exact paise and >= 2 lines, else `TallyExportError` naming the entry and document number and both totals. Text: `&`, `<`, `>` escaped in text, plus `"` in attributes; XML-illegal characters stripped; tested by parsing the output back with the strict `saxes` parser (a transitive dependency of exceljs, imported by tests only, like `jszip`) for names with `& < > " '`, Telugu, emoji, control characters and 100-character names.

### C. Archive: `GET /api/backup/archive.zip?fy=2026`

| Piece | Where |
|---|---|
| Route (`maxDuration` 300) | `src/app/api/backup/archive.zip/route.ts` -> `archive-handler.ts` |
| Streaming zip + SHA-256 while streaming | `zip.ts` (`ZipStream`) |
| README.txt, GSTR-1 month plan | `archive-readme.ts` |
| Six statements as report specs | `archive-reports.ts`; the PDF component `report-pdf.tsx` (`reportDocument`, `groupIndian`); ageing `ageing-asat.ts` |
| Tests (23) | `archive.test.ts` |

Contents, in zip order: `README.txt`, `books.xlsx` (the part A writer into the zip entry), `tally/masters.xml`, `tally/vouchers.xml` (the same bytes as the route), `data/<table>.json` x25 (one per `ExportTable`, row counts checked against the pre-counted heads) and `data/schema.json`, `reports/` trial-balance, profit-and-loss, balance-sheet, receivables-ageing, stock-valuation, gst-summary (PDF), `gst/gstr1-YYYY-MM.json` for every month with sales or notes that the portal would accept, `MANIFEST.sha256` (`<sha256>  <path>` per file, computed from the bytes as they pass; `shasum -a 256 -c` verified on an unpacked archive: all OK).

* **Same order of events as the other routes**, plus the Tally model and the statements' data are built before the audit row and the first byte; an unbalanced voucher refuses the whole archive (422) rather than silently dropping the Tally files. A failure after the first byte destroys the stream (the download fails, it never ends as a complete-looking zip), also when the browser goes away (`ZipStream.drain` stops on `close`).
* **fflate 0.8.3**, exact pin. MIT, **zero dependencies, no install scripts** (its scripts are `build`/`test`/`prepack` for its own repo). It is already in the tree as a dependency of `pdfkit` (under `@react-pdf/renderer`) at the same version, so promoting it to a direct dependency adds no new code. `npm audit`: 0 vulnerabilities. Only the synchronous streaming `Zip` / `ZipDeflate` / `ZipPassThrough` are used (the Async classes need worker threads). Text is deflated (level 6); PDFs and the xlsx are stored.
* **Fonts**: `next.config.ts` `outputFileTracingIncludes` now ships `src/assets/fonts/**` with `/api/backup/archive.zip` (as for the invoice PDF).
* **PDFs**: one generic component, Noto Sans (the invoices' registration), black on white, title block and column heads repeat on every page, right-aligned numbers, "Page x of y". Money is grouped Indian-style from the decimal text with no float. Telugu prints as `?` (the face has none); the README says so; xlsx/JSON have the names. Trial balance, profit and loss, balance sheet: the database's own functions (as the screens). Stock valuation = the workbook's *Stock on hand* rows (read once, replayed for the JSON file). GST summary = the workbook's month-wise 3B figures; omitted with a README note if the GST figures could not be read.
* **Ageing as at the year end** cannot use `v_party_aging` (always "today"). It is built from the ledger: posted lines on the receivables account that name a party, up to the FY end; each party's credits (receipts, credit notes) are matched against the oldest debits first (FIFO), the rest aged by entry date into 0-30 / 31-60 / 61-90 / over 90, credits left over shown as "On account". Per party the total is exactly the ledger balance; the PDF states how it was built and checks the grand total against the receivables line of the trial balance (and shows the gap when entries have no party). It does **not** follow which invoice a receipt was allocated to, so it can differ from the live ageing screen for a party that paid a newer invoice first.
* **GSTR-1**: `loadGst` now keeps each month's `gstr1_data`; the archive writes `buildGstr1File` for months with invoices or notes and no blocking warning; blocked months are listed in the README with the reason, empty months are skipped.
* Not in the archive (as the proposal said): invoice PDFs. README states it. No app version in the README (nothing reliable to read at runtime).

### Screen

`ExportCards`: books and archive are links; the Tally card shows the CA test-import note, the Manual-numbering line, "Two files, imported ... ledgers first, then the vouchers" and two buttons "1. Ledgers file" / "2. Vouchers file" (`.exportbtns`, stacked, full width; the cards already stack at 390 px). en + te strings (`tally.order`, `buttonLedgers`, `buttonVouchers`, `numbering`; `tally.button` removed). `exportHref('tally', fy, part)`. Card tests updated (11 pass).

### Defaults taken (B and C)
1. Masters and vouchers are two downloads (research), each audited; no combined file.
2. Opening balances as a 1 April Journal, masters carry no `OPENINGBALANCE` (the sign is contradictory in the sources).
3. Reversals are Journals (or Payment/Receipt when Cash/Bank is on them), not Sales vouchers with flipped signs.
4. Employees sit under Current Liabilities; "both" parties under Sundry Debtors; `ISBILLWISEON` No (no bill allocations are emitted).
5. `IMPORTDUPS @@DUPIGNORECOMBINE` is in the masters file only (spelling UNVERIFIED in the research; it is the example's).
6. Narration cap 500 characters (own).
7. A voucher problem refuses the whole archive (422) instead of building it without Tally.

### Measured (synthetic, in-process)
The local database is empty and a `db reset` was forbidden, so the timings are from an in-memory stand-in for PostgREST (same page sizes, filters and ordering) driven through the real handlers, with documents mixed 60% invoices / 20% receipts / 20% expenses:

| Documents | Journal lines | Whole archive, CPU + stand-in | PostgREST requests | Zip size | RSS |
|---|---|---|---|---|---|
| 3,000 | 9,600 | 2.9 s | 160 | 1.6 MB | ~300 MB |
| 10,000 | 32,000 | 6.8 s | 288 | 4.8 MB | ~400 MB |

Tally vouchers alone for 10,000 documents: 0.2 s, 19.6 MB (UTF-16), 29 requests. The stand-in has no network time, so on the hosted database add roughly requests x round trip: 288 x 30-60 ms is 9-17 s, plus transfer; **estimate 20-40 s for a 10,000-document year**, comfortably inside `maxDuration = 300`. Memory is bounded by the Tally model and the aggregates (a few tens of MB for 10,000 documents), not by file size. Real-database timing is for the browser walk. If a year ever outgrows this (a table over 200,000 rows gets a 422 that says so), the fallback is per quarter: the workbook and Tally routes take the whole FY only today; a quarter parameter was not built.

### Not done / for the reviewer
* No live Tally test (none available); the CA test-import is the real acceptance. Journals that carry Bank/Cash lines (opening vouchers) and Credit/Debit Note vouchers are the two mapping choices most likely to need adjusting.
* No browser walk (coordinator). The real archive was unpacked from a test run and checked: `shasum -a 256 -c MANIFEST.sha256` all OK, PDFs rendered and looked at (ageing, balance sheet).
* No per-quarter export.

### Review fixes (Opus review of B and C: approve after fixes)
1. **Ageing** (`ageing-asat.ts`): a cancelled document and its reversal (original has `reversed_by` and the reversal is among the year's lines) are dropped before matching, so a cancelled March invoice no longer uses up an older unpaid one; a credit note is matched to its `against_invoice_id` first (debits carry `source_type:source_id`), then oldest-first. Tests: the reviewer's example (1,000 stays over 90 days, 0 in 0-30), a reversal dated after the year end (original stays), credit note with and without the link.
2. **README wording**: the false "posted entries never change so the files agree" is gone; it now says the data files are read as of the moment, the trial balance and GST a moment later, and points to the Checks sheet. Tally: "should match ... not yet been confirmed in a live Tally"; the ledger is spelled "Profit and Loss brought forward" as in `tally-model.ts`.
3. **Per-ledger self-check in the handler** (`verifyAgainstTrialBalance` in `tally-model.ts`, used by the Tally route and the archive; `buildTallyModel(ctx, trialBalanceAtYearEnd)`: the archive passes `prep.trialBalance`, the Tally route loads it): (a) each ledger's total in the emitted vouchers equals what went into it (merging/netting lost nothing); (b) for every account, the year's entries equal trial balance at the year end minus the day before, which with the opening voucher means balance-sheet accounts end on the trial balance and P&L accounts show exactly the year's movement. A mismatch is a 422 naming the account ("Account 4100 Sales - Cement ... Nothing was exported", with a try-again hint for entries posted mid-export), no file, no audit row. Party ledgers are checked through the account the lines came from (a party can sit on two control accounts, so a ledger cannot be mapped back to one account after the fact). Tests: wrong year-end trial balance on both routes, an account that differs only on the trial balance side, honest fixtures pass.
4. **Inventory and Goods in Transit -> Current Assets** (not Stock-in-Hand; account names unchanged): reasoning in `tally-model.ts`, the archive README, a hint on the Export screen (`tally.inventory`, en + te) and research §8 item 9.
5. **Reserved names**: all of Tally's default group names from research §4 (and "Primary") are reserved in `NameRegistry`, so a party called "Capital Account" becomes "Capital Account (2)". Tested, also case-folded ("sundry debtors").
6. **Opening voucher** lines are netted per ledger (`netByLedger`): a party with a receivable and a payable (or any two control accounts) appears once. Tested with receivable 6,000 + payable 300 = one line of 5,700, plus an employee advance, in the shared fixture (prior-year entries 14 and 15).
7. `groupIndian` throws on non-zero digits beyond the precision (trailing zeros are fine).
8. **Audit of the Tally part**: `log_export(p_kind, p_fy)` accepts only `books|tally|archive`, so the part (masters or vouchers) cannot be recorded without a database change, which was ruled out; each download writes its own `tally` row, so the two parts show as two rows (their times tell them apart). Limit stands. `ExportCards.tsx` has no inline styles (`.exportp`, `.exportorder`), and every download link carries hidden text "(opens in a new tab)" (`.vh`, `settings.export.newTab`, en + te).
9. Extra tests the review asked for: a reversal in this year of a prior-year entry (flagged, `/REV`, Journal, opening voucher balances, net nil), opening voucher with split payables and an employee, ageing with a reversal.
