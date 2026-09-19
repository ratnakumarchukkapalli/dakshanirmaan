# Change 07 — app-shell: implementation notes

Status: built, all gates green, **not committed, not pushed**. No database change (no migration touched).

## What exists
- Next.js **16.3.5** (Turbopack), React 19.3.0, Tailwind 4.3.3, next-intl 4.14.5, @supabase/ssr 0.12.7, supabase-js 2.116.0, TypeScript **5.9.3** (7.x exists but eslint-config-next / typescript-eslint target 5.x), ESLint 9.39.5, Vitest 5.0.1. All pinned exactly.
- Tokens + glass + ambient ground + reduced-transparency/motion in `src/app/globals.css` (ported from the prototype; dark block written twice on purpose, a unit test keeps the two identical).
- Shell: glass topbar, side rail (desktop), floating tab bar (≤800px), avatar menu (Purchases/Staff/Reports/Settings on phones), theme toggle, language toggle, skip link.
- Placeholder screens for all 9 top-level routes + `/login` placeholder. Nothing reads ledger data.
- PWA: `/api/manifest.webmanifest`, `public/sw.js` (static assets + offline page only), `public/offline.html`, icons (192, 512, maskable) generated from the prototype's crane mark (`public/icons/icon.svg` is the source).
- Security: `src/proxy.ts` (per-request CSP nonce, session refresh, sign-in gate); static headers in `next.config.ts`.
- Clients: `src/lib/supabase/{server,client,proxy,admin}.ts`. `admin.ts` is `server-only` and unused until change 08.

## Deviations from the specs (all deliberate)
1. **`middleware.ts` is `proxy.ts`.** Next.js 16 renamed the convention; same behaviour. The specs still say "middleware".
2. **Avatar menu is solid, not glass.** It sits inside the topbar, which already has `backdrop-filter`; a nested blur cannot see the page behind it, so page text bled through. Solid `--surface-solid` keeps the ≥4.5:1 contrast rule.
3. **Extra tokens** `--brand-hi` / `--brand-lo` (the prototype hard-coded them in the brand-mark gradient).
4. **Manifest and `themeColor` contain hex** (`#E9EDF2`, `#0E1116`): a manifest / meta tag cannot read CSS variables. They mirror `--bg` and are the only hex outside `globals.css` (plus the icon generator).
5. **Locale is a cookie (`dn-locale`), not `app_users.locale`.** That column does not exist; change 08's `setLocale` adds DB persistence.
6. **FY chip shows `FY 26-27`** (spec's `fyLabel` format), not the prototype's `2026–27`.
7. **`StatTile`, `Segmented`, `Toast`** not built yet — nothing in the shell uses them (README lists them under shared components; the first screen that needs each adds it).

## Conservative defaults taken
- **Dev switch `DN_AUTH_GATE=off`** lets the shell render without a login (change 08 does not exist yet). Honoured only when `NODE_ENV !== 'production'`; proven in a unit test and against a real production build (anonymous `/` still 307 → `/login` with the variable set). Shell shows a "Dev session" pill. **Change 08 must delete this switch** (`isAuthGateOff` in `src/lib/access.ts`, its use in `src/proxy.ts`, and the `dev` fallback in `src/lib/shell-context.ts`).
- The gate calls `auth.getUser()` (asks the auth server) plus one `app_users` read on every request, not the cheaper local JWT check. Correctness over speed at ≤10 users; revisit if it shows in latency.
- `/login` for a signed-in user whose `app_users` row is missing/inactive is allowed (shown the login card) rather than looped.
- Service worker never caches pages, `/api`, or Supabase calls.
- CSP `connect-src` is derived from `NEXT_PUBLIC_SUPABASE_URL`, so local (http/ws) and hosted (https/wss) both work; `upgrade-insecure-requests` and the eval exemption differ by environment as specced.

## Verified
- `npm run lint`, `npx tsc --noEmit`, `npm test` (21 tests: token parity, reduced-transparency rule, CSP builder, access decision, date/FY helpers), `npm run build` — all clean.
- Production server: CSP + X-Frame-Options + nosniff + Referrer-Policy + Permissions-Policy present (also on redirects); nonce differs per request and is stamped on the inline theme script; manifest, `sw.js`, offline page, icons reachable without a session.
- Real local session (temporary admin user, since deleted): `/` renders with the Admin pill, `/login` redirects home, Telugu cookie renders `అమ్మకాలు`.
- Client bundle: zero occurrences of the secret key. No `NEXT_PUBLIC_` variable other than the URL and publishable key is read anywhere in `src/`.
- Real Chrome (Playwright, 390 and 1280 px, light + dark): no horizontal scroll at 390; OS dark + toggle light → light wins and survives reload; language choice survives reload; first Tab stop is the skip link with a 2 px ring; screenshots reviewed by eye.

## Not verified (say so, don't assume)
- `prefers-reduced-transparency` was checked only as a CSS rule (unit test), not rendered — Chrome/Playwright cannot emulate it.
- Service worker install/offline page never exercised in a browser (only served); PWA "Add to Home Screen" on a real phone not tried.
- Real-device Telugu rendering (fonts) not checked; screenshots used the Mac's fonts.
- Contrast ratios not measured with a tool; judged by eye.

## Needs owner / native-speaker review
Telugu strings that are **not** from the prototype were written by the model: `tabs.*` (Home = హోమ్, Money = డబ్బు), `topbar.*`, `role.*`, `placeholder.*`, `login.*`, `a11y.skip`, and the Telugu line on `offline.html`. Nav, screen titles and role names from the prototype are unchanged.

## For later changes
- 08: remove `DN_AUTH_GATE`; add sign-out to the avatar menu; `setLocale` + `app_users.locale`; role-based nav (a `user` currently sees Reports/Settings links — the screens are empty placeholders, but hide/deny them when they have content); aal2 for admins.
- The seeded `organization.gstin` is null, so the GSTIN pill is hidden until change 09 (org settings) or 17 (cutover) fills it.
- `next dev` added a "This is NOT the Next.js you know" block to the project `CLAUDE.md` (its own agent-rules feature). Kept as-is; decide whether to commit it.
- Shared UI grows per screen: Segmented (09/13), StatTile (14), Toast (first form, 10), DataTable/LedgerTable (13).
