# 22 bank-recon — implementation notes

## DB half (Opus, 2026-10-02)

### What was built
- `supabase/migrations/20261008100000_bank_recon.sql` (one migration):
  - `bank_statement_lines` += `value_date`, `reference`, `line_no`, `account_id`, `dedupe_key NOT NULL`, `matched_at`, `matched_by`, `ignore_reason`; unique `(account_id, dedupe_key)`; unique `matched_entry_id` where matched; CHECKs one-side-only and match shape; index `(account_id, txn_date)`.
  - Direct writes closed: the change-01 admin write policies are dropped and INSERT/UPDATE/DELETE revoked from `authenticated`; SELECT stays (owner-only RLS from change 06). Triggers: line `account_id` always copied from its statement; lines immutable except match fields (`bank_line_immutable`), a matched line cannot be deleted; statements immutable.
  - Guard trigger `bank_match_guard` on `journal_entries`: setting `reversed_by` on an entry matched to a bank line raises `DN_VALIDATION:bank_line_matched` (item 5, see below).
  - Functions: `bank_ref_normalize`, `import_bank_statement`, `_bank_match_candidates` (internal, no app grant), `suggest_bank_matches`, `match_bank_line`, `unmatch_bank_line`, `ignore_bank_line`, `auto_match_bank_statement`. All definer functions pin `search_path`, revoke from public/anon/service_role, grant to authenticated, and gate on `current_app_role() = 'admin'` (= owner at aal2).
  - Views (security_invoker, admin-gated like `v_money_balances`): `v_bank_recon` (change-06 columns unchanged + reconciliation columns), `v_bank_book_items`, `v_bank_statement_summary`.
  - Ledger `5950 Bank Charges`, `system_key 'bank_charges'` (added at the coordinator's request).
- `supabase/tests/database/00034_bank_recon.test.sql`: 196 assertions, covering every case in item 6.
- `supabase/tests/database/00035_bank_recon_review.test.sql`: 33 assertions for the review fixes below.
- Existing tests updated: `00002` (system_key count 34 -> 35, + `bank_charges`); `00008`: direct writes to the statement tables are now refused for the owner too (privilege, not RLS), and the view count goes 23 -> 25.
- Spec: `db-architecture/spec.md` → "bank_statements + bank_statement_lines" gains a "Built in change 22" paragraph.

### Item 5: cancelled/reversed documents → BLOCK
Investigation: every reversal path marks the original entry with `reversed_by`, the only UPDATE `check_journal_entry_immutable` allows: `cancel_document` (every branch, including `day_close` reopen, `cash_deposit`, `expense_voucher`, `payment`), `bounce_cheque` (reverses the receipt and, if deposited, the deposit entry), and the cutover batch reversal. So one BEFORE UPDATE trigger on that transition blocks all of them, present and future, without re-creating `cancel_document` / `bounce_cheque`. `post_day_close` only touches Cash/Cash over-short, so its entries never reach the bank and never match; its reopen is covered anyway. `match_bank_line` takes the entry row with `FOR NO KEY UPDATE`, so a concurrent cancel either waits and then sees the match, or wins and the match sees `reversed_by`. Tested: cancel of a matched receipt, cash deposit and expense voucher, and bounce of a cheque whose deposit is matched are all refused; after unmatching they go through.

### Defaults chosen (proposal silent)
1. **Matchable entry** = posted, non-zero net on the bank ledger, not reversed and **not itself a reversal**. Consequence: a bounced cheque's CHQ DEP credit and its return debit can't be matched (deposit is reversed, the bounce is a reversal). The owner ignores both lines ("bounced cheque"); the two lines net to zero, and so does the book pair, so the recon stays explained.
2. **Line order and dedupe**: key = `(txn_date, debit, credit, balance, occurrence)`, reference excluded (review fix 3); `occurrence` counts within the file. A file that starts in the middle of a day, between two rows identical in date, amounts, balance and reference, could be mis-deduped. Not possible with HDFC's whole-day statements; accepted.
3. **Period** of a statement = min/max date of the lines *it actually inserted* (not the file's range), so a backfill of older lines can't become the "latest" statement. A re-import with nothing new creates **no** statement row (`statement_id: null`).
4. **Input is strict**: money must be JSON strings (a JSON number is refused, so no float can get in), dates ISO `YYYY-MM-DD`, oldest first (`lines_out_of_order` otherwise), balance required on every line (may be negative, for an overdraft), max 5,000 lines, narration ≤ 1,000, reference ≤ 64, file name ≤ 200.
5. **Continuity warning** only when the file's first line is itself new and an earlier imported line exists on or before its date. A backfill that ends before existing lines is not checked against the next line; the recon's `unexplained` figure shows any gap.
6. **Reference match ignores the date window** (a cheque we issued can be presented weeks later). Amount + direction must still match exactly. Date window = the closest pair of {txn date, value date} × {entry date, cheque `cleared_on`}.
7. **Auto-match** = one candidate in the line's best tier *and* that entry is no other unmatched line's best-tier candidate (account-wide), repeated until nothing changes. Narration only ranks suggestions (+10 score).
8. **Ignored lines** count as bank-only items in the recon (the money did move). `unmatch_bank_line` also un-ignores. Matching does not check period locks (it changes no figures).
9. **v_bank_recon reconciliation** (as at the latest statement's `period_to`): `explained_difference = opening_difference + book_only(Dr−Cr) − bank_only(Cr−Dr)`, with `opening_difference` = unmatched book items before the first imported line − the bank balance implied before that line (0 when books and statements start together). That opening term is the one change from the proposal's formula; without it, the cutover opening entry would show as a permanent book-only item. A line matched to an entry dated after `period_to` counts as bank-only (timing). A cancelled document and its reversal drop out only when **both** are dated by `period_to` (a September receipt cancelled in October is a real September book-only item). `unexplained ≠ 0` means a gap or a broken chain between imports.
10. **Closing balance**: an imported statement has `line_no`, so its last line is exact; the change-06 ambiguity heuristic remains only for rows without `line_no` (old tests' raw inserts).
11. Bank charges go to `5950 Bank Charges` in full (no GST split), per proposal default 5. Confirmed by test: an expense voucher paid from the bank (`source_type 'expense_voucher'`, Cr bank) is suggested (`candidate_kind 'expense_voucher'`), auto-matched and accepted by `match_bank_line` for a debit line.

### Review fixes (independent Opus review: APPROVE AFTER FIXES), applied in place to the same uncommitted migration
1. **Opening and day-close entries are never matchable**: they are excluded from the candidates and from `v_bank_book_items.matchable`, and `match_bank_line` raises `entry_not_matchable`. Tested: an opening entry is not suggested, not auto-matched and refused by hand, and `cancel_opening_balances` still works with a statement imported.
2. **A conflicting reference rules a pair out of the amount + date tier.** When the line and the payment both carry a reference and the references differ, the pair is not a candidate. Tested: a line whose RRN differs from the booked receipt's is not offered it. Also tested: one entry that is the only candidate for two lines is matched to neither.
3. **The reference is out of the dedupe key.** The key is now `(txn_date, debit, credit, balance, occurrence-in-file)`. The reference is still stored. Tested: a re-import with a blank or different reference imports 0 lines.
4. **Date bounds.**
   - A txn date before 2000-01-01 is `invalid_date`, and so is a txn date in year 0026.
   - A value date is checked against the same lower bound.
   - **Pushback on the future bound:** a value date may run up to **today + 7** rather than "not future". Cheque clearing gives T+1 value dates, so a statement downloaded on the deposit day legitimately carries tomorrow's value date. A value date further ahead is `invalid_date`.
5. **Regexes use `[0-9]`.** Arabic-Indic digits in an amount, balance or date now raise `DN_VALIDATION`, not a raw 22P02.
6. **"Explained" vs "reconciled"**: see the contract section.
7. **Write privileges closed for service_role too.** INSERT/UPDATE/DELETE on both statement tables are revoked from `service_role`, and MAINTAIN is revoked from everyone. The MAINTAIN revoke sits in a guard that only runs on Postgres 17 or later, because the privilege does not exist before 17. Tested: overdraft (negative balance) import works.

### post_bank_expense (from the app-half review)
"Book bank charge" used to take four separate calls, so a double submit could post two vouchers for one line. `post_bank_expense` now does all of it in one transaction:
- It locks the line row and requires the line to be unmatched and a debit.
- It inserts the expense voucher and its line, calls `post_expense_voucher` (which applies the period lock and role checks), then calls `match_bank_line(…, 'manual')`.
- The amount is the line's debit, the date is the line's txn date, and the pay account is the statement's bank.
- **Allowed accounts:** a plain expense ledger only. Groups, control accounts and money accounts are refused, and so are the ledgers the posting engine owns (`cogs`, `round_off`, `stock_loss`, `cash_over_short`, `discount_allowed`, `salaries`). That `salaries` is refused is my own call: salaries go through the salary voucher.

Tests are in `00036_post_bank_expense.test.sql` (30 assertions). The function only narrows the bank-statement path; `post_expense_voucher` itself is unchanged.

### Gates (empty database: `supabase db reset` then `supabase test db`)
36 files / 2722 tests, all pass (00026 catalog guard included).

### RPC contract for the app (supabase-js `rpc`)
All raise `DN_FORBIDDEN` unless the caller is an active owner at aal2. Validation errors are `DN_VALIDATION:<detail>`. Import errors about one line add ` line=N` (1-based position in `p_lines`) after the detail. `parseDbError` already pulls the detail out; read the line with `/line=(\d+)/`.

| Function | Args | Returns | `DN_VALIDATION:` details |
|---|---|---|---|
| `import_bank_statement` | `p_account_id uuid` (the `bank` ledger), `p_source_file text` (name only), `p_lines jsonb` = array, oldest first, of `{txnDate:"YYYY-MM-DD", valueDate:"YYYY-MM-DD"\|null, narration:string\|null, reference:string\|null, debit:"0.00", credit:"0.00", balance:"0.00"}`. Money must be **strings**. Dates: txnDate 2000-01-01 … today; valueDate 2000-01-01 … today+7. Raw reference is fine (normalised in the DB). Extra keys are ignored. | `jsonb {statement_id: uuid\|null, imported: int, skipped_duplicates: int, first_date, last_date: "YYYY-MM-DD", opening_balance, closing_balance: string, continuity_warning: bool, previous_closing_balance: string\|null}` | `invalid_account`, `file_name_too_long`, `no_lines`, `too_many_lines`; per line: `invalid_line`, `invalid_date`, `future_date`, `lines_out_of_order`, `invalid_amount`, `invalid_balance`, `one_side_only`, `narration_too_long`, `reference_too_long`, `balance_chain_broken` |
| `suggest_bank_matches` | `p_statement_id uuid` | setof `{line_id, candidate_kind (entry source_type: 'payment' \| 'cash_deposit' \| 'expense_voucher' \| …), payment_id\|null, entry_id, score int, reason ('reference' \| 'amount_date', optionally '+narration'), entry_no bigint, entry_date, narration, amount numeric}`. Only unmatched lines, best tier per line, best first | `statement_not_found` |
| `match_bank_line` | `p_line_id uuid, p_entry_id uuid, p_status text` (`'manual'` from the app) | `jsonb {line_id, entry_id, payment_id\|null, match_status, cheque_to_clear: bool}`; `cheque_to_clear` = offer "Mark cheque cleared" | `invalid_status`, `line_not_found`, `line_not_unmatched`, `entry_not_found`, `entry_cancelled`, `entry_not_matchable` (opening / day close), `entry_not_on_account`, `wrong_direction`, `amount_mismatch`, `entry_already_matched` |
| `unmatch_bank_line` | `p_line_id uuid` (matched or ignored) | `void` | `line_not_found`, `line_not_matched` |
| `ignore_bank_line` | `p_line_id uuid, p_reason text` (1–200 chars after trim) | `void` | `reason_required`, `reason_too_long`, `line_not_found`, `line_not_unmatched` |
| `auto_match_bank_statement` | `p_statement_id uuid` | `int` (lines matched) | `statement_not_found` |
| `post_bank_expense` | `p_line_id uuid, p_account_id uuid default null` (null = Bank Charges), `p_note text default null` (≤ 200; becomes the voucher line narration, else the bank narration) | `jsonb {voucher_id, entry_id, line_id}`. Atomic: on any error nothing is left. Use this for "Book bank charge" / any unmatched debit, instead of insert + post + match | `line_not_found`, `line_not_unmatched` (also on a double submit), `line_not_debit`, `invalid_account`, `note_too_long`, `future_date`; plus `post_expense_voucher`'s errors (`DN_PERIOD_LOCKED`, …) |
| `cancel_document`, `bounce_cheque` (existing) | unchanged | unchanged | **new**: `bank_line_matched` (unmatch the line first) |

**`explained` is not "reconciled".** `explained` only proves the bank lines form one continuous chain and the listed items account for the difference. Show "Reconciled" only when `opening_difference = 0` **and** `book_only_entries = 0` **and** `bank_only_lines = 0` (and `difference = 0` follows). `unexplained ≠ 0` means a gap between imports: ask for the missing period.

Read-only for the screens (owner only; others get 0 rows): tables `bank_statements`, `bank_statement_lines`; views `v_bank_statement_summary` (per import: period, file, counts, totals, opening/closing balance), `v_bank_book_items` (bank-side entries: `entry_id, entry_no, entry_date, narration, source_type, source_id, payment_id, payment_mode, instrument_no, cleared_on, party_id, direction 'in'|'out', amount, matchable, reversed_by, reverses, matched_line_id`; for the manual "Match…" picker use `matchable and matched_line_id is null`), `v_bank_recon` (one row per bank ledger; tiles = `bank_balance`, `book_balance`, `difference`, `unmatched_lines`, plus `book_only_*`, `bank_only_*`, `opening_difference`, `explained_difference`, `unexplained`, `explained`). Bank charges ledger: `accounts.system_key = 'bank_charges'`.

## App half (Sonnet, 2026-10-02)

### What was built
- `src/schemas/bank.ts` (zod; money `^\d+\.\d{2}$`, balance may be negative, `refHint` optional) and `src/app/actions/bank.ts`: `importBankStatement`, `autoMatchStatement`, `matchBankLine`, `unmatchBankLine`, `ignoreBankLine`, `matchLineToPayment`, `bookBankExpense`. All start with `requireAdminMember` (owner at aal2); revalidate `/reports/reconcile`, `/reports/cash-bank`, `/reports/day-book`. Tests: `src/app/actions/bank.test.ts` (12) and `src/lib/bank-prefill.test.ts` (4); `access.test.ts` and `boundaries.test.ts` extended.
- Loaders `src/lib/bank-data.ts` (+ `bank-types.ts`); components `src/components/bank/` (`ImportCard`, `ReconTiles`, `StatementLines`, `LineModals`); pages `/reports/reconcile` and `/reports/reconcile/[id]` (status filter via `?status=`); links from the Reports index and the Cash & bank book; proxy guard (`src/lib/access.ts`) covers `/reports/reconcile` and below.
- PaymentForm: `/payments/new?bankLine=<id>` (owner only) prefills from `src/lib/bank-prefill.ts`; after `postPayment` it calls `matchLineToPayment` and redirects to the statement; if the link fails it shows the sentence and a "Back to the bank statement" link (the payment stays posted). No behaviour change without `bankLine`.
- Messages: new `bank` namespace, `errors.validation.*` (import and match details, en + te), `errors.field.bank_*`, `reports.cards.reconcile`, `payments.bankLine*`. CSS: `.stacktable` (rows become cards under 600 px).

### Defaults chosen
1. Import details get their own sentences under `errors.validation.import_<detail>` (words like `future_date` and `no_lines` already mean something else in other screens); an error with `line=N` reads "Row N: …". Match/ignore details use plain `errors.validation.<detail>`.
2. "Reconciled" chip only when `explained` and `unexplained = 0` and `opening_difference = 0` and no book-only entries and no bank-only lines; otherwise "N items to review", "Opening difference", or "Unexplained ₹x" (coordinator's review note).
3. `reference` sent to the RPC is `line.reference ?? line.refHint ?? null` (coded against `refHint?: string | null`; the parser type may not have it yet).
4. After an import the result panel stays with an "Open statement" button (no automatic redirect, so the skipped/continuity messages can be read). A file with any row lacking a balance, or over ~900 KB of parsed JSON (server-action body limit is 1 MB), is refused in the browser with a plain sentence.
5. Tiles on a statement page are the account-wide `v_bank_recon` row (as at the latest imported statement); the "Unmatched lines" tile is that statement's own count; a note says so when the statement is not the latest.
6. Direction on `/payments/new?bankLine=` comes from the line's side (credit = receipt, debit = payment); the `direction` query value is not needed. Mode: UPI -> `upi`, NEFT -> `neft`, anything else (IMPS, RTGS, unknown) -> `bank`. Note = narration trimmed to 200 chars; reference to 40.
7. `bookBankExpense` takes a client-generated request id (like `addBillFreight`): a repeat of a call that already posted finishes the match instead of posting twice. Expense account must be a non-group, non-control `expense` ledger; default `bank_charges`. If the match fails after posting the voucher it stands, code `partial` with "match the line to the new entry by hand".
8. "Mark cheque cleared" reuses `markCleared`; it shows on a matched line whose payment is `deposited` (or `issued`), so it also appears after "Accept" or a manual match, not only right after the match.
9. The Match... picker lists `v_bank_book_items` (matchable, free, direction fits, newest 500); same-amount entries first, others shown but disabled because the database requires an exact amount.

### Gaps / not done
- No browser walk (coordinator does it). The charge tag (`kind: 'charge'`) exists only in the import preview: it is not stored, so on the statement page every unmatched debit offers "Bank charge / expense".
- Statement page loads all lines (limit 5,000) and filters server-side; no paging.
- `reason_required` for Ignore reuses the existing "Give a reason." sentence.

### App half, review fixes (2026-10-02)
- **F1** PaymentForm from a bank line: amount is read-only, the direction chips are hidden and the account list holds only the bank ledger (the payload is also forced to the line's side/amount/ledger by `lockToBankLine`). If `matchLineToPayment` fails after the payment posted, the form is replaced by a locked "posted" screen (the sentence and "Back to the bank statement" only; no Post, no Save) and the URL is replaced with the statement's, so a reload cannot 404 or double-post. Helpers `afterBankLinePost` / `lockToBankLine` are unit-tested (no component test infrastructure exists in this repo).
- **F2** `bookBankExpense` is now a thin wrapper over `rpc('post_bank_expense', {p_line_id, p_account_id, p_note})` (voucher, post and match in one transaction; date and amount come from the stored line). The request-id, claim and draft-cleanup code is gone. `invalid_account` from this RPC is shown as `validation.bank_expense_account` (the shared `invalid_account` sentence is about the cash/bank account); `line_not_debit` is new; `line_not_unmatched` already existed. `Modal` gained `dismissible`: Escape, backdrop and the close button are inert while a modal's action is running, and its Cancel buttons are disabled.
- **F4** ReconTiles: `opening_difference = null` is never "Reconciled"; "Unexplained" shows only when the amount is non-zero, otherwise "N items to review", "Opening difference", or a generic "Needs review" chip.
- **F6** ImportCard measures bytes with `Blob.size`; a thrown `importBankStatement` shows `bank.importFailed` ("may not have been saved, check the list before importing again"). Other actions' thrown errors show `bank.failed`.
- **G** Chips inside tiles wrap (`.tile .sub .chip { white-space: normal }`). Not checked in a browser (no owner aal2 session in this run).
- **Known gap (F5):** the parser's warnings and refusal sentences are English-only strings shown as they are in the Telugu UI.
