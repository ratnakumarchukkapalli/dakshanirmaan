-- Must pass (change 09, masters):
--  * a counter user can add a party but never set credit terms, salary, or disable one
--  * only owners write items and the organisation; nobody deletes; strangers write nothing
--  * the database refuses bad GSTIN / state / phone / UPI / unit data even when the app is bypassed
--  * the books are protected: walk-in party, parties with a balance, item units after use,
--    organisation state after the first posted invoice
begin;

create extension if not exists pgtap with schema extensions;

select plan(90);

-- ============================================================
-- Fixtures (as the database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'left@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'user', 'Former Staff', false, 'left@example.test');

insert into parties (id, name, type, state_code) values
  ('a0000000-0000-0000-0000-000000000001', 'Ramesh Builders', 'customer', '37'),
  ('a0000000-0000-0000-0000-000000000002', 'Quiet Customer', 'customer', '37'),
  ('a0000000-0000-0000-0000-000000000003', 'Other Party', 'supplier', '37'),
  ('a0000000-0000-0000-0000-000000000004', 'Staff Member', 'employee', '37');
insert into party_addresses (id, party_id, label, address, state_code, is_default) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Site A', '{"line1":"x"}', '37', false),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Yard', '{"line1":"y"}', '37', false);

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'UltraTech Cement 50kg', 'cement', '2523', 18, 'bag', 360),
  ('c0000000-0000-0000-0000-000000000002', 'Unused Item', 'other', '7217', 18, 'kg', 64);

-- History for item 1 and a real balance for party 1: opening stock + a draft invoice we post later.
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 100, 318, 31800, 'opening'
  from warehouses where is_default limit 1;
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-06-10', 'a0000000-0000-0000-0000-000000000001', '37', 'draft', id
  from warehouses where is_default limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001',
        'UltraTech Cement 50kg', '2523', 'bag', 10, 360, 0, 18);

-- ============================================================
-- Counter user (role user)
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$insert into parties (id, name, type, state_code, credit_limit, credit_days, interest_rate_pm, monthly_salary)
    values ('a0000000-0000-0000-0000-0000000000f1', 'Walk-up Customer', 'customer', '37', 500000, 30, 2, 15000)$$,
  'a counter user can add a customer');
