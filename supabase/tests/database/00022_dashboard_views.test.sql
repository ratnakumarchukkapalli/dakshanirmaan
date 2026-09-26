-- Change 14 (dashboard): the read views the dashboard adds, and a has_column drift guard for every
-- column of every view/table the dashboard selects (the Supabase client is untyped, so a wrong
-- column name only ever fails at runtime; this makes it fail here, against the real database).
--
-- Documents are posted through the real post_* functions in real `authenticated` sessions (the
-- posting engine is what the dashboard reads the result of); nothing is inserted into journal_lines.
begin;

create extension if not exists pgtap with schema extensions;

select plan(71);

-- ============================================================
-- Drift guard: every column the dashboard (src/lib/dashboard-data.ts, the page) reads
-- ============================================================
select has_column('public', 'v_sales_daily', c, 'v_sales_daily.' || c || ' exists')
from unnest(array['sale_date', 'invoice_count', 'billed_total', 'round_off']) as c;
select has_column('public', 'v_sales_daily_category', c, 'v_sales_daily_category.' || c || ' exists')
from unnest(array['sale_date', 'category', 'amount']) as c;
select has_column('public', 'v_money_balances', c, 'v_money_balances.' || c || ' exists')
from unnest(array['account_id', 'code', 'name', 'system_key', 'balance']) as c;
select has_column('public', 'v_attention', c, 'v_attention.' || c || ' exists')
from unnest(array['kind', 'severity', 'subject_type', 'subject_id', 'title', 'detail', 'due_date', 'amount', 'interest']) as c;
select has_column('public', 'v_party_balances', c, 'v_party_balances.' || c || ' exists')
from unnest(array['party_id', 'ar_balance', 'ap_balance']) as c;
select has_column('public', 'v_stock_summary', c, 'v_stock_summary.' || c || ' exists')
from unnest(array['item_id', 'qty', 'value']) as c;
select has_column('public', 'v_stock_summary_all', c, 'v_stock_summary_all.' || c || ' exists')
from unnest(array['is_transit', 'value']) as c;
select has_column('public', 'v_trial_balance', c, 'v_trial_balance.' || c || ' exists')
from unnest(array['total_debit', 'total_credit']) as c;
select has_column('public', 'day_closes', c, 'day_closes.' || c || ' exists')
from unnest(array['close_date', 'difference', 'status']) as c;
select has_column('public', 'sales_invoices', c, 'sales_invoices.' || c || ' exists')
from unnest(array['id', 'status']) as c;
select has_column('public', 'items', c, 'items.' || c || ' exists')
from unnest(array['id', 'name']) as c;
select has_column('public', 'organization', 'timezone', 'organization.timezone exists');

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000003', 'Dashboard Customer', 'customer', state_code
  from organization limit 1;

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'Dash Cement 50kg', 'cement', '2523', 28, 'bag', 400),
  ('c0000000-0000-0000-0000-000000000002', 'Dash TMT 12mm', 'steel', '7214', 18, 'kg', 60);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select v.item, w.id, '2026-04-05', v.qty, v.rate, v.qty * v.rate, 'opening'
  from (values ('c0000000-0000-0000-0000-000000000001'::uuid, 1000::numeric, 300::numeric),
               ('c0000000-0000-0000-0000-000000000002'::uuid, 5000::numeric, 50::numeric)) v(item, qty, rate)
  cross join (select id from warehouses where is_default and not is_transit) w;

-- Three invoices on 2026-09-05 (one cement-only, one steel-only, one a rounding case), a fourth on
-- 2026-09-06 that is cancelled, and a draft. Written as the database owner, posted by the roles
-- below. Rates are what the posting function recomputes from (taxable_value 0 is a placeholder).
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select v.id::uuid, v.d::date, 'a0000000-0000-0000-0000-000000000003', o.state_code, 'draft',
       (select id from warehouses where is_default and not is_transit)
  from (values
    ('d0000000-0000-0000-0000-000000000001', '2026-09-05'),
    ('d0000000-0000-0000-0000-000000000002', '2026-09-05'),
    ('d0000000-0000-0000-0000-000000000003', '2026-09-05'),
    ('d0000000-0000-0000-0000-000000000004', '2026-09-06'),
    ('d0000000-0000-0000-0000-000000000005', '2026-09-07')
  ) v(id, d)
  cross join (select state_code from organization limit 1) o;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values
  ('d0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 'Dash Cement 50kg', '2523', 'bag', 10, 400, 0, 28),
  ('d0000000-0000-0000-0000-000000000002', 1, 'c0000000-0000-0000-0000-000000000002', 'Dash TMT 12mm', '7214', 'kg', 100, 60, 0, 18),
  ('d0000000-0000-0000-0000-000000000003', 1, 'c0000000-0000-0000-0000-000000000001', 'Dash Cement 50kg', '2523', 'bag', 1, 100.50, 0, 28),
  ('d0000000-0000-0000-0000-000000000004', 1, 'c0000000-0000-0000-0000-000000000001', 'Dash Cement 50kg', '2523', 'bag', 5, 400, 0, 28),
  ('d0000000-0000-0000-0000-000000000005', 1, 'c0000000-0000-0000-0000-000000000001', 'Dash Cement 50kg', '2523', 'bag', 2, 400, 0, 28);

insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status)
values ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-09-05', 'a0000000-0000-0000-0000-000000000003',
        'cash', 5000, (select id from accounts where system_key = 'cash'), 'draft');
insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, period_month)
values ('b0000000-0000-0000-0000-000000000005', '2026-09-05', null, 'draft', 'expense', null);
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
values ('b0000000-0000-0000-0000-000000000005', 1, (select id from accounts where system_key = 'godown_rent'), 3000, 'rent');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$, 'counter posts the cement invoice');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$, 'counter posts the steel invoice');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000003')$$, 'counter posts the rounding invoice');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000004')$$, 'counter posts the invoice that is cancelled below');
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'counter posts a cash receipt of 5,000');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_expense_voucher('b0000000-0000-0000-0000-000000000005')$$, 'owner posts godown rent 3,000 in cash');
select lives_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000004', 'wrong party')$$, 'owner cancels the fourth invoice');
reset role;

-- ============================================================
-- v_sales_daily: posted only, per invoice date
-- ============================================================
select is((select invoice_count from v_sales_daily where sale_date = '2026-09-05'), 3, 'three posted invoices on 05-09');
select is((select billed_total from v_sales_daily where sale_date = '2026-09-05'),
  (select sum(grand_total) from sales_invoices where invoice_date = '2026-09-05' and status = 'posted'),
  'billed_total = the sum of the posted invoices'' grand_total');
select is((select billed_total from v_sales_daily where sale_date = '2026-09-05'), 5120.00 + 7080.00 + 129.00,
  '5,120 cement + 7,080 steel (100 x 60 + 18%) + 129 (128.64 rounded up) = 12,329');
select is((select round_off from v_sales_daily where sale_date = '2026-09-05'), 0.36::numeric(14,2), 'round_off is exposed (0.36 on the rounding invoice)');
select is((select count(*)::int from v_sales_daily where sale_date = '2026-09-06'), 0, 'a cancelled invoice is not sales');
select is((select count(*)::int from v_sales_daily where sale_date = '2026-09-07'), 0, 'a draft is not sales');

-- ============================================================
-- v_sales_daily_category: lines split by item category; amount + round_off = billed_total
-- ============================================================
select is((select amount from v_sales_daily_category where sale_date = '2026-09-05' and category = 'cement'), 5248.64::numeric(14,2),
  'cement = 4,000 + 1,120 tax and 100.50 + 28.14 tax');
select is((select amount from v_sales_daily_category where sale_date = '2026-09-05' and category = 'steel'), 7080.00::numeric(14,2),
  'steel = 6,000 + 1,080 tax');
select is((select count(*)::int from v_sales_daily_category where sale_date = '2026-09-05' and category = 'other'), 0,
  'no other-category row when nothing of that category sold');
select is((select sum(amount) from v_sales_daily_category where sale_date = '2026-09-05')
          + (select round_off from v_sales_daily where sale_date = '2026-09-05'),
  (select billed_total from v_sales_daily where sale_date = '2026-09-05'),
  'the category split plus round-off reconciles to the day total');
select is((select count(*)::int from v_sales_daily_category where sale_date in ('2026-09-06', '2026-09-07')), 0,
  'cancelled and draft invoices are not in the category split either');

-- ============================================================
-- v_money_balances: owner-only, equals the ledger
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select balance from v_money_balances where system_key = 'cash'), 2000.00::numeric(14,2),
  'owner: cash = 5,000 receipt - 3,000 rent');
select is((select balance from v_money_balances where system_key = 'bank'), 0.00::numeric(14,2), 'owner: bank is 0');
select is((select count(*)::int from v_money_balances), 2, 'owner: exactly the two money accounts (no group, no other asset)');
select is((select balance from v_money_balances where system_key = 'cash'),
  (select closing from v_trial_balance where system_key = 'cash'), 'the cash row equals the trial balance');
select is((select sum(total_debit) - sum(total_credit) from v_trial_balance), 0.00::numeric, 'owner: the trial balance is balanced');
select is((select count(*)::int from v_sales_daily), 1, 'owner reads sales by day');

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from v_money_balances), 0, 'counter: cash and bank balances are not visible');
select is((select count(*)::int from v_trial_balance), 0, 'counter: no trial balance');
select is((select count(*)::int from v_sales_daily), 1, 'counter reads sales by day (counter staff raise the invoices)');
select is((select count(*)::int from v_sales_daily_category), 2, 'counter reads the category split');
select is((select billed_total from v_sales_daily where sale_date = '2026-09-05'), 12329.00::numeric(14,2), 'counter sees the same day total');
reset role;

-- ============================================================
-- Grants and hard rules for the three new views
-- ============================================================
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v'
             and c.relname in ('v_sales_daily', 'v_sales_daily_category', 'v_money_balances')
             and coalesce(c.reloptions @> array['security_invoker=true'], false)), 3,
  'all three are security_invoker');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v'
             and c.relname in ('v_sales_daily', 'v_sales_daily_category', 'v_money_balances')
             and (has_table_privilege('anon', c.oid, 'select')
                  or has_table_privilege('service_role', c.oid, 'select')
                  or has_table_privilege('authenticated', c.oid, 'insert')
                  or has_table_privilege('authenticated', c.oid, 'update')
                  or has_table_privilege('authenticated', c.oid, 'delete')
                  or not has_table_privilege('authenticated', c.oid, 'select'))), 0,
  'grants: SELECT to authenticated only');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'public' and table_name in ('v_sales_daily', 'v_sales_daily_category', 'v_money_balances')
             and column_name in ('billed_total', 'round_off', 'amount', 'balance') and data_type <> 'numeric'), 0,
  'every money column of the new views is numeric');

select * from finish();
rollback;
