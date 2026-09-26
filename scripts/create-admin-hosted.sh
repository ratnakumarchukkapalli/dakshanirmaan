#!/usr/bin/env bash
# Creates the FIRST owner on the hosted project (dcmgbkugdyxsjvkirmft). Run it yourself, in a terminal:
#   bash scripts/create-admin-hosted.sh you@example.com "Your Name"
# It reads the hosted secret key from the Supabase CLI (you must be logged in: `supabase login`), keeps it
# in this process only, and asks for the password with a hidden prompt. Nothing secret is printed.
set -euo pipefail
REF=dcmgbkugdyxsjvkirmft
KEY=$(supabase projects api-keys --project-ref "$REF" -o json 2>/dev/null | python3 -c 'import sys,json; raw=sys.stdin.read(); d=json.loads(raw[raw.index("["):]); print(next(k["api_key"] for k in d if k.get("type")=="secret"))')
NEXT_PUBLIC_SUPABASE_URL="https://$REF.supabase.co" SUPABASE_SECRET_KEY="$KEY" node scripts/create-admin.mjs "$@"
