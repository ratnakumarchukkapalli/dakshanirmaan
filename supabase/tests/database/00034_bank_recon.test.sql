-- Change 22 (bank-recon), DB half: import_bank_statement, matching, v_bank_recon, and the
-- "a matched entry cannot be reversed" guard.
--
-- Must pass (proposal item 6):
--  * import of a good file; a duplicate re-import imports 0; an overlapping file imports only the tail
--  * a broken balance chain (and every other invalid line) is refused and nothing is written
--  * a counter user and an owner at aal1 can neither read nor call anything; anon executes nothing
--  * match_bank_line refuses amount mismatch, wrong direction, an already-matched entry, a cancelled
--    entry (and its reversal)
--  * auto-match leaves ambiguous lines unmatched; same-day identical amounts match one-to-one
--  * v_bank_recon's difference is explained after matching, after a book-only item, with a line
--    matched to a later-dated entry; a gap between imports shows as unexplained
--  * cancelling / bouncing a document whose entry is matched is refused until the line is unmatched
--  * an expense voucher paid from the bank (how the app books a bank charge) is suggested,
--    auto-matched and accepted by match_bank_line
begin;

create extension if not exists pgtap with schema extensions;

select plan(196);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

create temp table _ids (name text primary key, id uuid);
grant all on _ids to authenticated;
create function _i(p text) returns uuid language sql stable as $$ select id from _ids where name = p $$;
grant execute on function _i(text) to authenticated;

insert into _ids values
  ('bank', (select id from accounts where system_key = 'bank')),
  ('cash', (select id from accounts where system_key = 'cash')),
  ('charges', (select id from accounts where system_key = 'bank_charges')),
  ('party', 'a0000000-0000-0000-0000-000000000022');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000022', 'Bank Customer', 'customer', state_code from organization limit 1;

-- Receipts into the bank. P1/P2: same day, same amount, told apart only by their UPI RRN.
-- P3: NEFT, no instrument (amount + date). P4/P5: same amount on adjacent days, no instrument
-- (ambiguous). P6: a cheque. P7: a receipt the bank never shows (book-only). P8: posted then cancelled.
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status, instrument_no)
select v.id::uuid, 'receipt', v.d::date, _i('party'), v.mode::payment_mode, v.amt, _i('bank'), 'draft', v.ins
from (values
  ('e0000000-0000-0000-0000-000000000001', '2026-09-02', 'upi',    10000, '427510653284'),
  ('e0000000-0000-0000-0000-000000000002', '2026-09-02', 'upi',    10000, '427510653285'),
  ('e0000000-0000-0000-0000-000000000003', '2026-09-03', 'neft',    5000, null),
  ('e0000000-0000-0000-0000-000000000004', '2026-09-04', 'neft',    7000, null),
  ('e0000000-0000-0000-0000-000000000005', '2026-09-05', 'neft',    7000, null),
  ('e0000000-0000-0000-0000-000000000006', '2026-09-01', 'cheque',  2000, '819021'),
  ('e0000000-0000-0000-0000-000000000007', '2026-09-08', 'neft',     118, null),
  ('e0000000-0000-0000-0000-000000000008', '2026-09-05', 'upi',      500, null)
) as v(id, d, mode, amt, ins);
insert into _ids select 'P' || right(id::text, 1), id from payments where party_id = _i('party');

-- EV1: a 250 bank charge already booked (paid from the bank). EV2: the 118 SMS charge, booked later.
insert into expense_vouchers (id, voucher_date, status, voucher_type, pay_account_id) values
  ('e1000000-0000-0000-0000-000000000001', '2026-09-06', 'draft', 'expense', _i('bank')),
  ('e1000000-0000-0000-0000-000000000002', '2026-09-08', 'draft', 'expense', _i('bank'));
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration) values
  ('e1000000-0000-0000-0000-000000000001', 1, _i('charges'), 250, 'ATM fee'),
  ('e1000000-0000-0000-0000-000000000002', 1, _i('charges'), 118, 'SMS charges');
insert into _ids values ('EV1', 'e1000000-0000-0000-0000-000000000001'),
                        ('EV2', 'e1000000-0000-0000-0000-000000000002');

create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
grant execute on function _as_counter(), _as_owner(), _as_owner_aal1() to authenticated;