select is(
  (select credit_limit::text || '/' || credit_days || '/' || interest_rate_pm::text || '/' || coalesce(monthly_salary::text, 'null')
     from parties where id = 'a0000000-0000-0000-0000-0000000000f1'),
  '0.00/0/0.00/null',
  'credit terms and salary a counter user tried to set are reset (new customers start with no credit)');
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Sneaky Employee', 'employee', '37')$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot create an employee party');
select throws_ok(
  $$update parties set credit_limit = 900000 where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot raise a credit limit');
select throws_ok(
  $$update parties set credit_days = 90 where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot change credit days');
select lives_ok(
  $$update parties set phone = '9876543210', whatsapp_phone = '9876543210' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'a counter user can update contact details');
select throws_ok(
  $$update parties set is_active = false where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot disable a party');
select throws_ok(
  $$update parties set type = 'supplier' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot change a party''s type');
select throws_ok(
  $$update parties set gstin = '37AAPFU0939F1ZU' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot change a party''s GSTIN');
select throws_ok(
  $$update parties set state_code = '36' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'a counter user cannot change a party''s state');
select lives_ok(
  $$update parties set name = 'Quiet Customer Traders' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'a counter user can still rename a party');
select lives_ok(
  $$insert into parties (id, name, type, state_code, gstin)
    values ('a0000000-0000-0000-0000-0000000000f2', 'GST Walk-up', 'supplier', '37', '37BBBBB1234B1ZE')$$,
  'a counter user can still add a party with a GSTIN and state');
select lives_ok(
  $$insert into parties (id, name, type, state_code, is_active)
    values ('a0000000-0000-0000-0000-0000000000f3', 'Born Inactive', 'customer', '37', false)$$,
  'a counter user tries to add a party as already inactive');
select is(
  (select is_active from parties where id = 'a0000000-0000-0000-0000-0000000000f3'),
  true, '...but a new party from a counter user is always active');
select lives_ok(
  $$insert into party_addresses (party_id, label, address, state_code, is_default)
    values ('a0000000-0000-0000-0000-000000000002', 'Main', '{"line1":"z"}', '37', true)$$,
  'a counter user can add a delivery address');
select throws_ok(
  $$delete from parties where id = 'a0000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'nobody deletes parties (no privilege)');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('X', 'other', '1234', 18, 'kg', 1)$$,
  '42501', null, 'a counter user cannot add an item');
select throws_ok($$truncate organization$$, '42501', null, 'an app session cannot truncate the organisation');
select throws_ok($$truncate parties$$, '42501', null, 'an app session cannot truncate parties');
select throws_ok($$truncate items$$, '42501', null, 'an app session cannot truncate items');
select throws_ok($$truncate party_addresses$$, '42501', null, 'an app session cannot truncate party addresses');
update items set sale_rate = 1 where id = 'c0000000-0000-0000-0000-000000000002';
select is(
  (select sale_rate from items where id = 'c0000000-0000-0000-0000-000000000002'),
  64.0000, 'a counter user cannot change an item (silently no row updated)');
update organization set upi_vpa = 'evil@upi';
select is(
  (select upi_vpa from organization), null,
  'a counter user cannot change the organisation (silently no row updated)');

-- ============================================================
-- Stranger (signed in, not a member) and anonymous
-- ============================================================
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Intruder', 'customer', '37')$$,
  '42501', null, 'a non-member cannot add a party');
reset role;
set local role anon;
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Anon', 'customer', '37')$$,
  '42501', null, 'anonymous cannot add a party');
reset role;

-- A former member (row exists, is_active = false): RLS treats them like a stranger.
set local role authenticated;
set local request.jwt.claims to '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Ghost', 'customer', '37')$$,
  '42501', null, 'a disabled member cannot add a party');
update parties set name = 'Renamed by ghost' where id = 'a0000000-0000-0000-0000-000000000003';
reset role;
select is(
  (select name from parties where id = 'a0000000-0000-0000-0000-000000000003'),
  'Other Party', 'a disabled member cannot change a party (silently no row updated)');

-- The guard itself must fail closed. Run as the table owner (RLS does not apply) but WITH a
-- signed-in identity that has no membership: it has no role, so it must count as a non-admin.
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into parties (name, type, state_code, credit_limit) values ('Sneaky Employee 2', 'employee', '37', 999999)$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'guard fails closed: a signed-in non-member cannot create an employee party');
select lives_ok(
  $$insert into parties (id, name, type, state_code, credit_limit, credit_days)
    values ('a0000000-0000-0000-0000-0000000000f4', 'Non-member Customer', 'customer', '37', 999999, 90)$$,
  'guard fails closed: a non-member''s insert reaches the guard...');
select is(
  (select credit_limit::text || '/' || credit_days from parties where id = 'a0000000-0000-0000-0000-0000000000f4'),
  '0.00/0', '...which strips credit terms exactly as for a counter user');
select throws_ok(
  $$update parties set credit_limit = 999999 where id = 'a0000000-0000-0000-0000-000000000003'$$,
  'P0001', 'DN_VALIDATION:admin_only_field', 'guard fails closed: a non-member cannot change credit terms');
set local request.jwt.claims to '';

-- ============================================================
-- Owner (admin)
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';

select lives_ok(
  $$update parties set credit_limit = 250000, credit_days = 30, interest_rate_pm = 1.5 where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'an owner sets credit terms');
select lives_ok(
  $$update parties set gstin = '37AAPFU0939F1ZU' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'a GSTIN whose first two digits match the state is accepted');
select throws_ok(
  $$update parties set gstin = '36AAPFU0939F1ZW' where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '23514', null, 'a GSTIN from a different state than the party is refused');
select throws_ok(
  $$update parties set gstin = '37aapfu0939f1zv' where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '23514', null, 'a malformed GSTIN is refused');
select throws_ok(
  $$update parties set gstin = '37AAPFU0939F1ZU' where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '23505', null, 'the same GSTIN cannot belong to two parties');
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Bad State', 'customer', '00')$$,
  '23514', null, 'state code 00 is not a GST state');
select throws_ok(
  $$insert into parties (name, type, state_code) values ('Bad State', 'customer', '40')$$,
  '23514', null, 'state code 40 is not a GST state');
