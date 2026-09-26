-- Must pass (Opus review of change 13, migration 20260926110000): salary and wages are owner-only
-- in the ledger too.
--  * a counter user cannot confirm a pay rate by UPDATE: writing the CORRECT value is refused like
--    any other; WHERE / RETURNING on the columns are refused by the column grant; the counter's
--    whitelisted party edits still work; an owner's employee edit still works
--  * salary and wage entries (and a cancellation's reversal) are invisible to a counter as whole
--    entries: no header, no line, no day-book row, no audit row; advances and ordinary expenses
--    stay visible, and every entry a counter can see is complete and balanced
--  * a counter still posts an advance, a sales invoice, a receipt and the day close, and the day
--    close counts the hidden salary cash (the posting functions are not blinded)
--  * an owner (aal2 and, unchanged until change 19, aal1) sees everything
begin;

create extension if not exists pgtap with schema extensions;

select plan(67);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code, monthly_salary, daily_wage)
select v.id::uuid, v.name, v.type::party_type, o.state_code, v.ms, v.dw
from (values
  ('a0000000-0000-0000-0000-000000000001', 'Salary Employee', 'employee', 18000::numeric, null::numeric),
  ('a0000000-0000-0000-0000-000000000002', 'Wage Employee', 'employee', null, 600),
  ('a0000000-0000-0000-0000-000000000003', 'Ordinary Customer', 'customer', null, null)
) v(id, name, type, ms, dw)
cross join (select state_code from organization limit 1) o;

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', 'cement', '2523', 28, 'bag', 400);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 300, 300000, 'opening'
  from warehouses where is_default and not is_transit;

-- Drafts (written as the database owner; posted below by the role that would post them).
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-09-05', 'a0000000-0000-0000-0000-000000000003',
       state_code, 'draft', (select id from warehouses where is_default and not is_transit)
  from organization limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001',
        'UltraTech OPC 53 50kg', '2523', 'bag', 10, 400, 0, 28);

insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status)
values ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-09-05', 'a0000000-0000-0000-0000-000000000003',
        'cash', 30000, (select id from accounts where system_key = 'cash'), 'draft');

insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, period_month) values
  ('b0000000-0000-0000-0000-000000000001', '2026-09-03', 'a0000000-0000-0000-0000-000000000001', 'draft', 'advance', null),
  ('b0000000-0000-0000-0000-000000000002', '2026-09-05', 'a0000000-0000-0000-0000-000000000001', 'draft', 'salary', '2026-09-01'),
  ('b0000000-0000-0000-0000-000000000003', '2026-09-05', 'a0000000-0000-0000-0000-000000000002', 'draft', 'wages', '2026-09-01'),
  ('b0000000-0000-0000-0000-000000000004', '2026-09-05', null, 'draft', 'wages', '2026-09-01'),
  ('b0000000-0000-0000-0000-000000000005', '2026-09-05', null, 'draft', 'expense', null);
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration) values
  ('b0000000-0000-0000-0000-000000000001', 1, (select id from accounts where system_key = 'employee_advance'), 2000, 'advance'),
  ('b0000000-0000-0000-0000-000000000002', 1, (select id from accounts where system_key = 'salaries'), 18000, 'salary'),
  ('b0000000-0000-0000-0000-000000000003', 1, (select id from accounts where system_key = 'loading_unloading'), 1200, 'wages'),
  ('b0000000-0000-0000-0000-000000000004', 1, (select id from accounts where system_key = 'loading_unloading'), 600, 'hamali'),
  ('b0000000-0000-0000-0000-000000000005', 1, (select id from accounts where system_key = 'godown_rent'), 3000, 'rent');

