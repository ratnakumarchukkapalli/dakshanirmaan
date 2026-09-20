-- Must pass (change 10b, invoice documents):
--  * transport / e-way-bill details can be recorded on a POSTED invoice by any active member
--  * only those columns change: money, status, party, lines and the journal stay exactly as posted
--  * drafts, cancelled invoices, strangers and anonymous callers are refused
--  * bad e-way-bill numbers, half-filled e-way-bill facts and impossible dates are refused
--  * every change leaves an audit row
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code) values
  ('a0000000-0000-0000-0000-000000000001', 'Ramesh Builders', 'customer', '37');
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'UltraTech Cement 50kg', 'cement', '2523', 18, 'bag', 360);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 100, 318, 31800, 'opening'
  from warehouses where is_default limit 1;
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-06-10', 'a0000000-0000-0000-0000-000000000001', '37', 'draft', id
  from warehouses where is_default limit 1;
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000002', '2026-06-11', 'a0000000-0000-0000-0000-000000000001', '37', 'draft', id
  from warehouses where is_default limit 1;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-0000-0000-000000000001', 1, 'c0000000-0000-0000-0000-000000000001', 'UltraTech Cement 50kg', '2523', 'bag', 10, 360, 0, 18),
       ('d0000000-0000-0000-0000-000000000002', 1, 'c0000000-0000-0000-0000-000000000001', 'UltraTech Cement 50kg', '2523', 'bag', 5, 360, 0, 18);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001', true)$$, 'setup: post invoice 1');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002', true)$$, 'setup: post invoice 2');
select lives_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000002', 'test cancel')$$, 'setup: cancel invoice 2');

create temp table before_state on commit drop as
select status, grand_total, taxable_total, party_id, journal_entry_id, invoice_no from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001';
grant select on before_state to authenticated;

-- Counter user records the details.
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 120, 'Sri Sai Transport', '37AAPFU0939F1ZV', 'ap 39 tv 1234',
      '123456789012', '2026-06-10', '2026-06-12 23:59:00+05:30')$$,
  'a counter user can record e-way-bill details on a posted invoice');
select is(
  (select ewb_no || '/' || vehicle_no || '/' || transport_mode || '/' || distance_km from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001'),
  '123456789012/AP 39 TV 1234/road/120', 'the details are stored (vehicle number upper-cased)');
select is(
  (select (s.status, s.grand_total, s.taxable_total, s.party_id, s.journal_entry_id, s.invoice_no)::text
     from sales_invoices s where s.id = 'd0000000-0000-0000-0000-000000000001'),
  (select (b.status, b.grand_total, b.taxable_total, b.party_id, b.journal_entry_id, b.invoice_no)::text from before_state b),
  'status, totals, party, journal link and number are unchanged');
select is(
  (select count(*)::int from audit_log where action = 'record_invoice_ewb' and entity_id = 'd0000000-0000-0000-0000-000000000001'),
  1, 'one audit row was written');

-- Refusals.
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 1, null, null, null, '12345', '2026-06-10', '2026-06-12 00:00:00+05:30')$$,
  'P0001', 'DN_VALIDATION:ewb_no', 'an e-way-bill number must be 12 digits');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 1, null, null, null, '123456789012', null, null)$$,
  'P0001', 'DN_VALIDATION:ewb_incomplete', 'a number without its dates is refused');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 1, null, null, null, '123456789012', '2026-06-10', '2026-06-09 00:00:00+05:30')$$,
  'P0001', 'DN_VALIDATION:ewb_dates', 'valid-until cannot be before the e-way-bill date');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'boat', null, null, null, null, null, null, null)$$,
  'P0001', 'DN_VALIDATION:transport_mode', 'the transport mode must be road, rail, air or ship');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', null, null, 'BADGSTIN', null, null, null, null)$$,
  'P0001', 'DN_VALIDATION:transporter_gstin', 'a malformed transporter GSTIN is refused');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000002', 'road', null, null, null, null, null, null, null)$$,
  'P0001', 'DN_NOT_POSTED', 'a cancelled invoice is refused');
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-0000000000ff', 'road', null, null, null, null, null, null, null)$$,
  'P0001', 'DN_NOT_POSTED', 'an unknown invoice is refused');

-- Strangers and anonymous callers.
set local request.jwt.claims to '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', null, null, null, null, null, null, null)$$,
  'P0001', 'DN_FORBIDDEN', 'a signed-in stranger (not an active member) is refused');
set local role anon;
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', null, null, null, null, null, null, null)$$,
  '42501', null, 'an anonymous caller cannot even call it');

select * from finish();
rollback;
