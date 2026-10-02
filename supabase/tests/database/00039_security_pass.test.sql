-- Security pass before go-live (migration 20261011100000_security_pass).
--
-- Must pass:
--  D1 a line of a posted (or cancelled) sales invoice, purchase invoice, delivery challan, expense
--     voucher, stock adjustment or stock transfer cannot be inserted, updated or deleted — not by the
--     table owner and not by a counter session; the draft path still works; posting still works;
--     allocations of a posted payment are frozen, and cancel_document / bounce_cheque still release
--     them (a marker naming another payment does not)
--  S1 a posted header refuses UPDATE (other than the sanctioned transitions) and DELETE, even for
--     the table owner; record_invoice_ewb, receive_stock_transfer, deposit_cheque, cancel_document
--     and bounce_cheque still work; service_role writes only app_users; no client role holds
--     TRUNCATE / REFERENCES / TRIGGER / MAINTAIN on a public table, now or by default
--  T1 current_app_role() is NULL once the earliest amr timestamp is older than 8 hours (owner and
--     counter), and for an empty or malformed amr; a fresh amr and a token without amr keep the role
--  A1 go_live_readiness reports owners_have_totp, green only when every active owner has a verified
--     TOTP factor; owner_totp_status() is owner-at-aal2 only and lists active members
--  A2 counters cannot read bank audit rows; note audit payloads carry no stock cost; a bank expense
--     without a note is narrated 'Bank charge'
--  D2 post_cash_deposit and post_day_close take the shared cash_day advisory lock
begin;

create extension if not exists pgtap with schema extensions;

select plan(142);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');

create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
-- a claim set with an amr whose earliest step is p_age_sec seconds ago (and a fresh TOTP step)
create function _with_amr(p_sub text, p_aal text, p_age_sec int) returns void language sql as $$
  select set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","aal":"%s","amr":[{"method":"totp","timestamp":%s},{"method":"password","timestamp":%s}]}',
           p_sub, p_aal, extract(epoch from now())::bigint - 30, extract(epoch from now())::bigint - p_age_sec), true) $$;
create function _acct(p_key text) returns uuid language sql stable as $$
  select id from accounts where system_key = p_key $$;
create function _head() returns uuid language sql stable as $$
  select id from warehouses where is_default and not is_transit $$;
grant execute on function _as_owner(), _as_owner_aal1(), _as_counter(), _with_amr(text, text, int),
  _acct(text), _head() to authenticated;

insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000001', 'Guard Customer', 'customer', state_code from organization limit 1;
insert into parties (id, name, type, state_code)
select 'a0000000-0000-0000-0000-000000000002', 'Guard Supplier', 'supplier', state_code from organization limit 1;
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', 'cement', '2523', 28, 'bag', 400);
insert into warehouses (id, name) values ('e0000000-0000-0000-0000-000000000002', 'Guard Second Godown');
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
values ('c0000000-0000-0000-0000-000000000001', _head(), '2026-04-05', 1000, 300, 300000, 'opening');

-- Drafts: sales SI1 (to post), SI2 (stays draft), SI3 (posted then cancelled), SI4 (cheque target)
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select v.id::uuid, '2026-09-10', 'a0000000-0000-0000-0000-000000000001', o.state_code, 'draft', _head()
  from organization o,
       (values ('d0000000-0000-0000-0000-000000000001'), ('d0000000-0000-0000-0000-000000000002'),
               ('d0000000-0000-0000-0000-000000000003'), ('d0000000-0000-0000-0000-000000000004')) v(id);
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
select ('f0000000-0000-0000-0000-00000000000' || n)::uuid, ('d0000000-0000-0000-0000-00000000000' || n)::uuid, 1,
       'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', '2523', 'bag', 2, 400, 28
  from generate_series(1, 4) n;

insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, supplier_bill_no, itc_eligible)
select 'd1000000-0000-0000-0000-000000000001', '2026-09-10', 'a0000000-0000-0000-0000-000000000002', state_code, 'draft', _head(), 'GUARD-1', true
  from organization limit 1;
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('f1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', '2523', 'bag', 10, 300, 0, 28);

