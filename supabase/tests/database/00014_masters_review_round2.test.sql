-- Must pass (second review of changes 08 + 09, database half):
--  * GSTIN check digit, HSN 4/6/8 digits, blank / same-case second unit, FY start 1-12 are refused by CHECKs
--  * the organisation's state / FY start lock once ANY entry exists or ANY number was issued
--  * the walk-in party cannot get credit terms, a GSTIN or another state, from anyone
--  * a counter user may change ONLY name / phone / WhatsApp / default site on a party (whitelist)
--  * a party with a payable or advance (credit-side) balance cannot be disabled; a settled one can
--  * the sales-line arm of items_guard on its own; address writes by strangers / anon / disabled members
--  * people rules: last-admin demotion, another admin disabling an admin, the 10-person cap on
--    create AND re-enable, through admin_set_user and through a direct write
-- Runs on a freshly reset database (like every other file: it assumes nothing has been posted).
begin;

create extension if not exists pgtap with schema extensions;

select plan(56);

-- Park any real person as inactive so the people counts below start from zero (rolled back).
alter table app_users disable trigger app_users_guard;
update app_users set is_active = false;
alter table app_users enable trigger app_users_guard;

-- ============================================================
-- Fixtures (as the database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-00000000000a', 'owner@example.test'),
  ('e1000000-0000-0000-0000-00000000000b', 'counter@example.test'),
  ('e1000000-0000-0000-0000-00000000000c', 'stranger@example.test'),
  ('e1000000-0000-0000-0000-00000000000d', 'gone@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('e1000000-0000-0000-0000-00000000000a', 'admin', 'Owner', true, 'owner@example.test'),
  ('e1000000-0000-0000-0000-00000000000b', 'user', 'Counter', true, 'counter@example.test'),
  ('e1000000-0000-0000-0000-00000000000d', 'user', 'Gone', false, 'gone@example.test');

insert into parties (id, name, type, state_code) values
  ('e2000000-0000-0000-0000-000000000001', 'Ordinary Customer', 'customer', '37'),
  ('e2000000-0000-0000-0000-000000000002', 'Supplier Owed', 'supplier', '37'),
  ('e2000000-0000-0000-0000-000000000003', 'Customer With Advance', 'customer', '37');
insert into party_addresses (id, party_id, label, address, state_code, is_default) values
  ('e3000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Site', '{"line1":"x"}', '37', false);

-- ============================================================
-- 1. GSTIN check digit
-- ============================================================
select is(gstin_checksum_ok('27AAPFU0939F1ZV'), true, 'a published sample GSTIN passes the check digit');
select is(gstin_checksum_ok('27AAPFU0939F1ZW'), false, 'a wrong last character fails');
select is(gstin_checksum_ok('27aapfu0939f1zv'), false, 'lower case fails (must be upper case)');
select is(gstin_checksum_ok(null), null, 'NULL in, NULL out (a CHECK then lets a missing GSTIN through)');
select throws_ok(
  $$insert into parties (name, type, state_code, gstin) values ('Typo GSTIN', 'supplier', '37', '37AAPFU0939F1ZV')$$,
  '23514', null, 'a GSTIN with a wrong check digit is refused by the database');
select lives_ok(
  $$insert into parties (name, type, state_code, gstin) values ('Right GSTIN', 'supplier', '37', '37AAPFU0939F1ZU')$$,
  'the same number with the right check digit is accepted');
select is((select state_code from organization), '37', 'setup: the organisation is in state 37');
select throws_ok(
  $$update organization set gstin = '37AAPFU0939F1ZV'$$,
  '23514', null, 'the organisation GSTIN also needs a valid check digit');

-- ============================================================
-- 2. Item and organisation checks
-- ============================================================
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate)
    values ('Blank unit', 'steel', '7214', 18, 'kg', '', 1, 1)$$,
  '23514', null, 'a blank second unit is refused');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate)
    values ('Spaces unit', 'steel', '7214', 18, 'kg', '   ', 1, 1)$$,
  '23514', null, 'a whitespace-only second unit is refused');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate)
    values ('Case unit', 'steel', '7214', 18, 'kg', 'KG', 1, 1)$$,
  '23514', null, '"KG" is the same unit as "kg"');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('HSN 5', 'other', '12345', 18, 'kg', 1)$$,
  '23514', null, 'a 5-digit HSN code does not exist');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('HSN 7', 'other', '1234567', 18, 'kg', 1)$$,
  '23514', null, 'a 7-digit HSN code does not exist');
