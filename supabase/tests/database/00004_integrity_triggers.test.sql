-- Must pass (change 02, integrity-triggers): "unbalanced insert raises"; "UPDATE on posted
-- line raises"; "locked period raises". Plus full coverage of the same requirement section:
-- DELETE immutability, the reversed_by one-time exception, stock_movements immutability,
-- unlocked-period contrast, and leaf-only postings.
begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- Fixtures: two leaf accounts from the seed CoA, one group account, one test item + warehouse.
create temp table _accts as
select
  (select id from accounts where system_key = 'cash') as cash_id,
  (select id from accounts where system_key = 'ar') as ar_id,
  (select id from accounts where code = '1000') as group_id; -- 'Assets', is_group = true

insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate)
values ('Test Item', 'other', '0000', 18, 'pcs', 100);

create temp table _stock as
select
  (select id from items where name = 'Test Item') as item_id,
  (select id from warehouses where is_default) as warehouse_id;

-- Test party, for control-account journal_lines (party_id required on ar/ap/etc.).
create temp table _party as
with p as (
  insert into parties (name, type, state_code)
  values ('Test Party', 'customer', '37')
  returning id
)
select id as party_id from p;

-- ============================================================
-- 1. Balanced entries (deferred constraint trigger on journal_lines)
-- ============================================================

-- Reset flag, run risky op inside a DO block so its own failure (and only its own effects)
-- rolls back via PL/pgSQL's implicit exception-handler savepoint.
select set_config('pgtap_test.raised', 'false', false);

do $$
declare
  v_entry_id uuid;
begin
  insert into journal_entries (entry_date, source_type, status)
  values (current_date, 'manual', 'posted')
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, (select cash_id from _accts), 100, 0);
  -- no offsetting credit line: entry is unbalanced

  set constraints all immediate;
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;

select is(
  current_setting('pgtap_test.raised', true),
  'true',
  'unbalanced insert raises once the deferred balance constraint is checked'
);

select set_config('pgtap_test.raised', 'false', false);

do $$
declare
  v_entry_id uuid;
begin
  insert into journal_entries (entry_date, source_type, status)
  values (current_date, 'manual', 'posted')
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, (select cash_id from _accts), 100, 0);
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values (v_entry_id, 2, (select ar_id from _accts), (select party_id from _party), 0, 100);

  set constraints all immediate;
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;

select is(
  current_setting('pgtap_test.raised', true),
  'false',
  'balanced insert does not raise at the deferred balance constraint check'
);

-- The successful (non-exception) SET CONSTRAINTS ALL IMMEDIATE call above leaves the session in
-- immediate mode for the rest of the transaction (only the failed one auto-rolled back). Put it
-- back to deferred so later journal_lines inserts in this file aren't checked mid-test.
set constraints all deferred;

-- ============================================================
-- 2. Immutability
-- ============================================================

-- Fixture: one real posted entry with two balanced leaf lines, for the mutation tests below.
create temp table _fixture_entry as
with e as (
  insert into journal_entries (entry_date, source_type, status)
  values (current_date, 'manual', 'posted')
  returning id
),
l as (
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  select e.id, 1, (select cash_id from _accts), null, 500, 0 from e
  union all
  select e.id, 2, (select ar_id from _accts), (select party_id from _party), 0, 500 from e
  returning id, entry_id
)
select e.id as entry_id, (select id from l order by id limit 1) as line_id from e;

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  update journal_lines set debit = debit + 1
  where id = (select line_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'UPDATE on a posted journal_lines row raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  delete from journal_lines where id = (select line_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'DELETE on a posted journal_lines row raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  update journal_entries set narration = 'tampered'
  where id = (select entry_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'UPDATE on journal_entries unrelated to reversed_by raises');

-- Setting reversed_by from NULL once: allowed.
insert into journal_entries (entry_date, source_type, status)
values (current_date, 'manual', 'posted');

select set_config('pgtap_test.raised', 'false', false);
do $$
declare
  v_reversal_id uuid;
begin
  select id into v_reversal_id from journal_entries
  where id <> (select entry_id from _fixture_entry) order by created_at desc limit 1;

  update journal_entries set reversed_by = v_reversal_id
  where id = (select entry_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'false',
  'setting journal_entries.reversed_by from NULL once succeeds');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  update journal_entries set reversed_by = (select entry_id from _fixture_entry)
  where id = (select entry_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'setting journal_entries.reversed_by a second time raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  delete from journal_entries where id = (select entry_id from _fixture_entry);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'DELETE on journal_entries raises');

-- stock_movements immutability.
create temp table _fixture_movement as
with m as (
  insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
  select item_id, warehouse_id, current_date, 10, 100, 1000, 'opening' from _stock
  returning id
)
select id from m;

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  update stock_movements set qty = qty + 1
  where id = (select id from _fixture_movement);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'UPDATE on stock_movements raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  delete from stock_movements where id = (select id from _fixture_movement);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'DELETE on stock_movements raises');

-- ============================================================
-- 3. Period lock
-- ============================================================

update fiscal_periods set is_locked = true where month = '2026-04-01';

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_entries (entry_date, source_type, status)
  values ('2026-04-15', 'manual', 'posted');
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'INSERT into journal_entries dated in a locked period raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
  select item_id, warehouse_id, '2026-04-15', 1, 100, 100, 'opening' from _stock;
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'INSERT into stock_movements dated in a locked period raises');

-- 2026-08-15 is inside seeded FY 2026-27 and not one of the periods explicitly locked above.
select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_entries (entry_date, source_type, status)
  values ('2026-08-15', 'manual', 'posted');
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'false',
  'INSERT dated in an unlocked period does not raise (contrast)');

