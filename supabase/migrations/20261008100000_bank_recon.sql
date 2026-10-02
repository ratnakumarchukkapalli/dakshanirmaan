-- Change 22: bank-recon (HDFC statement import and reconciliation) — DB half.
--
-- The owner downloads an HDFC statement, the app parses it (src/lib/bank-statement, not here),
-- previews it, and hands the parsed lines to import_bank_statement. Lines are then matched to the
-- posted journal entries that touch the bank ledger. Nothing here ever creates a journal entry:
-- an unmatched line is booked through the existing posting actions and then matched by hand.
--
--   1. bank_statement_lines: value_date, reference, line_no, account_id, dedupe_key, matched_at,
--      matched_by, ignore_reason; unique (account_id, dedupe_key); one line per matched entry;
--      lines immutable except the match fields; statements immutable; no direct writes from the app
--   2. guard: a journal entry matched to a bank line cannot be reversed (cancel_document,
--      bounce_cheque, a day-close reopen, a cutover reversal — every reversal sets reversed_by)
--   3. bank_ref_normalize(text)                       (internal helper)
--   4. import_bank_statement(account, file name, lines jsonb) -> jsonb
--   5. _bank_match_candidates(account)                (internal), suggest_bank_matches,
--      match_bank_line, unmatch_bank_line, ignore_bank_line, auto_match_bank_statement
--   6. v_bank_book_items, v_bank_statement_summary, v_bank_recon (+ explained-difference columns)
--
-- Everything is owner-only: current_app_role() = 'admin' (which already means aal2). A counter
-- user, an owner at aal1, a non-member and anon read nothing and every function raises DN_FORBIDDEN.

-- ============================================================
-- 1. Columns, constraints, privileges
-- ============================================================

alter table bank_statement_lines
  add column value_date date,
  add column reference text check (reference is null or (char_length(reference) between 1 and 64)),
  add column line_no int check (line_no is null or line_no > 0),
  add column account_id uuid references accounts (id),
  add column dedupe_key text,
  add column matched_at timestamptz,
  add column matched_by uuid references auth.users (id),
  add column ignore_reason text check (ignore_reason is null or char_length(ignore_reason) <= 200);

-- Backfill (hosted has no rows; a local database built from the tests may). Same key shape the
-- importer computes; occurrence = order of creation among identical rows of the same account.
-- The key leaves out the reference and the narration: the parser may take the reference from the
-- narration when the Chq./Ref.No. column is empty, and Excel and Delimited downloads of the same
-- row can differ there, so including it would import the same row twice.
update bank_statement_lines l set account_id = s.account_id
  from bank_statements s where s.id = l.statement_id;

with k as (
  select l.id,
         concat_ws('|', l.txn_date::text, l.debit::text, l.credit::text, coalesce(l.balance::text, '')) as base,
         row_number() over (
           partition by l.account_id, l.txn_date, l.debit, l.credit, l.balance
           order by l.created_at, l.id) as occ
  from bank_statement_lines l
)
update bank_statement_lines l set dedupe_key = k.base || '|' || k.occ from k where k.id = l.id;

alter table bank_statement_lines
  alter column account_id set not null,
  alter column dedupe_key set not null,
  -- A statement line moves money one way: exactly one side is non-zero.
  add constraint bank_statement_lines_one_side check ((debit = 0) <> (credit = 0)),
  -- auto/manual <=> an entry is named; a payment only ever alongside its entry.
  add constraint bank_statement_lines_match_shape check (
    ((match_status in ('auto', 'manual')) = (matched_entry_id is not null))
    and (matched_payment_id is null or matched_entry_id is not null));

-- A line already imported is never imported again, whichever statement it came in.
create unique index bank_statement_lines_dedupe_key on bank_statement_lines (account_id, dedupe_key);
-- One journal entry explains at most one bank line.
create unique index bank_statement_lines_matched_entry on bank_statement_lines (matched_entry_id)
  where match_status in ('auto', 'manual');
create index bank_statement_lines_account_date on bank_statement_lines (account_id, txn_date);

-- Writes go through the definer functions below only. The change-01 admin write policies are
-- dropped with the privileges so nothing suggests a second way in. SELECT stays (owner-only RLS).
drop policy admin_insert on bank_statements;
drop policy admin_update on bank_statements;
drop policy admin_delete on bank_statements;
drop policy admin_insert on bank_statement_lines;
drop policy admin_update on bank_statement_lines;
drop policy admin_delete on bank_statement_lines;
revoke insert, update, delete, truncate, references, trigger on bank_statements, bank_statement_lines
  from public, anon, authenticated, service_role;
grant select on bank_statements, bank_statement_lines to authenticated;
-- MAINTAIN (VACUUM/ANALYZE/REINDEX/...) exists from Postgres 17; nobody but the owner needs it.
do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on bank_statements, bank_statement_lines from public, anon, authenticated, service_role';
  end if;
end
$$;

-- BEFORE INSERT: the line's account is always its statement's (never trusted from the caller);
-- a key is computed for a raw insert that did not bring one (service role / tests).
create or replace function public.bank_statement_lines_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base text;
begin
  select account_id into new.account_id from bank_statements where id = new.statement_id;
  if new.dedupe_key is null then
    v_base := concat_ws('|', new.txn_date::text, new.debit::text, new.credit::text,
                        coalesce(new.balance::text, ''));
    new.dedupe_key := v_base || '|' || (1 + (
      select count(*) from bank_statement_lines
      where account_id = new.account_id
        and left(dedupe_key, char_length(v_base) + 1) = v_base || '|'
        and substr(dedupe_key, char_length(v_base) + 2) ~ '^[0-9]+$'));
  end if;
  return new;
end;
$$;
revoke all on function public.bank_statement_lines_before_insert() from public, anon, authenticated, service_role;

create trigger bank_statement_lines_before_insert before insert on bank_statement_lines
  for each row execute function public.bank_statement_lines_before_insert();

