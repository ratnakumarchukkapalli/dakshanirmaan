-- Change 22 (bank-recon), review fixes:
--  * the cutover opening entry is never matchable (not suggested, not auto-matched, refused by hand,
--    matchable = false) and cancel_opening_balances still works with statements imported
--  * a conflicting reference rules a pair out of the amount + date tier
--  * one entry that is the only candidate of two lines is matched to neither
--  * the dedupe key ignores the reference (re-import with another / no reference imports nothing)
--  * a negative (overdraft) balance imports; dates before 2000, a far-future value date and
--    non-ASCII digits are refused as validation errors
--  * service_role cannot write the statement tables
begin;

create extension if not exists pgtap with schema extensions;

select plan(33);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test');

create temp table _ids (name text primary key, id uuid);
grant all on _ids to authenticated;
create function _i(p text) returns uuid language sql stable as $$ select id from _ids where name = p $$;
grant execute on function _i(text) to authenticated;
insert into _ids values ('bank', (select id from accounts where system_key = 'bank'));

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000035', 'Review Customer', 'customer', state_code from organization limit 1;

create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
grant execute on function _as_owner() to authenticated;

create function _bline(p_ref text) returns uuid language sql stable security definer set search_path = public as $$
  select id from bank_statement_lines where reference = p_ref $$;
grant execute on function _bline(text) to authenticated;

-- ============================================================
-- Opening balances: never matchable
-- ============================================================
set local role authenticated;
select _as_owner();
insert into opening_batches default values;
insert into opening_lines (batch_id, kind, account_id, amount)
select id, 'money', _i('bank'), 1000 from opening_batches where status = 'draft';
select post_opening_balances('2026-09-01');
reset role;
insert into _ids select 'EOPEN', id from journal_entries where source_type = 'opening';
set local role authenticated;
select _as_owner();

create temp table _s1 as select import_bank_statement(_i('bank'), 's1.txt', '[
  {"txnDate":"2026-09-01","narration":"OPENING SIZED CREDIT","reference":"OPN1","debit":"0.00","credit":"1000.00","balance":"1000.00"}
]'::jsonb) as r;
grant select on _s1 to authenticated;
select is((select count(*)::int from suggest_bank_matches((select (r ->> 'statement_id')::uuid from _s1))), 0,
  'the opening entry is never suggested, even for a line of the same amount and date');
