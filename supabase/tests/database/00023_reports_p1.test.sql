-- Change 15 (reports-p1): day_close_preview and v_money_ledger, plus a has_column drift guard for every
-- column of every view/table the report screens select (the Supabase client is untyped, so a wrong
-- column name only ever fails at runtime; this makes it fail here, against the real database).
--
-- Must pass:
--  * day_close_preview returns exactly what post_day_close then stores (opening, in, out, banked,
--    expected), for a counter whose own reading of the cash ledger is missing the payroll entry
--  * it is for active members only (anon / service_role cannot execute it; a stranger and an
--    inactive user are refused)
--  * v_money_ledger is owner-only, its running balance ends at the account's balance and the last
--    row before a date is that date's opening balance
--  * the ageing screen's receivables add up to the AR control account
begin;

create extension if not exists pgtap with schema extensions;

select plan(120);

-- ============================================================
-- Drift guard: every column the report screens read (src/lib/reports-data.ts)
-- ============================================================
select has_column('public', 'v_day_book', c, 'v_day_book.' || c || ' exists')
from unnest(array['entry_id', 'entry_date', 'entry_no', 'source_type', 'doc_no', 'narration', 'total_debit', 'is_reversal', 'is_reversed']) as c;
select has_column('public', 'v_party_aging', c, 'v_party_aging.' || c || ' exists')
from unnest(array['party_id', 'party_name', 'bucket_0_30', 'bucket_31_60', 'bucket_61_90', 'bucket_90_plus', 'unallocated', 'unapplied_discount', 'interest', 'ar_balance']) as c;
select has_column('public', 'v_stock_summary', c, 'v_stock_summary.' || c || ' exists')
from unnest(array['item_id', 'item_name', 'category', 'base_uom', 'warehouse_id', 'warehouse_name', 'qty', 'avg_rate', 'value']) as c;
select has_column('public', 'v_stock_summary_all', 'value', 'v_stock_summary_all.value exists');
select has_column('public', 'v_trial_balance', c, 'v_trial_balance.' || c || ' exists')
from unnest(array['system_key', 'closing']) as c;
select has_column('public', 'v_money_balances', c, 'v_money_balances.' || c || ' exists')
from unnest(array['account_id', 'name', 'system_key', 'code']) as c;
select has_column('public', 'v_money_ledger', c, 'v_money_ledger.' || c || ' exists')
from unnest(array['account_id', 'line_id', 'entry_date', 'entry_no', 'line_no', 'doc_no', 'narration', 'is_reversal', 'debit', 'credit', 'running_balance']) as c;
select has_column('public', 'day_closes', c, 'day_closes.' || c || ' exists')
from unnest(array['id', 'close_date', 'expected', 'counted', 'difference', 'status', 'note', 'closed_by', 'closed_at']) as c;

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'gone@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'user', 'Gone Staff', false, 'gone@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000003', 'Report Customer', 'customer', state_code from organization limit 1;
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'Report Cement 50kg', 'cement', '2523', 28, 'bag', 400);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 300, 300000, 'opening'
  from warehouses where is_default and not is_transit;

-- 05-09: a 5,000 cash receipt (counter), an unnamed hamali of 600 in cash (payroll: hidden from a
-- counter), and 2,000 banked (Dr Bank / Cr Cash, an ordinary expense voucher). Expected drawer 2,400.
-- 06-09: another 1,000 cash receipt. An invoice of 5,120 on 05-09 is left unpaid.
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-09-05', 'a0000000-0000-0000-0000-000000000003',
       state_code, 'draft', (select id from warehouses where is_default and not is_transit)
  from organization limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 'Report Cement 50kg', '2523', 'bag', 10, 400, 0, 28);

insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status) values
  ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-09-05', 'a0000000-0000-0000-0000-000000000003', 'cash', 5000, (select id from accounts where system_key = 'cash'), 'draft'),
  ('e0000000-0000-0000-0000-000000000002', 'receipt', '2026-09-06', 'a0000000-0000-0000-0000-000000000003', 'cash', 1000, (select id from accounts where system_key = 'cash'), 'draft');
insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, period_month, pay_account_id) values
  ('b0000000-0000-0000-0000-000000000004', '2026-09-05', null, 'draft', 'wages', '2026-09-01', (select id from accounts where system_key = 'cash')),
  ('b0000000-0000-0000-0000-000000000005', '2026-09-05', null, 'draft', 'expense', null, (select id from accounts where system_key = 'cash'));
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration) values
  ('b0000000-0000-0000-0000-000000000004', 1, (select id from accounts where system_key = 'loading_unloading'), 600, 'hamali'),
  ('b0000000-0000-0000-0000-000000000005', 1, (select id from accounts where system_key = 'bank'), 2000, 'banked');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$, 'counter posts the unpaid invoice');
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'counter posts the 5,000 cash receipt');
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000002')$$, 'counter posts the 1,000 cash receipt on 06-09');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000004')$$, 'owner posts the 600 hamali in cash');
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000005')$$, 'owner banks 2,000');
reset role;

-- ============================================================
-- day_close_preview: a counter cannot add up the cash ledger, the function can
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select is((select sum(jl.debit - jl.credit) from journal_lines jl join journal_entries je on je.id = jl.entry_id
           where jl.account_id = (select id from accounts where system_key = 'cash') and je.entry_date = '2026-09-05'),
  3000.00::numeric, 'a counter reading the cash ledger directly sees 3,000 for 05-09: the hidden hamali is missing (why the preview is SECURITY DEFINER)');

create temp table _counter_prev as select * from day_close_preview('2026-09-05');
grant select on _counter_prev to authenticated;
select is((select opening_cash from _counter_prev), 0.00::numeric, 'counter preview: opening 0');
select is((select cash_in from _counter_prev), 5000.00::numeric, 'counter preview: cash in 5,000');
select is((select cash_out from _counter_prev), 600.00::numeric, 'counter preview: cash out 600 (the payroll cash the counter cannot see line by line)');
select is((select deposited from _counter_prev), 2000.00::numeric, 'counter preview: banked 2,000');
select is((select expected from _counter_prev), 2400.00::numeric, 'counter preview: expected = 0 + 5,000 - 600 - 2,000 = 2,400');
select is((select close_date from _counter_prev), '2026-09-05'::date, 'the preview echoes the date');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select expected from day_close_preview('2026-09-05')), 2400.00::numeric, 'owner preview equals the counter preview');
select is((select count(*)::int from day_close_preview('2026-09-05')), 1, 'exactly one row');
select is((select expected from day_close_preview('2026-01-01')), 0.00::numeric, 'a day with no cash is all zeros');
select is((select opening_cash from day_close_preview('2026-09-06')), 2400.00::numeric, 'the next day opens with the previous closing balance');

-- ---- drift guard: the close stores exactly what the preview said ----
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_day_close('2026-09-05', 2400, 'matches')$$, 'counter closes 05-09 with the counted cash');
reset role;
select is((select opening_cash from day_closes where close_date = '2026-09-05'), (select opening_cash from _counter_prev), 'stored opening_cash = preview');
select is((select cash_in from day_closes where close_date = '2026-09-05'), (select cash_in from _counter_prev), 'stored cash_in = preview');
select is((select cash_out from day_closes where close_date = '2026-09-05'), (select cash_out from _counter_prev), 'stored cash_out = preview');
select is((select deposited from day_closes where close_date = '2026-09-05'), (select deposited from _counter_prev), 'stored deposited = preview');
select is((select expected from day_closes where close_date = '2026-09-05'), (select expected from _counter_prev), 'stored expected = preview');