select lives_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('HSN 6', 'other', '721410', 18, 'kg', 1),
                                                                                     ('HSN 8', 'other', '72141090', 18, 'kg', 1)$$,
  '6- and 8-digit HSN codes are accepted');
select throws_ok($$update organization set fy_start_month = 13$$, '23514', null, 'FY start month 13 is refused');
select throws_ok($$update organization set fy_start_month = 0$$, '23514', null, 'FY start month 0 is refused');

-- ============================================================
-- 3. organization_guard: locked by ANY entry or issued number
-- ============================================================
select lives_ok($$update organization set fy_start_month = 5$$, 'with an empty book the FY start can still be set');
update organization set fy_start_month = 4;

update doc_sequences set next_no = 2 where id = (select id from doc_sequences order by series limit 1);
select throws_ok(
  $$update organization set fy_start_month = 5$$,
  'P0001', 'DN_VALIDATION:org_state_locked', 'once ANY document number has been issued the FY start is locked (even with no invoice)');
select throws_ok(
  $$update organization set state_code = '36'$$,
  'P0001', 'DN_VALIDATION:org_state_locked', '...and so is the state');
update doc_sequences set next_no = 1;

select lives_ok($$update organization set fy_start_month = 5$$, 'setup: numbers back to 1, the lock is released');
update organization set fy_start_month = 4;

insert into journal_entries (id, entry_date, source_type, status)
values ('e4000000-0000-0000-0000-000000000001', '2026-06-01', 'manual', 'posted');
insert into journal_lines (entry_id, line_no, account_id, debit, credit)
select 'e4000000-0000-0000-0000-000000000001', 1, (select id from accounts where system_key = 'cash'), 10, 0;
insert into journal_lines (entry_id, line_no, account_id, debit, credit)
select 'e4000000-0000-0000-0000-000000000001', 2, id, 0, 10 from accounts where not is_group and not is_control and system_key <> 'cash' limit 1;
select throws_ok(
  $$update organization set state_code = '36'$$,
  'P0001', 'DN_VALIDATION:org_state_locked', 'a single journal entry of any kind locks the organisation state');

-- ============================================================
-- 4. The walk-in party is closed to everyone
-- ============================================================
select throws_ok($$update parties set credit_limit = null where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'the walk-in party cannot be made unlimited-credit');
select throws_ok($$update parties set credit_limit = 500 where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'nor given a credit limit');
select throws_ok($$update parties set credit_days = 30 where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'nor credit days');
select throws_ok($$update parties set interest_rate_pm = 2 where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'nor an interest rate');
select throws_ok($$update parties set state_code = '36' where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'nor another state');
select throws_ok($$update parties set gstin = '37AAPFU0939F1ZU' where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'nor a GSTIN');
select throws_ok(
  $$update parties set is_walk_in = true where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'an ordinary party cannot be turned into a walk-in');

-- ============================================================
-- 5. Counter users: whitelist of columns
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$update parties set interest_rate_pm = 2 where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot set an interest rate');
select throws_ok(
  $$update parties set monthly_salary = 100 where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'nor a monthly salary');
select throws_ok(
  $$update parties set daily_wage = 10 where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'nor a daily wage');
select throws_ok(
  $$update parties set id = gen_random_uuid() where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'nor the row id (whitelist: anything not listed is owner-only)');
select throws_ok(
  $$update parties set created_at = now() - interval '1 year' where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'nor the creation time');