select is(auto_match_bank_statement((select (r ->> 'statement_id')::uuid from _s1)), 0, '...nor auto-matched');
select throws_ok($$select match_bank_line(_bline('OPN1'), _i('EOPEN'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_not_matchable',
  '...and refused by hand');
select is((select matchable from v_bank_book_items where entry_id = _i('EOPEN')), false, 'v_bank_book_items: opening is not matchable');
select lives_ok($$select cancel_opening_balances('redo')$$, 'cancel_opening_balances still works with a statement imported');

-- ============================================================
-- Conflicting reference
-- ============================================================
reset role;
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status, instrument_no) values
  ('e3500000-0000-0000-0000-000000000001', 'receipt', '2026-09-10', 'a0000000-0000-0000-0000-000000000035', 'upi',  5000, _i('bank'), 'draft', '111111111111'),
  ('e3500000-0000-0000-0000-000000000002', 'receipt', '2026-09-12', 'a0000000-0000-0000-0000-000000000035', 'neft', 3000, _i('bank'), 'draft', null);
set local role authenticated;
select _as_owner();
select post_payment('e3500000-0000-0000-0000-000000000001');
select post_payment('e3500000-0000-0000-0000-000000000002');
reset role;
insert into _ids select 'EQ1', journal_entry_id from payments where id = 'e3500000-0000-0000-0000-000000000001'
  union all select 'EQ2', journal_entry_id from payments where id = 'e3500000-0000-0000-0000-000000000002';
set local role authenticated;
select _as_owner();

-- Only the other customer's 5,000 (RRN ...222, never booked) is on this statement.
create temp table _s2 as select import_bank_statement(_i('bank'), 's2.txt', '[
  {"txnDate":"2026-09-10","valueDate":"2026-09-10","narration":"UPI-OTHER-222222222222","reference":"0000222222222222","debit":"0.00","credit":"5000.00","balance":"6000.00"}
]'::jsonb) as r;
grant select on _s2 to authenticated;
select is((select count(*)::int from suggest_bank_matches((select (r ->> 'statement_id')::uuid from _s2))), 0,
  'a line whose RRN differs from the booked receipt''s is not offered it by amount + date');
select is(auto_match_bank_statement((select (r ->> 'statement_id')::uuid from _s2)), 0, '...and not auto-matched to it');

-- Then the booked one (RRN ...111) arrives: it matches by reference; ...222 stays unmatched.
create temp table _s3 as select import_bank_statement(_i('bank'), 's3.txt', '[
  {"txnDate":"2026-09-10","valueDate":"2026-09-10","narration":"UPI-REVIEW CUSTOMER-111111111111","reference":"0000111111111111","debit":"0.00","credit":"5000.00","balance":"11000.00"}
]'::jsonb) as r;
grant select on _s3 to authenticated;
select is(auto_match_bank_statement((select (r ->> 'statement_id')::uuid from _s3)), 1, 'the matching RRN auto-matches');
select is((select matched_entry_id from bank_statement_lines where id = _bline('111111111111')), _i('EQ1'), '...to its receipt');
select is((select match_status from bank_statement_lines where id = _bline('222222222222')), 'unmatched', '...and the other line stays unmatched');

-- ============================================================
-- Entry-side ambiguity: one entry, two lines
-- ============================================================
create temp table _s4 as select import_bank_statement(_i('bank'), 's4.txt', '[
  {"txnDate":"2026-09-12","narration":"NEFT CR-A","reference":"N5","debit":"0.00","credit":"3000.00","balance":"14000.00"},
  {"txnDate":"2026-09-13","narration":"NEFT CR-B","reference":"N6","debit":"0.00","credit":"3000.00","balance":"17000.00"}
]'::jsonb) as r;
grant select on _s4 to authenticated;
select is((select count(*)::int from suggest_bank_matches((select (r ->> 'statement_id')::uuid from _s4)) where entry_id = _i('EQ2')), 2,
  'the single 3,000 receipt is a candidate for both 3,000 lines');
select is(auto_match_bank_statement((select (r ->> 'statement_id')::uuid from _s4)), 0, '...so auto-match takes neither');
select is((select count(*)::int from bank_statement_lines where reference in ('N5', 'N6') and match_status = 'unmatched'), 2,
  '...both lines stay unmatched');

-- ============================================================
-- Dedupe ignores the reference
-- ============================================================
create temp table _s5 as select import_bank_statement(_i('bank'), 's5.xlsx', '[
  {"txnDate":"2026-09-12","narration":"NEFT CR-A (excel)","reference":null,"debit":"0.00","credit":"3000.00","balance":"14000.00"},
  {"txnDate":"2026-09-13","narration":"NEFT CR-B","reference":"UTR-FROM-NARRATION","debit":"0","credit":"3000","balance":"17000"}
]'::jsonb) as r;
grant select on _s5 to authenticated;
select is((select (r ->> 'imported')::int from _s5), 0, 're-import with a blank / different reference imports 0 lines');
select is((select (r ->> 'skipped_duplicates')::int from _s5), 2, '...both skipped as duplicates');
select is((select reference from bank_statement_lines where id = _bline('N6')), 'N6', '...and the stored reference is unchanged');

-- ============================================================
-- Overdraft, dates, digits
-- ============================================================
create temp table _s6 as select import_bank_statement(_i('bank'), 's6.txt', jsonb_build_array(
  jsonb_build_object('txnDate', '2026-09-14', 'valueDate', ((now() at time zone 'Asia/Kolkata')::date + 1)::text,
    'narration', 'CHQ PAID', 'reference', '000123', 'debit', '20000.00', 'credit', '0.00', 'balance', '-3000.00'))) as r;
grant select on _s6 to authenticated;
select is((select (r ->> 'imported')::int from _s6), 1, 'a line taking the balance negative (overdraft) imports, with tomorrow''s value date');
select is((select balance from bank_statement_lines where id = _bline('123')), -3000.00::numeric, '...balance -3,000.00');
select is((select closing_balance from v_bank_statement_summary where statement_id = (select (r ->> 'statement_id')::uuid from _s6)),
  -3000.00::numeric, '...and the summary shows the negative closing balance');
select is((select bank_balance from v_bank_recon), -3000.00::numeric, 'v_bank_recon reads it too');

select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"0026-09-15","debit":"0.00","credit":"1.00","balance":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'year 0026 is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"1999-12-31","debit":"0.00","credit":"1.00","balance":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'a date before 2000 is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-15","valueDate":"1999-01-01","debit":"0.00","credit":"1.00","balance":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'a value date before 2000 is refused');
select throws_ok(format($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-15","valueDate":"%s","debit":"0.00","credit":"1.00","balance":"1.00"}]')$$,
                        ((now() at time zone 'Asia/Kolkata')::date + 30)::text),
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'a value date a month ahead is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-15","debit":"0.00","credit":"١٠","balance":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_amount line=1', 'Arabic-Indic digits are a validation error, not a cast failure');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-15","debit":"0.00","credit":"1.00","balance":"١٠"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_balance line=1', '...in the balance too');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"٢٠٢٦-09-15","debit":"0.00","credit":"1.00","balance":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', '...and in a date');
reset role;

-- ============================================================
-- service_role writes nothing directly
-- ============================================================
select ok(not has_table_privilege('service_role', t, p), 'service_role has no ' || p || ' on ' || t)
from unnest(array['bank_statements', 'bank_statement_lines']) t, unnest(array['INSERT', 'UPDATE', 'DELETE']) p;

select * from finish();
rollback;
