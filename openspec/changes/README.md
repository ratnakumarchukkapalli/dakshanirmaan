# Build plan — ordered change proposals

Written for: the implementing model (Sonnet by default; Opus for the posting engine) and the reviewer (Fable).

Hosted project: `daksha-nirmaan` (`dcmgbkugdyxsjvkirmft`, ap-south-1, Postgres 17, Supabase Free). Linked via CLI; `supabase start` runs the local stack for every change; `supabase db push` to hosted only after local pgTAP passes.

Each change below is one folder `openspec/changes/<id>-<slug>/` containing `proposal.md` (scope, spec sections, acceptance scenarios, brief) and, once merged, `implementation-notes.md`. Archive to `openspec/changes/archive/` after the pitch + quiz pass (see `openspec/project.md`). **Started 2026-09-16 (Ratna authorised).**

## Rules for every change

- The brief names **one skill** and **one spec section**. The child reads the skill, that section, and this file's row. Nothing else unless the brief says so.
- Acceptance = the scenario(s) listed pass (pgTAP for DB, Playwright/Vitest for app) **and** `npm run build` is clean **and** the hard rules in `CLAUDE.md` hold.
- Surprises: take the conservative option, log it in `implementation-notes.md`, keep going.
- Visual work matches `prototype/daksh-nirmaan.html` — same tokens, same glass rules, both themes, 390 px.

## Review protocol (agreed 2026-09-16 — keeps Fable usage near zero)

1. **Implement** (Sonnet; Opus for 03–05 and 20). Done = must-pass tests green locally, notes written.
2. **Fresh-context review** by a *second* agent that did not implement, loading the `daksh-review` skill: Opus for anything touching `journal_*`, `stock_movements`, `post_*`, RLS, auth, numbering; Sonnet for screens, actions, exports. The reviewer applies the skill's judgment rules and returns APPROVE / APPROVE AFTER FIXES / REJECT. Fixes go back to the implementer; the reviewer re-checks once.
3. **Automated gates** on every change: `supabase test db` (pgTAP), `npm run build`, `npm run lint`, `npx tsc --noEmit`, and from change 16 onward the CI suite (Playwright smoke, bundle grep for the service key, `npm audit`). A red gate blocks commit.
4. **Fable** only at three milestones, each one turn: after change 05 (posting engine complete), after change 12 (money flows end-to-end), and before go-live (security review via `/security-review`). If the Fable budget is gone, Opus runs the same milestone reviews with the `daksh-review` skill.
5. **Push to hosted** only after step 2 approves; `supabase db push` runs from a developer machine before go-live, from CI after.

Why this is enough: the first two reviews found spec gaps and default-direction judgments, not implementation errors. Those rules are now written in `daksh-review`, so any model can apply them. The guarantees of a production-grade ledger come from the database invariants and their tests, not from who reads the diff.

## Phase 1 — daily billing runs on it, and the family can check the books and file GST themselves