-- The statement files (oldest first, money as strings), as the parser hands them over.
create temp table _files (name text primary key, lines jsonb);
grant select on _files to authenticated;
insert into _files values
('A', '[
  {"txnDate":"2026-09-02","valueDate":"2026-09-02","narration":"UPI-BANK CUSTOMER-bc@okicici-ICIC0DC0099-427510653285-NA","reference":"0000427510653285","debit":"0.00","credit":"10000.00","balance":"10000.00"},
  {"txnDate":"2026-09-02","valueDate":"2026-09-02","narration":"UPI-BANK CUSTOMER-bc@okicici-ICIC0DC0099-427510653284-NA","reference":"0000427510653284","debit":"0.00","credit":"10000.00","balance":"20000.00"},
  {"txnDate":"2026-09-03","valueDate":"2026-09-03","narration":"NEFT CR-YESB0000001-BANK CUSTOMER-OWN CO-YESIB42752289400","reference":"YESIB42752289400","debit":"0","credit":"5000","balance":"25000"},
  {"txnDate":"2026-09-04","valueDate":"2026-09-04","narration":"NEFT CR-SBIN0000001-SOMEONE-N1","reference":"N1","debit":"0.00","credit":"7000.00","balance":"32000.00"},
  {"txnDate":"2026-09-05","valueDate":"2026-09-05","narration":"NEFT CR-SBIN0000001-SOMEONE-N2","reference":"N2","debit":"0.00","credit":"7000.00","balance":"39000.00"},
  {"txnDate":"2026-09-06","valueDate":"2026-09-06","narration":"FEE-ATM CASH(1TXN)05/09/26-AOR2531733136","reference":"AOR2531733136080","debit":"250.00","credit":"0.00","balance":"38750.00"},
  {"txnDate":"2026-09-07","valueDate":"2026-09-07","narration":"CASH DEPOSIT BY - SELF - CITY","reference":"0000000000000000","debit":"0.00","credit":"3000.00","balance":"41750.00"},
  {"txnDate":"2026-09-08","valueDate":"2026-09-08","narration":".SMS CHARGES FOR QTR INCL GST","reference":null,"debit":"118.00","credit":"0.00","balance":"41632.00"}
]'),
-- B overlaps A by its last two lines, then three new lines.
('B', '[
  {"txnDate":"2026-09-07","valueDate":"2026-09-07","narration":"CASH DEPOSIT BY - SELF - CITY","reference":"0000000000000000","debit":"0.00","credit":"3000.00","balance":"41750.00"},
  {"txnDate":"2026-09-08","valueDate":"2026-09-08","narration":".SMS CHARGES FOR QTR INCL GST","reference":null,"debit":"118.00","credit":"0.00","balance":"41632.00"},
  {"txnDate":"2026-09-09","valueDate":"2026-09-09","narration":"UPI-SOMEONE-x@ybl-YESB0000001-427510653299-NA","reference":"0000427510653299","debit":"0.00","credit":"1000.00","balance":"42632.00"},
  {"txnDate":"2026-09-10","valueDate":"2026-09-11","narration":"CHQ DEP MICR CLG CITY - MICR 1 CLG","reference":"0000000000819021","debit":"0.00","credit":"2000.00","balance":"44632.00"},
  {"txnDate":"2026-09-10","valueDate":"2026-09-10","narration":"NEFT DR-SBIN0000999-PAYEE-NETBANK, MUM-N199262615","reference":"N199262615","debit":"632.00","credit":"0.00","balance":"44000.00"}
]'),
-- Broken chain at line 2 (and line 1 is new, so a partial write would be visible).
('BROKEN', '[
  {"txnDate":"2026-09-11","narration":"x","reference":null,"debit":"0.00","credit":"10.00","balance":"44010.00"},
  {"txnDate":"2026-09-12","narration":"y","reference":null,"debit":"0.00","credit":"10.00","balance":"44030.00"}
]');

-- ============================================================
-- Shape and privileges
-- ============================================================
select has_column('public', 'bank_statement_lines', c, 'bank_statement_lines.' || c || ' exists')
from unnest(array['value_date', 'reference', 'line_no', 'account_id', 'dedupe_key', 'matched_at',
                  'matched_by', 'ignore_reason']) as c;
select col_not_null('public', 'bank_statement_lines', 'dedupe_key', 'dedupe_key is NOT NULL');
select is((select name from accounts where system_key = 'bank_charges'), 'Bank Charges', 'a Bank Charges ledger is seeded');
select is((select type::text from accounts where system_key = 'bank_charges'), 'expense', '...as an expense account');

select ok(not has_function_privilege('anon', f, 'EXECUTE'), 'anon cannot execute ' || f)
from unnest(array[
  'public.import_bank_statement(uuid, text, jsonb)',
  'public.suggest_bank_matches(uuid)',
  'public.match_bank_line(uuid, uuid, text)',
  'public.unmatch_bank_line(uuid)',
  'public.ignore_bank_line(uuid, text)',
  'public.auto_match_bank_statement(uuid)',
  'public._bank_match_candidates(uuid)']) as f;
select ok(not has_function_privilege('authenticated', 'public._bank_match_candidates(uuid)', 'EXECUTE'),
          'the internal candidate function is not callable by the app');
