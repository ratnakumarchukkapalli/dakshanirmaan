# Attack test (local Supabase only)

Adversarial permission test of the database and API, written for the 2026-09 review (`docs/reviews/2026-09-attack-test.md`).
Run it after every security-relevant change: `bash scripts/attack-test/run-all.sh` (about 5 minutes).

- It refuses to run unless `.env.local` points at `127.0.0.1:54321`. **Never point it at the hosted project**: it resets the database and creates users.
- Identities: `admin_aal2` (owner control), `admin_aal1` (password only), `user`, `user_off` (deactivated, live token), `anon`.
- Stages: `matrix` (tables/views x 4 ops), `funcs` (every public function), `tamper` (what the open doors let through), `extras` (known limits, payroll, auth layer),
  `next` (pages, exports, signed link, server actions), `svc` (service-key actions with valid args), `xpage`, `cleanup`.
- Verdicts: PASS, FAIL (deviates from the spec), KNOWN (spec-accepted limit), INFO, INCONCLUSIVE (the refusal was not a permission refusal, so it proves nothing: fix the request).
- Owner (`admin_aal2`) rows are controls: they prove each request is well-formed.
- Do not call the `signOut` server action in `next.mjs`: it revokes the test sessions (already skipped).
- Change 27 (`openspec/changes/27-attack-test-fixes/`) closed F1-F5 and L1. `matrix.mjs`, `tamper.mjs` (B1, B1b, B1c, B3b) and `funcs.mjs`/`extras.mjs` (F4, F5) judge the outcome, not the old behaviour, so a regression shows as a FAIL row. When a future fix changes behaviour on purpose, update the expectation that encodes it.
