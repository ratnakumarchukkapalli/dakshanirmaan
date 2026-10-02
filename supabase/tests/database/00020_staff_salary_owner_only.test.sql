-- Must pass (change 13, parties/stock/staff UI): salary and wage data are owner-only in the database.
--  * a counter user cannot read parties.monthly_salary / daily_wage, but every other column still works
--  * salary and wage vouchers (and their lines) are invisible to a counter user; expense/advance vouchers are not
--  * employee_pay_rates() and v_employees return the rates and balances to an owner and nothing to anyone else
--  * has_column drift guard: every column the parties, stock and staff screens read exists
begin;

create extension if not exists pgtap with schema extensions;

select plan(188);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code, monthly_salary, daily_wage) values
  ('a0000000-0000-0000-0000-000000000001', 'Salary Employee', 'employee', '37', 18000, null),
  ('a0000000-0000-0000-0000-000000000002', 'Wage Employee', 'employee', '37', null, 600),
  ('a0000000-0000-0000-0000-000000000003', 'Ordinary Customer', 'customer', '37', null, null);

-- Vouchers written directly as the database owner (what the posting function leaves behind); the
-- advance is then posted for real below so v_employees has a balance to show.
insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, period_month) values
  ('b0000000-0000-0000-0000-000000000001', '2026-09-01', 'a0000000-0000-0000-0000-000000000001', 'draft', 'salary', '2026-09-01'),
  ('b0000000-0000-0000-0000-000000000002', '2026-09-02', 'a0000000-0000-0000-0000-000000000002', 'draft', 'wages', '2026-09-01'),
  ('b0000000-0000-0000-0000-000000000003', '2026-09-03', null, 'draft', 'expense', null);
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount)
select v.id, 1, (select id from accounts where code = '5500'), 100
from expense_vouchers v;
-- Security pass (20261011100000): lines are written while the voucher is a draft, then it is marked posted.
update expense_vouchers set status = 'posted';

-- ============================================================
-- Owner: sees the rates, the vouchers, and the staff list
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

-- A real advance through the posting function, so the balance is a ledger fact.
insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type)
values ('b0000000-0000-0000-0000-000000000004', '2026-09-04', 'a0000000-0000-0000-0000-000000000001', 'draft', 'advance');
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
values ('b0000000-0000-0000-0000-000000000004', 1, (select id from accounts where system_key = 'employee_advance'), 2000, 'advance');
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000004')$$, 'an advance posts');

select is((select count(*)::int from employee_pay_rates()), 2, 'an owner reads both employees'' pay rates');
select is((select monthly_salary from employee_pay_rates() where party_id = 'a0000000-0000-0000-0000-000000000001'),
  18000.00::numeric, 'the monthly salary comes through employee_pay_rates()');
select is((select daily_wage from employee_pay_rates() where party_id = 'a0000000-0000-0000-0000-000000000002'),
  600.00::numeric, 'the daily wage comes through employee_pay_rates()');
select is((select count(*)::int from v_employees), 2, 'v_employees lists both employees to an owner (no customer)');
select is((select advance_balance from v_employees where party_id = 'a0000000-0000-0000-0000-000000000001'),
  2000.00::numeric, 'v_employees: the posted advance is the employee''s advance balance');
select is((select payable_balance from v_employees where party_id = 'a0000000-0000-0000-0000-000000000001'),
  0.00::numeric, 'v_employees: nothing payable');
select is((select monthly_salary from v_employees where party_id = 'a0000000-0000-0000-0000-000000000001'),
  18000.00::numeric, 'v_employees carries the pay rate to an owner');
select is((select count(*)::int from expense_vouchers where voucher_type in ('salary', 'wages')), 2,
  'an owner sees the salary and wage vouchers');
select is((select count(*)::int from expense_voucher_lines), 4, 'an owner sees every voucher line');

-- ============================================================
-- Counter user: nothing about pay
-- ============================================================
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select throws_ok($$select monthly_salary from parties$$, '42501', null, 'a counter user cannot read parties.monthly_salary');
select throws_ok($$select daily_wage from parties$$, '42501', null, 'nor parties.daily_wage');
select throws_ok($$select * from parties$$, '42501', null, 'select * on parties is refused too (it names the salary columns)');
select is((select count(*)::int from parties), 4, 'the other columns still read normally (count: three fixtures + the walk-in customer)');
select lives_ok($$select id, name, type, gstin, state_code, phone, credit_limit, credit_days, is_active, is_walk_in,
                         interest_rate_pm, whatsapp_phone, default_site_id, created_at from parties$$,
  'every non-salary column of parties is readable by a counter user');
