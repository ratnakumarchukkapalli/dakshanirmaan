-- Demo data for Daksha Nirmaan (LOCAL database only — never run this against the hosted project).
--
-- Every figure goes through the real posting functions, as the signed-in owner (the same
-- `set local role authenticated` + `request.jwt.claims` with "aal":"aal2" the pgTAP tests use),
-- so the books, stock and views are exactly what the app would produce. All names are made up.
--
-- Run it once against a freshly reset local database that already has its owner account:
--
--   supabase db reset
--   set -a; . ./.env.local; set +a; npm run create-admin -- <owner email> "<owner name>"
--   docker exec -i supabase_db_Daksh_Nirmaan psql -U postgres -v ON_ERROR_STOP=1 < supabase/demo/demo-data.sql
--
-- It refuses to run twice (reset first). Dates are relative to today, all inside FY 2026-27.

\set ON_ERROR_STOP on
begin;

-- ---------------------------------------------------------------- helpers (session only)
create function pg_temp.d(n int) returns date language sql as $$ select greatest(current_date - n, date '2026-04-01') $$;

create function pg_temp.billing(p_party uuid) returns jsonb language sql as $$
  select jsonb_build_object('label', a.label, 'line1', a.address->>'line1', 'line2', a.address->'line2',
    'city', a.address->>'city', 'district', a.address->'district', 'pincode', a.address->>'pincode', 'state_code', a.state_code)
  from party_addresses a where a.party_id = p_party order by a.is_default desc, a.label limit 1
$$;

create function pg_temp.site(p_party uuid, p_label text) returns jsonb language sql as $$
  select jsonb_build_object('label', a.label, 'line1', a.address->>'line1', 'line2', a.address->'line2',
    'city', a.address->>'city', 'district', a.address->'district', 'pincode', a.address->>'pincode', 'state_code', a.state_code)
  from party_addresses a where a.party_id = p_party and a.label = p_label
$$;

-- A draft sales invoice. p_lines = [[item name, qty, rate, discount %], ...]
create function pg_temp.mk_sale(p_date date, p_party text, p_site text, p_lines jsonb,
  p_vehicle text default null, p_transporter text default null, p_dist int default null) returns uuid language plpgsql as $$
declare v_party record; v_id uuid; v_n int := 0; l jsonb; v_item items;
begin
  select id, state_code into strict v_party from parties where name = p_party;
  insert into sales_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id, billing_address, shipping_address,
                              vehicle_no, transporter_name, transport_mode, distance_km)
  values (p_date, v_party.id, v_party.state_code, 'draft', (select id from warehouses where is_default and not is_transit),
          pg_temp.billing(v_party.id), coalesce(pg_temp.site(v_party.id, p_site), pg_temp.billing(v_party.id)),
          p_vehicle, p_transporter, case when p_vehicle is null then null else 'road' end, p_dist)
  returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select * into strict v_item from items where name = l->>0;
    insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct, taxable_value)
    values (v_id, v_n, v_item.id, v_item.name, v_item.hsn_code, v_item.base_uom, v_item.gst_rate, (l->>1)::numeric,
            case when v_item.alt_uom is null then null else round((l->>1)::numeric / v_item.conversion_factor, 3) end,
            (l->>2)::numeric, coalesce((l->>3)::numeric, 0), 0);
  end loop;
  return v_id;
end $$;

-- A draft purchase invoice. p_lines = [[item name, qty, rate], ...]
create function pg_temp.mk_purchase(p_date date, p_supplier text, p_bill text, p_lines jsonb) returns uuid language plpgsql as $$
declare v_party record; v_id uuid; v_n int := 0; l jsonb; v_item items;
begin
  select id, state_code into strict v_party from parties where name = p_supplier;
  insert into purchase_invoices (invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible)
  values (p_date, v_party.id, v_party.state_code, 'draft', (select id from warehouses where is_default and not is_transit), p_bill, true)
  returning id into v_id;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    select * into strict v_item from items where name = l->>0;
    insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
    values (v_id, v_n, v_item.id, v_item.name, v_item.hsn_code, v_item.base_uom, (l->>1)::numeric, (l->>2)::numeric, 0, v_item.gst_rate);
  end loop;
  return v_id;