select throws_ok(
  $$update parties set whatsapp_phone = '12345' where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '23514', null, 'a WhatsApp number must be a 10-digit mobile');
select throws_ok(
  $$update parties set phone = '98x6543210' where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '23514', null, 'a phone number must be digits');
select throws_ok(
  $$update parties set default_site_id = 'b0000000-0000-0000-0000-000000000003' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '23503', null, 'a default site must be one of the party''s own addresses');
select lives_ok(
  $$update parties set default_site_id = 'b0000000-0000-0000-0000-000000000001' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'a party''s own address can be its default site');
select throws_ok(
  $$insert into party_addresses (party_id, label, address, state_code, is_default)
    values ('a0000000-0000-0000-0000-000000000002', 'Second main', '{"line1":"q"}', '37', true)$$,
  '23505', null, 'a party has at most one billing address');
select lives_ok(
  $$update parties set is_active = false where id = 'a0000000-0000-0000-0000-000000000003'$$,
  'an owner can disable a party with no balance');
select lives_ok(
  $$update parties set is_active = true where id = 'a0000000-0000-0000-0000-000000000003'$$,
  '…and re-enable it');
select throws_ok(
  $$update parties set type = 'customer' where id = 'a0000000-0000-0000-0000-000000000004'$$,
  'P0001', 'DN_VALIDATION:party_type_locked', 'an employee cannot be turned into a customer (or back)');

-- Walk-in party is protected from everyone, owners included.
select throws_ok(
  $$update parties set is_active = false where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'the walk-in customer cannot be disabled');
select throws_ok(
  $$update parties set type = 'supplier' where is_walk_in$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'the walk-in customer cannot change type');
select throws_ok(
  $$insert into parties (name, type, state_code, is_walk_in) values ('Second Walk-in', 'customer', '37', true)$$,
  'P0001', 'DN_VALIDATION:walk_in_protected', 'an app session cannot create another walk-in party');

-- Items (owner)
select lives_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate)
    values ('Tiscon 12mm', 'steel', '7214', 18, 'kg', 'pc', 10.66, 58)$$,
  'an owner adds a TMT item with a pieces-to-kg pair');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('Bad HSN', 'other', '12', 18, 'kg', 1)$$,
  '23514', null, 'an HSN code must be 4 to 8 digits');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, sale_rate) values ('No factor', 'steel', '7214', 18, 'kg', 'pc', 1)$$,
  '23514', null, 'a second unit needs a conversion factor');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate) values ('Same unit', 'steel', '7214', 18, 'kg', 'kg', 1, 1)$$,
  '23514', null, 'the second unit must differ from the first');
select throws_ok(
  $$insert into items (name, category, hsn_code, gst_rate, base_uom, sale_rate) values ('Negative', 'other', '7217', 18, 'kg', -5)$$,
  '23514', null, 'a sale rate cannot be negative');
