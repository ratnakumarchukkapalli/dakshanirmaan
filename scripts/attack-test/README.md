# Attack test (local Supabase only)

Adversarial permission test of the database and API, written for the 2026-09 review (`docs/reviews/2026-09-attack-test.md`).
Run it after every security-relevant change: `bash scripts/attack-test/run-all.sh` (about 5 minutes).

- It refuses to run unless `.env.local` points at `127.0.0.1:54321`. **Never point it at the hosted project**: it resets the database and creates users.
- Identities: `admin_aal2` (owner control), `admin_aal1` (password only), `user`, `user_off` (deactivated, live token), `anon`.
- Stages: `matrix` (tables/views x 4 ops), `funcs` (every public function), `tamper` (what the open doors let through), `extras` (known limits, payroll, auth layer),
  `next` (pages, exports, signed link, server actions), `svc` (service-key actions with valid args), `xpage`, `cleanup`.
- Verdicts: PASS, FAIL (deviates from the spec), KNOWN (spec-accepted limit), INFO, INCONCLUSIVE (the refusal was not a permission refusal, so it proves nothing: fix the request).
- Owner (`admin_aal2`) rows are controls: they prove each request is well-formed.
- Do not call the `signOut` server action in `next.mjs`: it revokes the test sessions (already skipped).
- Change 27 (`openspec/changes/27-attack-test-fixes/`) closed F1-F5 and L1. `matrix.mjs`, `tamper.mjs` (B1, B1b, B1c, B3b) and `funcs.mjs`/`extras.mjs` (F4, F5) judge the outcome, not the old behaviour, so a regression shows as a FAIL row. When a future fix changes behaviour on purpose, update the expectation that encodes it.
- Final pass 2026-10 (`docs/reviews/2026-10-final-security-pass.md`): stale expectations were brought up to date so a clean run is all-PASS: owner may delete an unused item (26); `bank_statements`/`bank_statement_lines` direct writes are refused for everyone (22); a counter `select *` on `stock_movements` is refused 42501 and K3 is now a regression check (28); nobody INSERTs `accounts`/`warehouses` through the API; `next.mjs` knows the new owner-only actions (all of `bank.ts`, `cancelCashDeposit`, `deleteItem`; quotes, `postCashDeposit` and `changePassword` are member-level) and the three export routes (books.xlsx, tally.xml, archive.zip: counter/aal1/anon refused; a cross-site trigger by an owner is refused, finding A6); `funcs.mjs` has rows for `log_export`, `import_bank_statement`, `post_bank_expense`, `unmatch_bank_line`, `ignore_bank_line`. These edits were checked with `node --check` only; the first full run after them is the real validation.

## TODO: two-session race test (finding D1)
The child-line tables (sales/challan/expense-voucher/adjustment/transfer lines, payment allocations) used to be writable by a counter in the instant their header posts. The migration that closes it (header-lock trigger, like `note_lines_guard`) is covered by pgTAP, but the harness has no concurrent test, because every stage here is sequential. To add (`race.mjs`, run after `tamper`):
1. Open two direct database connections (the `psql`/`pg` helpers in `fx.mjs`) plus the counter `user` JWT.
2. Session A: `begin; select post_sales_invoice(<draft>)` and hold the transaction open after the header update (an advisory lock or `pg_sleep` inside a test-only wrapper, or `select ... for update` on the header in session A before calling the function).
3. Session B (counter token, PostgREST): `POST sales_invoice_lines` / `PATCH` / `DELETE` on that invoice while A is open; then commit A.
4. Pass when B is refused or blocked until A commits and then refused, and the invoice's lines still equal the lines in its journal entry (`taxable_value`, `qty` and `gst` sums per invoice). Fail on any extra, changed or missing line. Repeat for each line table and for `payment_allocations`; loop 50 times with random delays because the window is milliseconds wide.
Until this exists, D1 relies on the pgTAP test and on review.
