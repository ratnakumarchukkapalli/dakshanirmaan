-- Change 23 (cash-deposit): post_cash_deposit (Dr bank / Cr cash), its cancellation through
-- cancel_document, and the HDFC set-up.
--
-- Must pass:
--  * a counter user posts a balanced Dr bank / Cr cash entry; an owner below aal2 is refused
--  * bad amounts, future date, locked period, and a day that is already closed are refused
--  * day_close_preview.expected drops by exactly the amount, `deposited` shows it, and a cancelled
--    deposit restores both; the reversal is dated on the deposit's own day
--  * a counter user cannot cancel; an owner can, once; not into a closed day
--  * a deposit larger than the cash the books hold is allowed (warn, not refuse)
--  * the app cannot write cash_deposits directly; anon cannot execute the function
--  * the bank ledger is "HDFC Bank" and go_live_readiness reports bank_set_up
begin;

create extension if not exists pgtap with schema extensions;

select plan(72);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000003', 'Deposit Customer', 'customer', state_code from organization limit 1;
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status) values
  ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-09-05', 'a0000000-0000-0000-0000-000000000003', 'cash', 5000, (select id from accounts where system_key = 'cash'), 'draft');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'counter posts a 5,000 cash receipt on 05-09');
reset role;


-- helpers: act as the counter / the owner (aal2) / the owner who has not done the second step (aal1)
create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
grant execute on function _as_counter(), _as_owner(), _as_owner_aal1() to authenticated;

create function _expected(p_date date) returns numeric language sql as $$
  select expected from day_close_preview(p_date) $$;
create function _deposited(p_date date) returns numeric language sql as $$
  select deposited from day_close_preview(p_date) $$;
grant execute on function _expected(date), _deposited(date) to authenticated;

-- ============================================================
-- Shape
-- ============================================================
select has_table('public', 'cash_deposits', 'cash_deposits exists');
select has_column('public', 'cash_deposits', c, 'cash_deposits.' || c || ' exists')
from unnest(array['id', 'deposit_date', 'amount', 'reference', 'note', 'status', 'journal_entry_id', 'created_by']) as c;
select ok('cash_deposit' = any (enum_range(null::source_type)::text[]), 'source_type has cash_deposit');
select is((select name from accounts where system_key = 'bank'), 'HDFC Bank', 'the bank ledger is named HDFC Bank');
select ok(not has_function_privilege('anon', 'public.post_cash_deposit(date, numeric, text, text)', 'EXECUTE'),
          'anon cannot execute post_cash_deposit');
select ok(has_function_privilege('authenticated', 'public.post_cash_deposit(date, numeric, text, text)', 'EXECUTE'),
          'authenticated can execute post_cash_deposit');

-- ============================================================
-- Happy path: a counter user deposits 2,000 of the 5,000 on 05-09
-- ============================================================
set local role authenticated;
select _as_counter();
select is(_expected('2026-09-05'), 5000.00::numeric, 'before the deposit the drawer should hold 5,000');

create temp table _d1 as select post_cash_deposit('2026-09-05', 2000, ' SLIP-123 ', 'Monday deposit') as id;
grant select on _d1 to authenticated;
select isnt((select id from _d1), null, 'the counter user posts a deposit and gets its id');
select is((select amount from cash_deposits where id = (select id from _d1)), 2000.00::numeric, 'the deposit row holds the amount');
select is((select reference from cash_deposits where id = (select id from _d1)), 'SLIP-123', 'the slip reference is trimmed');
select is((select status::text from cash_deposits where id = (select id from _d1)), 'posted', 'the deposit is posted');
select is((select created_by from cash_deposits where id = (select id from _d1)),
          '44444444-4444-4444-4444-444444444444'::uuid, 'created_by is the signed-in user');

select is(_expected('2026-09-05'), 3000.00::numeric, 'expected drops by exactly the amount: 5,000 - 2,000');
select is(_deposited('2026-09-05'), 2000.00::numeric, 'the day-close preview shows 2,000 as banked');
select is((select cash_out from day_close_preview('2026-09-05')), 0.00::numeric, 'a deposit is not counted as cash out');
select is(_expected('2026-09-06'), 3000.00::numeric, 'the next day opens with 3,000');

