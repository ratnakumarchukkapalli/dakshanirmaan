-- Change 22 (bank-recon): post_bank_expense books an unmatched bank debit as an expense voucher
-- paid from the bank and matches the line to it, in one transaction.
--
-- Must pass: happy path (balanced entry, voucher posted, amount = the line's debit, line matched,
-- default account Bank Charges); a second call is refused and creates nothing; a credit line is
-- refused; non-expense / group / bank / AR-control / engine-owned accounts are refused; counter and
-- owner at aal1 refused; a locked month refused with nothing left behind.
begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
grant execute on function _as_owner(), _as_owner_aal1(), _as_counter() to authenticated;

create function _bl(p_ref text) returns uuid language sql stable security definer set search_path = public as $$
  select id from bank_statement_lines where reference = p_ref $$;
create function _acct(p_key text) returns uuid language sql stable as $$
  select id from accounts where system_key = p_key $$;
grant execute on function _bl(text), _acct(text) to authenticated;

select ok(not has_function_privilege('anon', 'public.post_bank_expense(uuid, uuid, text)', 'EXECUTE'), 'anon cannot execute post_bank_expense');

set local role authenticated;
select _as_owner();
select import_bank_statement(_acct('bank'), 's.txt', '[
  {"txnDate":"2026-08-20","narration":"FEE-AUG","reference":"AUG1","debit":"50.00","credit":"0.00","balance":"1000.00"},
  {"txnDate":"2026-09-06","narration":"FEE-ATM CASH(1TXN)","reference":"FEE1","debit":"250.00","credit":"0.00","balance":"750.00"},
  {"txnDate":"2026-09-07","narration":"NEFT CR-X","reference":"CR1","debit":"0.00","credit":"100.00","balance":"850.00"},
  {"txnDate":"2026-09-08","narration":"NEFT DR-RENT","reference":"RENT1","debit":"40.00","credit":"0.00","balance":"810.00"}
]'::jsonb);
reset role;
update fiscal_periods set is_locked = true where month = '2026-08-01';

-- ============================================================
-- Roles
-- ============================================================
set local role authenticated;
select _as_counter();
select throws_ok($$select post_bank_expense(_bl('FEE1'))$$, 'P0001', 'DN_FORBIDDEN', 'counter: refused');
select _as_owner_aal1();
select throws_ok($$select post_bank_expense(_bl('FEE1'))$$, 'P0001', 'DN_FORBIDDEN', 'owner at aal1: refused');

-- ============================================================
-- Happy path (default account)
-- ============================================================
select _as_owner();
create temp table _r as select post_bank_expense(_bl('FEE1'), null, ' ATM fee ') as r;
grant select on _r to authenticated;
reset role;
select is((select status::text from expense_vouchers where id = (select (r ->> 'voucher_id')::uuid from _r)), 'posted', 'the voucher is posted');
select is((select voucher_date from expense_vouchers where id = (select (r ->> 'voucher_id')::uuid from _r)), '2026-09-06'::date, 'dated on the line''s txn date');
select is((select pay_account_id from expense_vouchers where id = (select (r ->> 'voucher_id')::uuid from _r)), _acct('bank'), 'paid from the statement''s bank');
select is((select account_id from expense_voucher_lines where voucher_id = (select (r ->> 'voucher_id')::uuid from _r)), _acct('bank_charges'), 'default account is Bank Charges');
select is((select amount from expense_voucher_lines where voucher_id = (select (r ->> 'voucher_id')::uuid from _r)), 250.00::numeric, 'amount = the line''s debit');
select is((select narration from expense_voucher_lines where voucher_id = (select (r ->> 'voucher_id')::uuid from _r)), 'ATM fee', 'the note becomes the line narration, trimmed');
select is((select journal_entry_id from expense_vouchers where id = (select (r ->> 'voucher_id')::uuid from _r)), (select (r ->> 'entry_id')::uuid from _r), 'entry_id returned');
select is((select sum(debit) - sum(credit) from journal_lines where entry_id = (select (r ->> 'entry_id')::uuid from _r)), 0.00::numeric, 'the entry balances');
select is((select credit from journal_lines where entry_id = (select (r ->> 'entry_id')::uuid from _r) and account_id = _acct('bank')), 250.00::numeric, 'Cr bank 250');
select is((select debit from journal_lines where entry_id = (select (r ->> 'entry_id')::uuid from _r) and account_id = _acct('bank_charges')), 250.00::numeric, 'Dr Bank Charges 250');
select is((select matched_entry_id from bank_statement_lines where id = _bl('FEE1')), (select (r ->> 'entry_id')::uuid from _r), 'the line is matched to it');
select is((select match_status from bank_statement_lines where id = _bl('FEE1')), 'manual', '...as manual');
select is((select (r ->> 'line_id')::uuid from _r), _bl('FEE1'), 'line_id returned');

-- ============================================================
-- Second call, credit line, accounts
-- ============================================================
set local role authenticated;
select _as_owner();
select throws_ok($$select post_bank_expense(_bl('FEE1'))$$, 'P0001', 'DN_VALIDATION:line_not_unmatched', 'a second call on the same line is refused');
reset role;
select is((select count(*)::int from expense_vouchers), 1, '...and creates no second voucher');
set local role authenticated;
select _as_owner();
select throws_ok($$select post_bank_expense(_bl('CR1'))$$, 'P0001', 'DN_VALIDATION:line_not_debit', 'a credit line is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), (select id from accounts where code = '4100'))$$, 'P0001', 'DN_VALIDATION:invalid_account', 'an income account is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), (select id from accounts where code = '5000'))$$, 'P0001', 'DN_VALIDATION:invalid_account', 'a group account is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), _acct('bank'))$$, 'P0001', 'DN_VALIDATION:invalid_account', 'the bank account is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), _acct('ar'))$$, 'P0001', 'DN_VALIDATION:invalid_account', 'the AR control account is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), _acct('cogs'))$$, 'P0001', 'DN_VALIDATION:invalid_account', 'COGS (engine-owned) is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), gen_random_uuid())$$, 'P0001', 'DN_VALIDATION:invalid_account', 'an unknown account is refused');
select throws_ok($$select post_bank_expense(_bl('RENT1'), null, repeat('x', 201))$$, 'P0001', 'DN_VALIDATION:note_too_long', 'a 201-character note is refused');
select is((post_bank_expense(_bl('RENT1'), _acct('godown_rent'), 'Godown rent') ->> 'line_id')::uuid, _bl('RENT1'), 'another expense ledger (Godown Rent) is accepted');

-- ============================================================
-- Locked month
-- ============================================================
select throws_ok($$select post_bank_expense(_bl('AUG1'))$$, 'P0001', 'DN_PERIOD_LOCKED', 'a line in a locked month is refused');
reset role;
select is((select count(*)::int from expense_vouchers where voucher_date = '2026-08-20'), 0, '...and leaves no voucher behind');
select is((select match_status from bank_statement_lines where id = _bl('AUG1')), 'unmatched', '...and the line unmatched');

select * from finish();
rollback;
