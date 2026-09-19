# Frontend Architecture Specification

## Purpose

Define routes, screens, and UI conventions. The clickable prototype (`prototype/daksh-nirmaan.html`, v2 "liquid glass", published artifact) is the **visual contract** — screens, layout, palette, glass treatment, and interactions come from it; this spec maps them to Next.js structure. v1 (flat) is archived at `prototype/archive/` for history only.

## Requirement: Route structure (App Router)

```
app/
├── (auth)/login/                 email OTP via Supabase Auth; admin adds TOTP step
├── (app)/                        layout: glass topbar (FY chip, GSTIN, brand, role pill,
│   │                             language toggle, theme toggle, avatar) + glass side rail
│   │                             (desktop) / glass bottom tab bar (≤800px)
│   ├── page.tsx                  Dashboard: quick actions, stat tiles (hero = today's sales),
│   │                             7-day cement-vs-steel chart, attention list
│   ├── sales/                    list (segmented: all/invoices/challans/credit notes/drafts, search)
│   │   ├── new/                  invoice form (party, site, against-challan, lines w/ pcs↔kg, EWB panel,
│   │   │                         floating glass totals with UPI QR note, post/draft, PDF/WhatsApp/print)
│   │   ├── [id]/                 draft edit (same form)
│   │   ├── [id]/view/            posted view: header, lines, journal entry, cancel (reversal), credit note
│   │   ├── challans/new/         delivery challan form + open-challans panel
│   │   └── credit-notes/new/
│   ├── purchases/                list w/ tiles (payable, ITC, RCM payable, rebate accrued) → new/, [id]/
│   │                             bill form: supplier ref, lines w/ ITC flag, RCM freight block, bill photo
│   ├── payments/                 list w/ tiles (received today, PDC in hand, cheques issued, on account)
│   │   ├── new/                  receipt/payment form with **allocation grid** (auto-allocate oldest first),
│   │   │                         cheque fields (PDC lifecycle), on-account remainder
│   │   └── reconcile/            bank statement CSV import → match / create voucher
│   ├── parties/                  list (segmented + search) → [id] ledger (site chips, ageing tiles,
│   │                             statement PDF/Excel, WhatsApp reminder), new (modal)
│   ├── stock/                    summary (godown segmented) → [id] movement ledger;
│   │                             modals: new item, adjustment, godown transfer
│   ├── staff/                    list + tiles → [id] ledger; modals: advance, salary, daily wages
│   ├── reports/                  card grid → day-close, day-book, aging, stock, cash-bank,
│   │                             trial-balance, pnl, balance-sheet, gstr1, gstr3b, rebates, site-sales
│   └── settings/                 tabs: organisation (incl. invoice print, UPI VPA, e-invoice flag,
│                                 negative-stock override), users & roles (invite), items, chart of
│                                 accounts, period locks, backups & data (exports, continuity steps),
│                                 audit trail
```

## Requirement: Server/client component split

- Default is RSC. Client components (`'use client'`) only for: document entry forms (invoice, challan, purchase, payment+allocation, voucher modals), the dashboard chart, nav active-state, segmented filters/search, theme + language toggles, day-close counted-cash input.
- Entry forms: **react-hook-form + zodResolver** with the shared schemas from `src/schemas/`; submit via server actions with `useTransition`; server errors render inline via the `ActionResult` envelope (`period_locked`, `credit_limit`, `negative_stock` get specific friendly messages).
- The billing form recomputes taxable/CGST/SGST/round-off/total and amount-in-words live on every keystroke (as in the prototype) — display-only; DB is authoritative on post. TMT lines accept **pieces or kg**; the other field converts from the item's `conversion_factor`; kg is what is submitted.
- The payment form's allocation grid caps each allocation at the invoice's open amount, shows unallocated remainder as on-account, and offers "auto-allocate oldest first" — display logic only; `post_payment` re-validates Σ allocations ≤ amount + coalesce(discount, 0). Below 600px the grid drops the Due column and shows the due amount inline under the document reference.
- Lists/reports are RSCs with URL-state filters (`?period=`, `?party=`, `?type=`, `?q=`) — no client data stores.
- Post/cancel/close actions show a toast on success (glass toast, bottom-center, above the tab bar) and navigate to the posted view.

