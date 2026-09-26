# Adversarial permission test — Daksha Nirmaan (local Supabase)

Run 2026-09-26 against the **local** Supabase stack only (`127.0.0.1:54321`). Nothing was run against the hosted project.
Nothing was fixed, committed or pushed. No file under `src/`, `supabase/migrations/` or `supabase/tests/` was touched (`git status` is clean).

> **Closed 2026-09-26 (local, uncommitted):** F1-F5 and L1 are fixed by migration `20261001100000_attack_test_fixes.sql` and pgTAP `00026`; see `docs/STATUS.md`. The default ACL that hands new functions to `anon` (through PUBLIC) is guarded by a catalog test, not changed. Hosted is untouched.

## Verdict

The database holds where it matters most. Across 2,163 checks, **no identity below the owner could write to the ledger, change a posted document's
amounts, post a purchase, an outgoing payment or a discount, override a credit limit, reopen a day close, read payroll, or escalate its own role.**
An admin without the authenticator step (aal1) and a deactivated user were treated as no-one on every table, view and money-moving function. Signed-out callers were refused everywhere except one harmless helper.

What did **not** behave as specified — six findings, none critical:

| # | Severity | Finding | Who |
|---|---|---|---|
| F1 | medium | A counter user can add, change and delete payment allocations on a **posted** receipt | `user` |
| F2 | medium | `place_of_supply` on a draft is client-writable and decides the GST split (CGST+SGST vs IGST); it even accepts a non-existent state code | `user` |
| F3 | low | `created_by` on a draft can be set to another person (owner) | `user` |
| F4 | low | `gstin_checksum_ok()` is executable by signed-out callers | `anon` |
| F5 | low | `hidden_payroll_entry_ids()` / `hidden_payroll_voucher_ids()` answer an aal1 admin and a deactivated user; `set_my_locale()` writes for an aal1 admin | `admin_aal1`, `user_off` |
| L1 | medium (latent) | New functions default to executable by `anon`; new tables get full DML for `authenticated` with RLS **off**; no catalog-wide test guards either | future migrations |

Plus the limits the spec already accepts (§ "Spec-accepted limits, confirmed") — those are the ones to weigh before go-live: a counter user can still work out the bank balance, cash, profit and stock cost through the API.

## Setup

- `supabase db reset` → `supabase test db`: **25 files, 1779 tests, all pass** (run again on the fresh reset used for the official pass).
- `demo-data.sql` loaded (needs an owner first: `create-admin` made `demo-owner@attack.test`; trial balance 0.00).
- Throwaway users created through the auth admin API with the local secret key, each with a real sign-in JWT:
  - `admin_aal2` — admin, TOTP enrolled and verified in the script → token claims `aal2`
  - `admin_aal1` — admin **with a verified factor** (like a real owner), fresh password sign-in only → `aal1`
  - `user` — counter staff
  - `user_off` — token taken while active, **then** `is_active=false` (worst case: a still-live token)
  - `anon` — publishable key only, no bearer (plus the legacy anon JWT as a second anon shape)
- At the end all throwaway accounts were set `is_active=false` (none deleted). `demo-owner@attack.test` stays active: the database refuses to deactivate the last admin.
- Owner (`admin_aal2`) results are used only as a **control** — to prove each request is well-formed, so a refusal means the gate refused, not that the body was bad. A refusal only counts as a pass if it is a permission-type refusal (401/403, `42501`, a `DN_*` raise, or an RLS-filtered empty result); a constraint error or bad-argument error is recorded as inconclusive.

## Findings (things that did NOT behave as the spec says)

Each row is (identity × object × operation). Request bodies are exact; ids shortened. Severity uses your scale (critical = money/data exposure or modification; high = owner-only data readable).

### F1 — medium — posted receipt's allocations are editable by the counter

| Identity | Object | Op | Exact request | Actual response | Spec line |
|---|---|---|---|---|---|
| user | `payment_allocations` | INSERT | `POST /rest/v1/payment_allocations {"payment_id":"7ddb7273-…","invoice_type":"sales_invoice","invoice_id":"919a6e3a-…","amount":100}` (payment is **posted**) | `201`, 1 row returned | `db-architecture/spec.md:134` (INSERT/UPDATE on **draft** documents); `CLAUDE.md` hard rule "posted … immutable"; `docs/STATUS.md:26` lists it as open ("re-allocating a posted receipt") |
| user | `payment_allocations` | UPDATE | `PATCH /rest/v1/payment_allocations?id=eq.7ecaa5af-… {"amount":1}` (allocation of a posted receipt) | `200`, 1 row updated | same |
| user | `payment_allocations` | DELETE | `DELETE /rest/v1/payment_allocations?id=eq.84749bb9-…` (allocation of a posted receipt) | `200`, 1 row deleted | same |

