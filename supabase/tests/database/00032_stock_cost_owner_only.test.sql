-- Must pass (change 28, stock-cost-owner-only): what stock costs the family is owner-only in the database.
--  * a counter user (aal1 and aal2) cannot read stock_movements.rate/value; every cost column of
--    v_stock_summary(_all) / v_stock_ledger(_all) and stock_on_hand() is NULL for them; their
--    quantities are identical to the owner's
--  * an owner at aal2 sees exactly the figures the pre-change formulas give over the raw table
--  * an owner at aal1 (change 19) and a non-member see nothing
--  * a counter user still posts a sale and its COGS is the weighted-average cost
begin;

create extension if not exists pgtap with schema extensions;

select plan(71);

-- ============================================================
-- Fixtures (database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000028', 'Cost Test Customer', 'customer', state_code from organization limit 1;

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000281', 'Cost Cement 50kg', 'cement', '2523', 28, 'bag', 400),
  ('c0000000-0000-0000-0000-000000000282', 'Cost TMT 12mm', 'steel', '7214', 18, 'kg', 60),
  ('c0000000-0000-0000-0000-000000000283', 'Cost Sold Out', 'cement', '2523', 28, 'bag', 400);

-- Cement comes in twice at different rates (weighted average 310); the third item nets to zero
-- on hand (the qty = 0 avg_rate rule); one TMT lot sits In Transit (the _all views).
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select v.item, w.id, v.d::date, v.qty, v.rate, v.qty * v.rate, 'opening'
  from (values ('c0000000-0000-0000-0000-000000000281'::uuid, '2026-04-05', 100::numeric, 300::numeric),
               ('c0000000-0000-0000-0000-000000000281'::uuid, '2026-04-06', 100::numeric, 320::numeric),
               ('c0000000-0000-0000-0000-000000000282'::uuid, '2026-04-05', 1000::numeric, 50.25::numeric),
               ('c0000000-0000-0000-0000-000000000283'::uuid, '2026-04-05', 5::numeric, 280::numeric),
               ('c0000000-0000-0000-0000-000000000283'::uuid, '2026-04-07', -5::numeric, 280::numeric)) v(item, d, qty, rate)
  cross join (select id from warehouses where is_default and not is_transit) w;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000282', id, '2026-04-08', 200, 51, 10200, 'opening'
  from warehouses where is_transit;

insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000281', '2026-09-05', 'a0000000-0000-0000-0000-000000000028', o.state_code, 'draft',
       (select id from warehouses where is_default and not is_transit)
  from organization o limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000281', 1, 'c0000000-0000-0000-0000-000000000281', 'Cost Cement 50kg', '2523', 'bag', 10, 400, 0, 28);

-- ============================================================
-- A counter user posts a sale: COGS is the weighted-average cost (posting engine unchanged)
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000281')$$, 'a counter user still posts a sales invoice');
reset role;

select is((select m.rate from stock_movements m where m.source_id = 'd0000000-0000-0000-0000-000000000281'),
  310.0000::numeric, 'the sale goes out at the weighted-average rate (100 @ 300 + 100 @ 320)');
select is((select m.value from stock_movements m where m.source_id = 'd0000000-0000-0000-0000-000000000281'),
  -3100.00::numeric, 'the sale''s stock movement value is -10 x 310');
select is((select jl.debit from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'cogs'
            where jl.entry_id = (select journal_entry_id from sales_invoices where id = 'd0000000-0000-0000-0000-000000000281')),
  3100.00::numeric, 'COGS is debited 3,100.00');
select is((select jl.credit from journal_lines jl join accounts a on a.id = jl.account_id and a.system_key = 'inventory'
            where jl.entry_id = (select journal_entry_id from sales_invoices where id = 'd0000000-0000-0000-0000-000000000281')),
  3100.00::numeric, 'Inventory is credited 3,100.00');

-- ============================================================
-- Expected figures: the pre-change view formulas over the raw table (database owner)
-- ============================================================
create temp table exp_summary on commit drop as
select m.item_id, m.warehouse_id, w.is_transit,
       sum(m.qty)::numeric(12,3) as qty,
       (case when sum(m.qty) = 0 then 0 else round(sum(m.value) / sum(m.qty), 4) end)::numeric(14,4) as avg_rate,
       sum(m.value)::numeric(14,2) as value
from stock_movements m join warehouses w on w.id = m.warehouse_id
group by m.item_id, m.warehouse_id, w.is_transit;

create temp table exp_ledger on commit drop as
select m.id as movement_id, w.is_transit, m.qty, m.rate, m.value,
       (row_number() over (partition by m.item_id, m.warehouse_id order by m.movement_date, m.created_at, m.id))::int as seq,
       (sum(m.qty) over (partition by m.item_id, m.warehouse_id order by m.movement_date, m.created_at, m.id))::numeric(12,3) as running_qty,
       (sum(m.value) over (partition by m.item_id, m.warehouse_id order by m.movement_date, m.created_at, m.id))::numeric(14,2) as running_value
from stock_movements m join warehouses w on w.id = m.warehouse_id;

grant select on exp_summary, exp_ledger to authenticated;

select is((select count(*)::int from exp_summary), 4, 'fixture: four item x warehouse rows (one in transit)');
select is((select count(*)::int from exp_ledger), 7, 'fixture: seven movements');

-- ============================================================
-- Owner at aal2: every figure exactly as before
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select results_eq(
  $$select item_id, warehouse_id, qty, avg_rate, value from v_stock_summary_all order by 1, 2$$,
  $$select item_id, warehouse_id, qty, avg_rate, value from exp_summary order by 1, 2$$,
  'owner: v_stock_summary_all qty, avg_rate and value are unchanged');
select results_eq(
  $$select item_id, warehouse_id, qty, avg_rate, value from v_stock_summary order by 1, 2$$,
  $$select item_id, warehouse_id, qty, avg_rate, value from exp_summary where not is_transit order by 1, 2$$,
  'owner: v_stock_summary is unchanged');
select results_eq(
  $$select movement_id, qty, rate, value, seq, running_qty, running_value from v_stock_ledger_all order by 1$$,
  $$select movement_id, qty, rate, value, seq, running_qty, running_value from exp_ledger order by 1$$,
  'owner: v_stock_ledger_all rate, value, running figures are unchanged');
select results_eq(
  $$select movement_id, qty, rate, value, seq, running_qty, running_value from v_stock_ledger order by 1$$,
  $$select movement_id, qty, rate, value, seq, running_qty, running_value from exp_ledger where not is_transit order by 1$$,
  'owner: v_stock_ledger is unchanged');
select is((select avg_rate from v_stock_summary where item_id = 'c0000000-0000-0000-0000-000000000283'),
  0.0000::numeric, 'owner: avg_rate of a sold-out item is still 0');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 190.000::numeric, 58900.00::numeric, 310.0000::numeric$$,
  'owner: stock_on_hand() gives qty, value and average rate (190 bags at 310)');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000283', (select id from warehouses where is_default and not is_transit))$$,
  $$select 0.000::numeric, 0.00::numeric, 0.0000::numeric$$,
  'owner: stock_on_hand() of a sold-out item is 0 / 0 / 0 as before');