-- A second day with a difference: the preview taken before is what gets stored.
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
create temp table _prev6 as select * from day_close_preview('2026-09-06');
grant select on _prev6 to authenticated;
select is((select expected from _prev6), 3400.00::numeric, '06-09 preview: 2,400 + 1,000 = 3,400');
select lives_ok($$select post_day_close('2026-09-06', 3300, 'short 100')$$, 'counter closes 06-09 short by 100');
reset role;
select is((select expected from day_closes where close_date = '2026-09-06'), (select expected from _prev6), '06-09 stored expected = the preview taken before');
select is((select difference from day_closes where close_date = '2026-09-06'), -100.00::numeric, '06-09 difference = counted 3,300 - expected 3,400');
select is((select opening_cash from day_closes where close_date = '2026-09-06'), (select opening_cash from _prev6), '06-09 stored opening = preview');

-- ============================================================
-- day_close_preview: who may call it
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}';
select throws_ok($$select * from day_close_preview('2026-09-05')$$, 'P0001', 'DN_FORBIDDEN', 'an authenticated stranger (no app_users row) is refused');
set local request.jwt.claims to '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated","aal":"aal1"}';
select throws_ok($$select * from day_close_preview('2026-09-05')$$, 'P0001', 'DN_FORBIDDEN', 'a disabled user is refused');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok($$select * from day_close_preview(null)$$, 'P0001', 'DN_VALIDATION:invalid_date', 'a null date is refused');
reset role;
set local role anon;
select throws_ok($$select * from day_close_preview('2026-09-05')$$, '42501', null, 'anon cannot execute it');
reset role;
select is(has_function_privilege('anon', 'public.day_close_preview(date)', 'execute'), false, 'grants: not anon');
select is(has_function_privilege('service_role', 'public.day_close_preview(date)', 'execute'), false, 'grants: not service_role');
select is(has_function_privilege('authenticated', 'public.day_close_preview(date)', 'execute'), true, 'grants: authenticated');
select is((select prosecdef from pg_proc where proname = 'day_close_preview'), true, 'it is SECURITY DEFINER (so a counter gets the payroll cash too)');

-- ============================================================
-- v_money_ledger: owner-only, running balance, opening balance of a range
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from v_money_ledger where account_key = 'bank'), 1, 'owner: one bank line (the 2,000 deposit)');
select is((select debit from v_money_ledger where account_key = 'bank'), 2000.00::numeric, 'owner: the bank line is a 2,000 debit');
select is((select running_balance from v_money_ledger where account_key = 'bank'), 2000.00::numeric, 'owner: the bank running balance is 2,000');
select is((select running_balance from v_money_ledger where account_key = 'cash' order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
          (select balance from v_money_balances where system_key = 'cash'), 'owner: the last cash running balance = the cash balance of v_money_balances');
select is((select running_balance from v_money_ledger where account_key = 'cash' and entry_date < '2026-09-06' order by entry_date desc, entry_no desc, line_no desc, line_id desc limit 1),
          2400.00::numeric, 'owner: the last line before 06-09 is the 2,400 opening balance of that day');
select is((select count(*)::int from v_money_ledger where account_key not in ('cash', 'bank')), 0, 'owner: only money accounts appear');
select is((select sum(debit - credit) from v_money_ledger where account_key = 'cash'), (select balance from v_money_balances where system_key = 'cash'), 'owner: the ledger nets to the balance');
select is((select count(*)::int from v_money_ledger where is_reversal), 0, 'no reversals yet');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from v_money_ledger), 0, 'counter: the cash and bank book is empty');
reset role;

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'v_money_ledger' and c.relkind = 'v'
             and coalesce(c.reloptions @> array['security_invoker=true'], false)), 1, 'v_money_ledger is security_invoker');
select is((select count(*)::int from pg_class c where c.relname = 'v_money_ledger'
             and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('service_role', c.oid, 'select')
                  or has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update')
                  or has_table_privilege('authenticated', c.oid, 'delete') or not has_table_privilege('authenticated', c.oid, 'select'))), 0,
  'v_money_ledger grants: SELECT to authenticated only');