The RLS policies only require `payments.status <> 'cancelled'`, so posted receipts qualify. The owner can do the same (control).
**Why medium, not critical:** the ledger is untouched (trial balance stayed 0.00) and party balances do not change; what moves is *which invoice a receipt is applied to*, so ageing, statements and interest can show a paid invoice as open. The change is audited (7 `allocate`/`reallocate`/`unallocate` rows in `audit_log` with the counter user as actor). On a literal reading of your scale ("data modification") you may prefer to call it critical.

### F2 — medium — `place_of_supply` on a draft steers the tax split

| Identity | Object | Op | Exact request | Actual response | Spec line |
|---|---|---|---|---|---|
| user | `sales_invoices` (draft) | UPDATE then post | `PATCH /rest/v1/sales_invoices?id=eq.6da7ca58-… {"place_of_supply":"36"}` then `rpc post_sales_invoice` — customer Kishore is in state 37 | patch `200`; post `200`; posted with `place_of_supply=36`, `cgst=0 sgst=0 igst=63.00` (should be CGST+SGST) | `db-architecture/spec.md:96`, `:254` (place of supply decides the split); `daksh-review` checklist "recomputes tax from snapshots **and place of supply**"; `docs/STATUS.md:26` (open owner question) |
| user | `sales_invoices` (draft) | UPDATE then post | `PATCH … {"place_of_supply":"99"}` (no such state) then post | patch `200`; post `200`; posted `place_of_supply=99`, `igst=63.00` | same |
| user | `sales_invoices` (draft) | UPDATE then post | `PATCH … {"place_of_supply":"37"}` on an invoice for Hyderabad Projects (state 36), then post | patch `200`; post `200`; posted with `cgst=31.50 sgst=31.50 igst=0` (should be IGST) | same |

The invoice total is unchanged (the tax is the same 18%); what is wrong is the tax **head**. It reaches the ledger (the first invoice above posted 63.00 to Output IGST instead of Output CGST/SGST) and therefore GSTR-1 and GSTR-3B. Same effect through the API for any draft the counter can edit.

### F3 — low — `created_by` can be forged

| Identity | Object | Op | Exact request | Actual response | Spec line |
|---|---|---|---|---|---|
| user | `sales_invoices` | UPDATE (draft) | `PATCH /rest/v1/sales_invoices?id=eq.b3903a3d-… {"created_by":"<owner uid>"}` | `200`; row now shows the owner as creator | `db-architecture/spec.md` (documents carry `created_by REFERENCES auth.users`) |
| user | `sales_invoices` | INSERT | `POST /rest/v1/sales_invoices {"invoice_date":"2026-09-26","party_id":"…","place_of_supply":"37","warehouse_id":"…","status":"draft","created_by":"<owner uid>"}` | `201`; `created_by` = owner | same |

Only the attribution column is affected: `journal_entries.posted_by` and the `audit_log` actor were the real user on the posted invoice.

### F4 — low — one function is open to signed-out callers

| Identity | Object | Op | Exact request | Actual response | Spec line |
|---|---|---|---|---|---|
| anon | `gstin_checksum_ok(text)` | EXECUTE | `POST /rest/v1/rpc/gstin_checksum_ok {"g":"37AAACK1234A1Z9"}` (apikey only) | `200 true`; it is also the only path in the anon OpenAPI document (`GET /rest/v1/` lists `/rpc/gstin_checksum_ok`) | your brief ("every function must refuse"); `db-architecture/spec.md:406` (anon holds no privileges) |

Pure checksum, no data. Cause: the function's ACL still carries `PUBLIC` execute (`=X/postgres`); the `explicit_grants` migration grants but never revokes. Every other function shows no anon/PUBLIC execute.

### F5 — low — "no-one" identities can still call a few helpers

