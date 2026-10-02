#!/usr/bin/env bash
# OPT-IN backup of the private `docs` storage bucket (bill and expense photos) next to the database dump.
# The database dump (dump.sh) holds only the rows that point at the files; this copies the files themselves.
#
#   SUPABASE_ACCESS_TOKEN=sbp_...  SUPABASE_PROJECT_REF=<20-letter project ref> \
#   AGE_RECIPIENT=age1...   \
#     scripts/backup/storage-copy.sh [output-dir]
#
# Writes <output-dir>/dn-storage-<UTC timestamp>.tar.age (same stamp style and same age public key as
# dn-backup-*.tar.age, so the two files of a day sit side by side) and prints its path. Inside the archive:
#   docs/           every object of the bucket, same paths
#   manifest.json   when, how many files, total bytes, and the sha256 of every file
# Decrypt it like a database backup: age -d -i ~/family-age-key.txt dn-storage-<date>.tar.age | tar -x
# Nothing secret is printed: the access token only goes to the Supabase CLI through its environment, the CLI
# is run without --debug, and its output is kept in a temporary file that is deleted on exit.
#
# Switched on in GitHub Actions by the repository VARIABLE BACKUP_STORAGE=1 (default off, because the bucket
# is empty today); it also needs the secrets SUPABASE_ACCESS_TOKEN and the variable/secret SUPABASE_PROJECT_REF.
# See RUNBOOK 2.5.
#
# Optional:
#   ALLOW_EMPTY_BACKUP=1   let an empty bucket be "backed up" (nothing uploaded yet). Without it an empty bucket
#                          FAILS, the same way dump.sh refuses an empty set of books, so an empty copy can
#                          never look like a good one. Delete it when the first bill photo is in (RUNBOOK 2.1).
#   EXPECTED_AGE_RECIPIENT_SHA256   same guard as dump.sh (a wrong key stops the run before anything is encrypted).
#   STORAGE_BUCKET         bucket name (default docs)
#   STORAGE_LOCAL=1        read the LOCAL Supabase stack instead of the hosted project (rehearsal)
#   SUPABASE               another command for the Supabase CLI (default: supabase)
#
# Uses `supabase storage ls|cp` (Supabase CLI 2.117 here; the storage commands need a recent CLI).
set -euo pipefail

: "${AGE_RECIPIENT:?set AGE_RECIPIENT (the family age public key, starts with age1)}"
SUPABASE="${SUPABASE:-supabase}"
BUCKET="${STORAGE_BUCKET:-docs}"
OUT_DIR="${1:-${OUT_DIR:-backups}}"

case "$AGE_RECIPIENT" in
  age1*) ;;
  *) echo "storage-copy: AGE_RECIPIENT must be the PUBLIC key (starts with age1). The value is not printed." >&2; exit 2 ;;
esac
AGE_RECIPIENT="$(printf '%s' "$AGE_RECIPIENT" | tr -d '[:space:]')"
case "$BUCKET" in
  ''|*[!A-Za-z0-9_-]*) echo "storage-copy: STORAGE_BUCKET may only contain letters, digits, - and _" >&2; exit 2 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ -n "${EXPECTED_AGE_RECIPIENT_SHA256:-}" ]; then
  got="$(printf '%s' "$AGE_RECIPIENT" | { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1)"
  want_fp="$(printf '%s' "$EXPECTED_AGE_RECIPIENT_SHA256" | tr -d '[:space:]' | tr 'A-F' 'a-f')"
  if [ "$got" != "$want_fp" ]; then
    echo "::error title=Wrong backup key::AGE_PUBLIC_KEY is not the key whose sha256 is EXPECTED_AGE_RECIPIENT_SHA256; nothing was encrypted. Neither value is printed." >&2
    exit 1
  fi
fi
command -v age >/dev/null || { echo "storage-copy: age is not installed (brew install age / apt-get install age)" >&2; exit 2; }

