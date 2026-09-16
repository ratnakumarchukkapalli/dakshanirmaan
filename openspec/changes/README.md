# Build plan — ordered change proposals

Written for: the implementing model (Sonnet by default; Opus for the posting engine) and the reviewer (Fable).

Hosted project: `daksha-nirmaan` (`dcmgbkugdyxsjvkirmft`, ap-south-1, Postgres 17, Supabase Free). Linked via CLI; `supabase start` runs the local stack for every change; `supabase db push` to hosted only after local pgTAP passes.

Each change below is one folder `openspec/changes/<id>-<slug>/` containing `proposal.md` (scope, spec sections, acceptance scenarios, brief) and, once merged, `implementation-notes.md`. Archive to `openspec/changes/archive/` after the pitch + quiz pass (see `openspec/project.md`). **Do not start before Ratna says "start".**

## Rules for every change

- The brief names **one skill** and **one spec section**. The child reads the skill, that section, and this file's row. Nothing else unless the brief says so.
- Acceptance = the scenario(s) listed pass (pgTAP for DB, Playwright/Vitest for app) **and** `npm run build` is clean **and** the hard rules in `CLAUDE.md` hold.
- Surprises: take the conservative option, log it in `implementation-notes.md`, keep going.
- Visual work matches `prototype/daksh-nirmaan.html` — same tokens, same glass rules, both themes, 390 px.

## Phase 1 — daily billing runs on it

| # | Change | Model | Skill | Governing spec section | Must pass |
|---|---|---|---|---|---|
| 01 | `foundation-schema` — enums, core tables, app_users, RLS scaffolding, seed CoA (incl. new system keys), warehouses, fiscal periods, sequences, indexes | Sonnet | daksh-schema | db-architecture: Enums, Core tables, Seed data, Indexes, RLS and roles | RLS denies non-member; seed creates all `system_key` rows |
| 02 | `integrity-triggers` — balanced entry (deferred), immutability, period lock, leaf-only | Sonnet | daksh-schema | db-architecture: Integrity triggers | pgTAP: unbalanced insert raises; UPDATE on posted line raises; locked period raises |
| 03 | `posting-sales` — `next_doc_no`, `post_sales_invoice`, `cancel_document` for invoices, `stock_on_hand`, weighted-avg | **Opus** | daksh-posting | db-architecture: Posting engine; DESIGN.md §3 worked example | "posting a sales invoice keeps books balanced"; "cancelled invoice reverses, never deletes" |
| 04 | `posting-purchase-payment` — `post_purchase_invoice` (ITC, RCM), `post_payment` + allocations trigger, cheque lifecycle + `bounce_cheque`, `post_expense_voucher` (salary/advance/wages) | **Opus** | daksh-posting | db-architecture: Posting engine + Schema extensions (payments) | pgTAP for each; "cheque bounce re-opens the invoices" |
| 05 | `posting-challan-transfer-dayclose` — `post_delivery_challan` + convert, `post_stock_transfer` + receive, `post_day_close` | Opus | daksh-posting | db-architecture: Schema extensions (challans, transfers, day_closes) | "challan then invoice keeps stock and books consistent"; "day close records the difference" |
| 06 | `read-views` — all `v_*` views incl. `v_attention`, `v_party_interest`, `v_bank_recon` | Sonnet | daksh-schema | db-architecture: Views | trial balance view balances after 03–05 fixtures |
| 07 | `app-shell` — Next.js scaffold, Tailwind tokens, glass primitives, topbar/rail/tabbar, theme + next-intl (`en`,`te`), PWA manifest + SW, security headers, middleware, Supabase clients | Sonnet | daksh-ui | frontend-architecture: Design system, Route structure, Responsive, PWA | "theme fidelity"; "reduced transparency"; "language toggle"; build clean |
| 08 | `auth-users` — login (OTP + TOTP for admin), app_users gate, invite/disable actions, Settings → Users; **also set `supabase/config.toml` [auth] to match the spec** (`enable_signup=false`, `otp_expiry=600`, TOTP on) and mirror those settings in the hosted dashboard | Sonnet | daksh-api | api-architecture: Authorization + extensions (admin.ts); security-deployment: Accounts | "signup is a dead end"; "general user cannot cancel" |
| 09 | `masters` — parties (+addresses/sites, interest rate, WhatsApp), items (dual UOM), CoA view, org settings (UPI VPA, print) | Sonnet | daksh-api + daksh-ui | api-architecture: Action catalog (parties, items, admin); frontend: parties/settings routes | zod GSTIN/state validation; new party modal matches prototype |
| 10 | `sales-billing-ui` — sales list, invoice form (pcs↔kg, EWB panel, floating totals, UPI note), posted view w/ journal, cancel, PDF route, WhatsApp link | Sonnet | daksh-ui + daksh-api | frontend: sales routes; api: sales.ts, route handlers | "phone billing"; "client math never becomes truth" |
| 11 | `challans-ui` — challan form, open-challans panel, convert to invoice | Sonnet | daksh-ui | frontend: sales/challans; api: challans.ts | "challan conversion is idempotent" |
| 12 | `payments-ui` — receipt/payment form with AllocationGrid, cheque fields + lifecycle actions, list tiles | Sonnet | daksh-ui + daksh-api | frontend: payments; api: payments.ts | allocation cap + auto-allocate; bounce flow |
| 13 | `parties-stock-staff-ui` — party ledger (site chips, ageing tiles, statement exports), stock summary/ledger + adjustment/transfer modals, staff ledger + voucher modals | Sonnet | daksh-ui | frontend: parties/stock/staff | ledger rows Enter-activatable; 390 px |
| 14 | `dashboard` — tiles, chart (steel/cement tokens), attention list from `v_attention`, quick actions | Sonnet | daksh-ui | frontend: dashboard; dataviz palette already validated | both themes; tooltip; legend |
| 15 | `reports-p1` — day close screen, day book, ageing (with interest column), stock, cash & bank book; Excel exports (exceljs) | Sonnet | daksh-ui + daksh-api | frontend: reports; api: route handlers | ageing totals = AR control balance |
| 16 | `ops` — CI (typecheck, lint, pgTAP, Playwright smoke, bundle grep), weekly dump workflow, RUNBOOK.md, Sentry | Sonnet | daksh-api | security-deployment: Production topology, Dependencies & CI | "backup actually restores" (drill on staging) |
| 17 | `cutover` — opening balances + opening stock import (CSV), manual-book series `DNM/`, go-live checklist | Sonnet | daksh-schema | db-architecture: Seed data; security: Rollout steps | trial balance balances after import |

## Phase 2 — accountant-ready

| # | Change | Model | Skill | Spec section |
|---|---|---|---|---|
| 20 | `notes` — credit/debit notes posting + UI | Opus (posting) / Sonnet (UI) | daksh-posting, daksh-ui | db: Posting engine (notes) |
| 21 | `purchases-ui` — bill form (supplier ref, ITC flags, RCM block), attachments (bill photo) | Sonnet | daksh-ui + daksh-api | frontend: purchases; api: attachments.ts |
| 22 | `bank-recon` — CSV import, matching, create-from-line | Sonnet | daksh-api | db: bank_statements; api: bank.ts |
| 23 | `reports-p2` — trial balance, P&L, balance sheet, GSTR-1 (portal JSON + Excel), GSTR-3B, period locks UI, audit trail page | Sonnet | daksh-ui + daksh-api | frontend: reports/settings; api: route handlers |
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