| Identity | Object | Op | Exact request | Actual response | Spec line |
|---|---|---|---|---|---|
| admin_aal1 | `hidden_payroll_entry_ids()` | EXECUTE | `POST /rest/v1/rpc/hidden_payroll_entry_ids {}` | `200`, 4 ids | change 19, `db-architecture/spec.md:136` (aal1 admin gets no business access at all); `:418` (b) (ids reveal existence, never amounts) |
| user_off | `hidden_payroll_entry_ids()` | EXECUTE | same | `200`, 4 ids | same |
| admin_aal1 / user_off | `hidden_payroll_voucher_ids()` | EXECUTE | `POST /rest/v1/rpc/hidden_payroll_voucher_ids {}` | `200`, ids | same |
| admin_aal1 | `set_my_locale(text)` | EXECUTE | `POST /rest/v1/rpc/set_my_locale {"p_locale":"te"}` | `204`; the aal1 admin's own `app_users.locale` changed to `te` | change 19 (role logic goes through `current_app_role()`). For `user_off` it returns `204` but writes nothing (`and is_active`). |

Ids only, own-row preference only; no amounts and no cross-user effect. Listed because these two identities are meant to be no-one.

### L1 — medium (latent, nothing exploitable today) — defaults hand new objects to the wrong roles

Tested inside a transaction that was rolled back, on the local stack:

| New object created by a migration | Effective privileges | Result |
|---|---|---|
| function in `public` | `anon` **and** `authenticated` have EXECUTE | open to signed-out callers unless the author revokes |
| table in `public` | `authenticated` has SELECT/INSERT/UPDATE/DELETE, RLS **disabled** | readable and writable by every signed-in identity, including an aal1 admin and a deactivated user, until RLS is enabled |
| view | `anon` none | ok |

All 59 current tables/views are fine (RLS on, grants explicit). The gap is that nothing enforces it: the pgTAP suite checks named functions one by one, with no "no function in `public` is executable by anon" or "every table has RLS" catalog test. Phase 2 adds tables and functions, and `gstin_checksum_ok` (F4) is the first case that slipped through.
Also: `supabase/migrations/20260930110000_explicit_grants.sql` says the **hosted** project's default privileges differ from local, so hosted ACLs may not equal what was tested here (see Limits).

## Spec-accepted limits, confirmed (not counted as failures)

The spec documents these and accepts them for Phase 1; they are reproduced here because they are the owner-only data a counter user can still read. `db-architecture/spec.md:307` itself says "Revisit before go-live".

| # | Severity | What the `user` identity can do | Evidence |
|---|---|---|---|
| K1 | high | Work out bank and cash balances although `v_money_balances`/`v_money_ledger`/cash-bank are owner-only | `v_money_balances` → 0 rows; but `GET journal_lines?account_id=eq.<bank>&select=debit,credit` sums to 63,110.00 vs the owner view 48,610.00 (the 14,500.00 gap is exactly the hidden salary-via-bank leg; every non-payroll rupee is visible) |
| K2 | high | Work out profit and loss although `v_pnl`/`v_balance_sheet`/`v_trial_balance` return 0 rows | `accounts` + `journal_lines` give net profit 535,906.13 vs owner `v_pnl` 514,106.13 (gap = hidden payroll) |
| K3 | high | Read stock cost | `stock_movements?select=rate,value` → `{"rate":300.7693,"value":-300.77}`; `v_stock_summary` returns `avg_rate` and `value`; `stock_on_hand()` returns `value`, `avg_rate` (`STATUS.md`: owner decision 1, "still homeless") |
| K4 | high | Read supplier cost prices | `purchase_invoice_lines?select=item_name,rate` → `{"rate":300}` |
| K5 | low | Infer that payroll cash exists on a day | `day_close_preview(<date>)` `cash_out` 6,600 vs visible cash credits 6,500 → 100 hidden wages; amount only, not to whom (`:418` (a)) |
| K6 | low | List ids of hidden payroll entries | `hidden_payroll_entry_ids()` → 4 ids (`:418` (b)) |

Payroll itself is properly hidden: salary/wages vouchers and their lines, the ledger lines on Salaries and Salary payable, payroll audit rows, `v_employees`, `v_employee_ledger`, `employee_pay_rates()`, `v_day_book` and `v_document_refs` all returned **nothing** to the counter (12 probes), and `monthly_salary`/`daily_wage` are unreadable, unfilterable and unwritable (`403 42501` / `DN_VALIDATION:admin_only_field`).

## What passed, and how many checks were run

