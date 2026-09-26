-- Change 17 (cutover): opening balances + opening stock through post_opening_balances,
-- cancel_opening_balances, ensure_fiscal_year, go_live_readiness, and the FY-April lock.
--
-- Must pass:
--  * "trial balance balances after import": Σdr = Σcr; AR/AP per party, cash, bank, inventory and
--    the stock summary carry exactly what was staged; the balancing figure lands on
--    Opening Balance Equity
--  * only an owner past the authenticator step can stage, post or cancel; nobody else can read the batch
--  * every refusal: stale preview, missing period, party of the wrong type, non-stock item,
--    transit warehouse, non-money account, pre-existing stock, double post, second live batch,
--    posted lines frozen, cancel once anything else has posted
begin;

create extension if not exists pgtap with schema extensions;

select plan(90);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'admin2@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select v.id::uuid, v.name, v.type::party_type, o.state_code
from organization o, (values
  ('a0000000-0000-0000-0000-000000000001', 'Open Customer', 'customer'),
  ('a0000000-0000-0000-0000-000000000002', 'Open Supplier', 'supplier'),
  ('a0000000-0000-0000-0000-000000000003', 'Open Both', 'both'),
  ('a0000000-0000-0000-0000-000000000004', 'Open Employee', 'employee')
) as v(id, name, type);
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock) values
  ('c0000000-0000-0000-0000-000000000001', 'Open Cement 50kg', 'cement', '2523', 28, 'bag', 400, true),
  ('c0000000-0000-0000-0000-000000000002', 'Open Service', 'other', '9965', 18, 'nos', 100, false),
  ('c0000000-0000-0000-0000-000000000003', 'Open TMT 12mm', 'steel', '7214', 18, 'kg', 70, true);

-- ============================================================
-- Schema, seed, FY lock
-- ============================================================
select has_table('public', 'opening_batches', 'opening_batches exists');
select has_table('public', 'opening_lines', 'opening_lines exists');
select is((select type::text from accounts where system_key = 'opening_balance_equity'), 'equity', 'account 3900 is an equity account keyed opening_balance_equity');
select is((select code from accounts where system_key = 'opening_balance_equity'), '3900', 'its code is 3900');
select throws_ok($$update organization set fy_start_month = 5$$, '23514', null, 'the financial year start is locked to April');

