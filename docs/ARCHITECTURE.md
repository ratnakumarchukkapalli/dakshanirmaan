# Daksha Nirmaan — System Architecture

Written for: the engineer (or model) implementing the app from the specs. `docs/DESIGN.md` explains the accounting *why*; the specs in `openspec/specs/` are the contract; this document is the map of how the pieces fit at runtime and why the shape is what it is for a 10-user business system that must never lose a rupee.

## 1. Sizing reality

| Fact | Consequence |
|---|---|
| ≤ 10 users, one business, one country | No multi-tenancy, no sharding, no queues. A single Postgres is the whole system of record. |
| ~50–100 documents/day, ≤ 50k journal lines/year | Every report is a plain SQL view; no caches, no materialisation, no search engine. |
| Money is real; data loss is unacceptable | Correctness > latency. Invariants live in the database, not the app. Backups are off-platform. |
| Owners use phones at the godown | PWA, mobile-first surface, read-only offline glance. |
| Budget ≈ $50/month, no per-user fees | Vercel Pro + Supabase Pro. Nothing else recurring. |

The temptation with "best system design" is to add layers. For this scale the best design is the one with the fewest places a bug can hide: **one database that enforces the books, one stateless app that renders them.**

## 2. Container view

```
                      dakshanirmaantraders.in (Vercel DNS, TLS, HSTS)
                                        │
                     ┌──────────────────▼───────────────────┐
                     │  Next.js App Router on Vercel (bom1) │
                     │  ─ RSC pages read views via @supabase/ssr (user JWT, RLS)
                     │  ─ Server Actions: zod → role gate → .rpc('post_*') / draft writes
                     │  ─ Route handlers: PDF (react-pdf), xlsx (exceljs), GSTR JSON, Tally XML
                     │  ─ middleware: session refresh + app_users membership gate
                     │  ─ PWA shell: manifest + service worker (read-only cache)
                     └───────┬─────────────────────┬────────┘
                             │ HTTPS (anon key + user JWT)│ service key (server only: storage signing, invites)
                     ┌───────▼─────────────────────▼────────┐
                     │  Supabase project daksha-prod (ap-south-1)
                     │  ┌ Postgres ────────────────────────┐ │
                     │  │ documents (drafts, editable)     │ │
                     │  │ post_* plpgsql SECURITY DEFINER  │ │  ← the only writer of the ledger
                     │  │ journal_entries/lines, stock_movements (immutable, triggers)
                     │  │ views: v_trial_balance, v_party_ledger, v_party_aging, v_stock_*, v_gstr*, v_attention
                     │  │ RLS deny-by-default, app_users role gate
                     │  └──────────────────────────────────┘ │
                     │  Auth (email OTP, TOTP for admin, signup off)
                     │  Storage bucket `docs` (private, signed URLs)
                     └───────────────────────────────────────┘
                             │ weekly pg_dump (GitHub Actions cron)
                     ┌───────▼───────────────────────────────┐
                     │  Family-owned encrypted backup folder  │  ← survives losing Supabase
                     └───────────────────────────────────────┘
```

Staging is an identical, free-tier Supabase project bound to Vercel preview deployments. Sentry receives errors from both tiers.

## 3. The three write paths (and there are only three)

1. **Draft writes** — the app inserts/updates rows in document tables (`sales_invoices`, `payments`, …) with the user's own JWT. RLS allows this for both roles while `status = 'draft'`. No numbers are assigned, no ledger effect.
2. **Posting** — a server action calls one `post_*` function via RPC. Inside one transaction the function: re-checks role, validates the draft, assigns the gapless number (`next_doc_no`, row-locked), recomputes tax from line snapshots and place of supply, writes journal lines and stock movements, sets `status = 'posted'`, writes `audit_log`. The deferred balanced-entry trigger fires at commit. If anything raises, nothing persists.
3. **Reversal** — `cancel_document` / `bounce_cheque` post mirror-image entries. Nothing posted is ever updated or deleted; the immutability trigger guarantees it even if someone connects with psql.

Everything else the user sees (ledgers, ageing, stock, GST, trial balance, dashboard) is a `SELECT` on a view. This is why the app has no business math in TypeScript: client totals are a live preview, and a tampered client cannot corrupt the books.

