-- Must pass (Opus review of change 10a, migration 20260925110000):
--  * a draft line's item_name / hsn_code / uom / gst_rate, tampered with directly through the API,
--    is overwritten from the item master at post time and tax is computed from the master rate
--    (sales invoice, delivery challan, purchase invoice; name/unit on transfers and adjustments)
--  * a sales or purchase draft pointed at the hidden In Transit warehouse is refused
--  * negative qty / negative rate / discount over 100% / zero total are refused with DN_VALIDATION
--  * an e-way bill cannot predate its invoice, and e-way-bill / transport columns cannot be
--    written onto a draft in shapes record_invoice_ewb would refuse
begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000001', 'Ramesh Builders', 'customer', state_code from organization limit 1;
insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000002', 'Cement Supplier', 'supplier', state_code from organization limit 1;

-- 28% cement: the rate a tamperer would want to zero.
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', 'cement', '2523', 28, 'bag', 400);

insert into warehouses (id, name) values ('e0000000-0000-0000-0000-000000000002', 'Second Godown');

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select 'c0000000-0000-0000-0000-000000000001', id, '2026-04-05', 1000, 300, 300000, 'opening'
  from warehouses where is_default and not is_transit;

-- Sales draft d1 (10 bags @ 400, intra-state), written the honest way.
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-06-10', 'a0000000-0000-0000-0000-000000000001',
       state_code, 'draft', (select id from warehouses where is_default and not is_transit)
  from organization limit 1;
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', '2523', 'bag', 10, 400, 0, 28);

-- Sales draft d2: the guard target (re-pointed / re-valued per test, always rolled back).
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select 'd0000000-0000-0000-0000-000000000002', '2026-06-11', 'a0000000-0000-0000-0000-000000000001',
       state_code, 'draft', (select id from warehouses where is_default and not is_transit)
  from organization limit 1;
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('f0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 1,
        'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', '2523', 'bag', 5, 400, 0, 28);

-- ============================================================
-- 1. Sales invoice: a counter user tampers with the snapshot through the API, then posts
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$update sales_invoice_lines set gst_rate = 0, hsn_code = '9999', item_name = 'Sand', uom = 'x'
     where id = 'f0000000-0000-0000-0000-000000000001'$$,
  'setup: RLS lets a counter user PATCH the snapshot columns of a draft line');
select is((select gst_rate from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000001'), 0.00::numeric,
  'setup: the tampered gst_rate is really stored on the draft');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$,
  'the counter user posts the tampered draft');

reset role;
set local request.jwt.claims to '';

select is(
  (select item_name || '|' || hsn_code || '|' || uom || '|' || gst_rate from sales_invoice_lines
    where id = 'f0000000-0000-0000-0000-000000000001'),
  'UltraTech OPC 53 50kg|2523|bag|28.00',
  'posting overwrote name, HSN, unit and GST rate from the item master');
select is(
  (select (cgst_total, sgst_total, igst_total, taxable_total, grand_total)::text from sales_invoices
    where id = 'd0000000-0000-0000-0000-000000000001'),
  '(560.00,560.00,0.00,4000.00,5120.00)',
  'tax was computed from the master 28%, not the tampered 0%');
select is(
  (select sum(jl.credit) from journal_lines jl join accounts a on a.id = jl.account_id
    where a.system_key in ('output_cgst', 'output_sgst')
      and jl.entry_id = (select journal_entry_id from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001')),
  1120.00::numeric,
  'the journal carries the full output GST');

-- ============================================================
-- 2. Sales invoice guards (admin session; every refusal rolls back)
-- ============================================================

update sales_invoices set warehouse_id = (select id from warehouses where is_transit)
 where id = 'd0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:invalid_warehouse', 'a sales draft pointed at the In Transit warehouse is refused');
select throws_ok($$select post_cash_sale('d0000000-0000-0000-0000-000000000002', (select id from accounts where system_key = 'cash'))$$,
  'P0001', 'DN_VALIDATION:invalid_warehouse', 'the cash-sale path refuses it too');
reset role;
set local request.jwt.claims to '';
update sales_invoices set warehouse_id = (select id from warehouses where is_default and not is_transit)
 where id = 'd0000000-0000-0000-0000-000000000002';

update sales_invoice_lines set qty = -5 where id = 'f0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:invalid_qty', 'a negative sale quantity is refused (it would be a stock-in with no Inventory debit)');
reset role;
set local request.jwt.claims to '';

update sales_invoice_lines set qty = 5, rate = -400 where id = 'f0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:invalid_rate', 'a negative rate is refused');
reset role;
set local request.jwt.claims to '';

update sales_invoice_lines set rate = 400, discount_pct = 150 where id = 'f0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:invalid_discount', 'a discount over 100% is refused');
reset role;
set local request.jwt.claims to '';

update sales_invoice_lines set rate = 0, discount_pct = 0 where id = 'f0000000-0000-0000-0000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:zero_total', 'a zero-total invoice is refused in the DN_VALIDATION vocabulary');
reset role;
set local request.jwt.claims to '';
select is((select status::text from sales_invoices where id = 'd0000000-0000-0000-0000-000000000002'), 'draft',
  'every refused post left the draft as it was');

-- ============================================================
-- 3. Delivery challan: tampered snapshot overwritten
-- ============================================================

insert into delivery_challans (id, challan_date, party_id, warehouse_id, status)
select 'b0000000-0000-0000-0000-000000000001', '2026-06-12', 'a0000000-0000-0000-0000-000000000001', id, 'draft'
  from warehouses where is_default and not is_transit;
