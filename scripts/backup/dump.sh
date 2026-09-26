#!/usr/bin/env bash
# Daily backup: dump the business data, prove the dump is readable, encrypt it with age.
#
#   DATABASE_URL=postgresql://postgres:<password>@<host>:5432/postgres \
#   AGE_RECIPIENT=age1...   \
#     scripts/backup/dump.sh [output-dir]
#
# Writes <output-dir>/dn-backup-<UTC timestamp>.tar.age and prints its path. Inside the archive:
#   data.dump      pg_dump custom format, data only: every table in `public` plus the sign-in accounts
#                  (auth.users, auth.identities). Restoring it needs a database already built from
#                  the migrations, which is exactly what `scripts/backup/restore-drill.sh` does.
#   manifest.json  migration version, row count of every table, total debits and credits, when.
# The private key is never needed here: only the public recipient. Whoever holds the private key
# can read the books, so it lives with the family (see RUNBOOK.md), not in this repository.
#
# Optional guards:
#   EXPECTED_AGE_RECIPIENT_SHA256   sha256 (hex) of the correct age1... public key. When set, a different
#                                   recipient (a typo, or a stranger's key) stops the backup before anything
#                                   is encrypted. See RUNBOOK 2.1. The monthly decrypt check stays the real proof.
#   ALLOW_EMPTY_BACKUP=1            let a database with no journal entries be backed up (first run, dev only).
#                                   Without it an empty-books dump FAILS, so an empty backup can never look fine.
#
# PGDUMP / PGRESTORE / PSQL may be set to another command (the local rehearsal runs them inside the
# Supabase container: PGDUMP="docker exec -i supabase_db_Daksh_Nirmaan pg_dump").
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL (the database to dump)}"
: "${AGE_RECIPIENT:?set AGE_RECIPIENT (the family age public key, starts with age1)}"
PGDUMP="${PGDUMP:-pg_dump}"
PGRESTORE="${PGRESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"
OUT_DIR="${1:-${OUT_DIR:-backups}}"

case "$AGE_RECIPIENT" in
  age1*) ;;
  *) echo "dump: AGE_RECIPIENT must be the PUBLIC key (starts with age1). The value is not printed." >&2; exit 2 ;;
esac
AGE_RECIPIENT="$(printf '%s' "$AGE_RECIPIENT" | tr -d '[:space:]')"
if [ -n "${EXPECTED_AGE_RECIPIENT_SHA256:-}" ]; then
  if command -v sha256sum >/dev/null; then got="$(printf '%s' "$AGE_RECIPIENT" | sha256sum | cut -d' ' -f1)"
  else got="$(printf '%s' "$AGE_RECIPIENT" | shasum -a 256 | cut -d' ' -f1)"; fi
  want_fp="$(printf '%s' "$EXPECTED_AGE_RECIPIENT_SHA256" | tr -d '[:space:]' | tr 'A-F' 'a-f')"
  if [ "$got" != "$want_fp" ]; then
    echo "::error title=Wrong backup key::AGE_PUBLIC_KEY is not the key whose sha256 is EXPECTED_AGE_RECIPIENT_SHA256; nothing was encrypted. Neither value is printed." >&2
    exit 1
  fi
fi
command -v age >/dev/null || { echo "dump: age is not installed (brew install age / apt-get install age)" >&2; exit 2; }
mkdir -p "$OUT_DIR"
work="$(mktemp -d)"
final=""
trap 'rm -rf "$work"; [ -z "$final" ] || rm -f "$final.part"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$OUT_DIR/dn-backup-$stamp.tar.age"

manifest() {
  # shellcheck disable=SC2086  # PSQL may be a multi-word command on purpose
  $PSQL "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 -c "
    select jsonb_pretty(jsonb_build_object(
      'made_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
      'migration_version', (select max(version) from supabase_migrations.schema_migrations),
      'debit_total', (select coalesce(sum(debit), 0) from journal_lines),
      'credit_total', (select coalesce(sum(credit), 0) from journal_lines),
      'counts', (select jsonb_object_agg(table_name,
          (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint)
        from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'),
      'auth_users', (select count(*) from auth.users)
    ))"
}

# The manifest and the dump are two reads. If a posting lands between them the drill would call a healthy
# backup broken, so read the manifest again afterwards and retry (up to 3 times) until nothing moved.
attempt=0
while :; do
  attempt=$((attempt + 1))
  echo "dump: reading the database (attempt $attempt)…" >&2
  manifest > "$work/manifest.json"
  # shellcheck disable=SC2086
  $PGDUMP --dbname "$DATABASE_URL" --format=custom --data-only --no-owner --no-privileges \
    -t 'public.*' -t auth.users -t auth.identities > "$work/data.dump"
  manifest > "$work/manifest.after.json"
  if [ "$(grep -v made_at "$work/manifest.json")" = "$(grep -v made_at "$work/manifest.after.json")" ]; then break; fi
  if [ "$attempt" -ge 3 ]; then
    echo "dump: FAILED — the database kept changing while it was being dumped (3 attempts); run it again when it is quiet" >&2
    exit 1
  fi
done

# The dump must be readable and non-trivial before it is trusted.
# shellcheck disable=SC2086
entries="$($PGRESTORE --list < "$work/data.dump" | grep -c 'TABLE DATA' || true)"
size="$(wc -c < "$work/data.dump" | tr -d ' ')"
if [ "$entries" -lt 20 ]; then
  echo "dump: FAILED — the dump lists only $entries tables of data (expected 20+); refusing to keep it" >&2
  exit 1
fi
echo "dump: $entries tables, $size bytes, migration $(grep migration_version "$work/manifest.json" | tr -dc '0-9')" >&2

if [ "$(grep -c '"journal_entries": 0' "$work/manifest.json" || true)" -gt 0 ]; then
  if [ "${ALLOW_EMPTY_BACKUP:-}" = "1" ]; then
    echo "dump: WARNING — the database has no journal entries; this backup holds no books (ALLOW_EMPTY_BACKUP=1)" >&2
  else
    echo "::error title=Backup holds no books::the database has no journal entries, so this dump would contain no books. Refusing to keep it (it could push good backups out). If this is a brand-new or dev database, set ALLOW_EMPTY_BACKUP=1." >&2
    exit 1
  fi
fi

tar -C "$work" -cf "$work/backup.tar" data.dump manifest.json
# Write under a temporary name and rename, so a half-written file is never mistaken for a backup.
age -r "$AGE_RECIPIENT" -o "$final.part" "$work/backup.tar"
mv "$final.part" "$final"
echo "dump: encrypted -> $final ($(wc -c < "$final" | tr -d ' ') bytes)" >&2
echo "$final"