| # | Change | Model | Skill | Governing spec section | Must pass |
|---|---|---|---|---|---|
| 01 | `foundation-schema` — enums, core tables, app_users, RLS scaffolding, seed CoA (incl. new system keys), warehouses, fiscal periods, sequences, indexes | Sonnet | daksh-schema | db-architecture: Enums, Core tables, Seed data, Indexes, RLS and roles | RLS denies non-member; seed creates all `system_key` rows |
| 02 | `integrity-triggers` — balanced entry (deferred), immutability, period lock, leaf-only | Sonnet | daksh-schema | db-architecture: Integrity triggers | pgTAP: unbalanced insert raises; UPDATE on posted line raises; locked period raises |
| 03 | `posting-sales` — **lock order, default-privileges revoke, audit_log immutability, `organization.timezone` (db: Non-functional invariants)**; `next_doc_no`, `post_sales_invoice`, `cancel_document` for invoices, `stock_on_hand`, weighted-avg. **Also:** actor from `auth.uid()` (no `p_actor`), grants, `items.is_stock`, `warehouse_id` + `challan_id` on invoices, income system_keys, walk-in party seed, credit-limit check, `organization.allow_negative_stock` | **Opus** | daksh-posting | db-architecture: Posting engine **+ Implementation clarifications** (Actor, Numbering, Tax, Income accounts, Warehouse, COGS, Credit limit, Walk-in); DESIGN.md §3 | "posting a sales invoice keeps books balanced"; "cancelled invoice reverses, never deletes" |
| 04 | `posting-purchase-payment` — **`user` may deposit/clear cheques; `expense_vouchers.period_month` (db: Decisions from change 04 review)**; `post_purchase_invoice` (ITC), `post_payment` + allocations trigger, cheque lifecycle (`cheques_in_hand`, deposit/clear/bounce), `post_expense_voucher` (salary/advance/wages, RCM freight linked to a purchase) | **Opus** | daksh-posting | db-architecture: Posting engine + Schema extensions (payments) **+ Implementation clarifications** (RCM freight, Allocations, Discount & cheques, Salaries) | pgTAP for each; "cheque bounce re-opens the invoices" |
| 05 | `posting-challan-transfer-adjust-dayclose` — enum values (own migration first), **`post_cash_sale` + internal `_post_sales_invoice(skip_credit)`, nullable `credit_limit` (db: Decisions from change 04 review)**, `post_delivery_challan` + convert hook, `post_stock_transfer` + receive (transit warehouse), **`stock_adjustments` + `post_stock_adjustment`**, `post_day_close` | Opus | daksh-posting | db-architecture: Schema extensions (challans, transfers, day_closes) **+ Implementation clarifications** (Stock adjustments, Enum extensions, Transit, Challan → invoice) | "challan then invoice keeps stock and books consistent"; "day close records the difference" |
| 06 | `read-views` — all `v_*` views (`security_invoker`, admin-only predicate on P&L/BS/TB) incl. `v_attention`, `v_party_interest`, `v_bank_recon`, `v_employee_ledger` | Sonnet | daksh-schema | db-architecture: Views **+ Implementation clarifications (Views)** | trial balance view balances after 03–05 fixtures |
| 07 | `app-shell` — Next.js scaffold, Tailwind tokens, glass primitives, topbar/rail/tabbar, theme + next-intl (`en`,`te`), PWA manifest + SW, security headers, middleware, Supabase clients | Sonnet | daksh-ui | frontend-architecture: Design system, Route structure, Responsive, PWA | "theme fidelity"; "reduced transparency"; "language toggle"; build clean |
| 08 | `auth-users` — **custom SMTP (Resend) config, aal2 for admin, session time-box, nonce CSP, login rate limit (security: Non-functional clarifications)**; login (OTP + TOTP for admin), app_users gate, invite/disable actions, Settings → Users; **also set `supabase/config.toml` [auth] to match the spec** (`enable_signup=false`, `otp_expiry=600`, TOTP on) and mirror those settings in the hosted dashboard | Sonnet | daksh-api | api-architecture: Authorization + extensions (admin.ts); security-deployment: Accounts | "signup is a dead end"; "general user cannot cancel" |
| 09 | `masters` — RLS write policies per the clarification, parties (+addresses/sites, interest rate, WhatsApp), items (dual UOM, `is_stock`), CoA view, org settings (UPI VPA, print, negative-stock toggle) | Sonnet | daksh-api + daksh-ui | api-architecture: Action catalog; db: Implementation clarifications (Masters write policies); frontend: parties/settings routes | zod GSTIN/state validation; new party modal matches prototype |
| 10 | `sales-billing-ui` — sales list, invoice form (pcs↔kg, EWB panel, floating totals, UPI note), posted view w/ journal, cancel, PDF route, WhatsApp link | Sonnet | daksh-ui + daksh-api | frontend: sales routes; api: sales.ts, route handlers | "phone billing"; "client math never becomes truth" |
| 11 | `challans-ui` — challan form, open-challans panel, convert to invoice | Sonnet | daksh-ui | frontend: sales/challans; api: challans.ts | "challan conversion is idempotent" |
| 12 | `payments-ui` — receipt/payment form with AllocationGrid, cheque fields + lifecycle actions, list tiles | Sonnet | daksh-ui + daksh-api | frontend: payments; api: payments.ts | allocation cap + auto-allocate; bounce flow |
| 13 | `parties-stock-staff-ui` — party ledger (site chips, ageing tiles, statement exports), stock summary/ledger + adjustment/transfer modals, staff ledger + voucher modals | Sonnet | daksh-ui | frontend: parties/stock/staff | ledger rows Enter-activatable; 390 px |
| 14 | `dashboard` — tiles, chart (steel/cement tokens), attention list from `v_attention`, quick actions | Sonnet | daksh-ui | frontend: dashboard; dataviz palette already validated | both themes; tooltip; legend |
| 15 | `reports-p1` — day close screen, day book, ageing (with interest column), stock, cash & bank book; Excel exports (exceljs) | Sonnet | daksh-ui + daksh-api | frontend: reports; api: route handlers | ageing totals = AR control balance |
| 16 | `ops` — CI (typecheck, lint, pgTAP, Playwright smoke, bundle grep), **daily** encrypted dump workflow to family Drive, RUNBOOK.md, Sentry | Sonnet | daksh-api | security-deployment: Production topology, Dependencies & CI | "backup actually restores" (drill into the local stack) |
| 17 | `cutover` — `post_opening_balances`, opening stock import (CSV), fiscal periods for the opening month, manual-book series `DNM/`, go-live checklist | Sonnet | daksh-schema | db-architecture: Seed data + Implementation clarifications (Opening balances); security: Rollout steps | trial balance balances after import |
| 18 | `self-audit-and-gst` — **prerequisite: GSTR-1 schema research task (api clarifications)**; trial balance, P&L, balance sheet, GSTR-1 (portal JSON + Excel), GSTR-3B summary, period locks UI, audit trail page. **Moved from Phase 2 (2026-09-16): the family files GST and validates the books themselves — there is no external accountant.** | Sonnet | daksh-ui + daksh-api | frontend: reports/settings; api: route handlers | TB Σdr = Σcr on screen; GSTR-1 JSON validates against the portal schema for a month of posted invoices |
| 19 | `aal2-enforcement` — **an owner who has not passed the authenticator step is treated as no-one by the database, not just by the app.** Make `is_active_member()` and `current_app_role()` aal-aware; switch the 18 direct `app_users` role lookups in changes 03–06 to `current_app_role()`; mechanical `"aal":"aal2"` update of ~390 test sessions; new pgTAP proving an aal1 owner is refused everywhere. **Must land before 17 (cutover) / go-live; found in change 08's design (see its implementation-notes, KNOWN GAPS 1).** | **Opus** | daksh-schema + daksh-posting | security-deployment: Non-functional clarifications (Sessions); change 08 notes | "owner at step 1 cannot post, cancel, or read the books through the API"; all existing pgTAP still green |