select lives_ok(
  $$update parties set name = 'Ordinary Customer Ltd', phone = '0866123456', whatsapp_phone = '9876543210',
                       default_site_id = 'e3000000-0000-0000-0000-000000000001'
     where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'name, phones and default site are exactly what a counter user may change');

-- ============================================================
-- 6. Addresses: stranger, anonymous, disabled member
-- ============================================================
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000c","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code) values ('e2000000-0000-0000-0000-000000000001', 'Evil', '{"line1":"z"}', '37')$$,
  '42501', null, 'a non-member cannot add an address');
update party_addresses set label = 'Hacked' where id = 'e3000000-0000-0000-0000-000000000001';
reset role;
select is((select label from party_addresses where id = 'e3000000-0000-0000-0000-000000000001'), 'Site',
  'a non-member cannot change an address (silently no row updated)');

set local role anon;
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code) values ('e2000000-0000-0000-0000-000000000001', 'Anon', '{"line1":"z"}', '37')$$,
  '42501', null, 'anonymous cannot add an address');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000d","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code) values ('e2000000-0000-0000-0000-000000000001', 'Ghost', '{"line1":"z"}', '37')$$,
  '42501', null, 'a disabled member cannot add an address');
update party_addresses set label = 'Ghosted' where id = 'e3000000-0000-0000-0000-000000000001';
reset role;
select is((select label from party_addresses where id = 'e3000000-0000-0000-0000-000000000001'), 'Site',
  'a disabled member cannot change an address (silently no row updated)');

-- ============================================================
-- 7. Balances on the credit side block disabling; a settled party can be disabled
-- ============================================================
-- Direct journal rows (as the database owner) give exact control over the balance.
insert into journal_entries (id, entry_date, source_type, status) values
  ('e4000000-0000-0000-0000-000000000002', '2026-06-02', 'manual', 'posted'),
  ('e4000000-0000-0000-0000-000000000003', '2026-06-03', 'manual', 'posted'),
  ('e4000000-0000-0000-0000-000000000004', '2026-06-04', 'manual', 'posted');
insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
select 'e4000000-0000-0000-0000-000000000002'::uuid, 1, (select id from accounts where system_key = 'ap'), 'e2000000-0000-0000-0000-000000000002'::uuid, 0, 500
union all
select 'e4000000-0000-0000-0000-000000000002'::uuid, 2, (select id from accounts where system_key = 'cash'), null, 500, 0
union all
select 'e4000000-0000-0000-0000-000000000004'::uuid, 1, (select id from accounts where system_key = 'ar'), 'e2000000-0000-0000-0000-000000000003'::uuid, 0, 100
union all
select 'e4000000-0000-0000-0000-000000000004'::uuid, 2, (select id from accounts where system_key = 'cash'), null, 100, 0;

set local role authenticated;
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$update parties set is_active = false where id = 'e2000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:party_has_balance', 'a supplier we still owe (credit-side balance) cannot be disabled');
select throws_ok(
  $$update parties set is_active = false where id = 'e2000000-0000-0000-0000-000000000003'$$,
  'P0001', 'DN_VALIDATION:party_has_balance', 'a customer holding an advance with us (credit-side on receivables) cannot be disabled');
reset role;

-- Settle the supplier exactly: pay the 500 back out.
insert into journal_lines (entry_id, line_no, account_id, party_id, debit, credit)
select 'e4000000-0000-0000-0000-000000000003'::uuid, 1, (select id from accounts where system_key = 'ap'), 'e2000000-0000-0000-0000-000000000002'::uuid, 500, 0
union all
select 'e4000000-0000-0000-0000-000000000003'::uuid, 2, (select id from accounts where system_key = 'cash'), null, 0, 500;

set local role authenticated;
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$update parties set is_active = false where id = 'e2000000-0000-0000-0000-000000000002'$$,
  'a supplier whose balance nets to zero can be disabled');
reset role;

