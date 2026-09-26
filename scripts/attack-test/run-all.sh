#!/usr/bin/env bash
# Adversarial permission test, LOCAL Supabase only. Run from the repo root:  bash scripts/attack-test/run-all.sh
# Order matters (docs/STATUS.md): reset -> pgTAP -> owner + demo data -> identities -> attacks.
# Results: scripts/attack-test/out/*.json (git-ignored). Then write docs/reviews/<date>-attack-test.md from them.
set -euo pipefail
cd "$(dirname "$0")/../.."
grep -q '^NEXT_PUBLIC_SUPABASE_URL=http://\(127.0.0.1\|localhost\):54321' .env.local || { echo "REFUSING: .env.local is not the local stack"; exit 1; }
A=scripts/attack-test

supabase db reset
supabase test db | tail -4                       # expect: Files=26, Tests=1829 (update if pgTAP grows), Result: PASS
set -a; . ./.env.local; set +a
ADMIN_PASSWORD='DemoOwner-Local-1' npm run create-admin -- demo-owner@attack.test "Demo Owner"
docker exec -i supabase_db_Daksh_Nirmaan psql -U postgres -v ON_ERROR_STOP=1 < supabase/demo/demo-data.sql | tail -3

for s in setup matrix funcs tamper extras; do echo "=== $s"; node $A/$s.mjs | tail -3; done

# Next.js layer: needs a production build served on 3100 (does not touch tracked files)
npm run build >/dev/null
npx next start -p 3100 -H 127.0.0.1 > $A/out/next.log 2>&1 &
NEXT_PID=$!
trap 'kill $NEXT_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:3100/ && break; sleep 1; done
for s in next svc xpage; do echo "=== $s"; node $A/$s.mjs | tail -8; done

node $A/cleanup.mjs                              # throwaway accounts -> is_active=false (never deleted)
echo "done. Compare the FAIL / non-pass rows in $A/out/ with the previous report."