end $$;

-- A draft payment (receipt or payment) with one allocation against an invoice. p_amount NULL = the invoice's full total.
create function pg_temp.mk_pay(p_dir text, p_date date, p_party text, p_mode text, p_amount numeric, p_account text,
  p_inv_type text, p_inv uuid, p_instrument text default null, p_bank text default null) returns uuid language plpgsql as $$
declare v_party uuid; v_id uuid; v_amt numeric := p_amount;
begin
  select id into strict v_party from parties where name = p_party;
  if v_amt is null then
    v_amt := case p_inv_type when 'sales_invoice' then (select grand_total from sales_invoices where id = p_inv)
                             else (select grand_total from purchase_invoices where id = p_inv) end;
  end if;
  insert into payments (direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, account_id, status, cheque_bank)
  values (p_dir, p_date, v_party, p_mode::payment_mode, p_instrument, case when p_instrument is null then null else p_date end, v_amt,
          (select id from accounts where system_key = p_account), 'draft', p_bank)
  returning id into v_id;
  insert into payment_allocations (payment_id, invoice_type, invoice_id, amount) values (v_id, p_inv_type, p_inv, v_amt);
  return v_id;
end $$;

-- A second godown for the transfer and stock screens (masters are owner-written; the demo seeds it as the database owner).
insert into warehouses (name, is_default, is_transit) values ('Gannavaram Godown', false, false);

-- ---------------------------------------------------------------- act as the owner from here
select set_config('request.jwt.claims',
  json_build_object('sub', (select user_id from app_users where role = 'admin' and is_active order by created_at limit 1), 'role', 'authenticated', 'aal', 'aal2')::text, true);
set local role authenticated;