## Requirement: Design system — "liquid glass" (from prototype v2)

**Principle:** glass is for *chrome*, not for *data*. Navigation, toolbars, floating panels, modals, toasts, segmented controls are translucent, blurred, and edge-lit; content cards are near-opaque; tables/ledgers sit on solid surfaces so numbers stay legible.

Tokens as CSS custom properties with the prototype's names/values:

| Group | Light | Dark |
|---|---|---|
| Ground `--bg` + ambient glows `--bg-glow-a/b` | `#E9EDF2`, steel-blue 16% / amber 13% | `#0E1116`, steel 20% / amber 10% |
| `--surface` (cards) / `--surface-solid` (tables, inputs) | `rgba(255,255,255,.86)` / `#FFFFFF` | `rgba(29,33,40,.88)` / `#1D2128` |
| `--glass` / `--glass-strong` | `rgba(255,255,255,.58)` / `.74` | `rgba(24,28,36,.55)` / `.72` |
| `--glass-edge` (specular top line) / `--glass-edge-b` (border) | `rgba(255,255,255,.85)` / `rgba(20,28,40,.10)` | `rgba(255,255,255,.14)` / `rgba(0,0,0,.35)` |
| `--ink` / `--muted` / `--faint` | `#1B2028` / `#5A6472` / `#8B94A1` | `#E7EAEF` / `#98A1AD` / `#6C7683` |
| `--accent` / `--accent-ink` / `--accent-soft` | `#2A69A8` / `#FFF` / 12% | `#5D9BD6` / `#0E1A26` / 16% |
| `--brand` (mark + highlights only, never buttons) | `#E8A020` | same |
| `--good` / `--warn` / `--bad` (+ `-bg` 11–16% tints) | `#1F7A45` / `#92650A` / `#B23830` | `#5BBF85` / `#D9A93F` / `#E08078` |
| Chart `--c-steel` / `--c-cement` (CVD-validated) | `#2A69A8` / `#B36F12` | `#3E7FC4` / `#C08023` |
| Radii `--r-outer` / `--r-inner` / `--r-chip` | 22px / 12px / 999px (concentric: inner = outer − padding) | same |

- **Glass recipe** (`.glass`): `background: var(--glass); backdrop-filter: blur(22px) saturate(180%); border: 1px solid var(--glass-edge-b); box-shadow: inset 0 1px 0 var(--glass-edge), var(--shadow)`. `prefers-reduced-transparency` → solid surface, no blur. The ambient ground (three blurred radial glows, fixed, pointer-events none) exists so the glass has colour to refract; it is part of the contract.
- **Applied to:** topbar (sticky, floating with 12px inset, 18px radius), side rail (sticky, 22px radius, active item = accent with inner highlight), bottom tab bar (fixed, floating, safe-area padded), floating totals panel on billing/purchase/payment forms (sticky at top 76px on desktop), modals, toasts, segmented controls, login card.
- **Not applied to:** tables, ledgers, inputs, chart plot area.
- Theme: tokens on `:root` (light), `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])`, and `:root[data-theme="dark"]` — toggle wins both directions; persisted per device in `localStorage`. Tailwind v4 `@theme` maps these tokens; components never hardcode hex.
- Type: system stack (`"Avenir Next", -apple-system, "SF Pro Text", "Segoe UI", Roboto, "Noto Sans", "Noto Sans Telugu", sans-serif`); `tabular-nums` on every numeric column; uppercase 11px letter-spaced labels for tiles/table headers/field labels; hero tile 22px/750.
- Motion: screen enter 180ms rise; toggles 150ms; all disabled under `prefers-reduced-motion`.

## Requirement: Shared components