-- ============================================================
-- 8. items_guard: the sales-line arm on its own
-- ============================================================
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('e5000000-0000-0000-0000-000000000001', 'Only On A Draft Line', 'other', '7217', 18, 'kg', 64);
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'e6000000-0000-0000-0000-000000000001', '2026-06-10', 'e2000000-0000-0000-0000-000000000001', '37', 'draft', id
  from warehouses where is_default limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('e6000000-0000-0000-0000-000000000001', 1, 'e5000000-0000-0000-0000-000000000001', 'Only On A Draft Line', '7217', 'kg', 1, 64, 0, 18);
select is((select count(*)::int from stock_movements where item_id = 'e5000000-0000-0000-0000-000000000001'), 0,
  'setup: this item has no stock movement, only a draft sales line');
select throws_ok(
  $$update items set base_uom = 'bundle' where id = 'e5000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'a draft sales-invoice line alone locks the item''s unit');

-- ============================================================
-- 8b. Bank statements are owner-only to read (change 06 second review)
-- ============================================================
insert into bank_statements (id, account_id, period_from, period_to)
values ('e7000000-0000-0000-0000-000000000001', (select id from accounts where system_key = 'cash'), '2026-06-01', '2026-06-30');
insert into bank_statement_lines (statement_id, txn_date, narration, debit, credit, balance)
values ('e7000000-0000-0000-0000-000000000001', '2026-06-30', 'NEFT test', 0, 100, 100);

set local role authenticated;
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000b","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from bank_statements), 0, 'a counter user reads no bank statements');
select is((select count(*)::int from bank_statement_lines), 0, '...and no bank statement lines');
set local request.jwt.claims to '{"sub":"e1000000-0000-0000-0000-00000000000a","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from bank_statements), 1, 'the owner still reads the bank statement');
reset role;

-- ============================================================
-- 9. People: last admin, admin acting on admin, the 10-person cap (create AND re-enable)
-- ============================================================
alter table app_users disable trigger app_users_guard;
update app_users set is_active = false;
alter table app_users enable trigger app_users_guard;

insert into auth.users (id, email)
select ('f1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'n' || n || '@example.test' from generate_series(1, 11) n;
insert into app_users (user_id, role, name, is_active, email)
select ('f1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case when n = 1 then 'admin' else 'user' end::app_role, 'N' || n, true, 'n' || n || '@example.test'
  from generate_series(1, 10) n;
select is((select count(*)::int from app_users where is_active), 10, 'setup: exactly 10 active people');

set local role authenticated;
set local request.jwt.claims to '{"sub":"f1000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select admin_set_user('f1000000-0000-0000-0000-000000000011', 'n11@example.test', 'N11', 'user', true)$$,
  'P0001', 'DN_VALIDATION:max_active_users', 'an 11th active person cannot be created through admin_set_user');
select lives_ok(
  $$select admin_set_user('f1000000-0000-0000-0000-000000000002', 'n2@example.test', 'N2', 'admin', true)$$,
  'an admin can promote another person to admin');
set local request.jwt.claims to '{"sub":"f1000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select admin_set_user('f1000000-0000-0000-0000-000000000001', 'n1@example.test', 'N1', 'admin', false)$$,
  'another admin can disable an admin (only you cannot disable yourself)');
select lives_ok(
  $$select admin_set_user('f1000000-0000-0000-0000-000000000011', 'n11@example.test', 'N11', 'user', true)$$,
  'with 9 active, the 10th person can be created');
select throws_ok(
  $$select admin_set_user('f1000000-0000-0000-0000-000000000001', 'n1@example.test', 'N1', 'admin', true)$$,
  'P0001', 'DN_VALIDATION:max_active_users', 'a disabled person cannot be re-enabled past 10 through admin_set_user');
reset role;
select throws_ok(
  $$update app_users set is_active = true where user_id = 'f1000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:max_active_users', '...nor by a direct write (the guard is on the table)');
select throws_ok(
  $$update app_users set role = 'user' where user_id = 'f1000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:last_admin', 'the last active admin cannot be demoted');
select throws_ok(
  $$update app_users set is_active = false where user_id = 'f1000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:last_admin', 'nor disabled');


select * from finish();

rollback;