select results_eq(
  $$select movement_id, rate, value from stock_movement_cost() order by 1$$,
  $$select movement_id, rate, value from exp_ledger order by 1$$,
  'owner: stock_movement_cost() returns every movement''s rate and value');
select throws_ok($$select rate from stock_movements$$, '42501', null,
  'owner: the table''s cost columns are closed to every app session (owners read cost through the views)');
select lives_ok($$select id, created_at, item_id, warehouse_id, movement_date, qty, source_type, source_id, reversal_of from stock_movements$$,
  'owner: every other stock_movements column reads normally');

-- ============================================================
-- Counter user at aal1, then aal2: no cost anywhere, quantities identical
-- ============================================================
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select throws_ok($$select rate from stock_movements$$, '42501', null, 'user aal1: stock_movements.rate is refused');
select throws_ok($$select value from stock_movements$$, '42501', null, 'user aal1: stock_movements.value is refused');
select throws_ok($$select * from stock_movements$$, '42501', null, 'user aal1: select * on stock_movements is refused (it names rate/value)');
select throws_ok($$select 1 from stock_movements where value > 0$$, '42501', null, 'user aal1: filtering on value is refused too (no oracle)');
select results_eq(
  $$select id, qty from stock_movements order by 1$$,
  $$select movement_id, qty from exp_ledger order by 1$$,
  'user aal1: every movement and its qty are readable');