**Go-live blockers added mid-build:** change 19 (`aal2-enforcement`) must be done and reviewed before change 17 (cutover). Track it with the pre-go-live `/security-review` in Review protocol step 4.

Numbering: each phase owns a block (Phase 1 = 01–19, Phase 2 = 20–29, Phase 3 = 30+). Gaps such as 18–19 are reserved for changes discovered mid-phase, so later phases never renumber.

## Phase 2 — full self-accounting (notes, purchases screen, bank recon, quotes, rebates, exports)

| # | Change | Model | Skill | Spec section |
|---|---|---|---|---|
| 20 | `notes` — credit/debit notes posting + UI | Opus (posting) / Sonnet (UI) | daksh-posting, daksh-ui | db: Posting engine (notes) |
| 21 | `purchases-ui` — bill form (supplier ref, ITC flags, RCM block), attachments (bill photo) | Sonnet | daksh-ui + daksh-api | frontend: purchases; api: attachments.ts |
| 22 | `bank-recon` — **HIGH PRIORITY (owner: HDFC, mostly UPI/bank transfers).** Starts with a research task on HDFC's statement CSV/Excel format (same pattern as the GSTR-1 research before 18), then CSV import, matching on UPI/NEFT reference + amount + date, create-from-line | Sonnet | daksh-api | db: bank_statements; api: bank.ts |
| 23 | `cash-deposit` — `post_cash_deposit` (Dr Bank · Cr Cash), "Deposit cash to bank" modal, HDFC ledger name, go-live checklist item. Brief: `openspec/changes/23-cash-deposit/proposal.md` | Opus (posting) / Sonnet (UI) | daksh-posting, daksh-ui | db: day_closes `deposited` rule |
| 24 | `quotes-rebates-interest` — quotations, brand rebate tracker, interest debit note | Sonnet | daksh-api | db: quotations, brand_rebates, v_party_interest |
| 25 | `exports-portability` — full-books Excel, FY archive bundle, Tally XML | Sonnet | daksh-api | security: Business continuity |

## Phase 3 — integrations (each gets its own spec first)

E-way bill API (NIC) · e-invoice IRN (only if turnover > ₹5 cr) · GSTR-2B reconciliation import · WhatsApp Business API (replace wa.me links) · Web Push for attention items.

## Brief template (copy into each proposal)

```
Skill: daksh-<x>
Spec section: <file> → "## Requirement: <name>"
Context: <2–3 sentences: what exists, what this adds, why it matters to the books>
Done when: <acceptance scenario(s) by name> pass; build clean; hard rules hold
Do not: read other specs; write business math in TS; touch journal tables directly
```