-- ============================================================
-- Who can see and stage
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from opening_batches), 0, 'counter staff read no batches');
select throws_ok($$insert into opening_batches default values$$, '42501', null, 'counter staff cannot start a batch');
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot post opening balances');
select throws_ok($$select cancel_opening_balances('x')$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot cancel opening balances');
select throws_ok($$select ensure_fiscal_year('2027-28')$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot create a fiscal year');
select throws_ok($$select * from go_live_readiness()$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot run the readiness checks');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from opening_batches), 0, 'an owner at step 1 reads nothing');
select throws_ok($$insert into opening_batches default values$$, '42501', null, 'an owner at step 1 cannot start a batch');
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_FORBIDDEN', 'an owner at step 1 cannot post opening balances');

set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_NOT_DRAFT', 'posting with no draft batch is refused');
select lives_ok($$insert into opening_batches default values$$, 'an owner at step 2 starts the draft batch');
select throws_ok($$insert into opening_batches default values$$, '23505', null, 'a second live batch is refused');
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:no_lines', 'an empty batch is refused');

-- ============================================================
-- Staging: 100,000 owed by the customer, 40,000 owed to the supplier, 5,000 owed by the "both"
-- party, cash 25,000, bank 75,000, 100 bags @ 300 = 30,000.
--   debits 235,000 (100,000 + 5,000 + 25,000 + 75,000 + 30,000) - credits 40,000 = equity 195,000
-- ============================================================
select lives_ok($$
  insert into opening_lines (batch_id, kind, party_id, side, amount)
  select (select id from opening_batches where status = 'draft'), 'party', 'a0000000-0000-0000-0000-000000000001', 'receivable', 100000
$$, 'stage the customer due');
select lives_ok($$
  insert into opening_lines (batch_id, kind, party_id, side, amount)
  select (select id from opening_batches where status = 'draft'), 'party', 'a0000000-0000-0000-0000-000000000002', 'payable', 40000
$$, 'stage the supplier due');
select lives_ok($$
  insert into opening_lines (batch_id, kind, party_id, side, amount)
  select (select id from opening_batches where status = 'draft'), 'party', 'a0000000-0000-0000-0000-000000000003', 'receivable', 5000
$$, 'stage the both-party due');
select lives_ok($$
  insert into opening_lines (batch_id, kind, account_id, amount)
  select (select id from opening_batches where status = 'draft'), 'money', id, 25000 from accounts where system_key = 'cash'
$$, 'stage the cash balance');
select lives_ok($$
  insert into opening_lines (batch_id, kind, account_id, amount)
  select (select id from opening_batches where status = 'draft'), 'money', id, 75000 from accounts where system_key = 'bank'
$$, 'stage the bank balance');
select lives_ok($$
  insert into opening_lines (batch_id, kind, item_id, warehouse_id, qty, rate)
  select (select id from opening_batches where status = 'draft'), 'stock', 'c0000000-0000-0000-0000-000000000001', id, 100, 300
  from warehouses where is_default and not is_transit
$$, 'stage the cement stock');

select throws_ok($$
  insert into opening_lines (batch_id, kind, party_id, side, amount)
  select (select id from opening_batches where status = 'draft'), 'party', 'a0000000-0000-0000-0000-000000000001', 'receivable', 1
$$, '23505', null, 'the same party and side twice is refused');
select throws_ok($$
  insert into opening_lines (batch_id, kind, party_id, side, amount)
  select (select id from opening_batches where status = 'draft'), 'party', 'a0000000-0000-0000-0000-000000000003', 'payable', 0
$$, '23514', null, 'a zero amount is refused');
select throws_ok($$
  insert into opening_lines (batch_id, kind, item_id, warehouse_id, qty, rate, amount)
  select (select id from opening_batches where status = 'draft'), 'stock', 'c0000000-0000-0000-0000-000000000003', id, 5, 70, 350
  from warehouses where is_default and not is_transit
$$, '23514', null, 'a stock line carries qty and rate, never an amount');

-- ============================================================
-- Refusals at posting (offending line added as the table owner, then removed)
-- ============================================================
reset role;
insert into opening_lines (id, batch_id, kind, party_id, side, amount)
select 'f0000000-0000-0000-0000-000000000001', id, 'party', 'a0000000-0000-0000-0000-000000000001', 'payable', 10
from opening_batches where status = 'draft';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:party_type', 'a customer cannot be owed money');
delete from opening_lines where id = 'f0000000-0000-0000-0000-000000000001';

reset role;
insert into opening_lines (id, batch_id, kind, party_id, side, amount)
select 'f0000000-0000-0000-0000-000000000002', id, 'party', 'a0000000-0000-0000-0000-000000000004', 'receivable', 10
from opening_batches where status = 'draft';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:party_type', 'an employee has no opening due');
delete from opening_lines where id = 'f0000000-0000-0000-0000-000000000002';

reset role;
insert into opening_lines (id, batch_id, kind, item_id, warehouse_id, qty, rate)
select 'f0000000-0000-0000-0000-000000000003', b.id, 'stock', 'c0000000-0000-0000-0000-000000000002', w.id, 1, 1
from opening_batches b, warehouses w where b.status = 'draft' and w.is_default and not w.is_transit;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:non_stock_line', 'a non-stock item cannot carry opening stock');
delete from opening_lines where id = 'f0000000-0000-0000-0000-000000000003';

reset role;
insert into opening_lines (id, batch_id, kind, item_id, warehouse_id, qty, rate)
select 'f0000000-0000-0000-0000-000000000004', b.id, 'stock', 'c0000000-0000-0000-0000-000000000003', w.id, 1, 1
from opening_batches b, warehouses w where b.status = 'draft' and w.is_transit;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:transit_warehouse', 'opening stock cannot go into the transit warehouse');
delete from opening_lines where id = 'f0000000-0000-0000-0000-000000000004';

reset role;
insert into opening_lines (id, batch_id, kind, account_id, amount)
select 'f0000000-0000-0000-0000-000000000005', b.id, 'money', a.id, 10
from opening_batches b, accounts a where b.status = 'draft' and a.system_key = 'inventory';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:not_money_account', 'only cash and bank take an opening balance');
delete from opening_lines where id = 'f0000000-0000-0000-0000-000000000005';

-- Stock already moving in that place: a stray movement, rolled back with the savepoint.
reset role;
savepoint stray;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1, 1, 1, 'opening' from warehouses where is_default and not is_transit;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:stock_exists', 'opening stock into a place that already has movements is refused');
reset role;
rollback to savepoint stray;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

-- A document already posted on or before the opening date: refused. (A later one is fine.)
reset role;
savepoint early_doc;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000003', id, '2026-09-20', 1, 1, 1, 'stock_adjustment' from warehouses where is_default and not is_transit;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_VALIDATION:opening_after_documents', 'an opening dated after an existing document is refused');
reset role;
rollback to savepoint early_doc;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select throws_ok($$select post_opening_balances('2030-01-01')$$, 'P0001', 'DN_PERIOD_LOCKED', 'a date with no fiscal period is refused');
select throws_ok($$select post_opening_balances('2026-09-25', 1)$$, 'P0001', 'DN_VALIDATION:stale_preview', 'a stale balancing figure is refused');
select throws_ok($$select post_opening_balances(null)$$, 'P0001', 'DN_VALIDATION:date_required', 'a null date is refused');
select is((select count(*)::int from journal_entries), 0, 'every refusal left the ledger untouched');

-- ============================================================
-- Post
-- ============================================================
select is((select equity from opening_preview()), 195000.00::numeric, 'the preview shows the balancing figure the post will use');
select is((select stock from opening_preview()), 30000.00::numeric, 'the preview values the stock');
select is((select line_count from opening_preview()), 6, 'the preview counts the lines');
select lives_ok($$select post_opening_balances('2026-09-25', 195000)$$, 'the owner posts the opening balances with the previewed figure');

select is((select count(*)::int from journal_entries where source_type = 'opening'), 1, 'one opening journal entry');
select is((select sum(debit) from journal_lines), 235000.00::numeric, 'total debits 235,000');
select is((select sum(credit) from journal_lines), 235000.00::numeric, 'total credits 235,000: the entry balances');
select is((select sum(closing) from v_trial_balance), 0.00::numeric, 'the trial balance nets to zero');
select is((select closing from v_trial_balance where system_key = 'ar'), 105000.00::numeric, 'AR 105,000');
select is((select closing from v_trial_balance where system_key = 'ap'), -40000.00::numeric, 'AP 40,000 (credit)');
select is((select closing from v_trial_balance where system_key = 'cash'), 25000.00::numeric, 'cash 25,000');
select is((select closing from v_trial_balance where system_key = 'bank'), 75000.00::numeric, 'bank 75,000');
select is((select closing from v_trial_balance where system_key = 'inventory'), 30000.00::numeric, 'inventory 30,000');
select is((select closing from v_trial_balance where system_key = 'opening_balance_equity'), -195000.00::numeric, 'Opening Balance Equity 195,000 (credit)');
select is((select ar_balance from v_party_balances where party_id = 'a0000000-0000-0000-0000-000000000001'), 100000.00::numeric, 'customer owes 100,000');
select is((select ap_balance from v_party_balances where party_id = 'a0000000-0000-0000-0000-000000000002'), 40000.00::numeric, 'we owe the supplier 40,000');
select is((select ar_balance from v_party_balances where party_id = 'a0000000-0000-0000-0000-000000000003'), 5000.00::numeric, 'the both-party owes 5,000');
select is((select qty from v_stock_summary where item_id = 'c0000000-0000-0000-0000-000000000001'), 100.000::numeric, 'stock summary carries 100 bags');
select is((select avg_rate from v_stock_summary where item_id = 'c0000000-0000-0000-0000-000000000001'), 300.0000::numeric, 'at 300 a bag');
select is((select value from v_stock_summary where item_id = 'c0000000-0000-0000-0000-000000000001'), 30000.00::numeric, 'worth 30,000');
select is((select status::text from opening_batches order by created_at desc limit 1), 'posted', 'the batch is posted');
select is((select count(*)::int from audit_log where entity = 'opening_batches' and action = 'post'), 1, 'the posting is audited');

select throws_ok($$select post_opening_balances('2026-09-25')$$, 'P0001', 'DN_NOT_DRAFT', 'a second post is refused: no draft batch');
select throws_ok($$update opening_lines set amount = amount + 1 where kind = 'party'$$, 'P0001', 'DN_VALIDATION:opening_batch_not_draft', 'posted lines cannot be edited');
select throws_ok($$delete from opening_lines$$, 'P0001', 'DN_VALIDATION:opening_batch_not_draft', 'posted lines cannot be deleted');

-- ============================================================
-- Readiness checks (all still true or false for a reason we can name)
-- ============================================================
select is((select ok from go_live_readiness() where check_key = 'opening_posted'), true, 'readiness: opening posted');
select is((select ok from go_live_readiness() where check_key = 'ledger_balanced'), true, 'readiness: ledger balanced');
select is((select ok from go_live_readiness() where check_key = 'inventory_ties'), true, 'readiness: Inventory account = stock ledger');
select is((select ok from go_live_readiness() where check_key = 'organisation'), false, 'readiness: the seeded organisation has no GSTIN yet');
select is((select ok from go_live_readiness() where check_key = 'owners'), false, 'readiness: only one owner');
select is((select ok from go_live_readiness() where check_key = 'periods'),
  exists (select 1 from fiscal_periods where month = date_trunc('month', now() at time zone 'Asia/Kolkata')::date and not is_locked)
  and exists (select 1 from fiscal_periods where month = (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month')::date and not is_locked),
  'readiness: periods = this month and next month open');
reset role;
update organization set gstin = '37AAPFU0939F1ZU', address = '{"line1":"Main Road","city":"Guntur","pincode":"522001"}'::jsonb;
insert into app_users (user_id, role, name, is_active, email) values
  ('55555555-5555-5555-5555-555555555555', 'admin', 'Second Admin', true, 'admin2@example.test');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select ok from go_live_readiness() where check_key = 'organisation'), true, 'readiness: organisation filled in');
select is((select ok from go_live_readiness() where check_key = 'owners'), true, 'readiness: two owners');

-- ============================================================
-- Cancel and post again
-- ============================================================
select throws_ok($$select cancel_opening_balances('  ')$$, 'P0001', 'DN_VALIDATION:reason_required', 'a reason is required');
select lives_ok($$select cancel_opening_balances('Wrong cash figure')$$, 'the owner cancels the opening (nothing else has posted)');
select is((select count(*)::int from (select account_id from journal_lines group by account_id having sum(debit - credit) <> 0) x), 0, 'after the reversal every account nets to zero');
select is((select coalesce(sum(qty), 0) from stock_movements), 0.000::numeric, 'after the reversal the stock nets to zero');
select is((select count(*)::int from opening_batches where status = 'draft'), 1, 'a fresh draft batch is back');
select is((select count(*)::int from opening_lines where batch_id = (select id from opening_batches where status = 'draft')), 6, 'holding the six lines to correct');
select is((select count(*)::int from opening_batches where status = 'cancelled'), 1, 'the old batch is kept, cancelled');
select lives_ok($$update opening_lines set amount = 26000 where batch_id = (select id from opening_batches where status = 'draft') and kind = 'money' and account_id = (select id from accounts where system_key = 'cash')$$, 'the cash figure is corrected in the draft');
select throws_ok($$select post_opening_balances('2026-09-25', 195000)$$, 'P0001', 'DN_VALIDATION:stale_preview', 'the old preview figure no longer matches');
select lives_ok($$select post_opening_balances('2026-09-25', 196000)$$, 're-posted with the corrected figure');
select is((select closing from v_trial_balance where system_key = 'opening_balance_equity'), -196000.00::numeric, 'equity is now 196,000');
select is((select sum(closing) from v_trial_balance), 0.00::numeric, 'the trial balance still nets to zero');

-- ============================================================
-- Once anything else has posted the opening is final
-- ============================================================
reset role;
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000003', id, '2026-09-26', 1, 1, 1, 'stock_adjustment' from warehouses where is_default and not is_transit;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select cancel_opening_balances('too late')$$, 'P0001', 'DN_VALIDATION:books_in_use', 'cancel is refused once another document has posted');

-- ============================================================
-- ensure_fiscal_year
-- ============================================================
select is(ensure_fiscal_year('2027-28'), 12, 'FY 2027-28 gets its 12 months');
select is((select min(month) from fiscal_periods where year_label = '2027-28'), '2027-04-01'::date, 'starting April');
select is((select max(month) from fiscal_periods where year_label = '2027-28'), '2028-03-01'::date, 'ending March');
select is(ensure_fiscal_year('2027-28'), 0, 'a second call adds nothing');
select throws_ok($$select ensure_fiscal_year('2027-29')$$, 'P0001', 'DN_VALIDATION:bad_year_label', 'a label whose years do not follow is refused');
select throws_ok($$select ensure_fiscal_year('2027')$$, 'P0001', 'DN_VALIDATION:bad_year_label', 'a malformed label is refused');

select * from finish();
rollback;