reset role;
select is((select source_type::text from journal_entries where id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          'cash_deposit', 'the entry is a cash_deposit entry');
select is((select source_id from journal_entries where id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          (select id from _d1), 'the entry points back at the deposit');
select is((select entry_date from journal_entries where id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          '2026-09-05'::date, 'the entry is dated on the deposit date');
select is((select sum(debit) from journal_lines where entry_id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          (select sum(credit) from journal_lines where entry_id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          'debits equal credits');
select is((select debit from journal_lines jl join accounts a on a.id = jl.account_id
            where jl.entry_id = (select journal_entry_id from cash_deposits where id = (select id from _d1)) and a.system_key = 'bank'),
          2000.00::numeric, 'Dr bank 2,000');
select is((select credit from journal_lines jl join accounts a on a.id = jl.account_id
            where jl.entry_id = (select journal_entry_id from cash_deposits where id = (select id from _d1)) and a.system_key = 'cash'),
          2000.00::numeric, 'Cr cash 2,000');
select is((select count(*)::int from audit_log where entity = 'cash_deposits' and entity_id = (select id from _d1) and action = 'post'),
          1, 'the posting is audit-logged');

-- ============================================================
-- Refusals on post
-- ============================================================
set local role authenticated;
select _as_owner_aal1();
select throws_ok($$select post_cash_deposit('2026-09-05', 100, null, null)$$, 'P0001', 'DN_FORBIDDEN',
                 'an owner who has not done the second step cannot post');
select _as_counter();
select throws_ok($$select post_cash_deposit('2026-09-05', 0, null, null)$$, 'P0001', 'DN_VALIDATION:invalid_amount', 'zero is refused');
select throws_ok($$select post_cash_deposit('2026-09-05', -5, null, null)$$, 'P0001', 'DN_VALIDATION:invalid_amount', 'negative is refused');
select throws_ok($$select post_cash_deposit('2026-09-05', null, null, null)$$, 'P0001', 'DN_VALIDATION:invalid_amount', 'null amount is refused');
select throws_ok($$select post_cash_deposit('2026-09-05', 10.001, null, null)$$, 'P0001', 'DN_VALIDATION:invalid_amount', 'a third decimal is refused');
select throws_ok($$select post_cash_deposit(null, 100, null, null)$$, 'P0001', 'DN_VALIDATION:invalid_date', 'no date is refused');
select throws_ok($$select post_cash_deposit('2099-01-01', 100, null, null)$$, 'P0001', 'DN_VALIDATION:future_date', 'a future date is refused');
select throws_ok($$select post_cash_deposit('2026-09-05', 100, repeat('x', 61), null)$$, 'P0001', 'DN_VALIDATION:reference_too_long', 'a 61-character reference is refused');
select throws_ok($$select post_cash_deposit('2026-09-05', 100, null, repeat('x', 501))$$, 'P0001', 'DN_VALIDATION:note_too_long', 'a 501-character note is refused');
select _as_counter();
reset role;

-- a stranger (no membership) is refused
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}';
select throws_ok($$select post_cash_deposit('2026-09-05', 100, null, null)$$, 'P0001', 'DN_FORBIDDEN', 'a non-member cannot post');
select is((select count(*)::int from cash_deposits), 0, 'a non-member reads no deposits');
reset role;

-- locked period
update fiscal_periods set is_locked = true where month = '2026-08-01';
set local role authenticated;
select _as_counter();
select throws_ok($$select post_cash_deposit('2026-08-10', 100, null, null)$$, 'P0001', 'DN_PERIOD_LOCKED', 'a locked period is refused');
reset role;
update fiscal_periods set is_locked = false where month = '2026-08-01';

-- ============================================================
-- Direct writes are closed to the app
-- ============================================================
set local role authenticated;
select _as_owner();
select throws_ok(
  $$insert into cash_deposits (deposit_date, amount, journal_entry_id)
    select '2026-09-05', 1, journal_entry_id from cash_deposits limit 1$$,
  '42501', null, 'even an owner cannot insert a deposit row directly');
select throws_ok($$update cash_deposits set amount = 1$$, '42501', null, 'nor update one');
select throws_ok($$delete from cash_deposits$$, '42501', null, 'nor delete one');
select is((select count(*)::int from cash_deposits), 1, 'members can read deposits');
reset role;

-- ============================================================
-- Cancel: counter refused, owner below aal2 refused, owner at aal2 restores the figures
-- ============================================================
set local role authenticated;
select _as_counter();
select throws_ok($$select cancel_document('cash_deposit', (select id from _d1), 'oops')$$, 'P0001', 'DN_FORBIDDEN',
                 'a counter user cannot cancel a deposit');
select _as_owner_aal1();
select throws_ok($$select cancel_document('cash_deposit', (select id from _d1), 'oops')$$, 'P0001', 'DN_FORBIDDEN',
                 'an owner below aal2 cannot cancel');
select _as_owner();
select throws_ok($$select cancel_document('cash_deposit', gen_random_uuid(), 'oops')$$, 'P0001', 'DN_NOT_POSTED',
                 'cancelling a deposit that does not exist is refused');
select lives_ok($$select cancel_document('cash_deposit', (select id from _d1), 'wrong amount')$$, 'the owner cancels the deposit');
select is(_expected('2026-09-05'), 5000.00::numeric, 'expected returns to 5,000 after the cancel');
-- The reversal (Dr cash / Cr bank) is a cash receipt as far as the day's gross figures go, and the
-- original's Cr cash stays "banked": the two net out, which is what `expected` shows.
select is((select cash_in from day_close_preview('2026-09-05')), 7000.00::numeric, 'the reversal counts as 2,000 cash in, cancelling the 2,000 banked');
select is(_expected('2026-09-06'), 5000.00::numeric, 'the next day opens with 5,000 again');
select throws_ok($$select cancel_document('cash_deposit', (select id from _d1), 'again')$$, 'P0001', 'DN_NOT_POSTED',
                 'a second cancel is refused');
reset role;
select is((select status::text from cash_deposits where id = (select id from _d1)), 'cancelled', 'the row is kept, as cancelled');
select is((select entry_date from journal_entries where reversed_by is not null
            and id = (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          '2026-09-05'::date, 'the original entry is marked reversed');
select is((select entry_date from journal_entries
            where source_type = 'cash_deposit' and source_id = (select id from _d1) and reversed_by is null
              and id <> (select journal_entry_id from cash_deposits where id = (select id from _d1))),
          '2026-09-05'::date, 'the reversal is dated on the deposit''s own day');
select is((select count(*)::int from audit_log where entity = 'cash_deposits' and entity_id = (select id from _d1) and action = 'cancel'),
          1, 'the cancellation is audit-logged');

-- ============================================================
-- A day that is already closed cannot be changed by a deposit or its cancellation
-- ============================================================
set local role authenticated;
select _as_counter();
create temp table _d2 as select post_cash_deposit('2026-09-05', 2000, 'SLIP-2', null) as id;
grant select on _d2 to authenticated;
select _as_owner();
select lives_ok($$select post_day_close('2026-09-05', 3000, 'counted')$$, 'the owner closes 05-09 with 3,000 counted');
select _as_counter();
select throws_ok($$select post_cash_deposit('2026-09-05', 100, null, null)$$, 'P0001', 'DN_VALIDATION:day_closed',
                 'a deposit into the closed day is refused');
select throws_ok($$select post_cash_deposit('2026-09-04', 100, null, null)$$, 'P0001', 'DN_VALIDATION:day_closed',
                 'so is one dated before a closed day (it would move that day''s opening cash)');
select lives_ok($$select post_cash_deposit('2026-09-06', 500, null, null)$$, 'a day after the closed one is fine');
select _as_owner();
select throws_ok($$select cancel_document('cash_deposit', (select id from _d2), 'x')$$, 'P0001', 'DN_VALIDATION:day_closed',
                 'cancelling a deposit inside a closed day is refused');
select lives_ok($$select cancel_document('day_close', (select id from day_closes where close_date = '2026-09-05' and status = 'posted'), 'reopen')$$,
                'reopening the day (owner) lifts the block');
select lives_ok($$select cancel_document('cash_deposit', (select id from _d2), 'x')$$, 'and the deposit can then be cancelled');
reset role;

-- ============================================================
-- Warn, not refuse: more than the books say is in the drawer
-- ============================================================
set local role authenticated;
select _as_counter();
select lives_ok($$select post_cash_deposit('2026-09-10', 50000, 'BIG', null)$$, 'a deposit above the cash the ledger holds is accepted');
select ok(_expected('2026-09-10') < 0, 'and the day-close figure then shows a negative drawer for the owner to see');
reset role;

-- ============================================================
-- Whole ledger still balances; go-live check
-- ============================================================
select is((select sum(debit) from journal_lines), (select sum(credit) from journal_lines), 'the ledger is balanced');

set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'bank_set_up'), false, 'bank_set_up is open while no UPI id is set');
reset role;
update organization set upi_vpa = 'daksha@hdfcbank';
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'bank_set_up'), true, 'bank_set_up passes once the UPI id is set and the ledger is named');
reset role;
update accounts set name = 'Bank' where system_key = 'bank';
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'bank_set_up'), false, 'and fails again if the ledger is still called just "Bank"');
reset role;

select * from finish();
rollback;
