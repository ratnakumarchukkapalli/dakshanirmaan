# Daksha Nirmaan — Architecture & Database Design

Accounting + inventory system for a family business trading in cement, TMT steel, and construction materials (India, GST-registered).

**Stack:** Next.js (App Router) on Vercel · Supabase Postgres (no separate backend) · Supabase Auth.

---

## 1. Core design principle

**Documents are operational truth; the journal is financial truth.**

Every business event (sale, purchase, payment, return, stock adjustment) is entered as a *document*. Posting a document atomically creates:

1. A **balanced journal entry** (double-entry: Σ debits = Σ credits, enforced by a DB trigger)
2. **Stock movements** (if goods moved), valued at weighted average cost

Posted journal entries and stock movements are **immutable**. Corrections happen via reversal entries / credit notes — never edits. This is what makes it real bookkeeping instead of an expense tracker: the trial balance always balances, and every rupee is traceable to a source document.

```
  Sales Invoice ──┐
  Purchase Bill ──┤                    ┌── journal_entries ── journal_lines
  Receipt/Payment─┼──▶ POSTING ENGINE ─┤
  Credit/Dr Note ─┤   (Postgres fn,    └── stock_movements
  Stock Adjust ───┘    one transaction)
```

The posting engine lives in **Postgres functions (plpgsql), called via RPC** — not in Next.js code — so the invariants hold no matter which client calls them.

---

## 2. Entities

### 2.1 Organization & setup

| Table | Purpose |
|---|---|
| `organization` | Single row: legal name, GSTIN, state code (drives CGST/SGST vs IGST), address, FY start (April), e-invoice applicability flag |
| `fiscal_periods` | One row per month; `is_locked` blocks posting into closed periods (GST returns filed → lock the month) |
| `doc_sequences` | Per document type + FY series (e.g. `DN/25-26/0001`). Gapless numbering via `SELECT … FOR UPDATE` — GST requires consecutive invoice numbers |
| `app_users` / roles | Supabase auth users + role: `owner`, `accountant`, `staff` (staff can draft, only accountant/owner can post) |

### 2.2 Chart of Accounts — `accounts`

Hierarchical (self-referencing `parent_id`), typed:

- `asset` — Cash, Bank, Inventory, GST Input (CGST/SGST/IGST credit), **Accounts Receivable (control)**
- `liability` — GST Output, **Accounts Payable (control)**, RCM payable, TDS payable, loans
- `equity` — Capital accounts (dad, babai — partner capital + drawings)
- `income` — Sales (cement / steel / other), freight recovered, discount received
- `expense` — COGS, freight paid, godown rent, salaries, discount allowed, round-off

Party balances are **not** separate accounts per customer. Instead: two control accounts (AR/AP), and `journal_lines.party_id` provides the sub-ledger. Party ledger = filter journal lines by party. This keeps the CoA small and party ledgers exact.

### 2.3 Parties — `parties` + `party_addresses`

Customers, suppliers, or **both** (builders often are). Fields:

- `name`, `type` flags, `gstin` (nullable — B2C/unregistered buyers), `state_code` ← **determines IGST vs CGST+SGST**
- `credit_limit`, `credit_days` → drives the credit-control alerts on the dashboard
- `party_addresses`: multiple **ship-to addresses** — one builder, many construction sites. Ship-to goes on the invoice and e-way bill.

### 2.4 Items — `items`

- `name`, `brand` (UltraTech, ACC, Tata Tiscon, Vizag…), `category` (cement / TMT / other)
- `hsn_code` (cement **2523**, TMT bars **7214**), `gst_rate` (**snapshotted onto every invoice line** — rates change; cement went 28%→18% in Sept 2025)
- **UOM handling** — the tricky part of this trade:
  - `base_uom` (stock is always tracked in this) + `alt_uom` + `conversion_factor`
  - Cement: base = bag (50kg). Simple.
  - TMT: base = **kg**, alt = piece. A 12 m Fe500 bar: 8 mm ≈ 4.74 kg, 12 mm ≈ 10.66 kg, 16 mm ≈ 18.96 kg. Sell "20 pieces 12mm", stock decrements 213.2 kg. Conversion factor lives on the item.
