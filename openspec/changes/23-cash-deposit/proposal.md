# 23 — cash-deposit (and HDFC bank set-up)

Skill: daksh-posting (new posting function) + daksh-schema (enum value, grants, pgTAP) + daksh-ui (modal, i18n). Model: Opus for the function, Sonnet for the modal.
Spec section: openspec/specs/db-architecture/spec.md → "day_closes" (the `deposited` rule: "cash credits whose entry also debits `bank`") and the `accounts.is_money` clarification; api-architecture → the `payments.ts`/vouchers action list (one modal, one action, like `postVoucher`).
Context (owner input, 2026-09-26): the business banks with **one HDFC account**; most money in and out is **UPI or bank transfer**; only a little is cash, and cash received is **deposited into the bank** eventually. Today only `deposit_cheque` moves money into Bank; nothing records "cash from the drawer went to the bank", although day close subtracts a `deposited` figure that only such an entry can create. Without it the drawer's expected cash never drops after a deposit and the day-close difference is wrong.
Do not: touch existing posting functions; write `journal_*` from the app; let an expense voucher stand in for a deposit.

## Scope
**In**
1. **`post_cash_deposit(p_date, p_amount, p_reference, p_note) → uuid`**: Dr `bank` · Cr `cash`, `source_type = 'cash_deposit'` (new enum value, own migration first, as in change 05). Amount > 0, `numeric(14,2)`, date not in the future, period lock respected, active member (counter may post it, like `deposit_cheque`). Refuses to run below aal2 for an admin. Reversal only through `cancel_document` (admin, reversal dated on the original date).
2. **A "Deposit cash to bank" modal** on the Day close screen and on Payments (date, amount, bank slip / reference, note). No draft state, one action `postCashDeposit`. en + te strings.
3. **Day close** already counts cash credits whose entry debits bank as `deposited`; add pgTAP proving a posted deposit lowers `expected` by exactly its amount and a cancelled one restores it.
4. **HDFC set-up**: rename the `bank` ledger (account 1120) to "HDFC Bank" (through the chart-of-accounts screen if it allows a rename, else a small data migration); add "UPI ID set, HDFC Bank ledger named" to the go-live checklist.
**Out**: reconciling the deposit against the statement (change 22); multiple bank accounts.

## Conservative defaults (log in implementation-notes.md)
1. A deposit larger than the cash the ledger says is on hand is **warned, not refused** (the drawer may hold cash the books do not yet know about); a negative cash balance after the deposit is shown to the owner on the day-close screen.
2. Any active member can post a deposit; only an admin can cancel one.
3. No slip attachment until change 21's attachments exist.

## Done when
- pgTAP: entry balances (Dr bank = Cr cash); a counter user can post, cannot cancel; admin at aal1 refused; locked period refused; `expected` on the day-close preview drops by the amount and returns on cancel.
- Real-browser walk: cash receipt → deposit part of it → day close expected figure matches the drawer count → cancel the deposit → figures return.
- Gates: lint, tsc, vitest, build, `supabase test db` on an empty database.