insert into delivery_challans (id, challan_date, party_id, warehouse_id, status)
values ('d2000000-0000-0000-0000-000000000001', '2026-09-10', 'a0000000-0000-0000-0000-000000000001', _head(), 'draft');
insert into delivery_challan_lines (id, challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate, value)
values ('f2000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', '2523', 'bag', 1, 400, 28, 400);

insert into expense_vouchers (id, voucher_date, status, voucher_type, pay_account_id)
values ('d3000000-0000-0000-0000-000000000001', '2026-09-10', 'draft', 'expense', _acct('cash'));
insert into expense_voucher_lines (id, voucher_id, line_no, account_id, amount, narration)
values ('f3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 1, _acct('godown_rent'), 100, 'rent');

insert into stock_adjustments (id, adj_date, warehouse_id, reason, status)
values ('d4000000-0000-0000-0000-000000000001', '2026-09-10', _head(), 'guard', 'draft');
insert into stock_adjustment_lines (id, adjustment_id, line_no, item_id, item_name, qty)
values ('f4000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', -1);

insert into stock_transfers (id, transfer_date, from_warehouse_id, to_warehouse_id, vehicle_no, status)
values ('d5000000-0000-0000-0000-000000000001', '2026-09-10', _head(), 'e0000000-0000-0000-0000-000000000002', 'AP 00 XX 0000', 'draft');
insert into stock_transfer_lines (id, transfer_id, line_no, item_id, item_name, uom, qty)
values ('f5000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000001', 1,
        'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', 'bag', 1);

-- ============================================================
-- Draft path still works (owner and counter), for every guarded line table
-- ============================================================
select lives_ok($$update sales_invoice_lines set qty = 3 where id = 'f0000000-0000-0000-0000-000000000002'$$, 'owner session: a draft line can be updated');
select lives_ok($$insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
                  values ('d0000000-0000-0000-0000-000000000002', 2, 'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', '2523', 'bag', 1, 400, 28)$$,
                'owner session: a line can be added to a draft');
select lives_ok($$delete from sales_invoice_lines where invoice_id = 'd0000000-0000-0000-0000-000000000002' and line_no = 2$$, 'owner session: a draft line can be deleted');
set local role authenticated;
select _as_counter();
select lives_ok($$insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
                  values ('d0000000-0000-0000-0000-000000000002', 3, 'c0000000-0000-0000-0000-000000000001', 'Guard Cement 50kg', '2523', 'bag', 1, 400, 28)$$,
                'counter: a line can be added to a draft invoice');
select lives_ok($$update sales_invoice_lines set qty = 4 where invoice_id = 'd0000000-0000-0000-0000-000000000002' and line_no = 3$$, 'counter: a draft line can be updated');
select lives_ok($$delete from sales_invoice_lines where invoice_id = 'd0000000-0000-0000-0000-000000000002' and line_no = 3$$, 'counter: a draft line can be deleted');
reset role;
select lives_ok($$update purchase_invoice_lines set qty = 10 where id = 'f1000000-0000-0000-0000-000000000001'$$, 'draft purchase line writable');
select lives_ok($$update delivery_challan_lines set qty = 1 where id = 'f2000000-0000-0000-0000-000000000001'$$, 'draft challan line writable');
select lives_ok($$update expense_voucher_lines set amount = 100 where id = 'f3000000-0000-0000-0000-000000000001'$$, 'draft voucher line writable');
select lives_ok($$update stock_adjustment_lines set qty = -1 where id = 'f4000000-0000-0000-0000-000000000001'$$, 'draft adjustment line writable');
select lives_ok($$update stock_transfer_lines set qty = 1 where id = 'f5000000-0000-0000-0000-000000000001'$$, 'draft transfer line writable');

-- ============================================================
-- Posting still works end to end (the functions write lines while the header is a draft)
-- ============================================================
set local role authenticated;
select _as_owner();
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000001')$$, 'post_sales_invoice still posts (snapshot refresh on its own draft)');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000003')$$, 'second invoice posts');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-000000000004')$$, 'third invoice posts');
select lives_ok($$select post_purchase_invoice('d1000000-0000-0000-0000-000000000001')$$, 'post_purchase_invoice still posts');
select lives_ok($$select post_delivery_challan('d2000000-0000-0000-0000-000000000001')$$, 'post_delivery_challan still posts');
select lives_ok($$select post_expense_voucher('d3000000-0000-0000-0000-000000000001')$$, 'post_expense_voucher still posts');
select lives_ok($$select post_stock_adjustment('d4000000-0000-0000-0000-000000000001')$$, 'post_stock_adjustment still posts');
select lives_ok($$select post_stock_transfer('d5000000-0000-0000-0000-000000000001')$$, 'post_stock_transfer still posts');
select lives_ok($$select cancel_document('sales_invoice', 'd0000000-0000-0000-0000-000000000003', 'guard test')$$, 'cancel_document still cancels an invoice');
reset role;
set local request.jwt.claims to '';
select is((select taxable_value from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000001'), 800.00::numeric,
          'the posting function filled the line''s computed columns');

-- ============================================================
-- D1: lines under a posted / cancelled header — the table owner is refused
-- ============================================================
select throws_ok($$insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
                   values ('d0000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 400, 28)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a posted sales invoice');
select throws_ok($$update sales_invoice_lines set qty = 99 where id = 'f0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE a posted sales invoice line');
select throws_ok($$delete from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a posted sales invoice line');
select throws_ok($$update sales_invoice_lines set invoice_id = 'd0000000-0000-0000-0000-000000000002' where id = 'f0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted line cannot be moved onto a draft');
select throws_ok($$update sales_invoice_lines set invoice_id = 'd0000000-0000-0000-0000-000000000001' where id = 'f0000000-0000-0000-0000-000000000002'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a draft line cannot be moved onto a posted invoice');
select throws_ok($$insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
                   values ('d0000000-0000-0000-0000-000000000003', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 400, 28)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a cancelled sales invoice');
select throws_ok($$delete from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000003'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a cancelled invoice''s line');

select throws_ok($$insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
                   values ('d1000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 0, 28)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a posted purchase invoice');
select throws_ok($$update purchase_invoice_lines set rate = 1 where id = 'f1000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE a posted purchase line');
select throws_ok($$delete from purchase_invoice_lines where id = 'f1000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a posted purchase line');

select throws_ok($$insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate, value)
                   values ('d2000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 28, 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a posted challan');
select throws_ok($$update delivery_challan_lines set qty = 5 where id = 'f2000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE a posted challan line');
select throws_ok($$delete from delivery_challan_lines where id = 'f2000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a posted challan line');

select throws_ok($$insert into expense_voucher_lines (voucher_id, line_no, account_id, amount)
                   values ('d3000000-0000-0000-0000-000000000001', 9, _acct('godown_rent'), 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a posted expense voucher');
select throws_ok($$update expense_voucher_lines set amount = 1 where id = 'f3000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE a posted voucher line');
select throws_ok($$delete from expense_voucher_lines where id = 'f3000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a posted voucher line');

select throws_ok($$insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
                   values ('d4000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on a posted adjustment');
select throws_ok($$update stock_adjustment_lines set qty = -5 where id = 'f4000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE a posted adjustment line');
select throws_ok($$delete from stock_adjustment_lines where id = 'f4000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE a posted adjustment line');

select throws_ok($$insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
                   values ('d5000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', 'bag', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: INSERT a line on an in-transit transfer');
select throws_ok($$update stock_transfer_lines set qty = 5 where id = 'f5000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: UPDATE an in-transit transfer line');
select throws_ok($$delete from stock_transfer_lines where id = 'f5000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: DELETE an in-transit transfer line');

-- ============================================================
-- D1: the same through a counter session (INSERT reaches the trigger; RLS already hides posted
-- rows from UPDATE/DELETE, which therefore change nothing)
-- ============================================================
set local role authenticated;
select _as_counter();
select throws_ok($$insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate)
                   values ('d0000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 400, 28)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on a posted sales invoice');
select throws_ok($$insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
                   values ('d1000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 0, 28)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on a posted purchase invoice');
select throws_ok($$insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate, value)
                   values ('d2000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', '2523', 'bag', 1, 1, 28, 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on a posted challan');
select throws_ok($$insert into expense_voucher_lines (voucher_id, line_no, account_id, amount)
                   values ('d3000000-0000-0000-0000-000000000001', 9, _acct('godown_rent'), 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on a posted voucher');
select throws_ok($$insert into stock_adjustment_lines (adjustment_id, line_no, item_id, item_name, qty)
                   values ('d4000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on a posted adjustment');
select throws_ok($$insert into stock_transfer_lines (transfer_id, line_no, item_id, item_name, uom, qty)
                   values ('d5000000-0000-0000-0000-000000000001', 9, 'c0000000-0000-0000-0000-000000000001', 'x', 'bag', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: INSERT a line on an in-transit transfer');
update sales_invoice_lines set qty = 99 where id = 'f0000000-0000-0000-0000-000000000001';
delete from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000001';
reset role;
set local request.jwt.claims to '';
select is((select qty from sales_invoice_lines where id = 'f0000000-0000-0000-0000-000000000001'), 2.000::numeric,
          'counter: UPDATE / DELETE of a posted line changed nothing');
select is((select count(*)::int from sales_invoice_lines where invoice_id = 'd0000000-0000-0000-0000-000000000001'), 1,
          'the posted invoice still has exactly its one posted line');

-- Deleting a draft header still takes its lines with it (the cascade passes the guard).
select lives_ok($$delete from sales_invoices where id = 'd0000000-0000-0000-0000-000000000002'$$, 'a draft invoice can be deleted with its lines');
select is((select count(*)::int from sales_invoice_lines where invoice_id = 'd0000000-0000-0000-0000-000000000002'), 0, '...and its lines are gone');

-- ============================================================
-- D1: payment allocations
-- ============================================================
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id, status) values
  ('e0000000-0000-0000-0000-000000000001', 'receipt', '2026-09-11', 'a0000000-0000-0000-0000-000000000001', 'cash', 300, _acct('cash'), 'draft');
insert into payments (id, direction, payment_date, party_id, mode, instrument_no, instrument_date, amount, account_id, cheque_bank, status) values
  ('e0000000-0000-0000-0000-000000000002', 'receipt', '2026-09-11', 'a0000000-0000-0000-0000-000000000001', 'cheque', '000111', '2026-09-11', 500, _acct('bank'), 'SBI', 'draft');
select lives_ok($$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
                  values ('e0000000-0000-0000-0000-000000000001', 'sales_invoice', 'd0000000-0000-0000-0000-000000000001', 300)$$,
                'a draft receipt can be allocated');
select lives_ok($$update payment_allocations set amount = 250 where payment_id = 'e0000000-0000-0000-0000-000000000001'$$, 'a draft allocation can be changed');
select lives_ok($$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
                  values ('e0000000-0000-0000-0000-000000000002', 'sales_invoice', 'd0000000-0000-0000-0000-000000000004', 500)$$,
                'a draft cheque receipt can be allocated');

set local role authenticated;
select _as_owner();
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000001')$$, 'post_payment still posts an allocated receipt');
select lives_ok($$select post_payment('e0000000-0000-0000-0000-000000000002')$$, 'the cheque receipt posts');
select throws_ok($$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
                   values ('e0000000-0000-0000-0000-000000000001', 'sales_invoice', 'd0000000-0000-0000-0000-000000000001', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner session: no allocation can be added to a posted receipt');
select _as_counter();
select throws_ok($$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
                   values ('e0000000-0000-0000-0000-000000000001', 'sales_invoice', 'd0000000-0000-0000-0000-000000000001', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'counter: no allocation can be added to a posted receipt');
reset role;
set local request.jwt.claims to '';
select throws_ok($$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
                   values ('e0000000-0000-0000-0000-000000000001', 'sales_invoice', 'd0000000-0000-0000-0000-000000000001', 1)$$,
                 'P0001', 'DN_NOT_DRAFT', 'table owner: INSERT allocation on a posted receipt');
select throws_ok($$update payment_allocations set amount = 1 where payment_id = 'e0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'table owner: UPDATE a posted receipt''s allocation');
select throws_ok($$delete from payment_allocations where payment_id = 'e0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'table owner: DELETE a posted receipt''s allocation');
select throws_ok($$select set_config('dn.release_allocations', 'e0000000-0000-0000-0000-000000000002', true);
                   delete from payment_allocations where payment_id = 'e0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'a release marker naming another payment does not unlock this one');
select set_config('dn.release_allocations', '', true);

-- cancel_document and bounce_cheque still release allocations
set local role authenticated;
select _as_owner();
select lives_ok($$select cancel_document('payment', 'e0000000-0000-0000-0000-000000000001', 'guard test')$$, 'cancel_document still cancels an allocated receipt');
select lives_ok($$select deposit_cheque('e0000000-0000-0000-0000-000000000002')$$, 'deposit_cheque still updates a posted cheque receipt');
select lives_ok($$select bounce_cheque('e0000000-0000-0000-0000-000000000002', 'guard test')$$, 'bounce_cheque still bounces an allocated cheque');
reset role;
set local request.jwt.claims to '';
select is((select count(*)::int from payment_allocations where payment_id in ('e0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002')),
          0, 'both reversals released their allocations');
select is((select status::text || '/' || cheque_status from payments where id = 'e0000000-0000-0000-0000-000000000002'), 'cancelled/bounced',
          'the bounced cheque is cancelled and marked bounced');
select is(current_setting('dn.release_allocations', true), '', 'the release marker is cleared after use');

-- ============================================================
-- S1: posted headers are immutable for every writer
-- ============================================================
select throws_ok($$update sales_invoices set grand_total = 1 where id = 'd0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted invoice''s total cannot be rewritten');
select throws_ok($$update sales_invoices set status = 'cancelled' where id = 'd0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted invoice cannot be marked cancelled without its reversal');
select throws_ok($$update sales_invoices set status = 'draft' where id = 'd0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted invoice cannot go back to draft');
select throws_ok($$delete from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted invoice cannot be deleted');
select throws_ok($$update sales_invoices set irn = 'X' where id = 'd0000000-0000-0000-0000-000000000003'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a cancelled invoice cannot be changed');
select throws_ok($$update sales_invoices set status = 'posted' where id = 'd0000000-0000-0000-0000-000000000003'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a cancelled invoice cannot be revived');
select throws_ok($$update purchase_invoices set supplier_bill_no = 'X' where id = 'd1000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted purchase invoice cannot be changed');
select throws_ok($$delete from purchase_invoices where id = 'd1000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted purchase invoice cannot be deleted');
select throws_ok($$update delivery_challans set party_id = 'a0000000-0000-0000-0000-000000000002' where id = 'd2000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted challan cannot be re-pointed');
select throws_ok($$update delivery_challans set invoice_id = 'd0000000-0000-0000-0000-000000000001' where id = 'd2000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a challan cannot be linked to an invoice that was not made from it');
select throws_ok($$update expense_vouchers set voucher_date = '2026-09-01' where id = 'd3000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted voucher cannot be changed');
select throws_ok($$update stock_adjustments set reason = 'x' where id = 'd4000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted adjustment cannot be changed');
select throws_ok($$update stock_transfers set to_warehouse_id = _head() where id = 'd5000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: an in-transit transfer cannot be re-pointed');
select throws_ok($$update payments set amount = 1 where id = 'e0000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a cancelled receipt cannot be changed');
select throws_ok($$update payments set cheque_status = 'cleared' where id = 'e0000000-0000-0000-0000-000000000002'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a bounced receipt''s cheque status cannot be rewritten');
select throws_ok($$delete from payments where id = 'e0000000-0000-0000-0000-000000000002'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a bounced receipt cannot be deleted');

-- the sanctioned changes still work
set local role authenticated;
select _as_counter();
select lives_ok($$select record_invoice_ewb('d0000000-0000-0000-0000-000000000001', 'road', 120, null, null, 'ap 39 tv 1234',
                    '123456789012', '2026-09-10', '2026-09-12 23:59:00+05:30')$$,
                'record_invoice_ewb still writes e-way-bill details on a posted invoice');
select _as_owner();
select lives_ok($$select receive_stock_transfer('d5000000-0000-0000-0000-000000000001')$$, 'receive_stock_transfer still receives');
select lives_ok($$select cancel_document('stock_adjustment', 'd4000000-0000-0000-0000-000000000001', 'guard test')$$, 'cancel_document still cancels an adjustment');
select lives_ok($$select cancel_document('expense_voucher', 'd3000000-0000-0000-0000-000000000001', 'guard test')$$, 'cancel_document still cancels a voucher');
reset role;
set local request.jwt.claims to '';
select is((select ewb_no from sales_invoices where id = 'd0000000-0000-0000-0000-000000000001'), '123456789012', 'the e-way bill is stored');
select is((select status from stock_transfers where id = 'd5000000-0000-0000-0000-000000000001'), 'received', 'the transfer is received');
select throws_ok($$update stock_transfers set status = 'in_transit' where id = 'd5000000-0000-0000-0000-000000000001'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a received transfer cannot go back in transit');

-- Every guarded header table carries the trigger.
select is((select count(*)::int from pg_trigger
            where tgname = 'zz_posted_document_guard' and not tgisinternal and tgenabled = 'O'
              and tgrelid::regclass::text in ('sales_invoices', 'purchase_invoices', 'credit_notes', 'debit_notes', 'payments',
                'expense_vouchers', 'delivery_challans', 'stock_adjustments', 'stock_transfers', 'cash_deposits', 'day_closes',
                'opening_batches')),
          12, 'the posted-document guard is on all 12 document headers');
select is((select count(*)::int from pg_trigger
            where tgname = 'document_lines_guard' and not tgisinternal and tgenabled = 'O'),
          6, 'the line guard is on the 6 line tables that lacked one');
select ok((select prosecdef and proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.document_lines_guard()'::regprocedure)
      and (select prosecdef and proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.posted_document_guard()'::regprocedure)
      and (select prosecdef and proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.payment_allocations_guard()'::regprocedure)
      and (select prosecdef from pg_proc where oid = 'public.opening_lines_guard()'::regprocedure),
          'guard functions are SECURITY DEFINER with a pinned search_path');

-- ============================================================
-- S1 / D3: privileges
-- ============================================================
select is((select count(*)::int from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'app_users'
              and has_table_privilege('service_role', c.oid, 'insert,update,delete,truncate')),
          0, 'service_role cannot write any business table');
select ok(has_table_privilege('service_role', 'public.app_users', 'insert')
      and has_table_privilege('service_role', 'public.app_users', 'update')
      and has_table_privilege('service_role', 'public.app_users', 'select'),
          'service_role keeps what create-admin and the invite flow need on app_users');
select ok(has_table_privilege('service_role', 'public.sales_invoices', 'select')
      and has_table_privilege('service_role', 'public.sales_invoice_lines', 'select'),
          'service_role still reads invoices (signed PDF link)');
select is((select count(*)::int from pg_class c, aclexplode(c.relacl) a
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
              and a.grantee in ('authenticated'::regrole, 'service_role'::regrole, 'anon'::regrole)
              and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')),
          0, 'no client role holds TRUNCATE / REFERENCES / TRIGGER / MAINTAIN on a public table');
select is((select count(*)::int from pg_default_acl d, aclexplode(d.defaclacl) a
            where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
              and ((a.grantee = 'service_role'::regrole and a.privilege_type <> 'SELECT')
                or (a.grantee = 'authenticated'::regrole and a.privilege_type in ('REFERENCES', 'TRIGGER', 'MAINTAIN', 'TRUNCATE')))),
          0, 'new tables: service_role gets SELECT only, authenticated no REFERENCES/TRIGGER/MAINTAIN');
select ok(to_regprocedure('public.rls_auto_enable()') is null
       or not (has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE')
               or has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')
               or has_function_privilege('service_role', 'public.rls_auto_enable()', 'EXECUTE')),
          'rls_auto_enable() (hosted only) is not executable by any client role');

-- ============================================================
-- T1: the 8-hour session time-box
-- ============================================================
set local role authenticated;
select _with_amr('33333333-3333-3333-3333-333333333333', 'aal2', 3600);
select is(current_app_role()::text, 'admin', 'owner at aal2 signed in 1 hour ago: admin');
select _with_amr('33333333-3333-3333-3333-333333333333', 'aal2', 7 * 3600 + 3000);
select is(current_app_role()::text, 'admin', 'owner at aal2 signed in 7h50m ago: still admin');
select _with_amr('33333333-3333-3333-3333-333333333333', 'aal2', 8 * 3600 + 60);
select is(current_app_role(), null, 'owner at aal2 signed in 8h01m ago (fresh TOTP step does not reset it): no role');
select is(is_active_member(), false, '...and is_active_member() is false');
select throws_ok($$select log_export('books', 2026)$$, 'P0001', 'DN_FORBIDDEN', '...and an owner-only function refuses');
select is((select count(*)::int from sales_invoices), 0, '...and RLS shows no rows');
select _with_amr('44444444-4444-4444-4444-444444444444', 'aal1', 9 * 3600);
select is(current_app_role(), null, 'counter signed in 9 hours ago: no role');
select _with_amr('44444444-4444-4444-4444-444444444444', 'aal1', 600);
select is(current_app_role()::text, 'user', 'counter signed in 10 minutes ago: user');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2","amr":[]}', true);
select is(current_app_role(), null, 'an empty amr fails closed');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2","amr":"password"}', true);
select is(current_app_role(), null, 'an amr that is not an array fails closed');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2","amr":[{"method":"password","timestamp":"soon"}]}', true);
select is(current_app_role(), null, 'an amr without a usable timestamp fails closed');
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2","amr":null}', true);
select is(current_app_role(), null, 'an amr of JSON null fails closed');
select _as_owner();
select is(current_app_role()::text, 'admin', 'a token with no amr claim at all (only mintable with the project secret) is not time-boxed');
select _with_amr('33333333-3333-3333-3333-333333333333', 'aal1', 60);
select is(current_app_role(), null, 'a fresh owner session below aal2 still has no role');
reset role;
set local request.jwt.claims to '';

-- ============================================================
-- A1: owners have an authenticator before go-live
-- ============================================================
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'owners_have_totp'), false,
          'go-live: owners_have_totp is red while the owner has no verified factor');
select is((select has_totp from owner_totp_status() where user_id = '33333333-3333-3333-3333-333333333333'), false,
          'owner_totp_status: the owner has no authenticator yet');
select is((select count(*)::int from owner_totp_status()), 2, 'owner_totp_status lists the active members');
reset role;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('99999999-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'unverified', 'totp', 'unverified', now(), now(), 'x');
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'owners_have_totp'), false,
          'go-live: an unverified factor does not count');
reset role;
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('99999999-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'phone', 'totp', 'verified', now(), now(), 'x');
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'owners_have_totp'), true,
          'go-live: green once every active owner has a verified TOTP factor');
select is((select has_totp from owner_totp_status() where user_id = '33333333-3333-3333-3333-333333333333'), true,
          'owner_totp_status: the owner now has an authenticator');
select is((select has_totp from owner_totp_status() where user_id = '44444444-4444-4444-4444-444444444444'), false,
          'owner_totp_status: the counter has none');
reset role;
insert into auth.users (id, email) values ('66666666-6666-6666-6666-666666666666', 'owner2@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('66666666-6666-6666-6666-666666666666', 'admin', 'Second Owner', true, 'owner2@example.test');
set local role authenticated;
select _as_owner();
select is((select ok from go_live_readiness() where check_key = 'owners_have_totp'), false,
          'go-live: red again when a second active owner has no factor');
select _as_owner_aal1();
select throws_ok($$select * from owner_totp_status()$$, 'P0001', 'DN_FORBIDDEN', 'owner_totp_status: owner below aal2 refused');
select _as_counter();
select throws_ok($$select * from owner_totp_status()$$, 'P0001', 'DN_FORBIDDEN', 'owner_totp_status: counter refused');
reset role;
set local request.jwt.claims to '';
select ok(not has_function_privilege('anon', 'public.owner_totp_status()', 'EXECUTE')
      and not has_function_privilege('service_role', 'public.owner_totp_status()', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.owner_totp_status()', 'EXECUTE'),
          'owner_totp_status: authenticated only');
select ok((select prosecdef and proconfig::text like '%search_path=public, pg_temp%' from pg_proc where oid = 'public.owner_totp_status()'::regprocedure),
          'owner_totp_status is SECURITY DEFINER with a pinned search_path');

-- ============================================================
-- A2: audit trail
-- ============================================================
set local role authenticated;
select _as_owner();
select import_bank_statement(_acct('bank'), 'guard.txt', '[
  {"txnDate":"2026-09-06","narration":"FEE ACC 50100012345 TO SOMEONE","reference":"FEEG","debit":"75.00","credit":"0.00","balance":"925.00"}
]'::jsonb);
create temp table _bx as
  select post_bank_expense((select id from bank_statement_lines where reference = 'FEEG')) as r;
grant select on _bx to authenticated;
select ok((select count(*) from audit_log where entity in ('bank_statements', 'bank_statement_lines')) >= 2,
          'owner reads the bank import / match audit rows');
select _as_counter();
select is((select count(*)::int from audit_log where entity in ('bank_statements', 'bank_statement_lines')), 0,
          'counter reads no bank audit rows');
select ok((select count(*) from audit_log where entity = 'sales_invoices') > 0,
          'counter still reads ordinary audit rows');
reset role;
set local request.jwt.claims to '';
select is((select narration from expense_voucher_lines where voucher_id = (select (r ->> 'voucher_id')::uuid from _bx)), 'Bank charge',
          'a bank expense without a note is narrated ''Bank charge'', not the bank''s narration');
select ok((select prosrc not like '%''stock_value''%' from pg_proc where oid = 'public.post_credit_note(uuid)'::regprocedure),
          'post_credit_note no longer writes stock_value into the audit payload');
select ok((select prosrc not like '%''cogs_true_up''%' from pg_proc where oid = 'public.post_debit_note(uuid)'::regprocedure),
          'post_debit_note no longer writes cogs_true_up into the audit payload');

-- ============================================================
-- D2: cash deposit and day close share one lock
-- ============================================================
select ok((select prosrc like '%pg_advisory_xact_lock(hashtext(''cash_day''))%' from pg_proc where oid = 'public.post_cash_deposit(date, numeric, text, text)'::regprocedure)
      and (select prosrc like '%pg_advisory_xact_lock(hashtext(''cash_day''))%' from pg_proc where oid = 'public.post_day_close(date, numeric, text, numeric)'::regprocedure),
          'post_cash_deposit and post_day_close take the cash_day advisory lock');
set local role authenticated;
select _as_counter();
select lives_ok($$select post_cash_deposit('2026-09-10', 10, null, null)$$, 'a cash deposit still posts');
select lives_ok($$select post_day_close('2026-09-10', 0, null, null)$$, 'a day close (with a difference entry) still posts');
reset role;
set local request.jwt.claims to '';
select isnt((select journal_entry_id from day_closes where close_date = '2026-09-10' and status = 'posted'), null,
            'the day close links its own difference entry (the one change the header guard allows it)');
select throws_ok($$update day_closes set counted = 1 where close_date = '2026-09-10'$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted day close cannot be rewritten');
select throws_ok($$update cash_deposits set amount = 1$$,
                 'P0001', 'DN_NOT_DRAFT', 'owner: a posted cash deposit cannot be rewritten');
set local role authenticated;
select _as_owner();
select lives_ok($$select cancel_document('day_close', (select id from day_closes where close_date = '2026-09-10' and status = 'posted'), 'guard test')$$,
                'cancel_document still reopens a day close');
select lives_ok($$select cancel_document('cash_deposit', (select id from cash_deposits limit 1), 'guard test')$$,
                'cancel_document still cancels a cash deposit');
reset role;

select * from finish();
rollback;