- `reorder_level` for low-stock alerts

One item per brand+grade+size (e.g. "Tata Tiscon Fe500D 12mm"). No batch tracking needed for this trade.

### 2.5 Warehouses — `warehouses`

Godowns. Even if there's one today, every stock movement carries `warehouse_id` so a second godown is a data change, not a schema change.

### 2.6 The ledger core — `journal_entries` + `journal_lines`

```
journal_entries: id, entry_no, entry_date, narration,
                 source_type ('sales_invoice'|'purchase_invoice'|'payment'|…),
                 source_id, status, reversed_by_entry_id, posted_by, posted_at

journal_lines:   id, entry_id, line_no, account_id,
                 party_id (nullable — set on AR/AP control lines),
                 debit NUMERIC(14,2), credit NUMERIC(14,2)
                 CHECK (debit = 0 OR credit = 0)
```

Triggers enforce: entry balances on post; posted rows reject UPDATE/DELETE; entry_date must fall in an unlocked period.

### 2.7 Inventory — `stock_movements`

```
stock_movements: id, item_id, warehouse_id, movement_date,
                 qty (signed: + in, − out, in base UOM),
                 rate NUMERIC(14,4), value NUMERIC(14,2),
                 source_type, source_id
```

- **Valuation: weighted moving average.** On purchase, new avg = (old value + purchase value) / (old qty + new qty). On sale, COGS = qty × current avg — posted as Dr COGS / Cr Inventory in the same journal entry. FIFO layers are more code for no benefit here.
- Negative stock blocked at posting (configurable override for owner).
- Stock ledger and stock summary are just views over this table.

### 2.8 Sales — `sales_invoices` + `sales_invoice_lines`

Header: invoice no (from sequence), date, `party_id`, bill-to/ship-to snapshot, `place_of_supply_state`, status (`draft`→`posted`→`cancelled`), totals, round-off, **e-way bill block**, **e-invoice block** (nullable IRN, ack no, ack date, signed QR — schema-ready even if turnover < ₹5 cr today).

**E-way bill fields** (required when consignment > ₹50,000 — i.e. almost every cement/steel load): `ewb_no`, `ewb_date`, `valid_until`, `transporter_name`, `transporter_gstin`, `transport_mode`, `vehicle_no`, `distance_km`.

Lines snapshot everything: item name, HSN, UOM, qty, rate, discount, taxable value, `cgst_rate/amt`, `sgst_rate/amt`, `igst_rate/amt`. **Never join to the item master for a historical invoice.**

Tax logic: `party.state_code == org.state_code` → CGST+SGST, else IGST. Freight charged on the invoice takes the goods' GST rate (composite supply).

### 2.9 Purchases — `purchase_invoices` + lines

Mirror of sales, plus: supplier's bill number/date (their number, our internal sequence separately), ITC (input credit) per line, `rcm_flag` — **freight paid to lorry owners/GTA attracts 5% GST under reverse charge**, which the business must self-invoice and pay. Big deal in materials trading; modeled from day one.

### 2.10 Returns — `credit_notes` / `debit_notes` (+ lines)

Damaged bags, bent bars, rate differences. Credit note (sales return): reverses revenue + GST proportionally, stock comes back IN at original COGS rate. GST-reportable documents with their own sequence.

### 2.11 Money — `payments` + `payment_allocations`

- `payments`: direction (receipt/payment), `party_id`, mode (cash/UPI/NEFT/cheque), instrument no/date, amount, cash-discount amount
- `payment_allocations`: payment → invoice(s), amount each. **This is what makes receivables aging work** — "Sri Lakshmi Constructions owes ₹3.2L, of which ₹1.1L is 60+ days old."
- Unallocated amounts sit as on-account balance. Cheque bounce = reversal entry, allocation removed.

### 2.12 Employees & salaries

Staff: auto/lorry driver + 2–3 members. No payroll module needed — reuse the party sub-ledger machinery:

- `parties.type` gains `employee` (name, role — driver/loader/sales, monthly salary or daily wage, joining date, phone)
- Two control accounts: **Salary Payable** (liability) and **Employee Advances** (asset); journal lines carry `party_id` = the employee, so each employee has an exact ledger like any customer
- Expense accounts: `Salaries & Wages` (optionally split driver/staff), `Vehicle Running` (fuel, repairs — own auto is a business expense, distinct from third-party GTA freight which is RCM)
- **Salary voucher** (a payment-type document, same posting engine):
  - Month-end pay: Dr Salaries & Wages · Cr Cash/Bank (and Cr Employee Advance for any amount recovered)
  - Mid-month advance (the common case with drivers): Dr Employee Advance (employee) · Cr Cash — the employee's ledger shows advances taken vs salary due at all times
- Daily-wage hamali/loading labour: same voucher, `Loading & Unloading` expense account
- No GST on salaries (employment is outside GST). TDS fields optional — at these salary levels it won't apply, but the column costs nothing.

### 2.13 Audit — `audit_log`

Who did what, when, old→new, for every posted/cancelled document. Family business + multiple staff = non-negotiable.

---

## 3. Posting rules (worked example)

**Credit sale to a local (intra-state) builder: 100 bags UltraTech @ ₹360 + 500 kg 12mm TMT @ ₹58/kg, GST 18%:**

| Account | Debit | Credit |
|---|---|---|
| AR control (party: builder) | 76,700 | |
| Sales — Cement | | 36,000 |
| Sales — Steel | | 29,000 |
| Output CGST 9% | | 5,850 |
| Output SGST 9% | | 5,850 |
| **COGS** | 55,400 | |
| **Inventory** | | 55,400 |

- stock_movements: cement −100 bags @ avg ₹318, TMT −500 kg @ avg ₹47.2
- Receipt of ₹50,000 by UPI later: Dr Bank 50,000 / Cr AR (party) 50,000 + allocation to this invoice.

**Purchase 500 bags from dealer @ ₹310 + 5% RCM freight ₹4,000:**

| Account | Debit | Credit |
|---|---|---|
| Inventory — Cement | 1,55,000 | |
| Input CGST/SGST | 27,900 | |
| AP control (party: dealer) | | 1,82,900 |
| Freight inward | 4,000 | |
| Input GST (RCM, after payment) | 200 | |
| RCM payable + lorry owner | | 4,200 |

---

## 4. GST reporting (all derivable, no extra data entry)

- **GSTR-1**: B2B section from posted invoices with GSTIN; B2C summary for the rest; HSN-wise summary from line snapshots; document-number ranges from sequences. Export as the portal's JSON/Excel format.
- **GSTR-3B**: output vs input summary view.
- **GSTR-2B reconciliation** (phase 2): import 2B JSON, match against purchase invoices.

---

## 5. App architecture

```
Next.js (Vercel)
├── app/(auth)/…                    Supabase Auth (email/OTP), role-gated
├── app/(dashboard)/
│   ├── billing/    sales invoices, credit notes, delivery challans
│   ├── purchases/
│   ├── parties/    ledger, aging, credit limits
│   ├── inventory/  stock summary, ledger, adjustments
│   ├── payments/
│   ├── reports/    trial balance, P&L, balance sheet, day book, GST
│   └── settings/   CoA, items, sequences, period locks
├── Server Actions (zod-validated) ──▶ supabase.rpc('post_sales_invoice', …)
└── PDF: GST invoice via @react-pdf/renderer (server-side)

Supabase Postgres
├── Tables (above) — migrations via supabase CLI, in repo
├── plpgsql: post_sales_invoice, post_purchase_invoice, post_payment,
│            post_credit_note, cancel_document (reversal), next_doc_number
├── Views: v_trial_balance, v_party_ledger, v_party_aging, v_stock_summary,
│          v_stock_ledger, v_pnl, v_balance_sheet, v_gstr1_b2b, v_hsn_summary
└── RLS: deny-by-default; role-based policies; posting fns SECURITY DEFINER
```

