Skill: daksh-ui
Spec section: openspec/specs/frontend-architecture/spec.md → "## Requirement: Design system — liquid glass", "## Requirement: Route structure (App Router)", "## Requirement: Responsive behavior", "## Requirement: Mobile version (installable PWA)", "## Requirement: Internationalisation" (+ security-deployment: "HTTP security headers", "Content-Security-Policy" bullet under Non-functional clarifications, for the middleware/CSP only)
Context: Changes 01–06 built and tested the whole database (posting engine + read views). Nothing in the repo is an app yet. This change creates the Next.js project and the *chrome only*: design tokens, glass primitives, topbar / side rail / bottom tab bar, theme and language toggles, PWA, security headers, session middleware, and the Supabase clients. Every screen is an empty placeholder that later changes (08+) fill. It writes no business logic and reads no ledger data; it must not let anyone see the shell without a session in production.
Do not: read other specs; write business math or SQL in TS; build login (08), masters (09), or any real screen content; touch `supabase/migrations/`; push to hosted; commit (Ratna commits).

## Scope

**In**
1. Next.js (App Router, TypeScript strict) + Tailwind v4 (`@theme` mapping the prototype tokens) + `next-intl` at repo root (`package.json`, `src/`). No UI kit library.
2. `src/app/globals.css`: tokens from the spec table, both themes (`:root`, guarded `prefers-color-scheme: dark`, `[data-theme="dark"]`), `.glass` recipe, ambient ground, reduced-transparency and reduced-motion rules, tabular-nums helper, focus ring. No hex in components.
3. `src/components/ui/`: `GlassPanel`, `Card`, `Chip` — only those the shell/placeholder pages need now (`StatTile`, `Segmented`, `Toast` arrive with the first screen that uses them). Others arrive with the screen that first needs them (do not fork variants).
4. Shell (`src/app/(app)/layout.tsx` + components): glass topbar (FY chip, GSTIN, brand mark + name, role pill, language toggle, theme toggle, avatar), glass side rail (desktop) with the nav from the route structure, glass bottom tab bar ≤ 800 px (Home, Sales, Parties, Stock, Money) with safe-area padding, avatar menu reaching Purchases / Staff / Reports / Settings on mobile. Client components only for nav active state and the two toggles.
5. Route placeholders for every top-level route in the spec (dashboard, sales, purchases, payments, parties, stock, staff, reports, settings) — each a titled empty state from message keys — plus `(auth)/login` as a glass-card placeholder ("sign-in arrives with change 08").
6. i18n: `en` complete for shell strings; `te` seeded with the prototype's nav / tile / title strings. Locale in a cookie (no locale in the URL), toggle persists per device. (`app_users.locale` does not exist yet — DB persistence is change 08's `setLocale`.)
7. Theme: tiny inline no-flash script (nonce'd) applying `localStorage` theme before paint; toggle wins both directions.
8. PWA: `manifest.webmanifest` route (name "Daksha Nirmaan Traders", standalone, token theme colours, crane icon 192/512 + maskable), `public/sw.js` caching the shell only (network-first for HTML, cache-first for static assets, offline page with the manual-invoice-book instruction), registration in production only.
9. Security: middleware generates a per-request CSP nonce and sets the header set from the spec (CSP with `script-src 'self' 'nonce-…' 'strict-dynamic'`, frame-ancestors none / X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy), refreshes the Supabase session, and redirects to `/login` when there is no session or no active `app_users` row. `/login` redirects to `/` when signed in.
10. Supabase clients (`src/lib/supabase/{server,client,middleware}.ts`) with the **publishable** key in browser code and cookies via `@supabase/ssr`; `src/lib/supabase/admin.ts` (secret key, `import 'server-only'`, unused until 08). `.env.example` with names only. `src/lib/format.ts` limited to `fyLabel` and `formatDate` (DD-MM-YYYY) — the rest arrives with the first screen that uses it.
11. Tooling: `npm run build`, `lint`, `typecheck` scripts; Vitest with unit tests for `fyLabel`/`formatDate` and the CSP builder; `implementation-notes.md`.

**Out (log in notes)**: real login/OTP/TOTP/users (08); role-based nav hiding beyond showing the role pill (08/09); FY chip from `organization.fy_start_month` beyond the April default; Playwright and CI (16); dashboard content (14); data fetching of any ledger table.

## Conservative defaults (log each in `implementation-notes.md`)

1. **Development access without login.** 08 does not exist, so no one can sign in yet. Middleware honours `DN_AUTH_GATE=off` **only when `NODE_ENV !== 'production'`**; the (app) layout then shows a clearly marked "Dev session" role pill. The production build must ignore the variable (assert in a unit test on the middleware helper). 08 deletes this switch.
2. **GSTIN, legal name, FY chip** come from the `organization` row when a session exists (read through the user-scoped client, RLS applies); with the dev bypass they show placeholders. FY is April–March from today's date in `Asia/Kolkata`.
3. **Icons** are inline SVG copied from the prototype (no icon package). Crane brand mark from the prototype.
4. **Fonts**: system stack only (spec) — no `next/font`, no external font requests (CSP `default-src 'self'` stays tight).
5. **Service worker** never caches anything under `/api` or Supabase URLs, and never caches authenticated HTML for offline reading in this change (dashboard/party/stock read-only caching arrives with those screens).
6. **Next/React/Tailwind versions**: latest stable at implementation time; pin exact versions in `package.json` and record them in the notes.
7. **Env names**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`. No other `NEXT_PUBLIC_*` ever (security spec bundle hygiene).

## Done when

- **"theme fidelity"**: OS dark + toggle light → `data-theme="light"` wins and every token (glass alphas, chart series) switches; verified by a unit test on the CSS (both blocks define the same token set) and by eye in a browser.
- **"reduced transparency"**: `.glass` computes to `--surface-solid`, `backdrop-filter: none`.
- **"language toggle"**: switching to Telugu renders nav and screen titles from `te`, survives reload; numbers/dates untouched.
- 390 px: no horizontal body scroll; tab bar floats above content and `main` has bottom padding so the last element is reachable; topbar shows brand + toggles + avatar only.
- Keyboard: visible 2 px accent focus on every control; toggles operable with Enter/Space; skip-to-content link.
- Security: response headers present on `/login` and `/`; nonce differs per request; production build with `DN_AUTH_GATE=off` still redirects an anonymous request to `/login`; `grep -r "SECURITY\|SECRET" .next/static` finds no secret key; no `NEXT_PUBLIC_` variable other than the two allowed.
- `npm run build`, `npm run lint`, `npx tsc --noEmit`, `npm test` all clean; no hardcoded hex or user-visible literal in components (grep check recorded in notes); `implementation-notes.md` written; not pushed; **not committed**.