-- ============================================================
-- Ageing: the parties' receivables add up to the AR control account
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select sum(ar_balance) from v_party_aging), (select closing from v_trial_balance where system_key = 'ar'),
  'owner: sum of the parties'' receivables = the AR control account (5,120 invoice - 6,000 receipts = -880)');
select is((select ar_balance from v_party_aging where party_id = 'a0000000-0000-0000-0000-000000000003'), -880.00::numeric, 'the customer''s receivable is -880 (overpaid on account)');
select is((select unallocated from v_party_aging where party_id = 'a0000000-0000-0000-0000-000000000003'), 6000.00::numeric, 'both receipts are unallocated: 6,000 on account');
select is((select bucket_0_30 + bucket_31_60 + bucket_61_90 + bucket_90_plus from v_party_aging where party_id = 'a0000000-0000-0000-0000-000000000003'), 5120.00::numeric, 'the open invoice is in the buckets');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from v_party_aging), 1, 'counter reads the ageing');
select is((select count(*)::int from v_trial_balance), 0, 'counter has no trial balance (the reconciliation chip is owner-only)');
select is((select count(*)::int from v_day_book where entry_date = '2026-09-05'), 3, 'counter day book for 05-09: invoice, receipt, banking (the hamali is hidden)');
reset role;


-- ============================================================
-- Opus review fixes: expected-figure guard, counter closes in order, preview refuses the future
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok($$select * from day_close_preview('2999-01-01')$$, 'P0001', 'DN_VALIDATION:future_date', 'the preview refuses a future date like the close does');

-- 06-09 and 05-09 are closed. Post a cash receipt dated 07-09 by the owner, then let the counter close 07-09
-- against a stale expected figure.
reset role;
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status)
values ('e0000000-0000-0000-0000-000000000003', 'receipt', '2026-09-07', 'a0000000-0000-0000-0000-000000000003', 'cash', 700,
        (select id from accounts where system_key = 'cash'), 'draft');
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000003')$$, 'a 700 receipt is posted on 07-09');
select throws_ok($$select post_day_close('2026-09-07', 4000, null, 3300)$$, 'P0001', 'DN_VALIDATION:expected_changed',
  'a close whose expected figure moved since the screen showed it is refused (the screen said 3,300; the 700 receipt made it 4,000)');
select is((select count(*)::int from day_closes where close_date = '2026-09-07'), 0, 'the refused close left nothing behind');
select lives_ok($$select post_day_close('2026-09-07', 4000, null, 4000)$$, 'with the right expected figure the close goes through');
select is((select expected from day_closes where close_date = '2026-09-07'), 4000.00::numeric, 'expected 4,000 stored: 3,300 left after the short 06-09 close + the 700 receipt');

-- a counter cannot close an earlier day after a later one is closed; an owner still can (change 05 spec)
select throws_ok($$select post_day_close('2026-09-04', 0)$$, 'P0001', 'DN_VALIDATION:later_close_exists', 'a counter cannot close 04-09 while 05-09, 06-09 and 07-09 are closed');
select is((select count(*)::int from day_closes where close_date = '2026-09-04'), 0, 'nothing was stored');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_day_close('2026-09-04', 0)$$, 'an owner can still close an earlier day (out-of-order closing stays possible for owners)');
-- the 3-argument call form still works (no expected figure = no check)
select is((select count(*)::int from pg_proc where proname = 'post_day_close'), 1, 'exactly one post_day_close is left (the old 3-argument function was replaced)');
select is(has_function_privilege('anon', 'public.post_day_close(date, numeric, text, numeric)', 'execute'), false, 'grants: post_day_close not for anon');
select is(has_function_privilege('authenticated', 'public.post_day_close(date, numeric, text, numeric)', 'execute'), true, 'grants: post_day_close for authenticated');
reset role;

select * from finish();
rollback;