-- Lines are what the bank printed: only the match fields may change, and a matched line cannot be
-- deleted (it would leave its entry looking unreconciled with no trace).
create or replace function public.bank_statement_lines_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.match_status in ('auto', 'manual') then
      raise exception 'DN_VALIDATION:bank_line_matched';
    end if;
    return old;
  end if;

  if new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or new.statement_id is distinct from old.statement_id
     or new.account_id is distinct from old.account_id
     or new.txn_date is distinct from old.txn_date
     or new.value_date is distinct from old.value_date
     or new.narration is distinct from old.narration
     or new.reference is distinct from old.reference
     or new.debit is distinct from old.debit
     or new.credit is distinct from old.credit
     or new.balance is distinct from old.balance
     or new.line_no is distinct from old.line_no
     or new.dedupe_key is distinct from old.dedupe_key
  then
    raise exception 'DN_VALIDATION:bank_line_immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.bank_statement_lines_guard() from public, anon, authenticated, service_role;

create trigger bank_statement_lines_guard before update or delete on bank_statement_lines
  for each row execute function public.bank_statement_lines_guard();

create or replace function public.bank_statements_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'DN_VALIDATION:bank_statement_immutable';
end;
$$;
revoke all on function public.bank_statements_guard() from public, anon, authenticated, service_role;

create trigger bank_statements_guard before update on bank_statements
  for each row execute function public.bank_statements_guard();

-- ============================================================
-- 2. A matched entry cannot be reversed
-- ============================================================
-- Every reversal path (cancel_document, bounce_cheque, the day-close reopen, the cutover reversal)
-- marks the original with reversed_by — the only UPDATE journal_entries allows. Guarding that one
-- transition blocks all of them, present and future, without touching their bodies. The owner
-- unmatches the line first; the line then shows as unmatched and the reversal pair nets to zero.
create or replace function public.journal_entries_bank_match_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.reversed_by is null and new.reversed_by is not null
     and exists (select 1 from bank_statement_lines
                 where matched_entry_id = old.id and match_status in ('auto', 'manual'))
  then
    raise exception 'DN_VALIDATION:bank_line_matched';
  end if;
  return new;
end;
$$;
revoke all on function public.journal_entries_bank_match_guard() from public, anon, authenticated, service_role;

create trigger bank_match_guard before update on journal_entries
  for each row execute function public.journal_entries_bank_match_guard();

