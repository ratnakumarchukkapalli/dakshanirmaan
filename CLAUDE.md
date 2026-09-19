# Daksha Nirmaan Traders — Project Context

Business legal/brand name: **Daksha Nirmaan Traders**. Domain: **dakshanirmaantraders.in**.

Double-entry accounting + inventory app for the family cement/TMT trading business. Exists to replace Tally. Stack: Next.js (App Router) on Vercel + Supabase Postgres (Mumbai), no separate backend.

**Read before working:** `openspec/project.md` (conventions + build process). Capability contracts in `openspec/specs/*/spec.md`. Narrative design in `docs/DESIGN.md`; runtime map in `docs/ARCHITECTURE.md`. Visual contract: `prototype/daksh-nirmaan.html` (v2 liquid glass, artifact https://claude.ai/artifact/5GkgGRqXccYVPJeXdC4odp). Build order + per-change briefs: `openspec/changes/README.md`.

## Status gate

**Implementation started 2026-09-16.** Follow `openspec/changes/README.md` in order (current: 01 `foundation-schema`). Owner-interview unknowns still open — take the conservative default and log it in the change's `implementation-notes.md`.

## Delegation

The higher your tier, the more you delegate. Push the work down, keep your own context for judgment. Brief every child: the context, the why, what done looks like. It starts blank and inherits nothing.

| Model | Best for | Delegate? | Effort |
|---|---|---|---|
| Haiku | bulk mechanical (renames, boilerplate from a pattern, lookups) | never | low |
| Sonnet | scoped research, implementing one capability from a spec + skill | when it helps | medium |
| Opus 4.8 | multi-step reasoning across capabilities | on clear benefit | xhigh |
| Fable 5 | judgment, taste, architecture, review | by default | medium |

Fable goes xhigh only for the hardest calls (posting-engine correctness, security review). Skip high. Work above your tier? Return it, don't burn tokens on it.

**Briefing rule for children:** name the skill to load (`daksh-schema`, `daksh-posting`, `daksh-ui`), the one spec section that governs the task, and the acceptance scenario that must pass. Never send a child to "read all specs".

## Skills

| Skill | Load when |
|---|---|
| `daksh-schema` | migrations, tables, RLS, indexes, seeds |
| `daksh-posting` | posting functions, document types, journal/stock logic (has post-function skeleton in references/) |
| `daksh-api` | server actions, zod, RPC wiring, error envelope, exports |
| `daksh-ui` | screens, components, formatting, PWA |

Skills carry a token rule: children read only the spec section named in their brief — the skill + one section is the whole context budget.

## Hard rules (violations = reject in review)

- Money `NUMERIC(14,2)`, qty `NUMERIC(12,3)`, rates `NUMERIC(14,4)`. Never float. Never `parseFloat` for stored values.
- Posted journal entries / stock movements immutable; corrections are reversals.
- App never writes `journal_lines`/`stock_movements` directly — `post_*` functions only.
- Tax/HSN/names snapshotted on document lines; historical docs never join masters.
- en-IN formatting, `DD-MM-YYYY`, FY April–March.
- Parameterized SQL only; no `xlsx` (use `exceljs`); no `.env` commits; service key never client-side.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