do $demo$
declare
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s7 uuid; s8 uuid; s9 uuid; s10 uuid; c1 uuid; c2 uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; pay uuid; ev uuid; dc uuid;
begin
  if exists (select 1 from parties where name = 'Sri Venkateswara Constructions') then
    raise exception 'Demo data is already loaded. Run `supabase db reset` (and create-admin) first.';
  end if;

  -- Organisation --------------------------------------------------------------------------
  update organization set
    trade_name = 'Daksha Nirmaan Traders', gstin = '37AAPFU0939F1ZU',
    address = '{"line1":"Plot 9, Main Road, Autonagar","city":"Vijayawada","district":"NTR","pincode":"520007"}'::jsonb,
    upi_vpa = 'dakshanirmaan@sbi',
    invoice_bank_details = 'State Bank of India, Autonagar, Vijayawada. A/c 00000000000 (demo). IFSC SBIN0000001',
    invoice_footer = 'Goods once sold will not be taken back. Subject to Vijayawada jurisdiction.';

  -- Parties -------------------------------------------------------------------------------
  insert into parties (name, type, state_code, gstin, phone, whatsapp_phone, credit_limit, credit_days) values
    ('Krishna Cement Distributors',      'supplier', '37', '37AAACK1234A1Z9', '8662456789', null, null, 30),
    ('Sri Lakshmi Steels',               'supplier', '37', '37AABCS5678B1ZA', '8662345670', null, null, 30),
    ('Deccan Steel Traders (Hyderabad)', 'supplier', '36', '36AAAFD9012C1Z0', '4023456789', null, null, 15),
    ('Sri Venkateswara Constructions',   'customer', '37', '37ABCFS1234K1Z6', null, '9876543210', 500000, 30),
    ('Amaravati Infra Pvt Ltd',          'customer', '37', '37AAECA4321D1Z7', null, '9848012345', null, 45),
    ('Ramesh Builders',                  'customer', '37', null,               null, '9701234567', 200000, 30),
    ('Lakshmi Hardware, Guntur',         'customer', '37', '37AAJFL7788E1ZQ', null, '9963311220', 100000, 15),
    ('Hyderabad Projects LLP',           'customer', '36', '36AAAFH2468F1ZK', null, '9000112233', null, 30),
    ('Kishore Contractors',              'customer', '37', null,               null, '9247788990', 150000, 30);
  insert into party_addresses (party_id, label, state_code, is_default, address)
  select id, 'Head office', state_code, true,
    jsonb_build_object('line1', 'Shop ' || (10 + row_number() over (order by name)) || ', Main Road', 'city',
      case state_code when '36' then 'Hyderabad' else 'Vijayawada' end, 'pincode', case state_code when '36' then '500001' else '520001' end)
  from parties where name not like 'Cash%';
  insert into party_addresses (party_id, label, state_code, is_default, address)
  select id, 'Poranki site', '37', false, '{"line1":"NH16, Poranki","city":"Poranki","district":"Krishna","pincode":"521137"}'::jsonb
    from parties where name = 'Sri Venkateswara Constructions'
  union all
  select id, 'Kanuru site', '37', false, '{"line1":"Plot 4, Kanuru","city":"Vijayawada","pincode":"520007"}'::jsonb
    from parties where name = 'Amaravati Infra Pvt Ltd';
  update parties set default_site_id = (select id from party_addresses where label = 'Poranki site') where name = 'Sri Venkateswara Constructions';

  -- Items ---------------------------------------------------------------------------------
  insert into items (name, brand, category, hsn_code, gst_rate, base_uom, alt_uom, conversion_factor, sale_rate, reorder_level, is_stock) values
    ('UltraTech PPC 50kg',        'UltraTech', 'cement', '2523', 18, 'bag', null,  null,  366, 300,  true),
    ('UltraTech OPC 53 50kg',     'UltraTech', 'cement', '2523', 18, 'bag', null,  null,  396, 100,  true),
    ('Tata Tiscon Fe500D 8mm',    'Tata',      'steel',  '7214', 18, 'kg',  'pcs', 4.74,  60, 1000, true),
    ('Tata Tiscon Fe500D 12mm',   'Tata',      'steel',  '7214', 18, 'kg',  'pcs', 10.66, 58, 3000, true),
    ('Tata Tiscon Fe500D 16mm',   'Tata',      'steel',  '7214', 18, 'kg',  'pcs', 18.96, 57, 2000, true);

  -- Opening stock, as purchase bills ------------------------------------------------------
  p1 := pg_temp.mk_purchase(pg_temp.d(48), 'Krishna Cement Distributors', 'KCD/2291', '[["UltraTech PPC 50kg",800,300],["UltraTech OPC 53 50kg",300,330]]');
  perform post_purchase_invoice(p1);
  p2 := pg_temp.mk_purchase(pg_temp.d(46), 'Sri Lakshmi Steels', 'SLS/0417', '[["Tata Tiscon Fe500D 8mm",3500,54],["Tata Tiscon Fe500D 12mm",6000,52.5],["Tata Tiscon Fe500D 16mm",4000,52]]');
  perform post_purchase_invoice(p2);
  p3 := pg_temp.mk_purchase(pg_temp.d(30), 'Deccan Steel Traders (Hyderabad)', 'DST/8841', '[["Tata Tiscon Fe500D 12mm",4000,53]]');
  perform post_purchase_invoice(p3);
  p4 := pg_temp.mk_purchase(pg_temp.d(14), 'Krishna Cement Distributors', 'KCD/2544', '[["UltraTech PPC 50kg",500,302]]');
  perform post_purchase_invoice(p4);
  perform post_payment(pg_temp.mk_pay('payment', pg_temp.d(40), 'Krishna Cement Distributors', 'neft', 100000, 'bank', 'purchase_invoice', p1));

  -- Sales, oldest first -------------------------------------------------------------------
  s1 := pg_temp.mk_sale(pg_temp.d(40), 'Sri Venkateswara Constructions', 'Poranki site', '[["UltraTech PPC 50kg",200,365,0]]');
  perform post_sales_invoice(s1);
  s2 := pg_temp.mk_sale(pg_temp.d(38), 'Ramesh Builders', null, '[["Tata Tiscon Fe500D 12mm",500,58,0],["UltraTech PPC 50kg",50,368,0]]');
  perform post_sales_invoice(s2);
  s3 := pg_temp.mk_sale(pg_temp.d(35), 'Amaravati Infra Pvt Ltd', 'Kanuru site', '[["Tata Tiscon Fe500D 16mm",1500,57,0],["Tata Tiscon Fe500D 12mm",1000,58,1]]',
                        'AP 16 TC 4455', 'Own vehicle', 28);
  perform post_sales_invoice(s3);
  perform record_invoice_ewb(s3, 'road', 28, 'Own vehicle', null, 'AP 16 TC 4455', '291000123456', pg_temp.d(35), (pg_temp.d(35) + 2)::timestamptz + interval '23 hours 59 minutes');
  s4 := pg_temp.mk_sale(pg_temp.d(30), 'Lakshmi Hardware, Guntur', null, '[["UltraTech PPC 50kg",120,368,0],["UltraTech OPC 53 50kg",40,395,0]]');
  perform post_sales_invoice(s4);
  s5 := pg_temp.mk_sale(pg_temp.d(24), 'Hyderabad Projects LLP', null, '[["Tata Tiscon Fe500D 8mm",2000,60,0]]', 'TS 09 UB 2210', 'Sri Sai Transport', 275);
  perform post_sales_invoice(s5);
  s6 := pg_temp.mk_sale(pg_temp.d(20), 'Kishore Contractors', null, '[["UltraTech PPC 50kg",300,366,0]]');
  perform post_sales_invoice(s6);
  s7 := pg_temp.mk_sale(pg_temp.d(15), 'Sri Venkateswara Constructions', 'Poranki site', '[["Tata Tiscon Fe500D 12mm",2000,59,0],["UltraTech PPC 50kg",100,366,0]]');
  perform post_sales_invoice(s7);
  s8 := pg_temp.mk_sale(pg_temp.d(10), 'Ramesh Builders', null, '[["UltraTech PPC 50kg",150,367,0]]');
  perform post_sales_invoice(s8);
  perform cancel_document('sales_invoice', s8, 'Entered against the wrong customer; re-billed to Kishore Contractors');
  s9 := pg_temp.mk_sale(pg_temp.d(6), 'Amaravati Infra Pvt Ltd', 'Kanuru site', '[["UltraTech OPC 53 50kg",100,397,0]]');
  perform post_sales_invoice(s9);
  s10 := pg_temp.mk_sale(pg_temp.d(3), 'Sri Venkateswara Constructions', 'Poranki site', '[["Tata Tiscon Fe500D 8mm",1000,59,0]]');
  perform post_sales_invoice(s10);

  -- Counter sales (invoice + receipt in one step) ----------------------------------------
  c1 := pg_temp.mk_sale(pg_temp.d(8), 'Cash / Walk-in customer', null, '[["UltraTech PPC 50kg",20,375,0]]');
  perform post_cash_sale(c1, (select id from accounts where system_key = 'cash'));
  c2 := pg_temp.mk_sale(pg_temp.d(2), 'Cash / Walk-in customer', null, '[["Tata Tiscon Fe500D 12mm",100,62,0]]');
  perform post_cash_sale(c2, (select id from accounts where system_key = 'bank'));

  -- Receipts ------------------------------------------------------------------------------
  perform post_payment(pg_temp.mk_pay('receipt', pg_temp.d(28), 'Sri Venkateswara Constructions', 'neft', null, 'bank', 'sales_invoice', s1));
  perform post_payment(pg_temp.mk_pay('receipt', pg_temp.d(25), 'Ramesh Builders', 'cash', 20000, 'cash', 'sales_invoice', s2));
  pay := pg_temp.mk_pay('receipt', pg_temp.d(12), 'Amaravati Infra Pvt Ltd', 'cheque', 100000, 'bank', 'sales_invoice', s3, '004417', 'HDFC Bank');
  perform post_payment(pay);   -- a cheque in hand (post-dated tile on the payments screen)
  perform post_payment(pg_temp.mk_pay('receipt', pg_temp.d(9), 'Lakshmi Hardware, Guntur', 'upi', null, 'bank', 'sales_invoice', s4));
  perform post_payment(pg_temp.mk_pay('receipt', pg_temp.d(4), 'Kishore Contractors', 'cash', 50000, 'cash', 'sales_invoice', s6));

  -- Expenses ------------------------------------------------------------------------------
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
    values (pg_temp.d(30), 'draft', 'expense', (select id from accounts where system_key = 'cash')) returning id into ev;
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
    values (ev, 1, (select id from accounts where system_key = 'godown_rent'), 8000, 'Godown rent');
  perform post_expense_voucher(ev);
  insert into expense_vouchers (voucher_date, status, voucher_type, pay_account_id)
    values (pg_temp.d(5), 'draft', 'expense', (select id from accounts where system_key = 'cash')) returning id into ev;
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
    values (ev, 1, (select id from accounts where system_key = 'loading_unloading'), 3500, 'Hamali - unloading TMT lorry');
  perform post_expense_voucher(ev);

  -- Staff: two employees, an advance, a salary that recovers it, daily wages, and a stock adjustment + a transfer left in transit ----
  insert into parties (name, type, state_code, phone, monthly_salary) values ('Suribabu', 'employee', '37', '9876500001', 18000);
  insert into parties (name, type, state_code, phone, daily_wage) values ('Ramana', 'employee', '37', '9876500002', 600);
  insert into expense_vouchers (voucher_date, status, voucher_type, party_id, pay_account_id)
    values (pg_temp.d(20), 'draft', 'advance', (select id from parties where name = 'Suribabu'), (select id from accounts where system_key = 'cash')) returning id into ev;
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
    values (ev, 1, (select id from accounts where system_key = 'employee_advance'), 3500, 'Advance - house expense');
  perform post_expense_voucher(ev);
  insert into expense_vouchers (voucher_date, status, voucher_type, party_id, pay_account_id, period_month)
    values (pg_temp.d(10), 'draft', 'salary', (select id from parties where name = 'Suribabu'), (select id from accounts where system_key = 'bank'),
            date_trunc('month', pg_temp.d(10))::date) returning id into ev;
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
    values (ev, 1, (select id from accounts where code = '5500'), 18000, 'Salary');
  perform post_expense_voucher(ev);
  insert into expense_vouchers (voucher_date, status, voucher_type, party_id, pay_account_id, advance_recovered)
    values (pg_temp.d(6), 'draft', 'wages', (select id from parties where name = 'Ramana'), (select id from accounts where system_key = 'cash'), 0) returning id into ev;
  insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration)
    values (ev, 1, (select id from accounts where system_key = 'loading_unloading'), 3600, '6 days x 600');
  perform post_expense_voucher(ev);

  declare adj uuid; tr uuid;
  begin
    insert into stock_adjustments (adj_date, warehouse_id, reason, status)
      values (pg_temp.d(7), (select id from warehouses where is_default and not is_transit), '3 bags torn in rain', 'draft') returning id into adj;
    insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
      select adj, 1, id, name, -3 from items where name = 'UltraTech PPC 50kg';
    perform post_stock_adjustment(adj);
    insert into stock_transfers (transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status)
      values (pg_temp.d(2), (select id from warehouses where is_default and not is_transit), (select id from warehouses where name = 'Gannavaram Godown'), 'AP 16 TC 4455', 'draft') returning id into tr;
    insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
      select tr, 1, id, name, base_uom, 20 from items where name = 'UltraTech PPC 50kg';
    perform post_stock_transfer(tr);
  end;

  -- Goods sent on a challan and not yet billed (one old enough to show in the attention list) --
  insert into delivery_challans (challan_date, party_id, warehouse_id, site_address, vehicle_no, status)
    values (pg_temp.d(9), (select id from parties where name = 'Kishore Contractors'), (select id from warehouses where is_default and not is_transit),
            pg_temp.billing((select id from parties where name = 'Kishore Contractors')), 'AP 39 TV 1234', 'draft') returning id into dc;
  insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate, value)
    select dc, 1, id, name, hsn_code, base_uom, 100, sale_rate, gst_rate, 100 * sale_rate from items where name = 'UltraTech PPC 50kg';
  perform post_delivery_challan(dc);
end
$demo$;

commit;

-- Quick check: the books must balance.
select 'trial balance (debits - credits, must be 0)' as check, (select sum(debit) - sum(credit) from journal_lines) as value;
select 'sales invoices' as what, count(*) filter (where status = 'posted') as posted, count(*) filter (where status = 'cancelled') as cancelled from sales_invoices;
