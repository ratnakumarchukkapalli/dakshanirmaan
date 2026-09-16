---
name: daksh-api
description: Server-action and API conventions for Daksha Nirmaan. Load whenever writing or changing server actions, zod schemas, Supabase RPC calls, role gates, error handling, route handlers, or PDF/Excel/GSTR exports — even for "just wiring a form to the DB", because the validation and error-envelope contracts are review-blocking. Trigger on "server action", "action", "zod", "rpc", "route handler", "api", "validation", "export", "pdf", "auth check".
---

# Daksha Nirmaan — API Layer

Contract: `openspec/specs/api-architecture/spec.md`. No separate backend: Postgres functions are the write API, views are the read API, this layer is glue.

**Token rule:** your brief names one spec section — read that section only. Don't read other specs unless briefed.

## Every server action, same shape
1. `'use server'`; parse input with the zod schema from `src/schemas/` (shared with the client form — never define a second schema).
2. Role check via `app_users` (roles: `admin`, `user`). The DB re-checks — that's intentional defense in depth, don't "optimize" either side away.
3. Draft writes → user-scoped Supabase client (RLS applies). Post/cancel → `.rpc('post_*')`. **No business math in TypeScript** — the DB recomputes from snapshots and is authoritative; client totals are previews.
4. `revalidatePath` affected routes.
5. Return the envelope — never throw to the UI:

```ts
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ErrorCode };
// codes: validation | forbidden | period_locked | negative_stock | credit_limit | not_draft | conflict | internal
```

Map Postgres `DN_*` RAISEs to codes; `error` is a user-fixable sentence ("June is locked — GSTR-1 already filed"). Unknown errors → log server-side, return `internal`, never leak raw Postgres text.

## Validation invariants
- Money/qty travel as **strings**, validated `^\d+(\.\d{1,4})?$`, cast to NUMERIC in SQL. `parseFloat` for stored values is a review-reject (float drift corrupts books).
- GSTIN: `^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$`, state-code prefix valid, optional (B2C).
- Dates: UI `DD-MM-YYYY` → wire ISO.

## Numbering & concurrency
- Document numbers assigned by the DB **at post time** (`next_doc_no`, row-locked) — never generate numbers in TS, never at draft time. GST series must be gapless.
- Post/cancel idempotent: non-draft → `not_draft`, no side effects. Drafts carry `updated_at`; stale write → `conflict`.

## Route handlers (only non-action surface)
`/api/invoices/[id]/pdf` (react-pdf, server) · `/api/reports/gstr1` (portal JSON + exceljs) · `/api/reports/[name]/xlsx`. Role-gated, streamed. `exceljs` only — `xlsx` package is banned.

## Done means
Action has: schema, role gate, envelope with mapped codes, revalidate, and a test hitting happy path + `forbidden` + one DN_* mapping.
