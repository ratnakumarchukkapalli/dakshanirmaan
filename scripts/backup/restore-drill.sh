#!/usr/bin/env bash
# Restore drill: prove a backup comes back with balanced books. "An untested backup is not a backup."
#
#   AGE_IDENTITY=/path/to/family-age-key.txt \
#     scripts/backup/restore-drill.sh dn-backup-20260927T020000Z.tar.age --yes
#
# It RESETS THE LOCAL SUPABASE STACK (`supabase db reset`: fresh, migrated, seed data only) and then
# loads the backup into it, so it never touches a hosted database. --yes confirms the reset.
# (Foreign keys are off during the load, so the checks include orphan lines and users without an account.)
# Checks: the archive is for the same migration version as this checkout, every table's row count
# matches the manifest, total debits equal total credits, and the trial balance nets to zero.
# The backup must be restored with the repository checked out at the commit whose newest migration equals
# the manifest's migration_version (RUNBOOK 2.3 gives the commands), because the tables have to match.
# Keep the key file outside the repository folder.
#
# PGRESTORE / PSQL may be set to another command; LOCAL_DB_URL is the local stack's database.
set -euo pipefail

backup="${1:?usage: restore-drill.sh <backup.tar.age> --yes}"
[ "${2:-}" = "--yes" ] || { echo "drill: this resets the LOCAL Supabase database; pass --yes to continue" >&2; exit 2; }
: "${AGE_IDENTITY:?set AGE_IDENTITY (path to the private age key file)}"
LOCAL_DB_URL="${LOCAL_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PGRESTORE="${PGRESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"

# The host must be this machine, exactly: a substring match would accept a hosted URL that merely
# mentions localhost in a password or query string, and the drill empties every table it connects to.
if ! printf '%s' "$LOCAL_DB_URL" | grep -Eq '^postgres(ql)?://[^@/?#]*@(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/[A-Za-z0-9_]+$'; then
  echo "drill: LOCAL_DB_URL must be postgresql://user:password@127.0.0.1:<port>/<database> with no options (got a URL that is not plainly this machine)" >&2
  exit 2
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
age -d -i "$AGE_IDENTITY" -o "$work/backup.tar" "$backup"
tar -C "$work" -xf "$work/backup.tar" data.dump manifest.json

want="$(sed -n 's/.*"migration_version": *"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p' "$work/manifest.json")"
have="$(ls supabase/migrations | sed 's/_.*//' | sort | tail -1)"
if [ "$want" != "$have" ]; then
  echo "drill: FAIL — the backup is for migration $want but this checkout is at $have. Check out the matching commit first." >&2
  exit 1
fi

echo "drill: resetting the local stack…" >&2
supabase db reset >"$work/reset.log" 2>&1 || { echo "drill: supabase db reset failed:" >&2; tail -15 "$work/reset.log" >&2; exit 1; }

# The migrations leave seed rows (chart of accounts, organisation, sequences); the backup carries the
# real ones, so start from empty tables. Superuser-only, which the local database is.
# shellcheck disable=SC2086
$PSQL "$LOCAL_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "
  set session_replication_role = replica;
  do \$\$ declare t text; begin
    for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop
      execute 'truncate table ' || t || ' restart identity cascade';
    end loop;
    truncate table auth.identities, auth.users cascade;
  end \$\$;"

echo "drill: restoring…" >&2
# Rows are loaded with triggers off (session_replication_role = replica) so foreign keys and the
# immutability/balance triggers do not fight the load order; the checks below prove the result.
# The archive is turned into SQL and fed to psql in one transaction, because the setting has to be
# made inside the session (the local postgres role may set it there but not as a connection option).
# shellcheck disable=SC2086
{ echo "set session_replication_role = replica;"; $PGRESTORE --data-only --no-owner -f - < "$work/data.dump"; } \
  | $PSQL "$LOCAL_DB_URL" -X -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null

# One row per check: name|ok|detail. Row counts come from the manifest; the books are checked on
# their own, not only against the manifest, so a backup of already-broken books still fails loudly.
# shellcheck disable=SC2086
checks="$($PSQL "$LOCAL_DB_URL" -X -At -F '|' -v ON_ERROR_STOP=1 -v manifest="$(cat "$work/manifest.json")" <<'SQL'
with m as (select :'manifest'::jsonb as j),
live as (
  select jsonb_object_agg(table_name,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint) as counts
  from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'),
bad as (
  select string_agg(e.key || ' ' || coalesce((live.counts->>e.key), 'missing') || ' <> ' || (e.value#>>'{}'), ', ') as list, count(*) as n
  from m, live, jsonb_each(m.j->'counts') e where (live.counts->e.key) is distinct from e.value)
select 'the manifest lists the tables', (select jsonb_typeof(j->'counts') = 'object' and (select count(*) from jsonb_object_keys(j->'counts')) >= 20 from m),
       (select count(*)::text from m, jsonb_object_keys(m.j->'counts')) || ' tables in the manifest'
union all
select 'row counts match the manifest', (select n = 0 from bad), coalesce((select list from bad), 'all tables equal')
union all
select 'sign-in accounts match', (select count(*) from auth.users) = (select (j->>'auth_users')::int from m), (select count(*)::text from auth.users) || ' accounts'
union all
select 'debits equal credits', (select coalesce(sum(debit), 0) = coalesce(sum(credit), 0) from journal_lines),
       'debit ' || (select coalesce(sum(debit), 0) from journal_lines) || ' credit ' || (select coalesce(sum(credit), 0) from journal_lines)
union all
select 'every entry balances', (select count(*) = 0 from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x),
       (select count(*)::text from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x) || ' unbalanced entries'
union all
select 'totals equal the manifest',
       (select coalesce(sum(debit), 0) = (j->>'debit_total')::numeric and coalesce(sum(credit), 0) = (j->>'credit_total')::numeric from journal_lines, m group by j),
       'manifest debit ' || (select j->>'debit_total' from m)
union all
select 'no journal line without its entry', (select count(*) = 0 from journal_lines l where not exists (select 1 from journal_entries e where e.id = l.entry_id)),
       (select count(*)::text from journal_lines l where not exists (select 1 from journal_entries e where e.id = l.entry_id)) || ' orphan lines'
union all
select 'every app user has a sign-in account', (select count(*) = 0 from app_users u where not exists (select 1 from auth.users a where a.id = u.user_id)),
       (select count(*)::text from app_users u where not exists (select 1 from auth.users a where a.id = u.user_id)) || ' without one'
union all
select 'the books are not empty', (select count(*) > 0 from journal_entries), (select count(*)::text from journal_entries) || ' journal entries';
SQL
)"

failed=0
while IFS='|' read -r name ok detail; do
  if [ "$ok" = "t" ]; then echo "  ok    $name ($detail)"; else echo "  FAIL  $name ($detail)"; failed=1; fi
done <<< "$checks"
if [ "$failed" -ne 0 ] || [ -z "$checks" ]; then
  echo "drill: FAILED — this backup did not restore into balanced, complete books" >&2
  exit 1
fi
echo "drill: PASSED — the backup restored with balanced books and the manifest's counts"
