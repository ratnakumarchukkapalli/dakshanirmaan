# Feature Roadmap Specification

## Purpose

The permanent feature memory of the project. Three lists: (A) parity with the best platforms (Zoho Books is the benchmark), (B) features those platforms *don't* have that this trade needs — our edge, (C) production-grade gaps. Nothing here may be silently dropped; items move phases only by editing this spec.

## Requirement: Platform parity (Zoho Books benchmark)

| Feature | Zoho Books has | Our status |
|---|---|---|
| GST invoicing (auto CGST/SGST/IGST by place of supply) | ✔ | Spec'd — Phase 1 |
| E-way bill fields + >₹50k auto-detection | ✔ | Spec'd — Phase 1 |
| Delivery challans | ✔ | **Spec'd — Phase 1** (db-architecture extensions; prototype v2 screen) |
| Credit/debit notes | ✔ | Spec'd — Phase 2 |
| Payment recording + invoice allocation | ✔ | Spec'd — Phase 1 |
| Receivables aging | ✔ | Spec'd — Phase 1 |
| Inventory with reorder alerts | ✔ | Spec'd — Phase 1 |
| Chart of accounts + manual journals | ✔ | Spec'd — Phase 1 (manual journal admin-only) |
| Bank statement reconciliation (CSV import, match receipts) | ✔ | **Spec'd — Phase 2** (bank_statements; prototype v2 screen) |
| Cheque lifecycle: PDC tracking, bounce reversal | partial | **Spec'd — Phase 1** (cheque_status on payments, bounce_cheque) |
| Refunds (reverse-direction payment) | ✔ | **Phase 2** — `payments.direction = 'refund'`; Phase 1 uses notes + admin journal |
| Recurring invoices | ✔ | Skip — not how this trade bills |
| Quotations/estimates | ✔ | **Spec'd — Phase 2** (quotations table, convert action) |
| Payment reminders (email/WhatsApp) | ✔ (email) | **Spec'd — Phase 2 lite**: wa.me deep link + signed PDF URL (no Business API) |
| Customer portal | ✔ | Skip v1 — party statement PDF export instead |
| UPI QR on invoice (pay instantly) | partial | **Spec'd — Phase 1** (org.upi_vpa, UpiQr component, on PDF) |
| Document attachments (purchase bill photo) | ✔ | **Spec'd — Phase 2** (attachments table, signed upload URLs) |
| GSTR-1/3B exports | ✔ files direct | Spec'd — Phase 2 (portal JSON/Excel; direct API filing = Phase 3+) |
| E-invoicing (IRN) | ✔ | Schema-ready; API integration Phase 3, only if turnover > ₹5 cr |
| Audit trail | ✔ | Spec'd — Phase 1 (audit_log + admin page) |
| Multi-currency, projects, timesheets | ✔ | Skip — irrelevant to trade |

## Requirement: Our edge — what Zoho/Vyapar/myBillBook don't do

These are why the app exists; none may be cut without owner sign-off:

1. **TMT piece↔kg dual UOM done right** — sell 47 pieces of 12mm, stock moves 501 kg; per-diameter conversion factors. Generic platforms make this a spreadsheet-on-the-side.
2. **Brand rebates / quantity incentives** — cement companies pay quarterly slabs. Dedicated income accounts + a rebate-tracking report per brand (accrue expected rebate, match on credit note receipt). *No mainstream small-biz platform models this.* *Spec'd Phase 2 (brand_rebates, v_rebate_tracker).*
3. **Day-close cash report** — expected drawer cash vs book at day end, denomination-free, one tap. Cash-heavy trade essential. *Spec'd Phase 1 (day_closes, post_day_close; prototype v2 screen).*
4. **Employee advance ledgers** — driver/staff advances with auto-recovery at salary time (prototype demos this). Zoho needs a payroll add-on; Vyapar can't.
5. **Interest on overdue credit** — optional per-party interest rate on 30+ day balances, computed on the ledger, shown before it's charged (owner decides). Confirm practice with owners first. *Spec'd Phase 2 (parties.interest_rate_pm, v_party_interest; shown on ageing).*
6. **RCM freight built-in** — GTA lorry freight self-invoicing at 5% wired into purchase flow, not an accountant afterthought.
7. **Site-wise delivery for builders** — one party, many ship-to construction sites, per-site delivery history and (later) per-site outstanding split.
8. **Telugu UI toggle** — i18n scaffolding (next-intl or equivalent) from the first component so Telugu labels are a translation file, not a rewrite. Owners' comfort > feature count.
9. **Partner capital accounts** — dad's and babai's capital + drawings as first-class ledgers, visible only to admin.
10. **Godown transfer voucher** — stock movement between warehouses with in-transit state. *Spec'd Phase 1 (stock_transfers; prototype v2 modal).*
11. **Data freedom** — plain-Postgres dumps, CA-ready Excel/JSON exports, Tally XML escape hatch (per security-deployment spec). The anti-lock-in guarantee no SaaS offers.

## Requirement: Production-grade gaps (tracked, not yet spec'd)

1. ~~Indexes + pagination~~ — **done 2026-09-16**: baseline index list + keyset pagination in db-architecture.
2. ~~Backup automation home~~ — **done 2026-09-16**: security-deployment "Production topology" (weekly `pg_dump` → age-encrypted → family Drive).
3. **E2E tests** — Playwright: login → draft invoice → post → verify ledger/stock/PDF. Golden-file tests for invoice PDF and GSTR JSON.
4. **Outage UX** — friendly offline/error page with the manual-invoice-book instruction (continuity plan made visible where it's needed).
5. ~~`openspec/changes/` workflow~~ — **done 2026-09-16**: `openspec/changes/README.md` + ordered build plan with per-change briefs.
6. ~~Project skills~~ — done (`daksh-schema`, `daksh-posting`, `daksh-api`, `daksh-ui`).
7. ~~Custom SMTP~~ — **deferred by decision (2026-07-04): Supabase default email is fine for now** (2 users, low OTP volume). Revisit only if OTP delivery proves unreliable.

## Requirement: Open unknowns register

Owner interview: GST scheme; godown count; current billing + opening-balance cutover; turnover; credit terms + interest practice; staff pay structure; cash-drawer habits; godown internet reliability; invoice print musts (bank details, signature, jurisdiction); brand rebate terms; Telugu preference; device inventory; who is admin vs user.
CA: GSTR export format acceptance; FY archive expectations; URD purchase treatment.
Ratna: ~~Supabase Pro budget~~ decided 2026-09-16 (Supabase Pro + Vercel Pro ≈ $45–50/mo, PITR add-on deferred); domain purchase still pending.

#### Scenario: nothing gets forgotten
- WHEN any feature discussion happens in a session
- THEN it lands in this spec (with phase) before the session ends, and removal requires an explicit edit here — memory lives in the repo, not in chat history