select is((select count(*)::int from employee_pay_rates()), 0, 'employee_pay_rates() returns nothing to a counter user');
select is((select count(*)::int from v_employees), 0, 'v_employees returns nothing to a counter user');
select is((select count(*)::int from v_employee_ledger), 0, 'v_employee_ledger returns nothing to a counter user (change 06)');
select is((select count(*)::int from expense_vouchers where voucher_type in ('salary', 'wages')), 0,
  'a counter user sees no salary or wage voucher');
select is((select count(*)::int from expense_vouchers), 2, 'but does see the expense and advance vouchers');
select is((select count(*)::int from expense_voucher_lines), 2, 'and only those vouchers'' lines');
select is((select count(*)::int from expense_voucher_lines where voucher_id in
            ('b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002')), 0,
  'the lines of a salary or wage voucher are hidden with it');

-- ============================================================
-- Drift guard: every column the new screens read exists
-- ============================================================
reset role;

select has_column('public', t.tbl, c, t.tbl || '.' || c || ' exists')
from (values
  ('v_party_ledger', array['party_id', 'party_name', 'party_type', 'account_key', 'entry_date', 'entry_no', 'line_no', 'line_id', 'source_type',
                          'source_id', 'doc_no', 'narration', 'is_reversal', 'debit', 'credit', 'running_balance']),
  ('v_party_aging', array['party_id', 'bucket_0_30', 'bucket_31_60', 'bucket_61_90', 'bucket_90_plus', 'unallocated', 'interest']),
  ('v_party_interest', array['party_id']),
  ('v_party_balances', array['party_id', 'ar_balance', 'ap_balance']),
  ('v_open_purchase_invoices', array['party_id', 'age_days', 'open_amount']),
  ('parties', array['id', 'name', 'type', 'gstin', 'state_code', 'phone', 'whatsapp_phone', 'credit_limit', 'credit_days', 'interest_rate_pm',
                    'is_active', 'is_walk_in', 'default_site_id', 'monthly_salary', 'daily_wage']),
  ('party_addresses', array['id', 'party_id', 'label', 'state_code', 'is_default', 'address', 'created_at']),
  ('organization', array['state_code', 'timezone', 'legal_name', 'trade_name', 'gstin']),
  ('accounts', array['id', 'name', 'code', 'system_key', 'is_money', 'is_group']),
  ('items', array['id', 'name', 'brand', 'category', 'hsn_code', 'base_uom', 'alt_uom', 'conversion_factor', 'reorder_level', 'is_active', 'is_stock']),
  ('warehouses', array['id', 'name', 'is_default', 'is_transit']),
  ('v_stock_summary', array['item_id', 'warehouse_id', 'qty', 'value']),
  ('v_stock_summary_all', array['item_id', 'warehouse_id', 'is_transit', 'qty', 'value']),
  ('v_stock_ledger', array['item_id', 'warehouse_id', 'movement_id', 'movement_date', 'source_type', 'source_id', 'doc_no', 'is_reversal',
                           'qty', 'rate', 'value', 'running_qty', 'running_value', 'seq']),
  ('stock_transfers', array['id', 'transfer_no', 'transfer_date', 'from_warehouse_id', 'to_warehouse_id', 'vehicle_no', 'status', 'created_by']),
  ('stock_transfer_lines', array['transfer_id', 'line_no', 'item_id', 'item_name', 'uom', 'qty']),
  ('stock_adjustments', array['id', 'adj_date', 'warehouse_id', 'reason', 'status', 'created_by']),
  ('stock_adjustment_lines', array['adjustment_id', 'line_no', 'item_id', 'item_name', 'qty', 'rate']),
  ('expense_vouchers', array['id', 'voucher_date', 'party_id', 'status', 'voucher_type', 'pay_account_id', 'advance_recovered', 'period_month', 'created_by']),
  ('expense_voucher_lines', array['voucher_id', 'line_no', 'account_id', 'amount', 'narration']),
  ('v_employees', array['party_id', 'name', 'phone', 'whatsapp_phone', 'is_active', 'monthly_salary', 'daily_wage', 'advance_balance', 'payable_balance']),
  ('v_employee_ledger', array['party_id', 'line_id', 'entry_date', 'entry_no', 'line_no', 'doc_no', 'voucher_type', 'period_month', 'account_key',
                              'narration', 'debit', 'credit', 'advance_balance', 'payable_balance', 'entry_id', 'source_id'])
) as t(tbl, cols), unnest(t.cols) as c;

select * from finish();
rollback;