insert into delivery_challan_lines (id, challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
values ('f0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Sand', '9999', 'x', 3, 400, 0);

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select lives_ok($$select post_delivery_challan('b0000000-0000-0000-0000-000000000001')$$,
  'a counter user posts a challan whose line snapshot was tampered with');
reset role;
set local request.jwt.claims to '';
select is(
  (select item_name || '|' || hsn_code || '|' || uom || '|' || gst_rate from delivery_challan_lines
    where id = 'f0000000-0000-0000-0000-000000000003'),
  'UltraTech OPC 53 50kg|2523|bag|28.00',
  'the posted challan shows the master name, HSN, unit and GST rate');

-- ============================================================
-- 4. Purchase invoice: tampered gst_rate cannot inflate or erase input tax; transit refused
-- ============================================================

insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
select 'd1000000-0000-0000-0000-000000000001', '2026-06-12', 'a0000000-0000-0000-0000-000000000002',
       state_code, 'draft', (select id from warehouses where is_default and not is_transit), 'SB-1'
  from organization limit 1;
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('f1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Sand', '9999', 'x', 100, 300, 0, 40);

insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no)
select 'd1000000-0000-0000-0000-000000000002', '2026-06-12', 'a0000000-0000-0000-0000-000000000002',
       state_code, 'draft', (select id from warehouses where is_transit), 'SB-2'
  from organization limit 1;
insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d1000000-0000-0000-0000-000000000002', 1,
        'c0000000-0000-0000-0000-000000000001', 'UltraTech OPC 53 50kg', '2523', 'bag', 10, 300, 0, 28);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_purchase_invoice('d1000000-0000-0000-0000-000000000001')$$,
  'the owner posts a purchase whose line snapshot was tampered with');
select throws_ok($$select post_purchase_invoice('d1000000-0000-0000-0000-000000000002')$$,
  'P0001', 'DN_VALIDATION:invalid_warehouse', 'a purchase received into the In Transit warehouse is refused');
reset role;
set local request.jwt.claims to '';

select is(
  (select item_name || '|' || hsn_code || '|' || uom || '|' || gst_rate from purchase_invoice_lines
    where id = 'f1000000-0000-0000-0000-000000000001'),
  'UltraTech OPC 53 50kg|2523|bag|28.00',
  'the posted purchase line shows the master name, HSN, unit and GST rate');
select is(
  (select (cgst_total, sgst_total, taxable_total, grand_total)::text from purchase_invoices
    where id = 'd1000000-0000-0000-0000-000000000001'),
  '(4200.00,4200.00,30000.00,38400.00)',
  'input tax was computed from the master 28%, not the tampered 40%');

-- ============================================================
-- 5. Stock transfer and adjustment: display snapshot overwritten
-- ============================================================

insert into stock_transfers (id, transfer_date, from_warehouse_id, to_warehouse_id, status)
select 'b1000000-0000-0000-0000-000000000001', '2026-06-13', id, 'e0000000-0000-0000-0000-000000000002', 'draft'
  from warehouses where is_default and not is_transit;
insert into stock_transfer_lines (id, transfer_id, line_no, item_id, item_name, uom, qty)
values ('f2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Sand', 'x', 2);

insert into stock_adjustments (id, adj_date, warehouse_id, status, reason)
select 'b2000000-0000-0000-0000-000000000001', '2026-06-13', id, 'draft', 'torn bags'
  from warehouses where is_default and not is_transit;
insert into stock_adjustment_lines (id, adjustment_id, line_no, item_id, item_name, qty)
values ('f3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Sand', -1);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_stock_transfer('b1000000-0000-0000-0000-000000000001')$$, 'setup: post the transfer');
select lives_ok($$select post_stock_adjustment('b2000000-0000-0000-0000-000000000001')$$, 'setup: post the adjustment');
reset role;
set local request.jwt.claims to '';

select is(
  (select (select item_name || '|' || uom from stock_transfer_lines where id = 'f2000000-0000-0000-0000-000000000001')
       || '/' || (select item_name from stock_adjustment_lines where id = 'f3000000-0000-0000-0000-000000000001')),
  'UltraTech OPC 53 50kg|bag/UltraTech OPC 53 50kg',
  'transfer and adjustment lines show the master name and unit after posting');

-- ============================================================
-- 6. E-way bill / transport columns
-- ============================================================

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 10, null, null, null,
      '123456789012', '2026-06-09', '2026-06-12 23:59:00+05:30')$$,
  'P0001', 'DN_VALIDATION:ewb_before_invoice', 'an e-way bill dated before its invoice is refused');
select throws_ok(
  $$update sales_invoices set ewb_no = '123456789012', ewb_date = '2026-06-11', ewb_valid_until = '2026-06-12 23:59:00+05:30'
     where id = 'd0000000-0000-0000-0000-000000000002'$$,
  '23514', null, 'e-way-bill facts cannot be written onto a draft directly (only record_invoice_ewb on a posted invoice)');
select throws_ok(
  $$update sales_invoices set transporter_gstin = 'BADGSTIN', transport_mode = 'boat'
     where id = 'd0000000-0000-0000-0000-000000000002'$$,
  '23514', null, 'a malformed transporter GSTIN or transport mode cannot be written onto a draft directly');
reset role;
set local request.jwt.claims to '';

select * from finish();
rollback;