select results_eq(
  $$select item_id, warehouse_id, qty from v_stock_summary_all order by 1, 2$$,
  $$select item_id, warehouse_id, qty from exp_summary order by 1, 2$$,
  'user aal1: v_stock_summary_all quantities equal the owner''s');
select results_eq(
  $$select item_id, warehouse_id, qty from v_stock_summary order by 1, 2$$,
  $$select item_id, warehouse_id, qty from exp_summary where not is_transit order by 1, 2$$,
  'user aal1: v_stock_summary quantities equal the owner''s');
select is((select count(*)::int from v_stock_summary_all where avg_rate is not null or value is not null), 0,
  'user aal1: v_stock_summary_all avg_rate and value are NULL on every row (also the sold-out one)');
select is((select count(*)::int from v_stock_summary where avg_rate is not null or value is not null), 0,
  'user aal1: v_stock_summary avg_rate and value are NULL on every row');
select results_eq(
  $$select movement_id, qty, seq, running_qty from v_stock_ledger_all order by 1$$,
  $$select movement_id, qty, seq, running_qty from exp_ledger order by 1$$,
  'user aal1: v_stock_ledger_all quantities and running qty equal the owner''s');
select results_eq(
  $$select movement_id, qty, seq, running_qty from v_stock_ledger order by 1$$,
  $$select movement_id, qty, seq, running_qty from exp_ledger where not is_transit order by 1$$,
  'user aal1: v_stock_ledger quantities equal the owner''s');
select is((select count(*)::int from v_stock_ledger_all where rate is not null or value is not null or running_value is not null), 0,
  'user aal1: v_stock_ledger_all rate, value and running_value are NULL on every row');
select is((select count(*)::int from v_stock_ledger where rate is not null or value is not null or running_value is not null), 0,
  'user aal1: v_stock_ledger rate, value and running_value are NULL on every row');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 190.000::numeric, null::numeric, null::numeric$$,
  'user aal1: stock_on_hand() gives the qty and NULL cost');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000283', (select id from warehouses where is_default and not is_transit))$$,
  $$select 0.000::numeric, null::numeric, null::numeric$$,
  'user aal1: stock_on_hand() of a sold-out item: qty 0, cost NULL (not 0)');
select is((select count(*)::int from stock_movement_cost()), 0, 'user aal1: stock_movement_cost() returns nothing');
select is((select count(*)::int from v_attention where kind = 'low_stock'), 0, 'user aal1: v_attention (reads qty only) still works');

set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal2"}';

select throws_ok($$select rate from stock_movements$$, '42501', null, 'user aal2: stock_movements.rate is refused');
select throws_ok($$select value from stock_movements$$, '42501', null, 'user aal2: stock_movements.value is refused');
select throws_ok($$select * from stock_movements$$, '42501', null, 'user aal2: select * on stock_movements is refused');
select throws_ok($$select 1 from stock_movements where value > 0$$, '42501', null, 'user aal2: filtering on value is refused');
select results_eq(
  $$select id, qty from stock_movements order by 1$$,
  $$select movement_id, qty from exp_ledger order by 1$$,
  'user aal2: every movement and its qty are readable');
select results_eq(
  $$select item_id, warehouse_id, qty from v_stock_summary_all order by 1, 2$$,
  $$select item_id, warehouse_id, qty from exp_summary order by 1, 2$$,
  'user aal2: v_stock_summary_all quantities equal the owner''s');
select results_eq(
  $$select item_id, warehouse_id, qty from v_stock_summary order by 1, 2$$,
  $$select item_id, warehouse_id, qty from exp_summary where not is_transit order by 1, 2$$,
  'user aal2: v_stock_summary quantities equal the owner''s');
select is((select count(*)::int from v_stock_summary_all where avg_rate is not null or value is not null), 0,
  'user aal2: v_stock_summary_all avg_rate and value are NULL on every row');
select is((select count(*)::int from v_stock_summary where avg_rate is not null or value is not null), 0,
  'user aal2: v_stock_summary avg_rate and value are NULL on every row');
select results_eq(
  $$select movement_id, qty, seq, running_qty from v_stock_ledger_all order by 1$$,
  $$select movement_id, qty, seq, running_qty from exp_ledger order by 1$$,
  'user aal2: v_stock_ledger_all quantities equal the owner''s');
