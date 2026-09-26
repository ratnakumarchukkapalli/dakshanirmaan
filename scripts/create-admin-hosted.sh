#!/usr/bin/env bash
# Creates the FIRST owner on the hosted project (dcmgbkugdyxsjvkirmft). Run it yourself, in a terminal:
#   bash scripts/create-admin-hosted.sh you@example.com "Your Name"
# It asks (hidden) for the hosted SECRET key -- copy it from the Supabase dashboard: Project Settings ->
# API Keys -> Secret keys -> reveal/copy (the CLI only shows it masked) -- and then for the new owner's
# password, twice. Nothing secret is printed or stored.
set -euo pipefail
NEXT_PUBLIC_SUPABASE_URL="https://dcmgbkugdyxsjvkirmft.supabase.co" node scripts/create-admin.mjs "$@"