-- A date with no fiscal_periods row at all is blocked, not allowed.
select set_config('pgtap_test.raised_msg', '', false);
do $$
begin
  insert into journal_entries (entry_date, source_type, status)
  values ('2062-01-01', 'manual', 'posted');
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'no fiscal period',
  'INSERT dated with no fiscal_periods row raises "no fiscal period"'
);

-- ============================================================
-- 5. Leaf-only postings
-- ============================================================

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values ((select entry_id from _fixture_entry), 3, (select group_id from _accts), 50, 0);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'INSERT into journal_lines against a group account raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values ((select entry_id from _fixture_entry), 3, (select cash_id from _accts), 50, 0);
  -- leaves this entry unbalanced deliberately; never call SET CONSTRAINTS IMMEDIATE here so the
  -- deferred balance check is simply never fired within this transaction.
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'false',
  'INSERT into journal_lines against a leaf account does not raise (contrast)');

-- ============================================================
-- 6. Minimum lines (deferred constraint trigger on journal_entries)
-- ============================================================

select set_config('pgtap_test.raised_msg', '', false);
do $$
declare
  v_entry_id uuid;
begin
  insert into journal_entries (entry_date, source_type, status)
  values (current_date, 'manual', 'posted')
  returning id into v_entry_id;

  insert into journal_lines (entry_id, line_no, account_id, debit, credit)
  values (v_entry_id, 1, (select cash_id from _accts), 100, 0);
  -- only one line: entry has fewer than 2 lines

  -- Check only this constraint, not ALL: an earlier fixture (leaf-only section) deliberately
  -- left _fixture_entry unbalanced and relies on the balance constraint never being checked
  -- within this transaction; SET CONSTRAINTS ALL would sweep that up too.
  set constraints journal_entries_have_lines immediate;
exception when others then
  perform set_config('pgtap_test.raised_msg', sqlerrm, true);
end;
$$;
select matches(
  current_setting('pgtap_test.raised_msg', true),
  'fewer than 2 lines',
  'entry with a single line raises "fewer than 2 lines" once the deferred constraint is checked'
);

-- The successful SET CONSTRAINTS ... IMMEDIATE call above never ran to completion (it raised),
-- so PL/pgSQL's exception-handler savepoint rolled it back and the session is still deferred.
-- No explicit reset needed here, but keep the invariant explicit for future edits to this file.
set constraints all deferred;

-- ============================================================
-- 7. Party rule (control accounts require party_id, others forbid it)
-- ============================================================

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values ((select entry_id from _fixture_entry), 4, (select ar_id from _accts), null, 50, 0);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'INSERT into journal_lines against a control account without party_id raises');

select set_config('pgtap_test.raised', 'false', false);
do $$
begin
  insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
  values ((select entry_id from _fixture_entry), 4, (select cash_id from _accts),
    (select party_id from _party), 50, 0);
exception when others then
  perform set_config('pgtap_test.raised', 'true', true);
end;
$$;
select is(current_setting('pgtap_test.raised', true), 'true',
  'INSERT into journal_lines against a non-control account with party_id raises');

select * from finish();

rollback;