select ok(not has_table_privilege('authenticated', t, p), 'authenticated has no ' || p || ' on ' || t)
from unnest(array['bank_statements', 'bank_statement_lines']) t, unnest(array['INSERT', 'UPDATE', 'DELETE']) p;

-- ============================================================
-- Post the books (owner, aal2)
-- ============================================================
set local role authenticated;
select _as_owner();
select post_payment(_i(k)) from unnest(array['P1','P2','P3','P4','P5','P6','P8']) k;
select post_expense_voucher(_i('EV1'));
create temp table _cd as select post_cash_deposit('2026-09-07', 3000, null, null) as id;
grant select on _cd to authenticated;
select cancel_document('payment', _i('P8'), 'entered twice');
reset role;
insert into _ids
  select 'E' || right(p.id::text, 1), p.journal_entry_id from payments p
  where p.party_id = _i('party') and p.status <> 'draft'
  union all select 'EEV1', journal_entry_id from expense_vouchers where id = _i('EV1')
  union all select 'ECD', journal_entry_id from cash_deposits where id = (select id from _cd)
  union all select 'EP8REV', reversed_by from journal_entries
             where id = (select journal_entry_id from payments where id = _i('P8'));

-- ============================================================
-- Import: good file
-- ============================================================
set local role authenticated;
select _as_owner();
create temp table _imp_a as
  select import_bank_statement(_i('bank'), ' Acct_Statement_Sep.txt ', (select lines from _files where name = 'A')) as r;
grant select on _imp_a to authenticated;
select is((select (r ->> 'imported')::int from _imp_a), 8, 'import A: 8 lines imported');
select is((select (r ->> 'skipped_duplicates')::int from _imp_a), 0, 'import A: none skipped');
select is((select r ->> 'first_date' from _imp_a), '2026-09-02', 'import A: first date');
select is((select r ->> 'last_date' from _imp_a), '2026-09-08', 'import A: last date');
select is((select r ->> 'opening_balance' from _imp_a), '0.00', 'import A: opening balance implied by the first line');
select is((select r ->> 'closing_balance' from _imp_a), '41632.00', 'import A: closing balance = last line');
select is((select (r ->> 'continuity_warning')::bool from _imp_a), false, 'import A: no continuity warning on the first import');
select is((select count(*)::int from bank_statements), 1, 'one statement row');
select is((select period_from from bank_statements where id = (select (r ->> 'statement_id')::uuid from _imp_a)),
          '2026-09-02'::date, 'period_from derived from the lines');
select is((select period_to from bank_statements where id = (select (r ->> 'statement_id')::uuid from _imp_a)),
          '2026-09-08'::date, 'period_to derived from the lines');
select is((select source_file from bank_statements), 'Acct_Statement_Sep.txt', 'only the file name is kept, trimmed');
select is((select imported_by from bank_statements), '33333333-3333-3333-3333-333333333333'::uuid, 'imported_by is the owner');
select is((select array_agg(reference order by line_no) from bank_statement_lines),
          array['427510653285','427510653284','YESIB42752289400','N1','N2','AOR2531733136080',null,null],
          'references normalised: zero padding stripped, all zeros -> NULL');
select is((select array_agg(line_no order by line_no) from bank_statement_lines), array[1,2,3,4,5,6,7,8], 'line_no = file order');
select is((select count(*)::int from bank_statement_lines where match_status = 'unmatched' and account_id = _i('bank')),
          8, 'every line starts unmatched, on the bank account');
select is((select credit from bank_statement_lines where line_no = 3), 5000.00::numeric, '"5000" parsed as 5000.00');
select is((select count(*)::int from audit_log where entity = 'bank_statements' and action = 'import'), 1, 'the import is audit-logged');
reset role;
insert into _ids
  select 'SA', (r ->> 'statement_id')::uuid from _imp_a
  union all select 'L' || line_no, id from bank_statement_lines;

-- ============================================================
-- Import: duplicate, invalid, broken chain
-- ============================================================
set local role authenticated;
select _as_owner();
create temp table _imp_a2 as
  select import_bank_statement(_i('bank'), 'again.txt', (select lines from _files where name = 'A')) as r;
grant select on _imp_a2 to authenticated;
select is((select (r ->> 'imported')::int from _imp_a2), 0, 're-import of the same file: 0 new lines');
select is((select (r ->> 'skipped_duplicates')::int from _imp_a2), 8, 're-import: all 8 skipped');
select is((select r ->> 'statement_id' from _imp_a2), null, 're-import: no statement row is created');
select is((select count(*)::int from bank_statement_lines), 8, 'still 8 lines');