-- ============================================================
-- 1. Pay rates: no UPDATE oracle for a counter user
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select throws_ok($$update parties set monthly_salary = 18000 where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user writing the CORRECT monthly salary is refused (no oracle)');
select throws_ok($$update parties set monthly_salary = 17000 where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'and a wrong one is refused the same way');
select throws_ok($$update parties set daily_wage = 600 where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'the correct daily wage is refused too');
select throws_ok($$update parties set monthly_salary = null where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'clearing the salary is refused');
select throws_ok($$update parties set name = 'Salary Employee', monthly_salary = 18000 where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a pay column alongside a whitelisted one is refused');
select throws_ok($$update parties set daily_wage = null where id = 'a0000000-0000-0000-0000-000000000003'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a pay column in the SET list is refused on any party (a NULL no-op included)');
select throws_ok($$update parties set name = name where monthly_salary = 18000$$,
  '42501', null, 'WHERE on monthly_salary is refused by the column grant (no filter oracle)');
select throws_ok($$update parties set phone = '9000000000' where id = 'a0000000-0000-0000-0000-000000000001' returning monthly_salary$$,
  '42501', null, 'RETURNING monthly_salary is refused by the column grant');
select throws_ok($$insert into parties (id, name, type, state_code)
                   values ('a0000000-0000-0000-0000-000000000003', 'x', 'customer', (select state_code from organization limit 1))
                   on conflict (id) do update set monthly_salary = 18000$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'an upsert that lands on the pay column is refused');
select lives_ok($$update parties set name = 'Customer Renamed', phone = '9000000001', whatsapp_phone = '9000000001'
                  where id = 'a0000000-0000-0000-0000-000000000003'$$,
  'a counter user still edits the whitelisted contact columns');
select is((select name from parties where id = 'a0000000-0000-0000-0000-000000000003'), 'Customer Renamed',
  'the whitelisted edit is stored');
select lives_ok($$update parties set phone = '9000000002' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'a counter user may still change an employee''s phone');
select throws_ok($$update parties set credit_limit = 50000 where id = 'a0000000-0000-0000-0000-000000000003'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'the existing whitelist still refuses credit terms');

-- Owner (aal2): the employee edit (name, phone, both rates in one statement) still works.
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$update parties set monthly_salary = 19000 where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'an owner changes a monthly salary');
select is((select monthly_salary from employee_pay_rates() where party_id = 'a0000000-0000-0000-0000-000000000001'),
  19000.00::numeric, 'the new salary is stored');
select lives_ok($$update parties set name = 'Wage Employee', phone = null, monthly_salary = null, daily_wage = 650
                  where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'an owner''s full employee edit (updateEmployee shape) works');
select is((select daily_wage from employee_pay_rates() where party_id = 'a0000000-0000-0000-0000-000000000002'),
  650.00::numeric, 'the new daily wage is stored');

-- Owner without a second factor: unchanged from before this migration (aal2 in the DB is change 19).
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select lives_ok($$update parties set monthly_salary = 18000 where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'aal1 owner: pay edit behaves as before (known gap, change 19)');

-- ============================================================
-- 2. Postings: a counter posts its documents, the owner posts payroll and cancels one wage
-- ============================================================
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000001')$$, 'counter: an advance of Rs 2,000 posts');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$, 'counter: a sales invoice posts');
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'counter: a cash receipt of Rs 30,000 posts');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000002')$$, 'owner: salary 18,000 posts (recovers the advance)');
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000003')$$, 'owner: named wages 1,200 post');
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000004')$$, 'owner: unnamed hamali 600 posts');
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000005')$$, 'owner: godown rent 3,000 posts');
select lives_ok($$select cancel_document('expense_voucher', 'b0000000-0000-0000-0000-000000000003', 'wrong worker')$$,
  'owner: the named wages are cancelled (a reversal entry with the same source)');

reset role;
set local request.jwt.claims to '';

-- What the owner's ledger holds, taken as the database owner (no RLS).
create temp table _payroll as
select id from journal_entries
where source_type = 'expense_voucher'
  and source_id in ('b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003',
                    'b0000000-0000-0000-0000-000000000004');
create temp table _owner as
select
  (select count(*) from journal_entries)::int as entries,
  (select count(*) from journal_lines)::int as lines,
  (select count(*) from journal_lines where entry_id in (select id from _payroll))::int as payroll_lines,
  (select count(*) from v_day_book)::int as day_book,
  (select balance from v_party_balances where party_id = 'a0000000-0000-0000-0000-000000000003') as customer_balance,
  (select count(*) from v_party_ledger where party_id = 'a0000000-0000-0000-0000-000000000003')::int as customer_ledger,
  (select coalesce(sum(jl.debit) - sum(jl.credit), 0) from journal_lines jl
     join journal_entries je on je.id = jl.entry_id
    where jl.account_id = (select id from accounts where system_key = 'cash')
      and je.entry_date <= '2026-09-05') as cash_expected;
grant select on _payroll, _owner to authenticated;

select is((select count(*)::int from _payroll), 4, 'setup: four payroll entries (salary, wages, its reversal, hamali)');
select is((select count(*)::int from journal_lines jl
           join accounts a on a.id = jl.account_id and a.system_key = 'salary_payable'
           where jl.party_id = 'a0000000-0000-0000-0000-000000000001' and jl.credit = 18000),
  1, 'setup: the salary entry names the employee with the gross (the leak being closed)');
select is((select count(*)::int from audit_log where after->>'voucher_type' in ('salary', 'wages')), 3,
  'setup: three payroll audit rows carry the voucher type and gross');

-- ============================================================
-- 3. Counter user: payroll entries are gone as whole entries, nothing else changes
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select is((select count(*)::int from journal_entries where id in (select id from _payroll)), 0,
  'counter: no payroll journal entry (original, reversal, unnamed hamali)');
select is((select count(*)::int from journal_lines where entry_id in (select id from _payroll)), 0,
  'counter: no line of any payroll entry');
select is((select count(*)::int from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key = 'salary_payable'), 0,
  'counter: no salary_payable line at all');
select is((select count(*)::int from journal_lines jl join accounts a on a.id = jl.account_id
           where a.system_key in ('salaries', 'loading_unloading')), 0,
  'counter: no salary or wage expense line either (the party-less legs of the same amounts)');
select is((select count(*)::int from journal_lines where party_id = 'a0000000-0000-0000-0000-000000000001'), 1,
  'counter: the employee''s only visible line is the advance (Dr employee_advance 2,000), not its recovery');
select is((select count(*)::int from journal_entries), (select entries - 4 from _owner),
  'counter: every other entry is visible');
select is((select count(*)::int from journal_lines), (select lines - payroll_lines from _owner),
  'counter: every other line is visible');
select cmp_ok((select payroll_lines from _owner), '>', 0, 'setup: the payroll entries have lines to hide');
select is((select count(*)::int from journal_lines jl where not exists (select 1 from journal_entries je where je.id = jl.entry_id)), 0,
  'counter: every visible line belongs to a visible entry');
select is((select count(*)::int from (
             select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) u), 0,
  'counter: every visible entry is complete and balanced (no partial entry)');
select is((select count(*)::int from journal_entries je where not exists (select 1 from journal_lines jl where jl.entry_id = je.id)), 0,
  'counter: no visible entry without its lines');
select is((select count(*)::int from v_day_book where entry_id in (select id from _payroll)), 0,
  'counter: v_day_book has no payroll row');
select is((select count(*)::int from v_day_book), (select day_book - 4 from _owner),
  'counter: v_day_book loses exactly the four payroll entries');
select is((select count(*)::int from v_day_book where source_id in ('b0000000-0000-0000-0000-000000000001',
                                                                   'b0000000-0000-0000-0000-000000000005')), 2,
  'counter: the advance and the rent are still in the day book');
select is((select count(*)::int from audit_log where entity_id in ('b0000000-0000-0000-0000-000000000002',
                                                                 'b0000000-0000-0000-0000-000000000003',
                                                                 'b0000000-0000-0000-0000-000000000004')), 0,
  'counter: no audit row of a payroll voucher (post or cancel)');
select is((select count(*)::int from audit_log where after->>'voucher_type' in ('salary', 'wages')), 0,
  'counter: no audit row carries a salary or wage gross');
select is((select count(*)::int from audit_log where entity_id in ('b0000000-0000-0000-0000-000000000001',
                                                                 'b0000000-0000-0000-0000-000000000005')), 2,
  'counter: the advance and rent audit rows are still visible');
select is((select count(*)::int from audit_log where entity = 'sales_invoices'), 1,
  'counter: ordinary audit rows are still visible');
select is((select balance from v_party_balances where party_id = 'a0000000-0000-0000-0000-000000000003'),
  (select customer_balance from _owner), 'counter: v_party_balances is unchanged');
select is((select count(*)::int from v_party_ledger where party_id = 'a0000000-0000-0000-0000-000000000003'),
  (select customer_ledger from _owner), 'counter: v_party_ledger is unchanged');
select is((select count(*)::int from expense_vouchers where id in ('b0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003',
  'b0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000005')), 2,
  'counter: vouchers agree with the ledger (advance and rent only)');
select isnt((select coalesce(sum(jl.debit) - sum(jl.credit), 0) from journal_lines jl
              join journal_entries je on je.id = jl.entry_id
             where jl.account_id = (select id from accounts where system_key = 'cash')
               and je.entry_date <= '2026-09-05'),
  (select cash_expected from _owner), 'counter: the visible cash ledger omits the hidden payroll cash');

-- ============================================================
-- 4. Day close by a counter user counts the hidden cash (definer is not blinded)
-- ============================================================
select is(post_day_close('2026-09-05', (select cash_expected from _owner), 'counted to the rupee'), null::uuid,
  'counter: day close at the owner''s cash figure posts no difference entry');
select is((select expected from day_closes where close_date = '2026-09-05'), (select cash_expected from _owner),
  'day close expected includes the salary and wage cash the counter cannot see');
select is((select difference from day_closes where close_date = '2026-09-05'), 0.00::numeric,
  'day close difference is zero');

-- ============================================================
-- 5. Owners see everything; a non-member sees nothing
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from journal_entries where id in (select id from _payroll)), 4, 'owner: every payroll entry');
select is((select count(*)::int from journal_entries), (select entries from _owner), 'owner: every entry');
select is((select count(*)::int from journal_lines), (select lines from _owner), 'owner: every line');
select is((select count(*)::int from v_day_book), (select day_book from _owner), 'owner: the full day book');
select is((select count(*)::int from audit_log where after->>'voucher_type' in ('salary', 'wages')), 3,
  'owner: the payroll audit rows');
select is((select count(*)::int from hidden_payroll_entry_ids()), 0, 'owner: nothing is hidden from an owner');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from journal_entries where id in (select id from _payroll)), 4,
  'aal1 owner: unchanged, sees payroll entries (known gap, change 19)');

set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from journal_entries), 0, 'non-member: no entry');
select is((select count(*)::int from audit_log), 0, 'non-member: no audit row');

reset role;
set local request.jwt.claims to '';

-- ============================================================
-- 6. Shape
-- ============================================================
select has_trigger('parties', 'parties_pay_guard', 'parties_pay_guard trigger exists');
select ok((select prosecdef from pg_proc where oid = 'public.check_journal_balanced()'::regprocedure),
  'check_journal_balanced runs as definer (not blinded by the session''s RLS)');
select ok((select prosecdef from pg_proc where oid = 'public.check_journal_has_lines()'::regprocedure),
  'check_journal_has_lines runs as definer');
select ok(not has_function_privilege('anon', 'public.hidden_payroll_entry_ids()', 'execute')
          and not has_function_privilege('anon', 'public.hidden_payroll_voucher_ids()', 'execute'),
  'anon cannot call the payroll helpers');

select * from finish();
rollback;