| Stage | Checks | Pass | Deviations | Known / info | Inconclusive |
|---|---:|---:|---:|---:|---:|
| Tables and views via PostgREST: 59 relations × SELECT/INSERT/UPDATE/DELETE, 4 identities (+ legacy anon JWT on SELECT) | 1,375 | 1,372 | 3 (F1) | 0 | 0 |
| Public functions via `/rpc`, incl. tamper variants and day-close ordering | 234 | 232 | 2 (F5) | 0 (16 helper info rows for F4/F5 are counted separately) | 0 |
| Tamper tests (posted docs, drafts, lines, credit override, payments, vouchers, cheques, concurrency, upsert, bulk) | 55 | 51 | 4 (F2, F3) | 0 | 0 |
| Known-limit, payroll and auth-layer probes | 33 | 22 | 3 (F4, F5) | 8 (5 known-limit rows, 3 info) | 0 |
| Next.js: pages, export routes, signed link, server actions | 459 | 408 | 0 | 1 | 50 |
| Service-key server actions with valid arguments (`inviteUser`, `resetUserPassword`, `disableUser`, `enableUser`) | 7 | 7 | 0 | 0 | 0 |
| **Total** | **2,163** | **2,092** | **12 rows = F1–F5** | **9** | **50** |

Per identity: anon 329 table/view checks + 59 legacy-JWT + 64 function checks — **every table, view and function refused** except `gstin_checksum_ok` (F4). `admin_aal1` and `user_off`: 329 table/view checks each — **0 rows on every relation except their own `app_users` row**, every write refused, every business function `DN_FORBIDDEN`.

Held up as specified for the `user` identity (each with a fresh fixture, refusal by the intended gate, owner control succeeded):

- Ledger and audit: `journal_entries`, `journal_lines`, `stock_movements` never writable; `audit_log` immutable; posted invoice's journal cannot be edited, cancelled or deleted (`403 42501`).
- Posted documents: amount, status→draft, status→cancelled, lines and delete on a posted invoice: 0 rows changed; `UPSERT` over a posted id refused by RLS; bulk PATCH/DELETE touched only drafts.
- `app_users`: own role→admin, own reactivation, demoting the owner, self-insert as admin, delete — all refused; `admin_set_user` `DN_FORBIDDEN`.
- Masters: `organization`, `accounts`, `items`, `warehouses`, `fiscal_periods` (`is_locked`), `doc_sequences` (`next_no`) not writable; party guards hold for `credit_limit`, `credit_days`, `interest_rate_pm`, `is_active`, `type`, `gstin`, `state_code`, pay columns, second walk-in.
- Money functions: `post_payment` outgoing → `DN_FORBIDDEN`; receipt with discount → `DN_FORBIDDEN`; `post_purchase_invoice`, `post_stock_adjustment`, `post_stock_transfer`, `receive_stock_transfer`, `bounce_cheque`, every `cancel_document` source type, `set_period_lock`, `ensure_fiscal_year`, opening-balance functions, `go_live_readiness`, `gstr1_data`, `gstr3b_summary` → `DN_FORBIDDEN`. `post_expense_voucher`: salary, wages, expense, advance > 5,000 and 2×4,000 → refused; an advance whose line debits Sales or Rent → `advance_account`.
- Credit-limit override as `user`: `post_sales_invoice(p_override_credit=true)` → `DN_CREDIT_LIMIT` (the override is ignored for a counter user; the owner control posts it).
- Day close as `user`: in-order close allowed; 2026-09-22 after 2026-09-24 exists → `later_close_exists`; future date and 2099-12-31 → `future_date`; twice → `already_closed`; reopen → `DN_FORBIDDEN`, close stayed `posted`. Owner control closed out of order and reopened.
- Posting inputs: gst_rate→0, forged taxable_value, garbage HSN/name are overwritten from the item master at post; negative or zero qty/rate, discount >100 or <0, sub-paisa rate refused; out-of-stock refused; transit warehouse, supplier or inactive party refused; locked period (`DN_PERIOD_LOCKED`) and a month with no period row refused; posting twice or a cancelled invoice → `DN_NOT_DRAFT`.
- Forged server-owned columns on a draft (`invoice_no`, `journal_entry_id`, totals, `round_off`, `buyer_gstin`) were overwritten by the posting function; `challan_id` pointing at another party's challan → `challan_mismatch`.
- Concurrency: 6 parallel posts of one draft → exactly 1 success, 1 journal entry; 8 parallel posts of 8 drafts → numbers unique and gap-free.
- Payments: negative or zero receipt, non-money account, supplier/employee party refused at post; allocation to another party's invoice, over-allocation and negative allocation refused. Cheques: clearing an undeposited cheque, depositing twice, depositing cash, depositing a bounced or cancelled cheque all → `DN_CHEQUE_STATE`.
- Internal functions (`next_doc_no`, `_post_sales_invoice`, `is_money_account`, `_gst_out_lines`): `403 42501` for `user` and `anon`.
- Auth layer (local GoTrue): an aal1 admin **could not** enrol a new authenticator (`403`), remove the existing one (`422`) or get an aal2 token by refresh; sign-up, OTP sign-up and anonymous sign-in refused; editing own `user_metadata` to `{role:admin, aal:aal2}` changed nothing (`current_app_role()` stayed `user`); `Accept: application/vnd.pgrst.plan` refused (`406`); no storage buckets.
- Next.js: `user` is redirected from `/settings`, every `/settings/*`, `/staff`, `/staff/<id>` and `/reports/cash-bank` to `/`; `admin_aal1` to `/login/mfa`; anon and the deactivated user to `/login` (108 page checks: 27 pages × 4 identities). `/api/reports/*` (owner-only reports 403 to the counter), `/api/reports/gstr1`, party statements and `/api/invoices/<id>/pdf` refuse without a session. Signed link: a valid link works with no cookie; a link signed for another invoice, an extended `exp`, an expired link, an empty `sig`, a `sig` with no `exp`, and reuse on another route are all refused (`403`/redirect); a valid link on a draft answers `409` (an existence oracle only for holders of a valid signature). Owner-only actions called as the counter returned the `forbidden` envelope for the 11 that the counter can reach by URL, and were redirected by the proxy for the other 19. With **valid** arguments, `inviteUser` (role admin), `resetUserPassword` (owner), `disableUser` and `enableUser` as the counter created no auth user, left the owner's password unchanged and changed no `app_users` row, while the owner control succeeded.