**Rules that keep it production-grade:**
- Money `NUMERIC(14,2)`, qty `NUMERIC(12,3)`, rates `NUMERIC(14,4)`. Never float.
- All writes go through posting functions — the app never inserts journal lines directly.
- Drafts are freely editable; posting is the commitment point; cancellation posts a reversal and keeps the number (GST: cancelled numbers must still be reported).
- Every list/report is a SQL view — the app renders, Postgres computes.

---

## 6. Build phases

| Phase | Scope | Outcome |
|---|---|---|
| **0 — Prototype** *(now)* | Static clickable mock: dashboard, billing screen with live GST calc, party ledger, stock view. Demo data. | Show dad & babai, agree on screens/workflow |
| **1 — Core** | Schema + posting engine + auth/roles; items, parties, sales/purchase invoices, payments, stock; invoice PDF; party ledger + stock reports | Daily billing runs on it |
| **2 — Accounting close** | Credit/debit notes, delivery challans, RCM, aging, trial balance/P&L/BS, period locks, GSTR-1 export | Accountant-ready |
| **3 — Integrations** | E-way bill API (NIC), e-invoice IRN if turnover crosses ₹5 cr, GSTR-2B recon, WhatsApp invoice share | Automation |

---

## 7. Prior art — what we borrow, from whom

| Product | What it proves / what we take |
|---|---|
| **ERPNext** (open source — we can read its actual schema) | The architecture we're following is essentially ERPNext's, simplified: every submitted document auto-creates **GL Entries**; stock moves through **Stock Ledger Entries** with perpetual valuation (Dr Stores / Cr COGS on delivery); CoA has *group* vs *ledger* nodes and postings only hit ledger (leaf) accounts. Their `general_ledger.py` is the reference for our posting functions. |
| **Zoho Books** | UX + compliance bar: auto CGST/SGST/IGST from place of supply, HSN on items, e-way bill auto-detection ("this invoice needs an EWB"), delivery challans, direct GSTR filing. Their invoice → payment → reconciliation flow is the workflow model for our screens. |
| **Vyapar / myBillBook** | What small Indian traders actually use daily: fast billing, godown-wise stock, low-stock reminders, party balances up front, works on phone. myBillBook's cloud multi-device model matches our Vercel+Supabase choice; Vyapar shows the demand for construction-materials-specific reports. |

What none of them give us (why we're building): partner-level capital accounts the family controls, TMT piece↔kg conversion done right, credit-control rules tuned to how the business actually lends, no per-user subscription, data stays ours.

## 8. Build workflow (agreed 2026-07-04)

1. **Spec-driven via openspec** — `openspec/specs/` at repo root (same pattern as MyExpenseTracker). One spec per capability, written *before* code: `foundation` (schema+CoA), `posting-engine`, `parties`, `items-stock`, `sales-billing`, `purchases`, `payments`, `reports`, `gst-compliance`. Each spec: requirements, schema deltas, posting rules, acceptance scenarios.
2. **Project skills for cheap models** — `.claude/skills/` so Haiku/Sonnet can implement routine work without re-deriving context: e.g. `daksh-schema` (table conventions, NUMERIC types, naming), `daksh-posting` (how to write/post a document type, invariants checklist), `daksh-ui` (component patterns, en-IN formatting). Fable/Opus for architecture + review; Sonnet implements from specs; Haiku for lookups/explorations.

## 9. Open questions for the owners

1. **GST scheme** — regular (assumed; ITC matters at these volumes) or composition?
2. **How many godowns/locations** today? *(Prototype v2 demos a second godown named "Gannavaram" purely to show the transfer voucher and in-transit state — it is an assumption, not a fact.)*
3. **Who bills today and how** (manual book / Tally / nothing)? Opening balances and opening stock will come from there.
4. Rough **annual turnover** — decides whether e-invoicing (₹5 cr+) is a Phase 3 must or a someday.
5. Do they extend **credit on informal terms** (no fixed days)? Affects how strict the credit-limit blocking should be.
6. **Staff pay structure** — who is monthly salary vs daily wage? How are driver advances handled today (khata book?), and is the auto owned by the business (fuel/repairs = business expense)?