-- ============================================================
-- 3. Reference normalisation
-- ============================================================
-- Upper-case, trimmed, a leading apostrophe and zero padding removed; all zeros / empty = NULL.
-- Used on the statement's Chq./Ref.No. and on payments.instrument_no so both compare alike.
create or replace function public.bank_ref_normalize(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(ltrim(upper(btrim(ltrim(btrim(coalesce(p, '')), ''''))), '0'), '');
$$;
revoke all on function public.bank_ref_normalize(text) from public, anon, service_role;
grant execute on function public.bank_ref_normalize(text) to authenticated;

-- ============================================================
-- 4. import_bank_statement
-- ============================================================
-- p_lines: JSON array, oldest first, one object per printed row:
--   { "txnDate": "YYYY-MM-DD", "valueDate": "YYYY-MM-DD" | null, "narration": text | null,
--     "reference": text | null, "debit": "123.45", "credit": "0.00", "balance": "-12.50" }
-- Money is a JSON *string* (never a float). Atomic: any refusal imports nothing.
create or replace function public.import_bank_statement(
  p_account_id  uuid,
  p_source_file text,
  p_lines       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_today        date;
  v_file         text := nullif(btrim(coalesce(p_source_file, '')), '');
  v_n            int;
  v_el           jsonb;
  v_i            int;
  v_txn          date[] := '{}';
  v_val          date[] := '{}';
  v_nar          text[] := '{}';
  v_ref          text[] := '{}';
  v_dr           numeric(14,2)[] := '{}';
  v_cr           numeric(14,2)[] := '{}';
  v_bal          numeric(14,2)[] := '{}';
  v_key          text[] := '{}';
  v_occ          jsonb := '{}';
  v_base         text;
  v_d            date;
  v_vd           date;
  v_s            text;
  -- [0-9], not \d: \d also matches other scripts' digits (e.g. Arabic-Indic), which then fail the cast.
  v_amt_re       constant text := '^[0-9]{1,12}([.][0-9]{1,2})?$';
  v_bal_re       constant text := '^-?[0-9]{1,12}([.][0-9]{1,2})?$';
  v_date_re      constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  v_new          bool[] := '{}';
  v_first_new    int;
  v_imported     int := 0;
  v_stmt_id      uuid;
  v_prev_bal     numeric(14,2);
  v_warn         bool := false;
  v_from         date;
  v_to           date;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;

  if p_account_id is null
     or not exists (select 1 from accounts where id = p_account_id and system_key = 'bank') then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;
  if char_length(coalesce(v_file, '')) > 200 then
    raise exception 'DN_VALIDATION:file_name_too_long';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'DN_VALIDATION:no_lines';
  end if;
  v_n := jsonb_array_length(p_lines);
  if v_n > 5000 then
    raise exception 'DN_VALIDATION:too_many_lines';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;

  -- One import per bank account at a time: two concurrent imports of overlapping files must not
  -- both decide a line is new.
  perform pg_advisory_xact_lock(hashtext('bank_import:' || p_account_id::text));

  -- ---- validate every line, build the arrays -------------------------------------------
  for v_i in 1 .. v_n loop
    v_el := p_lines -> (v_i - 1);
    if jsonb_typeof(v_el) is distinct from 'object' then
      raise exception 'DN_VALIDATION:invalid_line line=%', v_i;
    end if;

    -- dates
    v_s := v_el ->> 'txnDate';
    if jsonb_typeof(v_el -> 'txnDate') is distinct from 'string' or v_s !~ v_date_re then
      raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
    end if;
    begin
      v_d := v_s::date;
    exception when others then
      raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
    end;
    if v_d < date '2000-01-01' then
      raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
    end if;
    if v_d > v_today then
      raise exception 'DN_VALIDATION:future_date line=%', v_i;
    end if;
    if v_i > 1 and v_d < v_txn[v_i - 1] then
      raise exception 'DN_VALIDATION:lines_out_of_order line=%', v_i;
    end if;

    v_vd := null;
    if v_el ? 'valueDate' and jsonb_typeof(v_el -> 'valueDate') <> 'null' then
      v_s := v_el ->> 'valueDate';
      if jsonb_typeof(v_el -> 'valueDate') <> 'string' or v_s !~ v_date_re then
        raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
      end if;
      begin
        v_vd := v_s::date;
      exception when others then
        raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
      end;
      -- A value date runs ahead of the booking date (cheque clearing is T+1 or later), so a statement
      -- downloaded on the deposit day can carry tomorrow's value date: allow up to 7 days ahead.
      if v_vd < date '2000-01-01' or v_vd > v_today + 7 then
        raise exception 'DN_VALIDATION:invalid_date line=%', v_i;
      end if;
    end if;

    -- money: strings only, at most two decimals, within NUMERIC(14,2)
    if jsonb_typeof(v_el -> 'debit') is distinct from 'string' or (v_el ->> 'debit') !~ v_amt_re
       or jsonb_typeof(v_el -> 'credit') is distinct from 'string' or (v_el ->> 'credit') !~ v_amt_re then
      raise exception 'DN_VALIDATION:invalid_amount line=%', v_i;
    end if;
    if jsonb_typeof(v_el -> 'balance') is distinct from 'string' or (v_el ->> 'balance') !~ v_bal_re then
      raise exception 'DN_VALIDATION:invalid_balance line=%', v_i;
    end if;
    v_dr  := v_dr  || (v_el ->> 'debit')::numeric(14,2);
    v_cr  := v_cr  || (v_el ->> 'credit')::numeric(14,2);
    v_bal := v_bal || (v_el ->> 'balance')::numeric(14,2);
    if (v_dr[v_i] = 0) = (v_cr[v_i] = 0) then
      raise exception 'DN_VALIDATION:one_side_only line=%', v_i;
    end if;

    -- text
    if v_el ? 'narration' and jsonb_typeof(v_el -> 'narration') not in ('string', 'null') then
      raise exception 'DN_VALIDATION:invalid_line line=%', v_i;
    end if;
    if char_length(coalesce(v_el ->> 'narration', '')) > 1000 then
      raise exception 'DN_VALIDATION:narration_too_long line=%', v_i;
    end if;
    if v_el ? 'reference' and jsonb_typeof(v_el -> 'reference') not in ('string', 'null') then
      raise exception 'DN_VALIDATION:invalid_line line=%', v_i;
    end if;

    v_txn := v_txn || v_d;
    v_val := v_val || v_vd;
    v_nar := v_nar || nullif(btrim(coalesce(v_el ->> 'narration', '')), '');
    v_ref := v_ref || bank_ref_normalize(v_el ->> 'reference');
    if char_length(coalesce(v_ref[v_i], '')) > 64 then
      raise exception 'DN_VALIDATION:reference_too_long line=%', v_i;
    end if;

    -- balance chain inside the file: previous balance + credit - debit = this balance
    if v_i > 1 and v_bal[v_i - 1] + v_cr[v_i] - v_dr[v_i] <> v_bal[v_i] then
      raise exception 'DN_VALIDATION:balance_chain_broken line=%', v_i;
    end if;

    -- dedupe key: (date, debit, credit, balance, occurrence of that tuple in the file); the
    -- reference is stored but kept out of the key (see section 1)
    v_base := concat_ws('|', v_d::text, v_dr[v_i]::text, v_cr[v_i]::text, v_bal[v_i]::text);
    v_occ := jsonb_set(v_occ, array[v_base], to_jsonb(coalesce((v_occ ->> v_base)::int, 0) + 1));
    v_key := v_key || (v_base || '|' || (v_occ ->> v_base));
  end loop;

  -- ---- which lines are new --------------------------------------------------------------
  select array_agg(not exists (select 1 from bank_statement_lines l
                               where l.account_id = p_account_id and l.dedupe_key = k.key)
                   order by k.ord)
    into v_new
  from unnest(v_key) with ordinality as k(key, ord);

  select min(i) into v_first_new from generate_subscripts(v_new, 1) i where v_new[i];

  if v_first_new is not null then
    -- Continuity across imports: when the file's first line is itself new, its implied opening
    -- balance should equal the closing balance of the last line already imported before it.
    -- (When an earlier, already-imported line precedes it in the file, the in-file chain proved it.)
    if v_first_new = 1 then
      select l.balance into v_prev_bal
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
      where l.account_id = p_account_id and l.txn_date <= v_txn[1] and l.balance is not null
      order by l.txn_date desc, s.imported_at desc, s.id desc, l.line_no desc nulls last,
               l.created_at desc, l.id desc
      limit 1;
      v_warn := v_prev_bal is not null and v_prev_bal <> v_bal[1] - v_cr[1] + v_dr[1];
    end if;

    select min(v_txn[i]), max(v_txn[i]) into v_from, v_to
    from generate_subscripts(v_new, 1) i where v_new[i];

    insert into bank_statements (account_id, period_from, period_to, imported_by, imported_at, source_file)
    values (p_account_id, v_from, v_to, v_actor, now(), v_file)
    returning id into v_stmt_id;

    insert into bank_statement_lines
      (statement_id, txn_date, value_date, narration, reference, debit, credit, balance, line_no,
       dedupe_key)
    select v_stmt_id, v_txn[i], v_val[i], v_nar[i], v_ref[i], v_dr[i], v_cr[i], v_bal[i], i, v_key[i]
    from generate_subscripts(v_new, 1) i
    where v_new[i]
    order by i;
    get diagnostics v_imported = row_count;

    insert into audit_log (actor, action, entity, entity_id, after)
    values (v_actor, 'import', 'bank_statements', v_stmt_id,
            jsonb_build_object('source_file', v_file, 'imported', v_imported,
                               'skipped_duplicates', v_n - v_imported,
                               'period_from', v_from, 'period_to', v_to,
                               'continuity_warning', v_warn));
  end if;

  return jsonb_build_object(
    'statement_id', v_stmt_id,
    'imported', v_imported,
    'skipped_duplicates', v_n - v_imported,
    'first_date', v_txn[1],
    'last_date', v_txn[v_n],
    'opening_balance', (v_bal[1] - v_cr[1] + v_dr[1])::text,
    'closing_balance', v_bal[v_n]::text,
    'continuity_warning', v_warn,
    'previous_closing_balance', v_prev_bal::text
  );
end;
$$;

revoke all on function public.import_bank_statement(uuid, text, jsonb) from public, anon, service_role;
grant execute on function public.import_bank_statement(uuid, text, jsonb) to authenticated;

-- ============================================================
-- 5. Matching
-- ============================================================

-- Bank-side view of the books: one row per posted journal entry with a non-zero net effect on a
-- bank ledger (a money account other than the cash box). amount > 0 always; direction 'in' = the
-- entry debits the bank (pairs with a statement *credit*). matchable = neither reversed nor itself
-- a reversal: a cancelled document and its mirror never reach the bank, and both stay out of
-- matching (a bounced cheque's deposit and bounce are such a pair; the owner ignores the two lines).
-- Opening-balance and day-close entries are never matchable either.
create view v_bank_book_items with (security_invoker = true) as
select * from (
  select
    jl.account_id,
    je.id as entry_id,
    je.entry_no,
    je.entry_date,
    je.narration,
    je.source_type::text as source_type,
    je.source_id,
    p.id as payment_id,
    p.mode::text as payment_mode,
    p.instrument_no,
    p.cleared_on,
    p.party_id,
    (case when sum(jl.debit - jl.credit) > 0 then 'in' else 'out' end)::text as direction,
    abs(sum(jl.debit - jl.credit))::numeric(14,2) as amount,
    (je.reversed_by is null
      and je.source_type not in ('opening', 'day_close')
      and not exists (select 1 from journal_entries o where o.reversed_by = je.id)) as matchable,
    je.reversed_by,
    (select o.id from journal_entries o where o.reversed_by = je.id order by o.entry_no limit 1) as reverses,
    m.id as matched_line_id
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  left join payments p on je.source_type = 'payment' and p.id = je.source_id
  left join bank_statement_lines m on m.matched_entry_id = je.id and m.match_status in ('auto', 'manual')
  where a.is_money and not a.is_group and a.system_key is distinct from 'cash'
  group by jl.account_id, je.id, p.id, m.id
  having sum(jl.debit - jl.credit) <> 0
) gated
where (select current_app_role()) = 'admin';

revoke all on public.v_bank_book_items from public, anon, authenticated, service_role;
grant select on public.v_bank_book_items to authenticated;

-- Every (line, entry) candidate pair for the unmatched lines of one bank account.
--   tier 1 'reference'   : the payment's instrument_no equals the line's reference (any date)
--   tier 2 'amount_date' : a line date (txn or value date) within ±3 days of an entry date (entry
--                          date or the cheque's cleared_on), unless the line and the payment both
--                          carry a reference and they differ
-- Never: opening-balance or day-close entries (not bank transactions).
-- Always: same account, same direction, exact amount, entry matchable and not matched.
-- narration_hit: a word (4+ letters) of the party's name appears in the narration (tie-break only).
-- Internal: called only by the definer functions below.
create or replace function public._bank_match_candidates(p_account_id uuid)
returns table (line_id uuid, entry_id uuid, payment_id uuid, candidate_kind text, tier int,
               day_gap int, narration_hit bool)
language sql
stable
set search_path = public, pg_temp
as $$
  with lines as (
    select l.* from bank_statement_lines l
    where l.account_id = p_account_id and l.match_status = 'unmatched'
  ),
  book as (
    select je.id as entry_id, je.entry_date, je.source_type, je.source_id,
           sum(jl.debit - jl.credit) as net
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
    where jl.account_id = p_account_id
      and je.reversed_by is null
      and je.source_type not in ('opening', 'day_close')
      and not exists (select 1 from journal_entries o where o.reversed_by = je.id)
      and not exists (select 1 from bank_statement_lines m
                      where m.matched_entry_id = je.id and m.match_status in ('auto', 'manual'))
    group by je.id
    having sum(jl.debit - jl.credit) <> 0
  ),
  pairs as (
    select l.id as line_id, b.entry_id, p.id as payment_id,
           b.source_type::text as candidate_kind,
           (l.reference is not null and p.id is not null
             and bank_ref_normalize(p.instrument_no) = l.reference) as ref_hit,
           -- both sides carry a reference and they differ: evidence against, not a candidate
           (l.reference is not null and bank_ref_normalize(p.instrument_no) is not null
             and bank_ref_normalize(p.instrument_no) <> l.reference) as ref_conflict,
           (select min(abs(ld - ed))
              from unnest(array[l.txn_date, l.value_date]) ld,
                   unnest(array[b.entry_date, p.cleared_on]) ed
             where ld is not null and ed is not null) as day_gap,
           exists (
             select 1
             from parties pt,
                  regexp_split_to_table(upper(pt.name), '[^A-Z0-9]+') tok
             where pt.id in (select jl2.party_id from journal_lines jl2
                             where jl2.entry_id = b.entry_id and jl2.party_id is not null
                             union select p.party_id)
               and char_length(tok) >= 4
               and position(tok in upper(coalesce(l.narration, ''))) > 0
           ) as narration_hit
    from lines l
    join book b on (l.credit > 0 and b.net = l.credit) or (l.debit > 0 and b.net = -l.debit)
    left join payments p on b.source_type = 'payment' and p.id = b.source_id
  )
  select line_id, entry_id, payment_id, candidate_kind,
         case when ref_hit then 1 else 2 end as tier, day_gap, narration_hit
  from pairs
  where ref_hit or (day_gap <= 3 and not ref_conflict);
$$;
revoke all on function public._bank_match_candidates(uuid) from public, anon, authenticated, service_role;

-- Suggestions for the unmatched lines of one statement, best first per line. A line that has a
-- reference candidate is offered only those.
create or replace function public.suggest_bank_matches(p_statement_id uuid)
returns table (line_id uuid, candidate_kind text, payment_id uuid, entry_id uuid, score int,
               reason text, entry_no bigint, entry_date date, narration text, amount numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account uuid;
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  select account_id into v_account from bank_statements where id = p_statement_id;
  if v_account is null then
    raise exception 'DN_VALIDATION:statement_not_found';
  end if;

  return query
  with c as (
    select c.*, min(c.tier) over (partition by c.line_id) as best_tier
    from _bank_match_candidates(v_account) c
    join bank_statement_lines l on l.id = c.line_id and l.statement_id = p_statement_id
  )
  select c.line_id, c.candidate_kind, c.payment_id, c.entry_id,
         (case when c.tier = 1 then 100 else 60 - 5 * coalesce(c.day_gap, 3) end
          + case when c.narration_hit then 10 else 0 end)::int as score,
         (case when c.tier = 1 then 'reference' else 'amount_date' end
          || case when c.narration_hit then '+narration' else '' end) as reason,
         je.entry_no, je.entry_date, je.narration,
         (select abs(sum(jl.debit - jl.credit)) from journal_lines jl
           where jl.entry_id = c.entry_id and jl.account_id = v_account)::numeric(14,2)
  from c
  join journal_entries je on je.id = c.entry_id
  where c.tier = c.best_tier
  order by c.line_id, 5 desc, je.entry_date, je.entry_no;
end;
$$;
revoke all on function public.suggest_bank_matches(uuid) from public, anon, service_role;
grant execute on function public.suggest_bank_matches(uuid) to authenticated;

-- Match one line to one entry. p_status: 'manual' (the owner picked it) or 'auto'.
-- Returns { line_id, entry_id, payment_id, match_status, cheque_to_clear }; cheque_to_clear is true
-- when the entry is a cheque still waiting to be marked cleared (the screen offers the button).
create or replace function public.match_bank_line(p_line_id uuid, p_entry_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_line    record;
  v_entry   record;
  v_net     numeric(14,2);
  v_payment record;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_status is null or p_status not in ('auto', 'manual') then
    raise exception 'DN_VALIDATION:invalid_status';
  end if;

  -- Lock order: line, then entry (a concurrent reversal updates the entry row and so waits, then
  -- its guard sees the match; or it wins and this function sees reversed_by).
  select * into v_line from bank_statement_lines where id = p_line_id for update;
  if not found then
    raise exception 'DN_VALIDATION:line_not_found';
  end if;
  if v_line.match_status <> 'unmatched' then
    raise exception 'DN_VALIDATION:line_not_unmatched';
  end if;

  select * into v_entry from journal_entries where id = p_entry_id for no key update;
  if not found then
    raise exception 'DN_VALIDATION:entry_not_found';
  end if;
  if v_entry.status <> 'posted' or v_entry.reversed_by is not null
     or exists (select 1 from journal_entries o where o.reversed_by = v_entry.id) then
    raise exception 'DN_VALIDATION:entry_cancelled';
  end if;
  -- The cutover opening entry carries the bank balance, not a transaction; a day close moves cash.
  if v_entry.source_type in ('opening', 'day_close') then
    raise exception 'DN_VALIDATION:entry_not_matchable';
  end if;

  select sum(debit - credit) into v_net
  from journal_lines where entry_id = p_entry_id and account_id = v_line.account_id;
  if coalesce(v_net, 0) = 0 then
    raise exception 'DN_VALIDATION:entry_not_on_account';
  end if;
  if (v_line.credit > 0) <> (v_net > 0) then
    raise exception 'DN_VALIDATION:wrong_direction';
  end if;
  if abs(v_net) <> v_line.credit + v_line.debit then
    raise exception 'DN_VALIDATION:amount_mismatch';
  end if;
  if exists (select 1 from bank_statement_lines
             where matched_entry_id = p_entry_id and match_status in ('auto', 'manual')) then
    raise exception 'DN_VALIDATION:entry_already_matched';
  end if;

  select * into v_payment from payments
  where v_entry.source_type = 'payment' and id = v_entry.source_id;

  begin
    update bank_statement_lines
       set match_status = p_status,
           matched_entry_id = p_entry_id,
           matched_payment_id = v_payment.id,
           matched_at = now(),
           matched_by = v_actor,
           ignore_reason = null
     where id = p_line_id;
  exception when unique_violation then
    raise exception 'DN_VALIDATION:entry_already_matched';
  end;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'bank_match', 'bank_statement_lines', p_line_id,
          jsonb_build_object('entry_id', p_entry_id, 'payment_id', v_payment.id, 'status', p_status));

  return jsonb_build_object(
    'line_id', p_line_id,
    'entry_id', p_entry_id,
    'payment_id', v_payment.id,
    'match_status', p_status,
    'cheque_to_clear', coalesce(v_payment.mode = 'cheque' and v_payment.status = 'posted' and (
        (v_payment.direction = 'receipt' and v_payment.cheque_status = 'deposited')
        or (v_payment.direction = 'payment' and v_payment.cheque_status in ('issued', 'presented'))),
      false)
  );
end;
$$;
revoke all on function public.match_bank_line(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.match_bank_line(uuid, uuid, text) to authenticated;

-- Back to unmatched, from matched (auto/manual) or ignored.
create or replace function public.unmatch_bank_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line  record;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  select * into v_line from bank_statement_lines where id = p_line_id for update;
  if not found then
    raise exception 'DN_VALIDATION:line_not_found';
  end if;
  if v_line.match_status = 'unmatched' then
    raise exception 'DN_VALIDATION:line_not_matched';
  end if;

  update bank_statement_lines
     set match_status = 'unmatched', matched_entry_id = null, matched_payment_id = null,
         matched_at = null, matched_by = null, ignore_reason = null
   where id = p_line_id;

  insert into audit_log (actor, action, entity, entity_id, before)
  values (v_actor, 'bank_unmatch', 'bank_statement_lines', p_line_id,
          jsonb_build_object('status', v_line.match_status, 'entry_id', v_line.matched_entry_id,
                             'ignore_reason', v_line.ignore_reason));
end;
$$;
revoke all on function public.unmatch_bank_line(uuid) from public, anon, service_role;
grant execute on function public.unmatch_bank_line(uuid) to authenticated;

-- Mark an unmatched line as not needing a book entry (own-account transfer noise, a bounced
-- cheque's deposit/return pair, ...). The reason is required and kept.
create or replace function public.ignore_bank_line(p_line_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_line   record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if v_reason is null then
    raise exception 'DN_VALIDATION:reason_required';
  end if;
  if char_length(v_reason) > 200 then
    raise exception 'DN_VALIDATION:reason_too_long';
  end if;
  select * into v_line from bank_statement_lines where id = p_line_id for update;
  if not found then
    raise exception 'DN_VALIDATION:line_not_found';
  end if;
  if v_line.match_status <> 'unmatched' then
    raise exception 'DN_VALIDATION:line_not_unmatched';
  end if;

  update bank_statement_lines
     set match_status = 'ignored', ignore_reason = v_reason, matched_at = now(), matched_by = v_actor
   where id = p_line_id;

  insert into audit_log (actor, action, entity, entity_id, after)
  values (v_actor, 'bank_ignore', 'bank_statement_lines', p_line_id,
          jsonb_build_object('reason', v_reason));
end;
$$;
revoke all on function public.ignore_bank_line(uuid, text) from public, anon, service_role;
grant execute on function public.ignore_bank_line(uuid, text) to authenticated;

-- Apply only the unambiguous pairs: the line has exactly one candidate in its best tier AND that
-- entry is the best-tier candidate of no other unmatched line of the account. Repeats until
-- nothing changes (a reference match can make a neighbour's amount+date match unique). Returns
-- the number of lines matched. Never creates entries.
create or replace function public.auto_match_bank_statement(p_statement_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account uuid;
  v_total   int := 0;
  v_round   int;
  v_pair    record;
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  select account_id into v_account from bank_statements where id = p_statement_id;
  if v_account is null then
    raise exception 'DN_VALIDATION:statement_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('bank_import:' || v_account::text));

  loop
    v_round := 0;
    for v_pair in
      with c as (select * from _bank_match_candidates(v_account)),
      best as (
        select c.*, min(c.tier) over (partition by c.line_id) as best_tier from c
      ),
      t as (select * from best where tier = best_tier),
      uniq as (
        select t.line_id, t.entry_id
        from t
        where (select count(*) from t t2 where t2.line_id = t.line_id) = 1
          and (select count(*) from t t3 where t3.entry_id = t.entry_id) = 1
      )
      select u.line_id, u.entry_id
      from uniq u
      join bank_statement_lines l on l.id = u.line_id
      where l.statement_id = p_statement_id
      order by l.line_no nulls last, l.id
    loop
      perform match_bank_line(v_pair.line_id, v_pair.entry_id, 'auto');
      v_round := v_round + 1;
    end loop;
    v_total := v_total + v_round;
    exit when v_round = 0;
  end loop;

  return v_total;
end;
$$;
revoke all on function public.auto_match_bank_statement(uuid) from public, anon, service_role;
grant execute on function public.auto_match_bank_statement(uuid) to authenticated;

-- ============================================================
-- 6. Views
-- ============================================================

-- One row per imported statement (the statement list and its header).
create view v_bank_statement_summary with (security_invoker = true) as
select * from (
  select
    s.id as statement_id,
    s.account_id,
    s.period_from,
    s.period_to,
    s.source_file,
    s.imported_at,
    s.imported_by,
    count(l.id)::int as line_count,
    (count(l.id) filter (where l.match_status = 'unmatched'))::int as unmatched_count,
    (count(l.id) filter (where l.match_status in ('auto', 'manual')))::int as matched_count,
    (count(l.id) filter (where l.match_status = 'ignored'))::int as ignored_count,
    coalesce(sum(l.debit), 0)::numeric(14,2) as total_debit,
    coalesce(sum(l.credit), 0)::numeric(14,2) as total_credit,
    (select f.balance - f.credit + f.debit from bank_statement_lines f
      where f.statement_id = s.id order by f.txn_date, f.line_no nulls last, f.created_at, f.id
      limit 1)::numeric(14,2) as opening_balance,
    (select f.balance from bank_statement_lines f
      where f.statement_id = s.id order by f.txn_date desc, f.line_no desc nulls last,
            f.created_at desc, f.id desc
      limit 1)::numeric(14,2) as closing_balance
  from bank_statements s
  left join bank_statement_lines l on l.statement_id = s.id
  group by s.id
) gated
where (select current_app_role()) = 'admin';

revoke all on public.v_bank_statement_summary from public, anon, authenticated, service_role;
grant select on public.v_bank_statement_summary to authenticated;

-- v_bank_recon: the change-06 columns unchanged (same names, order, types), then the
-- reconciliation statement. With as_of = the latest statement's period_to:
--   difference           = book balance as at as_of - bank closing balance
--   opening_difference   = unmatched book items dated before the first imported line
--                          - the bank balance implied before that line (0 when the books and the
--                          first statement start together)
--   book_only_*          = unmatched bank entries dated from the first line to as_of
--                          (a cancelled document and its reversal, both by as_of, net to 0 and
--                          are left out)
--   bank_only_*          = lines not matched to an entry dated by as_of (unmatched, ignored, or
--                          matched to a later-dated entry)
--   explained_difference = opening_difference + book_only (Dr - Cr) - bank_only (Cr - Dr)
--   unexplained          = difference - explained_difference; explained = (unexplained = 0)
-- A non-zero unexplained figure means lines are missing (a gap between imports) or the chain
-- across imports is broken.
-- Closing balance: an imported statement carries file order (line_no), so its last line is exact;
-- the change-06 heuristic remains only for rows without line_no.
create or replace view v_bank_recon with (security_invoker = true) as
select * from (
  select
    a.id as account_id,
    a.code,
    a.name,
    (case when ls.statement_id is null then ba.book_today else ba.book_asof end)::numeric(14,2) as book_balance,
    ba.book_today::numeric(14,2) as book_balance_today,
    ls.statement_id,
    ls.period_to as statement_period_to,
    ls.closing_balance as bank_balance,
    coalesce(ls.closing_balance_ambiguous, false) as closing_balance_ambiguous,
    (case when ls.closing_balance is null then null
          else ba.book_asof - ls.closing_balance end)::numeric(14,2) as difference,
    coalesce(u.unmatched_lines, 0)::int as unmatched_lines,
    -- reconciliation statement
    fl.recon_from,
    fl.bank_opening::numeric(14,2) as bank_opening_balance,
    (case when ls.statement_id is null then null
          else bo.book_opening - fl.bank_opening end)::numeric(14,2) as opening_difference,
    coalesce(bk.n, 0)::int as book_only_entries,
    coalesce(bk.dr, 0)::numeric(14,2) as book_only_debit,
    coalesce(bk.cr, 0)::numeric(14,2) as book_only_credit,
    coalesce(bl.n, 0)::int as bank_only_lines,
    coalesce(bl.dr, 0)::numeric(14,2) as bank_only_debit,
    coalesce(bl.cr, 0)::numeric(14,2) as bank_only_credit,
    (case when ls.statement_id is null then null
          else bo.book_opening - fl.bank_opening
               + coalesce(bk.dr, 0) - coalesce(bk.cr, 0)
               - (coalesce(bl.cr, 0) - coalesce(bl.dr, 0)) end)::numeric(14,2) as explained_difference,
    (case when ls.closing_balance is null or fl.bank_opening is null then null
          else (ba.book_asof - ls.closing_balance)
               - (bo.book_opening - fl.bank_opening
                  + coalesce(bk.dr, 0) - coalesce(bk.cr, 0)
                  - (coalesce(bl.cr, 0) - coalesce(bl.dr, 0))) end)::numeric(14,2) as unexplained,
    (case when ls.closing_balance is null or fl.bank_opening is null then null
          else (ba.book_asof - ls.closing_balance)
               = (bo.book_opening - fl.bank_opening
                  + coalesce(bk.dr, 0) - coalesce(bk.cr, 0)
                  - (coalesce(bl.cr, 0) - coalesce(bl.dr, 0))) end) as explained
  from accounts a
  left join lateral (
    select
      s.id as statement_id,
      s.period_to,
      c.closing_balance,
      c.closing_balance_ambiguous
    from bank_statements s
    cross join lateral (
      with last_day as (
        select l.*
        from bank_statement_lines l
        where l.statement_id = s.id and l.balance is not null
          and l.txn_date = (select max(l2.txn_date) from bank_statement_lines l2
                            where l2.statement_id = s.id and l2.balance is not null)
      ),
      terminal as (
        select d.*
        from last_day d
        where exists (select 1 from bank_statement_lines p
                      where p.statement_id = s.id and p.balance is not null and p.id <> d.id
                        and p.balance - d.debit + d.credit = d.balance)
          and not exists (select 1 from last_day q
                          where q.id <> d.id and d.balance - q.debit + q.credit = q.balance)
      )
      select
        (case
           when not exists (select 1 from last_day where line_no is null)
             then (select balance from last_day order by line_no desc limit 1)
           when (select count(distinct balance) from last_day) <= 1
             then (select max(balance) from last_day)
           when (select count(distinct balance) from terminal) = 1
             then (select max(balance) from terminal)
           else (select balance from last_day order by created_at desc, id desc limit 1)
         end) as closing_balance,
        (exists (select 1 from last_day where line_no is null)
          and (select count(distinct balance) from last_day) > 1
          and (select count(distinct balance) from terminal) <> 1) as closing_balance_ambiguous
    ) c
    where s.account_id = a.id
    order by s.period_to desc, s.imported_at desc, s.id desc
    limit 1
  ) ls on true
  left join lateral (
    select
      coalesce(sum(jl.debit - jl.credit), 0) as book_today,
      coalesce(sum(jl.debit - jl.credit) filter (where je.entry_date <= ls.period_to), 0) as book_asof
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
    where jl.account_id = a.id
  ) ba on true
  left join (
    select l.account_id, count(*) as unmatched_lines
    from bank_statement_lines l
    where l.match_status = 'unmatched'
    group by l.account_id
  ) u on u.account_id = a.id
  -- the first imported line of the account and the bank balance implied before it
  left join lateral (
    select f.txn_date as recon_from, f.balance - f.credit + f.debit as bank_opening
    from bank_statement_lines f
    join bank_statements fs on fs.id = f.statement_id
    where f.account_id = a.id
    order by f.txn_date, fs.imported_at, fs.id, f.line_no nulls last, f.created_at, f.id
    limit 1
  ) fl on true
  -- book items: bank entries dated by as_of that no line explains, minus cancelled pairs
  -- (bo: before the first imported line; bk: from it to as_of)
  left join lateral (
    select coalesce(sum(x.net) filter (where x.entry_date < fl.recon_from), 0) as book_opening
    from (
      select je.id, je.entry_date, sum(jl.debit - jl.credit) as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.account_id = a.id and je.entry_date <= ls.period_to
        and not exists (select 1 from bank_statement_lines m
                        where m.matched_entry_id = je.id and m.match_status in ('auto', 'manual'))
        and not exists (select 1 from journal_entries r
                        where r.id = je.reversed_by and r.entry_date <= ls.period_to)
        and not (exists (select 1 from journal_entries o where o.reversed_by = je.id)
                 and not exists (select 1 from journal_entries o
                                 where o.reversed_by = je.id and o.entry_date > ls.period_to))
      group by je.id
      having sum(jl.debit - jl.credit) <> 0
    ) x
  ) bo on true
  left join lateral (
    select count(*) as n,
           sum(greatest(x.net, 0)) as dr,
           sum(greatest(-x.net, 0)) as cr
    from (
      select je.id, je.entry_date, sum(jl.debit - jl.credit) as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      where jl.account_id = a.id and je.entry_date <= ls.period_to
        and je.entry_date >= fl.recon_from
        and not exists (select 1 from bank_statement_lines m
                        where m.matched_entry_id = je.id and m.match_status in ('auto', 'manual'))
        and not exists (select 1 from journal_entries r
                        where r.id = je.reversed_by and r.entry_date <= ls.period_to)
        and not (exists (select 1 from journal_entries o where o.reversed_by = je.id)
                 and not exists (select 1 from journal_entries o
                                 where o.reversed_by = je.id and o.entry_date > ls.period_to))
      group by je.id
      having sum(jl.debit - jl.credit) <> 0
    ) x
  ) bk on true
  left join lateral (
    select count(*) as n, sum(l.debit) as dr, sum(l.credit) as cr
    from bank_statement_lines l
    where l.account_id = a.id and l.txn_date <= ls.period_to
      and not exists (select 1 from journal_entries me
                      where me.id = l.matched_entry_id and l.match_status in ('auto', 'manual')
                        and me.entry_date <= ls.period_to)
  ) bl on true
  where a.is_money and not a.is_group and a.system_key is distinct from 'cash'
) gated
where (select current_app_role()) = 'admin';

revoke all on public.v_bank_recon from public, anon, authenticated, service_role;
grant select on public.v_bank_recon to authenticated;

-- ============================================================
-- 7. Bank Charges ledger
-- ============================================================
-- A bank debit with no book entry (FEE-..., SMS/IMPS charges, "INCL GST") is booked through the
-- existing expense voucher (pay account = the bank ledger) to this account, in full, without a
-- GST split (owner default; revisit ITC with the owner). Then the line is matched to that entry.
insert into accounts (code, name, type, parent_id, system_key)
values ('5950', 'Bank Charges', 'expense', (select id from accounts where code = '5000'), 'bank_charges')
on conflict do nothing;

-- ============================================================
-- 8. post_bank_expense: book an unmatched bank debit and match it, atomically
-- ============================================================
-- The app's "Book bank charge" used to be four calls (check, insert voucher, post, match): a
-- double submit could post two vouchers for one line. This does it in one transaction under the
-- line's row lock, so the second call finds the line matched (line_not_unmatched) and creates
-- nothing. The amount is the line's debit, never the caller's; the date is the line's txn date;
-- the pay account is the statement's bank. Period locks and role checks are post_expense_voucher's.
-- Account: p_account_id or Bank Charges; must be a plain expense ledger (not a group, control or
-- money account, and not one the posting engine owns: cogs, round_off, stock_loss,
-- cash_over_short, discount_allowed, salaries — salaries go through the salary voucher).
create or replace function public.post_bank_expense(
  p_line_id    uuid,
  p_account_id uuid default null,
  p_note       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_line    record;
  v_acct    record;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_today   date;
  v_voucher uuid := gen_random_uuid();
  v_entry   uuid;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if char_length(coalesce(v_note, '')) > 200 then
    raise exception 'DN_VALIDATION:note_too_long';
  end if;

  select * into v_line from bank_statement_lines where id = p_line_id for update;
  if not found then
    raise exception 'DN_VALIDATION:line_not_found';
  end if;
  if v_line.match_status <> 'unmatched' then
    raise exception 'DN_VALIDATION:line_not_unmatched';
  end if;
  if v_line.debit <= 0 then
    raise exception 'DN_VALIDATION:line_not_debit';
  end if;

  select * into v_acct from accounts
  where id = coalesce(p_account_id, (select id from accounts where system_key = 'bank_charges'));
  if not found or v_acct.type <> 'expense' or v_acct.is_group or v_acct.is_control or v_acct.is_money
     or coalesce(v_acct.system_key, '') in
        ('cogs', 'round_off', 'stock_loss', 'cash_over_short', 'discount_allowed', 'salaries') then
    raise exception 'DN_VALIDATION:invalid_account';
  end if;

  select (now() at time zone (select timezone from organization limit 1))::date into v_today;
  if v_line.txn_date > v_today then
    raise exception 'DN_VALIDATION:future_date';
  end if;

  insert into expense_vouchers (id, voucher_date, status, voucher_type, pay_account_id)
  values (v_voucher, v_line.txn_date, 'draft', 'expense', v_line.account_id);
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
  values (v_voucher, 1, v_acct.id, v_line.debit,
          coalesce(v_note, left(coalesce(v_line.narration, 'Bank debit'), 200)));

  v_entry := post_expense_voucher(v_voucher);
  perform match_bank_line(p_line_id, v_entry, 'manual');

  return jsonb_build_object('voucher_id', v_voucher, 'entry_id', v_entry, 'line_id', p_line_id);
end;
$$;
revoke all on function public.post_bank_expense(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.post_bank_expense(uuid, uuid, text) to authenticated;
