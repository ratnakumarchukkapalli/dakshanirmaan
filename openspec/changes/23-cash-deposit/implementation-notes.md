# 23 cash-deposit — implementation notes

Built 2026-10-01 (Sonnet 5.5, both halves; the brief suggested Opus for the function — **an independent Opus review is still owed before the hosted push**).

## What was built
- `supabase/migrations/20261005100000_cash_deposit_enum.sql` — `source_type` += `cash_deposit` (alone, as in change 05).
- `supabase/migrations/20261005110000_cash_deposit.sql`:
  - table `cash_deposits` (RLS: members read; no write grants — only the definer function writes; `set_created_by` trigger);
  - `post_cash_deposit(date, numeric, text, text) → uuid` (the deposit's id), Dr bank / Cr cash;
  - `cancel_document` re-created with one new `cash_deposit` branch (diff against change 20's body is additions only);
  - bank ledger (`system_key = 'bank'`, code 1120) renamed **HDFC Bank** (data update; the chart-of-accounts screen was not needed);
  - `go_live_readiness` + `bank_set_up` (UPI id set, bank ledger no longer just "Bank"), shown in Settings → Cutover checklist (en + te).
- App: `postCashDeposit` / `cancelCashDeposit` actions, `src/schemas/cash-deposit.ts`, "Deposit cash to bank" modal (`DepositCashButton`) on Payments and on Day close, `CashDepositList` (owner-only Cancel) on both, negative-drawer notice on Day close. en + te strings (`cashDeposit.*`, three `errors.validation.*`).
- A `cash_deposits` row exists (rather than reusing the journal entry id) so `cancel_document` has a document to key on, the lists have something to read, and change 22 can match deposits against the statement.

## Conservative defaults
1. **Deposit above the books' cash: warned, not refused** (as briefed). The modal shows the books' figure and a warning; the day-close screen shows a notice while `expected` is negative. Verdict: accept.
2. Any active member posts; only an owner cancels (DB + action). Verdict: accept.
3. No slip attachment (change 21's attachments are purchase-only). Verdict: accept; revisit with change 22.
4. **Added beyond the brief — closed days:** a deposit dated on or before a day that already has a posted close is refused (`day_closed`), and so is cancelling a deposit in that position. Without it a deposit could silently change the opening cash of a day the counter had already counted. Remedy is the owner reopening the day. Verdict: keep; written into the spec.
5. **Reversal dated on the deposit's date** (as briefed), so the original day's `expected` is restored exactly. Side effect: on that day `cash_in` rises by the amount and `deposited` stays, so the gross tiles read oddly after a same-day cancel while `expected` is right. Verdict: accept (rare, owner-only); not worth changing `day_close_preview`/`post_day_close`.
6. Known small race: a deposit posting in the same instant as a day close for the same date passes its closed-day check just before the close commits. `post_day_close`'s `p_expected_seen` catches the other order. Verdict: accept (no locking elsewhere in the day-close path either).

## Gates (2026-10-01)
tsc clean · lint 0 errors · vitest 732 (68 files) · build clean · `supabase db reset` then `supabase test db`: 31 files / 2361 tests (new file `00031_cash_deposit.test.sql`, 72 assertions: balanced Dr/Cr, counter posts and cannot cancel, aal1 owner refused both ways, bad amounts, future/null date, locked month, closed day (on, before, after), expected drops by the amount and returns on cancel, second cancel refused, no direct DML even for an owner, anon cannot execute, over-deposit allowed, bank name, readiness check).

Live browser walk (Playwright, local stack, counter + owner aal2): 24/24 — modal shows the books' 5,000, over-amount warning, zero refused in the form, deposit lands in the list, counter has no Cancel, day close shows should-be 3,000 and banked 2,000, over-deposit accepted and the negative-drawer notice appears, owner cancels both (figure back to 3,000 then 5,000, rows kept as Cancelled), day closes, deposit into the closed day shows the friendly refusal; dark and 390 px no sideways scroll, no console or page errors. Telugu not exercised in a browser (key parity is tested). Button style fixed after the first screenshot (ghost button).

## Open
- Independent review (Opus) before push; then hosted `db push` of the two migrations.
- On hosted, the new `bank_set_up` check stays red until Settings has the UPI id and the ledger rename has applied (the rename is in the migration).
