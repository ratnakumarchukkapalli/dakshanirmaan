---
name: daksh-ui
description: Frontend conventions for Daksha Nirmaan. Load for ANY user-facing change however small — screens, components, forms, charts, labels, colors, spacing, formatting, PWA — because tokens/i18n/formatting rules are review-blocking and easy to violate with hardcoded values. Trigger on "screen", "component", "page", "form", "dashboard", "mobile", "PWA", "chart", "UI", "style", "layout", "Tailwind".
---

# Daksha Nirmaan — UI Work

Contract: `openspec/specs/frontend-architecture/spec.md`. Visual contract: `prototype/daksh-nirmaan.html` (v2 liquid glass) — match it, don't reinterpret it. Screens: dashboard, sales (list/new/view/challan), purchases, payments (+allocation, bank recon), parties, stock, staff, reports (day close, TB, ageing, GSTR-1), settings (7 tabs), login.

**Token rule:** your brief names one spec section — read that section only. For visual questions open the prototype file section for that screen, not the whole file. Don't read other specs unless briefed.

## Component rules
- RSC by default. `'use client'` ONLY for: document entry forms, dashboard chart, nav active state, theme toggle.
- Forms: react-hook-form + zodResolver, schemas imported from `src/schemas/` (shared with server actions — never duplicate a schema).
- Writes via server actions returning `ActionResult`; map error codes to friendly Indian-English messages ("June is locked — GSTR-1 already filed").
- Shared components live in `src/components/ui/`: GlassPanel, StatTile(hero), Card, DataTable, Chip, LimitBar, LedgerTable, Segmented, SearchInput, Modal, Toast, MoneyInput, QtyInput(pcs↔kg), EwbPanel, AllocationGrid, UpiQr, AgeingTiles, SiteChips, KeyValue, StepList. Extend these; don't fork per-screen variants.

## Formatting (src/lib/format.ts — use, never inline)
- `inr()` → ₹1,23,456 (en-IN); `inr2()` with paise for tax rows; `amountInWords()` crore/lakh system.
- Dates display `DD-MM-YYYY`, wire ISO. `tabular-nums` on every numeric column. Numeric table columns right-aligned.
- TMT: qty stored kg, display helper shows "≈ N pcs" from item conversion factor.

## Design system — liquid glass (prototype v2; never hardcode hex in components)
- **Glass is chrome, not data.** `.glass` (blur 22px, saturate 180%, `--glass` fill, specular `--glass-edge` inset line, `--glass-edge-b` border) on: topbar, side rail, bottom tab bar, floating totals panel, modals, toasts, segmented controls, login card. Never on tables, ledgers, inputs, chart plot.
- Ambient ground: `--bg` + three fixed blurred glows (`--bg-glow-a` steel, `--bg-glow-b` amber). Part of the contract — glass needs colour behind it.
- Tokens: `--surface` (cards, .86 alpha) / `--surface-solid` (tables/inputs); `--ink/--muted/--faint`; `--accent` `#2A69A8` light / `#5D9BD6` dark + `--accent-soft`; `--brand` `#E8A020` = brand mark + highlights only, never buttons; semantic `--good/--warn/--bad` + `-bg` tints; chart `--c-steel/--c-cement` (CVD-validated; new series = re-run dataviz validator).
- Radii concentric: `--r-outer` 22px cards/panels, `--r-inner` 12px inputs/nested, `--r-chip` pill.
- `prefers-reduced-transparency` → `.glass` becomes `--surface-solid`, no blur. `prefers-reduced-motion` → no enter animations.
- Both themes always: tokens on `:root`, `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]`. Tailwind v4 `@theme` maps tokens.
- Type: system stack incl. "Noto Sans Telugu"; `tabular-nums` on numerics; 11px uppercase letter-spaced labels; hero tile 22px/750.

## Layout
- Desktop: glass side rail. ≤800px: floating glass bottom tab bar (Home, Sales, Parties, Stock, Money; safe-area padding). Tables scroll inside cards (`overflow-x:auto`); body never scrolls sideways. Billing line items stack as cards <600px.
- Mobile-first surface order: Dashboard glance → Billing → Party balance lookup → Stock check. Reports/settings desktop-optimized.
- PWA: manifest (standalone, crane icon, token theme colors) + SW caching shell + last dashboard read-only. No offline writes.

## i18n
All user-facing strings through next-intl message keys (`en` complete, `te` grown per screen; topbar toggle) — no hardcoded literals in JSX.

## Accessibility
Visible focus states; ledger rows Enter-activatable; chips carry text not just color; charts get a table-view counterpart on report pages.

## Done means
Screen matches prototype visually in both themes, works at 390px width, `npm run build` clean, no hardcoded hex/strings, numeric columns tabular.