## Owner-identity observations (outside the four identities; not counted)

- The owner cannot write `accounts` or `warehouses` through the API (`INSERT` → `403 42501`; `UPDATE` → 0 rows), although `db-architecture/spec.md` ("Masters write policies") says admin may. Not an exposure; check the chart-of-accounts and warehouse screens are meant to be read-only in Phase 1.
- The owner can also change allocations on posted receipts (same as F1).
- An earlier harness fixture (a duplicate GSTIN on my own test party) made one owner control fail; not a system issue.

## Limits of this test — read before relying on it

- **Local only.** Hosted was not touched, as instructed. `20260930110000_explicit_grants.sql` says hosted default privileges differ from local, so the hosted ACLs, and GoTrue's MFA-enrolment rule (M1), are unverified. A read-only catalog comparison (ACLs of every function and table for `anon`/`authenticated`, RLS flags, the `pg_default_acl` rows) on hosted would close that; it needs your explicit go-ahead.
- `pg_graphql` is not enabled in the local stack (every GraphQL call returned "extension is not enabled"). Hosted projects normally have it on; it runs on the same grants and RLS, but it was not exercised.
- Realtime, Storage beyond the bucket list, email/SMTP flows, rate limits, CSRF/XSS/CSP, Vercel deployment protection and dependency audit were not tested. This is not a substitute for the planned `/security-review`.
- Server actions were driven over HTTP against a local production build (`next start`, port 3100) with real session cookies written by the app's own `@supabase/ssr`. 50 calls that posted an owner-only action id to a page that does not host it returned an empty `{}` body instead of a `forbidden` envelope; for those I could not tell from the response whether the action code ran. I verified side effects for the four actions that hold the service-role key (none) and rely on the database gates (tested above) for the rest. Note that action ids are **not** bound to their page — the owner's call to `/` executed — so the proxy's URL redirects are not a barrier by themselves; the in-action `requireAdmin()` and the database gates are.
- Deactivating a user does not revoke their auth session: a deactivated user can still sign in and hold a valid token (the database refuses them everywhere). Informational.
- The local database now contains the test's writes (fixtures, owner-control writes, e.g. deleted demo allocations). Reset and reload the demo data before using it for anything else.

## Reproduction

Scripts are in the session scratchpad (`…/scratchpad/`: `setup.mjs`, `matrix.mjs`, `funcs.mjs`, `tamper.mjs`, `extras.mjs`, `next.mjs`, `svc.mjs`, with `lib.mjs`/`fx.mjs`) and are not in the repo. Say if you want them copied into the repo (e.g. under `scripts/attack-test/`) so the run can be repeated after each fix.