`src/components/ui/`: `GlassPanel`, `StatTile` (variant `hero`), `Card`, `DataTable` (right-aligned numeric columns, `rowlink` rows Enter-activatable), `Chip` (good/warn/bad/muted/accent), `LimitBar`, `LedgerTable` (date/doc/details/debit/credit/running-balance — party, staff, stock ledgers), `Segmented`, `SearchInput`, `Modal` (glass), `Toast`, `MoneyInput` (en-IN grouping, decimal string semantics), `QtyInput` (dual pcs/kg for TMT), `EwbPanel` (auto-appears when invoice total > ₹50,000), `AllocationGrid`, `UpiQr` (static QR of org VPA + amount), `AgeingTiles`, `SiteChips`, `KeyValue`, `StepList`.

## Requirement: Formatting utilities (`src/lib/format.ts`)

- `inr(value)` → `₹1,23,456` (en-IN, no decimals for display ≥ ₹1); `inr2` with paise for tax rows
- `amountInWords(value)` → "Rupees One Lakh Twenty-Three Thousand ... Only" (crore/lakh system — port the prototype implementation)
- `formatQty(qty, uom)`, TMT helpers: `pcsToKg(factor, pcs)`, `kgToPcs(factor, kg)` from item conversion factors (3-decimal kg)
- Dates: display `DD-MM-YYYY`, wire ISO; FY helpers `fyLabel(date)` → `'26-27'`

## Requirement: Internationalisation

- `next-intl` (or equivalent) from the first component: every user-facing string via message keys; `en` complete, `te` (Telugu) file seeded with nav, dashboard, tile labels, and screen titles (as in the prototype) and grown per screen. Toggle in the topbar, persisted per user (`app_users.locale`) and per device.
- Numbers/dates stay en-IN formatting in both locales; document PDFs stay English (GST portal language) with optional Telugu item names.

## Requirement: Responsive behavior

Owners will use phones. Numeric, document-reference, and right-aligned cells never wrap (`white-space: nowrap`); a ledger wider than the card scrolls inside it. Desktop: side rail. ≤800px: topbar shows brand + language/theme/avatar only (FY and GSTIN chips hidden); floating glass bottom tab bar with five tabs — Home, Sales, Parties, Stock, Money (Payments); Purchases/Staff/Reports/Settings reachable via the avatar menu. Stat tiles wrap, tables scroll horizontally inside cards (`overflow-x:auto`), body never scrolls sideways. Billing on a phone: line items collapse to stacked cards below 600px, the totals panel drops below the lines, Post stays reachable above the tab bar.

## Requirement: Mobile version (installable PWA, not a native app)

- Installable **PWA**: web manifest (name "Daksha Nirmaan Traders", crane icon, `display: standalone`, theme colours from tokens) + service worker. No React Native in v1.
- **Mobile-first surface order:** 1. Dashboard glance (today, to collect w/ overdue, cash+bank, low stock) 2. Billing 3. Party balance lookup (two taps, ledger drill-down) 4. Stock check 5. Receive payment.
- **Connectivity**: v1 requires being online for writes. The service worker caches the shell and the last-loaded dashboard/party balances/stock summary for read-only glances; the offline page shows the manual-invoice-book instruction. Offline drafts are out of scope for v1.

## Requirement: Accessibility

Visible focus states on all interactive elements (2px accent outline); ledger rows and report cards keyboard-activatable (Enter); modals trap focus and close on Escape; charts accompanied by table data on report pages; colour never the sole carrier of state (chips carry text; ageing shows numbers); glass surfaces maintain ≥ 4.5:1 text contrast in both themes (verify with the ambient ground behind them).

#### Scenario: phone billing
- WHEN a user opens Sales → New on a 390px viewport
- THEN party select, line entry (pcs and kg for TMT), live totals, and Post are all reachable without horizontal body scroll, and the floating tab bar does not cover the Post button

#### Scenario: theme fidelity
- WHEN the OS is dark but the in-app toggle is set light
- THEN `data-theme="light"` wins over the media query and all tokens (including glass alphas and chart series) switch consistently

#### Scenario: reduced transparency
- WHEN the OS requests reduced transparency
- THEN every `.glass` surface renders solid (`--surface-solid`) with no blur and the layout is otherwise unchanged

#### Scenario: language toggle
- WHEN the user switches to Telugu
- THEN navigation, dashboard tiles, and screen titles render from the `te` message file, numbers stay en-IN, and the choice survives reload