## 4. Request flow — posting an invoice on a phone

```
tap Post ──▶ Server Action postInvoice(id)
              ├ zod parse {id}
              ├ getUser() → app_users.role  (forbidden? return envelope)
              ├ supabase.rpc('post_sales_invoice', {p_invoice_id, p_actor})
              │     Postgres: BEGIN … validate draft, lock sequence, compute tax,
              │               INSERT journal + stock, audit, COMMIT (trigger checks Σdr=Σcr)
              ├ map DN_* RAISE → ErrorCode (period_locked, negative_stock, credit_limit…)
              ├ revalidatePath('/sales', '/parties/[id]', '/stock', '/')
              └ return {ok:true, data:{invoiceNo, journalEntryId}}
UI: toast "Posted DN/26-27/0347" → navigate to /sales/[id]/view (RSC reads the posted snapshot)
```

Latency budget: one RPC round-trip Vercel(bom1) ↔ Supabase(Mumbai) ≈ 5–15 ms; posting completes well under 200 ms. No optimistic UI is needed.

## 5. Security model in one paragraph

Browser holds only the anon key and the user's session; RLS turns every query into "what this member may see." Ledger tables grant no INSERT/UPDATE/DELETE to any role; only `SECURITY DEFINER` functions (with pinned `search_path`) write them, and they re-check the role inside. The service-role key exists only in server env for storage signing and user invites, and CI greps the bundle to prove it never ships. Admin accounts require TOTP. Public signup is off; the roster is capped at 10. Every post/cancel/unlock/reopen is in `audit_log`, visible to admins in Settings. Headers: CSP, HSTS preload, frame-ancestors none.

## 6. Data model at a glance

```
organization ─┐        accounts (tree; leaf-only postings; system_key lookups)
fiscal_periods│              ▲
doc_sequences │              │ account_id
app_users     │   journal_entries ──< journal_lines >── parties (customer/supplier/employee)
              │        ▲                                   ▲
   documents ─┘        │ journal_entry_id                  │ party_id
   sales_invoices, purchase_invoices, credit/debit_notes, payments(+allocations, cheque_status),
   expense_vouchers, delivery_challans, stock_transfers, day_closes, quotations (no ledger)
              │
   items ──< stock_movements >── warehouses        attachments, bank_statements(+lines), brand_rebates, audit_log
```

Party balances are journal lines on the AR/AP/employee control accounts filtered by `party_id`; there are no per-party accounts. Stock value is Σ(qty × rate) of movements; average cost is recomputed per purchase. Document lines snapshot names/HSN/rates so history never depends on masters.

## 7. Failure modes and what happens

| Failure | Behaviour |
|---|---|
| Vercel down | PWA shell serves cached dashboard/balances read-only; billing continues from the manual book (`DNM/` series). Redeploy elsewhere from Git in hours. |
| Supabase down | Same as above; nothing is lost because nothing is cached for write. |
| Supabase account lost | Restore last weekly dump into any Postgres; quarterly drill proves it. |
| Two users post simultaneously | `next_doc_no` row lock serialises numbering; no gaps, no duplicates. |
| Stale draft edit | `updated_at` check → `conflict` envelope; user reloads. |
| Wrong posting discovered | Cancel → reversal entry; original number retained (GST). |
| Month already filed | Period lock rejects any posting dated inside, including reversals; admin unlock is audit-logged. |

## 8. What we deliberately do not build

Multi-tenant org switching · separate API server · message queue · Redis · full-text search · microservices · React Native · real-time subscriptions (Supabase Realtime) · offline writes · custom auth. Each would add a place for the books to go wrong without serving 10 users better. Revisit only on a concrete need recorded in `feature-roadmap`.

## 9. Delivery mechanics

Monorepo-free single Next.js repo on GitHub. CI: typecheck, lint, unit (format helpers, zod), pgTAP (posting invariants) against a throwaway Supabase local DB, Playwright smoke (login → draft → post → ledger), service-key bundle grep, `npm audit`. Migrations promote local → staging → production; production push is a manual approved job that takes a backup first. Build order and per-change briefs: `openspec/changes/README.md`.