select throws_ok($$select import_bank_statement(_i('bank'), 'b.txt', (select lines from _files where name = 'BROKEN'))$$,
  'P0001', 'DN_VALIDATION:balance_chain_broken line=2', 'a broken balance chain is refused, naming the line');
select is((select count(*)::int from bank_statements), 1, '...and nothing was written (no statement)');
select is((select count(*)::int from bank_statement_lines where txn_date = '2026-09-11'), 0, '...and no line');

select throws_ok($$select import_bank_statement(_i('cash'), 'x', (select lines from _files where name = 'A'))$$,
  'P0001', 'DN_VALIDATION:invalid_account', 'only the bank ledger can take a statement');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[]')$$, 'P0001', 'DN_VALIDATION:no_lines', 'an empty file is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":0,"credit":"10.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_amount line=1', 'a JSON number (float) as money is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":"0.00","credit":"10.001","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_amount line=1', 'a third decimal is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":"1,000.00","credit":"0","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_amount line=1', 'grouping commas are refused (the parser strips them)');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":"5.00","credit":"10.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:one_side_only line=1', 'both sides non-zero is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":"0.00","credit":"0.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:one_side_only line=1', 'both sides zero is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2099-01-01","debit":"0.00","credit":"1.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:future_date line=1', 'a future date is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"11/09/26","debit":"0.00","credit":"1.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'a non-ISO date is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-02-30","debit":"0.00","credit":"1.00","balance":"10.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_date line=1', 'an impossible date is refused');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-12","debit":"0.00","credit":"1.00","balance":"11.00"},{"txnDate":"2026-09-11","debit":"0.00","credit":"1.00","balance":"12.00"}]')$$,
  'P0001', 'DN_VALIDATION:lines_out_of_order line=2', 'newest-first input is refused (the parser must reverse it)');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', '[{"txnDate":"2026-09-11","debit":"0.00","credit":"1.00"}]')$$,
  'P0001', 'DN_VALIDATION:invalid_balance line=1', 'a missing balance is refused');
reset role;