select throws_ok(
  $$update items set base_uom = 'bundle' where id = 'c0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'an item''s unit is locked once it has stock or document history');
select throws_ok(
  $$update items set category = 'other' where id = 'c0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'so is its category');
select lives_ok(
  $$update items set name = 'UltraTech PPC 50kg', sale_rate = 365, gst_rate = 18, reorder_level = 200 where id = 'c0000000-0000-0000-0000-000000000001'$$,
  'name, rate and reorder level of a used item can still change');
select lives_ok(
  $$update items set base_uom = 'bag', alt_uom = 'pallet', conversion_factor = 40 where id = 'c0000000-0000-0000-0000-000000000002'$$,
  'an unused item''s units can still change');

-- Organisation (owner)
select lives_ok(
  $$update organization set upi_vpa = 'dakshanirmaan@sbi', invoice_footer = 'Subject to Vijayawada jurisdiction'$$,
  'an owner sets the UPI ID and invoice footer');
select throws_ok(
  $$update organization set upi_vpa = 'not a vpa'$$,
  '23514', null, 'a malformed UPI ID is refused');
select throws_ok(
  $$update organization set gstin = '36AAPFU0939F1ZW'$$,
  '23514', null, 'the organisation GSTIN must match its state');
select throws_ok(
  $$delete from organization$$, '42501', null, 'the organisation row cannot be deleted');
select throws_ok(
  $$insert into organization (legal_name, state_code) values ('Second Org', '37')$$,
  '42501', null, 'there cannot be a second organisation row');

-- A party with a balance cannot be disabled: post the draft invoice for party 1 first.
select lives_ok(
  $$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$,
  'setup: an owner posts a credit invoice to Ramesh Builders');
select throws_ok(
  $$update parties set is_active = false where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:party_has_balance', 'a party who owes us money cannot be disabled');

-- Changing a party's type: harmless without a balance, restricted with one (owners included).
select lives_ok(
  $$update parties set type = 'supplier' where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'an owner can change the type of a party with no balance');
select throws_ok(
  $$update parties set type = 'supplier' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:party_type_has_balance', 'a customer who owes us money cannot become supplier-only (even for an owner)');
select lives_ok(
  $$update parties set type = 'both' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'but widening a party with a balance to customer-and-supplier is allowed');
select throws_ok(
  $$update parties set type = 'customer' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'DN_VALIDATION:party_type_has_balance', 'and narrowing it again while the balance is open is refused');

-- An address never moves to another party.
select throws_ok(
  $$update party_addresses set party_id = 'a0000000-0000-0000-0000-000000000002' where id = 'b0000000-0000-0000-0000-000000000003'$$,
  'P0001', 'DN_VALIDATION:address_party_locked', 'an address cannot be re-parented to another party');
select lives_ok(
  $$update party_addresses set label = 'Yard (rear gate)' where id = 'b0000000-0000-0000-0000-000000000003'$$,
  'but the rest of an address can be edited');

-- Organisation state is locked once an invoice has been posted.
select throws_ok(
  $$update organization set state_code = '36'$$,
  'P0001', 'DN_VALIDATION:org_state_locked', 'the organisation''s state cannot change after the first posted invoice');
select throws_ok(
  $$update organization set fy_start_month = 1$$,
  'P0001', 'DN_VALIDATION:org_state_locked', 'nor can the financial-year start');
select lives_ok(
  $$update organization set upi_vpa = 'newvpa@sbi'$$,
  'but the UPI ID still can');

reset role;

-- ============================================================
-- items_guard: every unit field, and every history table (as the database owner: the guard
-- protects the books whoever writes)
-- ============================================================
-- One item with a pieces-per-kg pair and stock history: each guarded field is refused on its own.
insert into items (id, name, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate) values
  ('c1000000-0000-0000-0000-0000000000a0', 'Locked Pair Item', 'steel', '7214', 18, 'kg', 'pc', 10, 58);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c1000000-0000-0000-0000-0000000000a0', id, '2026-04-05', 100, 50, 5000, 'opening'
  from warehouses where is_default limit 1;
select throws_ok(
  $$update items set alt_uom = 'bundle' where id = 'c1000000-0000-0000-0000-0000000000a0'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'the second unit of an item with history is locked');
select throws_ok(
  $$update items set conversion_factor = 20 where id = 'c1000000-0000-0000-0000-0000000000a0'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'so is its conversion factor');
select throws_ok(
  $$update items set is_stock = false where id = 'c1000000-0000-0000-0000-0000000000a0'$$,
  'P0001', 'DN_VALIDATION:item_units_locked', 'so is its stock-tracked flag');
select lives_ok(
  $$update items set name = 'Locked Pair Item (renamed)' where id = 'c1000000-0000-0000-0000-0000000000a0'$$,
  'but its name can still change');

-- One item per history table, each holding a single line in that table only. The update is
-- refused while the line exists and allowed once it is removed, so each table is shown to be
-- what locks the item.
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate)
select ('c1000000-0000-0000-0000-00000000000' || n)::uuid, 'History item ' || n, 'other', '7217', 18, 'kg', 1
  from generate_series(1, 6) n;

insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, warehouse_id)
select 'e0000000-0000-0000-0000-000000000001', '2026-06-01', 'a0000000-0000-0000-0000-000000000003', '37', id
  from warehouses where is_default limit 1;
insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values ('e0000000-0000-0000-0000-000000000001', 1, 'c1000000-0000-0000-0000-000000000001', 'History item 1', '7217', 'kg', 1, 1, 1, 18);

insert into credit_notes (id, note_date, party_id, place_of_supply)
  values ('e0000000-0000-0000-0000-000000000002', '2026-06-01', 'a0000000-0000-0000-0000-000000000001', '37');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values ('e0000000-0000-0000-0000-000000000002', 1, 'c1000000-0000-0000-0000-000000000002', 'History item 2', '7217', 'kg', 1, 1, 1, 18);

insert into debit_notes (id, note_date, party_id, place_of_supply)
  values ('e0000000-0000-0000-0000-000000000003', '2026-06-01', 'a0000000-0000-0000-0000-000000000003', '37');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values ('e0000000-0000-0000-0000-000000000003', 1, 'c1000000-0000-0000-0000-000000000003', 'History item 3', '7217', 'kg', 1, 1, 1, 18);

insert into delivery_challans (id, challan_date, party_id, warehouse_id)
select 'e0000000-0000-0000-0000-000000000004', '2026-06-01', 'a0000000-0000-0000-0000-000000000001', id
  from warehouses where is_default limit 1;
insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
  values ('e0000000-0000-0000-0000-000000000004', 1, 'c1000000-0000-0000-0000-000000000004', 'History item 4', '7217', 'kg', 1, 1, 18);

insert into stock_transfers (id, transfer_date, from_warehouse_id, to_warehouse_id)
select 'e0000000-0000-0000-0000-000000000005', '2026-06-01', f.id, t.id
  from warehouses f, warehouses t where f.is_default and t.is_transit;
insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
  values ('e0000000-0000-0000-0000-000000000005', 1, 'c1000000-0000-0000-0000-000000000005', 'History item 5', 'kg', 1);

insert into stock_adjustments (id, adj_date, warehouse_id)
select 'e0000000-0000-0000-0000-000000000006', '2026-06-01', id from warehouses where is_default limit 1;
insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
  values ('e0000000-0000-0000-0000-000000000006', 1, 'c1000000-0000-0000-0000-000000000006', 'History item 6', 1);

select throws_ok(
  format($q$update items set base_uom = 'bag' where id = %L$q$, h.item_id),
  'P0001', 'DN_VALIDATION:item_units_locked', 'a line in ' || h.tbl || ' locks the item''s unit')
  from (values
    ('purchase_invoice_lines', 'c1000000-0000-0000-0000-000000000001'),
    ('credit_note_lines',      'c1000000-0000-0000-0000-000000000002'),
    ('debit_note_lines',       'c1000000-0000-0000-0000-000000000003'),
    ('delivery_challan_lines', 'c1000000-0000-0000-0000-000000000004'),
    ('stock_transfer_lines',   'c1000000-0000-0000-0000-000000000005'),
    ('stock_adjustment_lines', 'c1000000-0000-0000-0000-000000000006')) h(tbl, item_id)
  order by h.item_id;

delete from purchase_invoice_lines where invoice_id = 'e0000000-0000-0000-0000-000000000001';
delete from credit_note_lines where note_id = 'e0000000-0000-0000-0000-000000000002';
delete from debit_note_lines where note_id = 'e0000000-0000-0000-0000-000000000003';
delete from delivery_challan_lines where challan_id = 'e0000000-0000-0000-0000-000000000004';
delete from stock_transfer_lines where transfer_id = 'e0000000-0000-0000-0000-000000000005';
delete from stock_adjustment_lines where adjustment_id = 'e0000000-0000-0000-0000-000000000006';

select lives_ok(
  format($q$update items set base_uom = 'bag' where id = %L$q$, h.item_id),
  'with its ' || h.tbl || ' line gone, the unit is free again')
  from (values
    ('purchase_invoice_lines', 'c1000000-0000-0000-0000-000000000001'),
    ('credit_note_lines',      'c1000000-0000-0000-0000-000000000002'),
    ('debit_note_lines',       'c1000000-0000-0000-0000-000000000003'),
    ('delivery_challan_lines', 'c1000000-0000-0000-0000-000000000004'),
    ('stock_transfer_lines',   'c1000000-0000-0000-0000-000000000005'),
    ('stock_adjustment_lines', 'c1000000-0000-0000-0000-000000000006')) h(tbl, item_id)
  order by h.item_id;

select * from finish();

rollback;