select results_eq(
  $$select movement_id, qty, seq, running_qty from v_stock_ledger order by 1$$,
  $$select movement_id, qty, seq, running_qty from exp_ledger where not is_transit order by 1$$,
  'user aal2: v_stock_ledger quantities equal the owner''s');
select is((select count(*)::int from v_stock_ledger_all where rate is not null or value is not null or running_value is not null), 0,
  'user aal2: v_stock_ledger_all cost columns are NULL on every row');
select is((select count(*)::int from v_stock_ledger where rate is not null or value is not null or running_value is not null), 0,
  'user aal2: v_stock_ledger cost columns are NULL on every row');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 190.000::numeric, null::numeric, null::numeric$$,
  'user aal2: stock_on_hand() gives the qty and NULL cost');
select is((select count(*)::int from stock_movement_cost()), 0, 'user aal2: stock_movement_cost() returns nothing');

-- ============================================================
-- Owner at aal1 (change 19) and a non-member: nothing at all
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';

select is((select count(*)::int from v_stock_summary_all), 0, 'owner aal1: v_stock_summary_all is empty');
select is((select count(*)::int from v_stock_ledger_all), 0, 'owner aal1: v_stock_ledger_all is empty');
select is((select count(*)::int from stock_movements), 0, 'owner aal1: stock_movements is empty');
select is((select count(*)::int from stock_movement_cost()), 0, 'owner aal1: stock_movement_cost() returns nothing');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 0.000::numeric, null::numeric, null::numeric$$,
  'owner aal1: stock_on_hand() sees no stock and no cost');
select throws_ok($$select rate from stock_movements$$, '42501', null, 'owner aal1: stock_movements.rate is refused');

set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal2"}';

select is((select count(*)::int from v_stock_summary_all), 0, 'non-member: v_stock_summary_all is empty');
select is((select count(*)::int from v_stock_ledger_all), 0, 'non-member: v_stock_ledger_all is empty');
select is((select count(*)::int from stock_movement_cost()), 0, 'non-member: stock_movement_cost() returns nothing');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 0.000::numeric, null::numeric, null::numeric$$,
  'non-member: stock_on_hand() sees nothing');

-- ============================================================
-- The owner cancels the counter's sale: the reversal still uses the original cost
-- ============================================================
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000281', 'test')$$, 'owner cancels the sale');
select results_eq(
  $$select qty, value, avg_rate from stock_on_hand('c0000000-0000-0000-0000-000000000281', (select id from warehouses where is_default and not is_transit))$$,
  $$select 200.000::numeric, 62000.00::numeric, 310.0000::numeric$$,
  'owner: after the reversal the cement is back to 200 bags at 310');
reset role;

-- ============================================================
-- Catalog
-- ============================================================
select ok(not has_column_privilege('authenticated', 'public.stock_movements', 'rate', 'SELECT'), 'authenticated has no SELECT on stock_movements.rate');
select ok(not has_column_privilege('authenticated', 'public.stock_movements', 'value', 'SELECT'), 'authenticated has no SELECT on stock_movements.value');
select ok(has_column_privilege('authenticated', 'public.stock_movements', 'qty', 'SELECT'), 'authenticated keeps SELECT on stock_movements.qty');
select ok(has_table_privilege('service_role', 'public.stock_movements', 'SELECT'), 'service_role keeps SELECT on the whole table');
select ok(not has_table_privilege('authenticated', 'public.stock_movements', 'INSERT'), 'authenticated still cannot write stock_movements');
select is((select prosecdef from pg_proc where oid = 'public.stock_movement_cost()'::regprocedure), true, 'stock_movement_cost() is SECURITY DEFINER');
select ok(not has_function_privilege('anon', 'public.stock_movement_cost()', 'EXECUTE'), 'anon cannot execute stock_movement_cost()');
select ok(has_function_privilege('authenticated', 'public.stock_movement_cost()', 'EXECUTE'), 'authenticated can execute stock_movement_cost()');
select is((select prosecdef from pg_proc where oid = 'public.stock_on_hand(uuid, uuid)'::regprocedure), false, 'stock_on_hand() stays SECURITY INVOKER');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace
            and c.relname in ('v_stock_summary_all', 'v_stock_summary', 'v_stock_ledger_all', 'v_stock_ledger')
            and c.reloptions @> array['security_invoker=true']), 4, 'the four stock views stay security_invoker');

select * from finish();
rollback;