-- ============================================================
-- Owner-only: counter user, owner at aal1
-- ============================================================
set local role authenticated;
select _as_counter();
select is((select count(*)::int from bank_statements), 0, 'counter: reads no statements');
select is((select count(*)::int from bank_statement_lines), 0, 'counter: reads no statement lines');
select is((select count(*)::int from v_bank_recon), 0, 'counter: v_bank_recon is empty');
select is((select count(*)::int from v_bank_book_items), 0, 'counter: v_bank_book_items is empty');
select is((select count(*)::int from v_bank_statement_summary), 0, 'counter: v_bank_statement_summary is empty');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', (select lines from _files where name = 'B'))$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot import');
select throws_ok($$select * from suggest_bank_matches(_i('SA'))$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot ask for suggestions');
select throws_ok($$select match_bank_line(_i('L1'), _i('E2'), 'manual')$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot match');
select throws_ok($$select unmatch_bank_line(_i('L1'))$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot unmatch');
select throws_ok($$select ignore_bank_line(_i('L1'), 'x')$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot ignore');
select throws_ok($$select auto_match_bank_statement(_i('SA'))$$, 'P0001', 'DN_FORBIDDEN', 'counter: cannot auto-match');

select _as_owner_aal1();
select is((select count(*)::int from bank_statements), 0, 'owner at aal1: reads no statements');
select is((select count(*)::int from bank_statement_lines), 0, 'owner at aal1: reads no statement lines');
select is((select count(*)::int from v_bank_recon), 0, 'owner at aal1: v_bank_recon is empty');
select is((select count(*)::int from v_bank_book_items), 0, 'owner at aal1: v_bank_book_items is empty');
select throws_ok($$select import_bank_statement(_i('bank'), 'x', (select lines from _files where name = 'B'))$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot import');
select throws_ok($$select * from suggest_bank_matches(_i('SA'))$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot ask for suggestions');
select throws_ok($$select match_bank_line(_i('L1'), _i('E2'), 'manual')$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot match');
select throws_ok($$select unmatch_bank_line(_i('L1'))$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot unmatch');
select throws_ok($$select ignore_bank_line(_i('L1'), 'x')$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot ignore');
select throws_ok($$select auto_match_bank_statement(_i('SA'))$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: cannot auto-match');

-- even the owner at aal2 cannot write the tables directly
select _as_owner();
select throws_ok($$update bank_statement_lines set match_status = 'ignored' where id = _i('L8')$$,
  '42501', null, 'owner: no direct UPDATE of a line');
select throws_ok($$delete from bank_statement_lines where id = _i('L8')$$, '42501', null, 'owner: no direct DELETE of a line');
select throws_ok($$insert into bank_statements (account_id, period_from, period_to) values (_i('bank'), '2026-09-01', '2026-09-02')$$,
  '42501', null, 'owner: no direct INSERT of a statement');
reset role;

-- immutability (even for a privileged session)
select throws_ok($$update bank_statement_lines set narration = 'edited' where id = _i('L1')$$,
  'P0001', 'DN_VALIDATION:bank_line_immutable', 'a line''s printed fields cannot change');
select throws_ok($$update bank_statement_lines set credit = 1 where id = _i('L1')$$,
  'P0001', 'DN_VALIDATION:bank_line_immutable', 'nor its amount');
select throws_ok($$update bank_statements set period_to = '2026-09-30' where id = _i('SA')$$,
  'P0001', 'DN_VALIDATION:bank_statement_immutable', 'a statement row cannot change');

-- ============================================================
-- Suggestions
-- ============================================================
set local role authenticated;
select _as_owner();
create temp table _sug as select * from suggest_bank_matches(_i('SA'));
grant select on _sug to authenticated;
select is((select array_agg(entry_id) from _sug where line_id = _i('L1')), array[_i('E2')],
  'L1 (RRN ...285) is offered only P2 (reference beats the same-day same-amount P1)');
select is((select reason from _sug where line_id = _i('L1')), 'reference+narration', '...with reason reference (+ the party name in the narration)');
select is((select score from _sug where line_id = _i('L1')), 110, '...score 100 + 10 for the name');
select is((select array_agg(entry_id) from _sug where line_id = _i('L2')), array[_i('E1')], 'L2 is offered only P1');
select is((select entry_id from _sug where line_id = _i('L3')), _i('E3'), 'L3 (NEFT, no instrument) is offered P3 by amount + date');
select is((select reason from _sug where line_id = _i('L3')), 'amount_date+narration', '...and the party name in the narration is noted');
select is((select count(*)::int from _sug where line_id = _i('L4')), 2, 'L4 (7,000) has two candidates (P4, P5)');
select is((select entry_id from _sug where line_id = _i('L4') order by score desc limit 1), _i('E4'),
  '...the same-day one ranked first');
select is((select candidate_kind from _sug where line_id = _i('L6')), 'expense_voucher',
  'L6 (bank fee debit) is offered the expense voucher paid from the bank');
select is((select entry_id from _sug where line_id = _i('L6')), _i('EEV1'), '...EV1''s entry');
select is((select candidate_kind from _sug where line_id = _i('L7')), 'cash_deposit', 'L7 (cash deposit, no reference) is offered the cash deposit');
select is((select count(*)::int from _sug where line_id = _i('L8')), 0, 'L8 (SMS charge) has no book entry yet');
select is((select count(*)::int from _sug where entry_id in (_i('E8'), _i('EP8REV'))), 0,
  'a cancelled receipt and its reversal are never suggested');
select is((select payment_id from _sug where line_id = _i('L1')), _i('P2'), 'a payment candidate carries its payment id');

-- ============================================================
-- Auto-match
-- ============================================================
select is(auto_match_bank_statement(_i('SA')), 5, 'auto-match applies the 5 unambiguous pairs');
select is((select matched_entry_id from bank_statement_lines where id = _i('L1')), _i('E2'), 'same-day 10,000s: L1 -> P2 ...');
select is((select matched_entry_id from bank_statement_lines where id = _i('L2')), _i('E1'), '... and L2 -> P1 (one-to-one)');
select is((select matched_payment_id from bank_statement_lines where id = _i('L1')), _i('P2'), 'the payment id is recorded');
select is((select match_status from bank_statement_lines where id = _i('L1')), 'auto', 'status auto');
select is((select matched_by from bank_statement_lines where id = _i('L1')), '33333333-3333-3333-3333-333333333333'::uuid, 'matched_by is the owner');
select is((select matched_entry_id from bank_statement_lines where id = _i('L3')), _i('E3'), 'L3 -> P3 by unique amount + date');
select is((select matched_entry_id from bank_statement_lines where id = _i('L6')), _i('EEV1'), 'L6 -> the bank-paid expense voucher');
select is((select matched_entry_id from bank_statement_lines where id = _i('L7')), _i('ECD'), 'L7 -> the cash deposit');
select is((select array_agg(match_status order by line_no) from bank_statement_lines where id in (_i('L4'), _i('L5'), _i('L8'))),
          array['unmatched','unmatched','unmatched'], 'ambiguous L4/L5 and the unbooked L8 stay unmatched');
select is(auto_match_bank_statement(_i('SA')), 0, 'running auto-match again changes nothing');

-- ============================================================
-- Manual matching and its refusals
-- ============================================================
select is((select match_bank_line(_i('L4'), _i('E4'), 'manual') ->> 'match_status'), 'manual', 'owner matches L4 -> P4 by hand');
select throws_ok($$select match_bank_line(_i('L5'), _i('E4'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_already_matched',
  'an entry already matched to another line is refused');
select throws_ok($$select match_bank_line(_i('L4'), _i('E5'), 'manual')$$, 'P0001', 'DN_VALIDATION:line_not_unmatched',
  'a line already matched is refused');
select lives_ok($$select match_bank_line(_i('L5'), _i('E5'), 'manual')$$, 'L5 -> P5');
select throws_ok($$select match_bank_line(_i('L8'), _i('E8'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_cancelled',
  'a cancelled (reversed) entry is refused');
select throws_ok($$select match_bank_line(_i('L8'), _i('EP8REV'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_cancelled',
  'a reversal entry is refused');
select throws_ok($$select match_bank_line(_i('L8'), _i('E3'), 'manual')$$, 'P0001', 'DN_VALIDATION:wrong_direction',
  'a debit line against a receipt (money in) is refused');
select throws_ok($$select match_bank_line(_i('L8'), _i('EEV1'), 'manual')$$, 'P0001', 'DN_VALIDATION:amount_mismatch',
  'a different amount (250 vs 118) is refused');
select throws_ok($$select match_bank_line(_i('L8'), _i('E6'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_not_on_account',
  'a cheque receipt (Cheques in Hand, not yet banked) is not on the bank account');
select throws_ok($$select match_bank_line(_i('L8'), _i('E3'), 'bogus')$$, 'P0001', 'DN_VALIDATION:invalid_status', 'status must be auto or manual');
select throws_ok($$select match_bank_line(gen_random_uuid(), _i('E3'), 'manual')$$, 'P0001', 'DN_VALIDATION:line_not_found', 'an unknown line is refused');
select throws_ok($$select match_bank_line(_i('L8'), gen_random_uuid(), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_not_found', 'an unknown entry is refused');

-- ============================================================
-- v_bank_recon (as at 08-09, the statement's last date)
-- ============================================================
-- Book (to 08-09): 10000+10000+5000+7000+7000 - 250 + 3000 + 500 (P8: its reversal is dated today,
-- after the period) = 42,250. Bank: 41,632. Difference 618 = book-only P8 500 - bank-only (-118).
select is((select bank_balance from v_bank_recon), 41632.00::numeric, 'recon: bank balance = the last line');
select is((select book_balance from v_bank_recon), 42250.00::numeric, 'recon: book balance as at 08-09');
select is((select difference from v_bank_recon), 618.00::numeric, 'recon: difference 618');
select is((select bank_opening_balance from v_bank_recon), 0.00::numeric, 'recon: bank opening implied by the first line');
select is((select opening_difference from v_bank_recon), 0.00::numeric, 'recon: books and bank start together');
select is((select book_only_entries from v_bank_recon), 1, 'recon: one book-only entry (P8, cancelled only after the period)');
select is((select book_only_debit from v_bank_recon), 500.00::numeric, '...500 in');
select is((select bank_only_lines from v_bank_recon), 1, 'recon: one bank-only line (the SMS charge)');
select is((select bank_only_debit from v_bank_recon), 118.00::numeric, '...118 out');
select is((select explained_difference from v_bank_recon), 618.00::numeric, 'recon: explained difference = 500 - (-118)');
select is((select explained from v_bank_recon), true, 'recon: the difference is fully explained after matching');
select is((select unexplained from v_bank_recon), 0.00::numeric, 'recon: nothing unexplained');
select is((select unmatched_lines from v_bank_recon), 1, 'recon: one unmatched line');
select is((select unmatched_count from v_bank_statement_summary where statement_id = _i('SA')), 1, 'summary: 1 unmatched');
select is((select matched_count from v_bank_statement_summary where statement_id = _i('SA')), 7, 'summary: 7 matched');
select is((select closing_balance from v_bank_statement_summary where statement_id = _i('SA')), 41632.00::numeric, 'summary: closing balance');

-- A book-only item: P7 (118 in on 08-09) is in the books, not on the statement.
select post_payment(_i('P7'));
reset role;
insert into _ids select 'E7', journal_entry_id from payments where id = _i('P7');
set local role authenticated;
select _as_owner();
select is((select difference from v_bank_recon), 736.00::numeric, 'recon: a book-only receipt moves the difference to 736');
select is((select book_only_entries from v_bank_recon), 2, '...two book-only entries');
select is((select book_only_debit from v_bank_recon), 618.00::numeric, '...618 in');
select is((select explained from v_bank_recon), true, 'recon: still explained after a book-only item');

-- Book the SMS charge (EV2, how the app books a bank debit: expense voucher paid from the bank)
-- and match it by hand: the bank-only line disappears.
select post_expense_voucher(_i('EV2'));
reset role;
insert into _ids select 'EEV2', journal_entry_id from expense_vouchers where id = _i('EV2');
set local role authenticated;
select _as_owner();
select is((select candidate_kind from suggest_bank_matches(_i('SA')) where line_id = _i('L8')), 'expense_voucher',
  'the newly booked bank charge is suggested for L8');
select is((select match_bank_line(_i('L8'), _i('EEV2'), 'manual') ->> 'payment_id'), null,
  'match_bank_line accepts an expense-voucher entry (no payment id)');
select is((select difference from v_bank_recon), 618.00::numeric, 'recon: difference back to 618 (P7 + P8 book-only)');
select is((select bank_only_lines from v_bank_recon), 0, 'recon: no bank-only line left');
select is((select explained from v_bank_recon), true, 'recon: explained');

-- ============================================================
-- Ignore / unmatch
-- ============================================================
select throws_ok($$select ignore_bank_line(_i('L8'), 'noise')$$, 'P0001', 'DN_VALIDATION:line_not_unmatched', 'a matched line cannot be ignored');
select lives_ok($$select unmatch_bank_line(_i('L8'))$$, 'a matched line can be unmatched');
select is((select row(match_status, matched_entry_id, matched_payment_id, matched_at, matched_by)::text
           from bank_statement_lines where id = _i('L8')),
          row('unmatched', null::uuid, null::uuid, null::timestamptz, null::uuid)::text, '...and every match field is cleared');
select throws_ok($$select unmatch_bank_line(_i('L8'))$$, 'P0001', 'DN_VALIDATION:line_not_matched', 'an unmatched line cannot be unmatched');
select throws_ok($$select ignore_bank_line(_i('L8'), '   ')$$, 'P0001', 'DN_VALIDATION:reason_required', 'ignoring needs a reason');
select throws_ok($$select ignore_bank_line(_i('L8'), repeat('x', 201))$$, 'P0001', 'DN_VALIDATION:reason_too_long', 'a 201-character reason is refused');
select lives_ok($$select ignore_bank_line(_i('L8'), ' own-account noise ')$$, 'an unmatched line can be ignored');
select is((select ignore_reason from bank_statement_lines where id = _i('L8')), 'own-account noise', 'the reason is kept, trimmed');
select throws_ok($$select match_bank_line(_i('L8'), _i('EEV2'), 'manual')$$, 'P0001', 'DN_VALIDATION:line_not_unmatched', 'an ignored line cannot be matched');
select is((select explained from v_bank_recon), true, 'recon: an ignored line is still a bank-only item, so still explained');
select lives_ok($$select unmatch_bank_line(_i('L8'))$$, 'an ignored line can be put back');
select lives_ok($$select match_bank_line(_i('L8'), _i('EEV2'), 'manual')$$, 'and matched again');
select is((select count(*)::int from audit_log where entity = 'bank_statement_lines'), 12,
  'every match, unmatch and ignore is audit-logged (8 matches earlier + 4 here)');

-- ============================================================
-- Overlapping import (B): only the tail is new
-- ============================================================
create temp table _imp_b as
  select import_bank_statement(_i('bank'), 'B.txt', (select lines from _files where name = 'B')) as r;
grant select on _imp_b to authenticated;
select is((select (r ->> 'imported')::int from _imp_b), 3, 'overlap: 3 new lines imported');
select is((select (r ->> 'skipped_duplicates')::int from _imp_b), 2, 'overlap: the 2 already imported are skipped');
select is((select (r ->> 'continuity_warning')::bool from _imp_b), false, 'overlap: continuous, no warning');
select is((select count(*)::int from bank_statement_lines), 11, '11 lines in all, none twice');
select is((select period_from from bank_statements where id = (select (r ->> 'statement_id')::uuid from _imp_b)),
          '2026-09-09'::date, 'overlap: the new statement covers only its new lines');
select is((select match_status from bank_statement_lines where id = _i('L8')), 'manual', 'overlap: the old line keeps its match');
reset role;
insert into _ids
  select 'SB', (r ->> 'statement_id')::uuid from _imp_b
  union all select 'L' || (8 + line_no - 2), id from bank_statement_lines
            where statement_id = (select (r ->> 'statement_id')::uuid from _imp_b);

-- the cheque (P6) is deposited today; the statement line L10 carries its number
set local role authenticated;
select _as_owner();
select deposit_cheque(_i('P6'));
reset role;
insert into _ids select 'EDEP', id from journal_entries
  where source_type = 'payment' and source_id = _i('P6') and entry_no = (
    select max(entry_no) from journal_entries where source_type = 'payment' and source_id = _i('P6'));
set local role authenticated;
select _as_owner();
select is((select reason from suggest_bank_matches(_i('SB')) where line_id = _i('L10')), 'reference',
  'the cheque deposit line is offered the deposit by cheque number, though the deposit is dated weeks later');
select is((select value_date from bank_statement_lines where id = _i('L10')), '2026-09-11'::date, 'value date kept');
select is(auto_match_bank_statement(_i('SB')), 1, 'auto-match B: only the cheque (L9 and L11 have no book entry)');
select is((select matched_entry_id from bank_statement_lines where id = _i('L10')), _i('EDEP'), 'L10 -> the cheque deposit');

-- Book (to 10-09): 42,250 + 118 (P7) - 118 (EV2) = 42,250. Bank 44,000. Difference -1,750 =
-- book-only 618 - bank-only (1000 + 2000 - 632): L10 counts as bank-only because its entry is dated
-- after the period.
select is((select bank_balance from v_bank_recon), 44000.00::numeric, 'recon B: bank balance = B''s last line (file order)');
select is((select difference from v_bank_recon), -1750.00::numeric, 'recon B: difference -1,750');
select is((select bank_only_lines from v_bank_recon), 3, 'recon B: L9, L11 and L10 (matched to a later entry) are bank-only');
select is((select explained from v_bank_recon), true, 'recon B: explained');

-- ============================================================
-- A matched document cannot be cancelled / bounced
-- ============================================================
select throws_ok($$select cancel_document('payment', _i('P1'), 'test')$$, 'P0001', 'DN_VALIDATION:bank_line_matched',
  'cancelling a receipt matched to a bank line is refused');
select throws_ok($$select cancel_document('cash_deposit', (select id from _cd), 'test')$$, 'P0001', 'DN_VALIDATION:bank_line_matched',
  'cancelling a matched cash deposit is refused');
select throws_ok($$select cancel_document('expense_voucher', _i('EV2'), 'test')$$, 'P0001', 'DN_VALIDATION:bank_line_matched',
  'cancelling a matched expense voucher is refused');
select throws_ok($$select bounce_cheque(_i('P6'), 'returned')$$, 'P0001', 'DN_VALIDATION:bank_line_matched',
  'bouncing a cheque whose deposit is matched is refused');
select is((select status::text from payments where id = _i('P1')), 'posted', '...P1 is untouched');
select is((select cheque_status::text from payments where id = _i('P6')), 'deposited', '...P6 is untouched');

select lives_ok($$select unmatch_bank_line(_i('L2'))$$, 'unmatch L2');
select lives_ok($$select cancel_document('payment', _i('P1'), 'test')$$, 'then P1 cancels');
select throws_ok($$select match_bank_line(_i('L2'), _i('E1'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_cancelled',
  'and its entry can no longer be matched');
select lives_ok($$select unmatch_bank_line(_i('L10'))$$, 'unmatch L10');
select lives_ok($$select bounce_cheque(_i('P6'), 'returned')$$, 'then the cheque bounces');
select throws_ok($$select match_bank_line(_i('L10'), _i('EDEP'), 'manual')$$, 'P0001', 'DN_VALIDATION:entry_cancelled',
  'the reversed deposit cannot be matched');
reset role;
-- a matched line cannot be deleted even by a privileged session
select throws_ok($$delete from bank_statement_lines where id = _i('L1')$$, 'P0001', 'DN_VALIDATION:bank_line_matched',
  'a matched line cannot be deleted');

-- ============================================================
-- A gap between imports: warned, and unexplained in the recon
-- ============================================================
set local role authenticated;
select _as_owner();
create temp table _imp_c as
  select import_bank_statement(_i('bank'), 'C.txt',
    jsonb_build_array(jsonb_build_object('txnDate', (now() at time zone 'Asia/Kolkata')::date::text,
      'narration', 'UPI-X', 'reference', null, 'debit', '0.00', 'credit', '100.00', 'balance', '50100.00'))) as r;
grant select on _imp_c to authenticated;
select is((select (r ->> 'continuity_warning')::bool from _imp_c), true, 'gap: the import warns (implied opening 50,000 vs last closing 44,000)');
select is((select r ->> 'previous_closing_balance' from _imp_c), '44000.00', 'gap: the previous closing balance is reported');
select is((select explained from v_bank_recon), false, 'gap: the recon is no longer explained');
select is((select unexplained from v_bank_recon), -6000.00::numeric, 'gap: unexplained = the missing 6,000');
-- As at today the cancelled pairs (P8, P1, the bounced deposit) have both halves inside the
-- period and drop out; P7 is the only book-only entry left.
select is((select book_only_entries from v_bank_recon), 1, 'gap: cancelled pairs inside the period are not book-only items');
select is((select book_only_debit from v_bank_recon), 118.00::numeric, '...P7''s 118 is');
reset role;

select * from finish();
rollback;