if [ "${STORAGE_LOCAL:-}" = "1" ]; then
  target=(--local)
else
  : "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN (a Supabase personal access token; never printed)}"
  : "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF (the project ref, e.g. the 20 letters in the dashboard URL)}"
  case "$SUPABASE_PROJECT_REF" in
    *[!a-z0-9]*) echo "storage-copy: SUPABASE_PROJECT_REF must be lowercase letters and digits" >&2; exit 2 ;;
  esac
  export SUPABASE_ACCESS_TOKEN
  target=(--project-ref "$SUPABASE_PROJECT_REF")
fi

mkdir -p "$OUT_DIR"
work="$(mktemp -d)"
final=""
trap 'rm -rf "$work"; [ -z "$final" ] || rm -f "$final.part"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$OUT_DIR/dn-storage-$stamp.tar.age"

# The CLI's own output can carry URLs and request details, so it goes to a file and is shown only as a
# generic failure message.
echo "storage-copy: listing bucket '$BUCKET'…" >&2
if ! "$SUPABASE" storage ls -r "ss:///$BUCKET" "${target[@]}" >"$work/ls.out" 2>"$work/ls.err"; then
  echo "storage-copy: FAILED — the Supabase CLI could not list the bucket (check SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and that the CLI is recent enough for 'storage ls'). Its output is not printed because it may contain secrets." >&2
  exit 1
fi

mkdir -p "$work/tree/docs"
if [ -s "$work/ls.out" ]; then
  echo "storage-copy: downloading…" >&2
  if ! "$SUPABASE" storage cp -r "ss:///$BUCKET" "$work/tree/docs" "${target[@]}" >"$work/cp.out" 2>"$work/cp.err"; then
    echo "storage-copy: FAILED — the Supabase CLI could not download the bucket. Its output is not printed because it may contain secrets." >&2
    exit 1
  fi
fi

files="$(find "$work/tree/docs" -type f | wc -l | tr -d ' ')"
if [ "$files" -eq 0 ]; then
  if [ "${ALLOW_EMPTY_BACKUP:-}" = "1" ]; then
    echo "storage-copy: WARNING — bucket '$BUCKET' holds no files; this copy is empty (ALLOW_EMPTY_BACKUP=1)" >&2
  else
    echo "::error title=Storage backup holds no files::bucket '$BUCKET' is empty, so this copy would hold nothing. Refusing to keep it (it could push good copies out). If nothing has been uploaded yet, set ALLOW_EMPTY_BACKUP=1." >&2
    exit 1
  fi
fi
# manifest.json: file list with sha256, so the copy can be checked after a restore.
{
  printf '{\n  "made_at": "%s",\n  "bucket": "%s",\n  "file_count": %s,\n  "files": [' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BUCKET" "$files"
  first=1
  while IFS= read -r f; do
    rel="${f#"$work/tree/"}"
    [ "$first" -eq 1 ] || printf ','
    first=0
    # File names come from the bucket: keep only characters that need no JSON escaping, so the manifest is always valid.
    safe="$(printf '%s' "$rel" | LC_ALL=C tr -c 'A-Za-z0-9._/ -' '_')"
    printf '\n    {"path": "%s", "bytes": %s, "sha256": "%s"}' "$safe" "$(wc -c < "$f" | tr -d ' ')" "$(sha256_of "$f")"
  done < <(find "$work/tree/docs" -type f | LC_ALL=C sort)
  printf '\n  ]\n}\n'
} > "$work/tree/manifest.json"
echo "storage-copy: $files files from '$BUCKET'" >&2

tar -C "$work/tree" -cf "$work/storage.tar" docs manifest.json
# Write under a temporary name and rename, so a half-written file is never mistaken for a backup.
age -r "$AGE_RECIPIENT" -o "$final.part" "$work/storage.tar"
mv "$final.part" "$final"
echo "storage-copy: encrypted -> $final ($(wc -c < "$final" | tr -d ' ') bytes)" >&2
echo "$final"
