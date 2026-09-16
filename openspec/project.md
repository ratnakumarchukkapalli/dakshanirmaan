# Project Context — Daksha Nirmaan Traders

**Purpose (owner, 2026-09-16):** the family runs the business *and* keeps its own books. There is no external accountant or CA. The app exists so the family can record, validate, and file (GST) themselves, with the double-entry engine as the safety net. Every report is a self-check tool for owners, not a hand-off to a professional.

In-house accounting + inventory app for a family business trading cement, TMT steel, and construction materials (Andhra Pradesh, GST state 37). Proper double-entry bookkeeping, perpetual inventory, party credit ledgers, staff salary/advance ledgers, GST-compliant invoicing with e-way bill fields.

## Stack

- **Next.js (App Router, latest stable)** deployed on Vercel — no separate backend server
- **Supabase**: Postgres (all business logic in plpgsql posting functions), Auth (email OTP), no Storage dependency initially
- **TypeScript strict**, Tailwind CSS, zod for validation
- PDFs: `@react-pdf/renderer`, server-side

## Specs

| Spec | Covers |
|---|---|
| `specs/db-architecture` | Schema, constraints, triggers, posting functions, views, RLS |
| `specs/api-architecture` | Server actions, RPC contracts, validation, auth/roles, exports |
| `specs/frontend-architecture` | Routes, screens, component/formatting conventions, theming |
| `specs/security-deployment` | Auth hardening, headers, backups/DR, continuity, dakshanirmaantraders.in |
| `specs/feature-roadmap` | Zoho-parity matrix, trade-specific edge features, gaps, unknowns register |

`docs/DESIGN.md` is the narrative design (entities, posting rules, GST reasoning, prior art). Specs are the buildable contract; DESIGN.md explains *why*.

## Conventions (binding for all implementation work)

- Money `NUMERIC(14,2)`, quantity `NUMERIC(12,3)`, unit rates `NUMERIC(14,4)`. **Never floats.**
- All SQL parameterized. Migrations via `supabase` CLI, committed to repo, never edited after apply.
- Posted journal entries and stock movements are **immutable** — corrections are reversal entries, never UPDATE/DELETE.
- The app **never writes journal_lines or stock_movements directly** — only via `post_*` Postgres functions.
- Tax rates, HSN, item names, addresses are **snapshotted onto document lines** at posting time.
- Display formatting: `en-IN` locale everywhere (₹1,23,456), dates `DD-MM-YYYY`, FY = April–March.
- Naming: snake_case in SQL, camelCase in TS, kebab-case files.
- Banned: `xlsx` package (use `exceljs`), string-concatenated SQL, committing `.env`.

## Build process — finding unknowns first

We follow Thariq Shihipar's "A Field Guide to Fable: Finding Your Unknowns" (x.com/trq212, Jul 2026). The bottleneck is unclarified unknowns, so every capability goes through:

1. **Blind-spot pass** before touching a capability: Claude lists what the prompt/specs *don't* cover and what could surprise us
2. **Prototype brainstorm** for anything visual (the clickable prototype is the standing example)
3. **Structured interview**: Claude asks Ratna/the owners targeted questions, architecture-changing ones first
4. **References**: ERPNext source is the standing reference for accounting/stock behavior
5. **Implementation plan** per capability (an openspec change proposal) before code
6. During implementation: a temporary `implementation-notes.md` logs decisions; on surprises, take the conservative option and log the deviation
7. After implementation: a **pitch/explainer doc** for Ratna + a **quiz pass** (Claude generates a report + quiz on the change; merge only on a clean pass)

## Model workflow

- **Fable/Opus**: architecture, specs, prototype, code review.
- **Sonnet**: implements capabilities from these specs (each spec section is self-contained enough to implement without re-deriving design decisions).
- **Haiku**: read-only exploration and lookups.

## Current status (2026-09-16)

Prototype v2 (liquid glass, all Phase 1–2 screens) and the full architecture set are complete: specs extended for challans, transfers, cheque lifecycle, bank recon, day close, attachments, rebates, interest, i18n; `docs/ARCHITECTURE.md` (runtime map); `openspec/changes/README.md` (ordered build plan with model + skill + spec-section briefs). Infra decided: Vercel Pro + Supabase Pro (Mumbai), staging on Free. Requirements v1 still pends the owner interview (`docs/DESIGN.md` §9, `feature-roadmap` unknowns). **Implementation started 2026-09-16.** Work `openspec/changes/README.md` in order; current change: 01 `foundation-schema`.
