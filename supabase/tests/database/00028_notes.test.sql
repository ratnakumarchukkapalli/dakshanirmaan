-- Change 20 (notes), database half: post_credit_note, post_debit_note, cancel_document for notes,
-- owner-only note drafts, and every downstream reader that must stay right once notes exist.
--
-- Scenarios (names from the proposal):
--   * "credit note reverses revenue and GST proportionally"
--   * "debit note is the remedy when a purchase cannot be cancelled"
--   * "note quantity cannot exceed what was invoiced"
--
-- Same discipline as 00006: every post_*/cancel_* call runs under `set local role authenticated` with
-- real JWT claims (admin at aal2 unless the test is about the gate); fixtures are inserted as
-- postgres. Sigma-debit = Sigma-credit is asserted on every entry a note creates, and once more over
-- the whole ledger at the end.
--
-- Timeline (FY 2026-27, all months open unless a test locks one):
--   June   I1 (P1, intra: cement 10 + steel 100 + freight 1), I2 (P2, inter: steel 200),
--          I3 (P1: cement 5), PB1 (S2, inter: cement 100 @ 400 -> moves the cement average),
--          R1 pays I2 in full, R2 pays 2,000 of I3; CN1, CN2 (returns), CN4 (value-only),
--          CN5 (inter-state return on the fully paid I2)
--   July   PB2 (S1: RET 100 @ 200), PB3 (S1, no ITC: steel 10 @ 55.55), I4 sells 70 RET,
--          DN1 (return 30 RET, the remedy), DN2 (return on the no-ITC bill), DN3 (value-only),
--          DN4 (stand-alone value-only), DN5 (return on PB1, then cancelled)
--   August I5 (CAN 10), CN7 (return 4 CAN, then cancelled), CN8 (stand-alone value-only),
--          DC1 -> I6 (challan-converted CHL 5), CN9 (return 2 CHL at the challan's cost)
begin;

create extension if not exists pgtap with schema extensions;

select plan(341);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');
update organization set gstin = '37AAPFU0939F1ZU';

insert into parties (id, name, type, state_code, gstin) values
  ('a2000000-0000-4000-8000-000000000001', 'P1 B2B intra', 'customer', '37', '37ABCDE1234F1ZZ'),
  ('a2000000-0000-4000-8000-000000000002', 'P2 B2B inter', 'customer', '36', '36ABCDE1234F1Z1'),
  ('a2000000-0000-4000-8000-000000000005', 'S1 local supplier', 'supplier', '37', null),
  ('a2000000-0000-4000-8000-000000000006', 'S2 inter supplier', 'supplier', '29', null);

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock) values
  ('c2000000-0000-4000-8000-000000000001', 'Cement 50kg', 'cement', '2523', 28, 'bag', 400, true),
  ('c2000000-0000-4000-8000-000000000002', 'TMT 12mm', 'steel', '7214', 18, 'kg', 70, true),
  ('c2000000-0000-4000-8000-000000000003', 'Freight to site', 'other', '9965', 18, 'trip', 500, false),
  ('c2000000-0000-4000-8000-000000000004', 'Return Item', 'other', '7308', 18, 'pcs', 250, true),
  ('c2000000-0000-4000-8000-000000000006', 'Cancel Item', 'other', '7309', 18, 'pcs', 150, true),
  ('c2000000-0000-4000-8000-000000000007', 'Challan Item', 'other', '7310', 18, 'pcs', 120, true);

create temp table _wh as select id from warehouses where is_default and not is_transit limit 1;

insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select v.item, (select id from _wh), '2026-04-05', v.q, v.r, v.q * v.r, 'opening'
from (values
  ('c2000000-0000-4000-8000-000000000001'::uuid, 1000, 300),
  ('c2000000-0000-4000-8000-000000000002', 10000, 50),
  ('c2000000-0000-4000-8000-000000000006', 50, 100),
  ('c2000000-0000-4000-8000-000000000007', 20, 80)) v(item, q, r);

-- helpers (rolled back with the file)
create function _entry(p_note uuid) returns uuid language sql as $$
  select coalesce((select journal_entry_id from credit_notes where id = p_note),
                  (select journal_entry_id from debit_notes where id = p_note))
$$;
-- net debit on one system account inside one entry (credit shows negative)
create function _jl(p_entry uuid, p_key text) returns numeric language sql as $$
  select coalesce(sum(jl.debit - jl.credit), 0)
  from journal_lines jl join accounts a on a.id = jl.account_id
  where jl.entry_id = p_entry and a.system_key = p_key
$$;
create function _balanced(p_entry uuid) returns boolean language sql as $$
  select sum(debit) = sum(credit) and count(*) >= 2 from journal_lines where entry_id = p_entry
$$;
-- all-time net debit on a system account (optionally one party)
create function _gl(p_key text, p_party uuid default null) returns numeric language sql as $$
  select coalesce(sum(jl.debit - jl.credit), 0)
  from journal_lines jl join accounts a on a.id = jl.account_id
  where a.system_key = p_key and (p_party is null or jl.party_id = p_party)
$$;
create function _soh(p_item uuid) returns table (qty numeric, value numeric) language sql as $$
  select qty, value from stock_on_hand(p_item, (select id from _wh))
$$;
grant select on _wh to authenticated;

-- Sales invoice drafts
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id) values
  ('d2000000-0000-4000-8000-000000000001', '2026-06-10', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000002', '2026-06-11', 'a2000000-0000-4000-8000-000000000002', '36', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000003', '2026-06-11', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000004', '2026-07-05', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000005', '2026-08-03', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh));
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select v.id, v.inv, v.ln, v.item, 'x', 'x', 'x', v.q, v.r, 0, 0
from (values
  ('d3000000-0000-4000-8000-000000000101'::uuid, 'd2000000-0000-4000-8000-000000000001'::uuid, 1, 'c2000000-0000-4000-8000-000000000001'::uuid, 10, 400),
  ('d3000000-0000-4000-8000-000000000102', 'd2000000-0000-4000-8000-000000000001', 2, 'c2000000-0000-4000-8000-000000000002', 100, 70),
  ('d3000000-0000-4000-8000-000000000103', 'd2000000-0000-4000-8000-000000000001', 3, 'c2000000-0000-4000-8000-000000000003', 1, 500),
  ('d3000000-0000-4000-8000-000000000201', 'd2000000-0000-4000-8000-000000000002', 1, 'c2000000-0000-4000-8000-000000000002', 200, 70),
  ('d3000000-0000-4000-8000-000000000301', 'd2000000-0000-4000-8000-000000000003', 1, 'c2000000-0000-4000-8000-000000000001', 5, 400),
  ('d3000000-0000-4000-8000-000000000401', 'd2000000-0000-4000-8000-000000000004', 1, 'c2000000-0000-4000-8000-000000000004', 70, 250),
  ('d3000000-0000-4000-8000-000000000501', 'd2000000-0000-4000-8000-000000000005', 1, 'c2000000-0000-4000-8000-000000000006', 10, 150)
) v(id, inv, ln, item, q, r);

-- Purchase drafts
insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible) values
  ('e2000000-0000-4000-8000-000000000001', '2026-06-12', 'a2000000-0000-4000-8000-000000000006', '37', 'draft', (select id from _wh), true),
  ('e2000000-0000-4000-8000-000000000002', '2026-07-02', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true),
  ('e2000000-0000-4000-8000-000000000003', '2026-07-03', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), false);
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e3000000-0000-4000-8000-000000000101', 'e2000000-0000-4000-8000-000000000001', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 100, 400, 0, 0),
  ('e3000000-0000-4000-8000-000000000201', 'e2000000-0000-4000-8000-000000000002', 1, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 100, 200, 0, 0),
  ('e3000000-0000-4000-8000-000000000301', 'e2000000-0000-4000-8000-000000000003', 1, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 10, 55.55, 0, 0);

-- Receipts: R1 pays I2 in full (16,520); R2 pays 2,000 of I3 (2,560)
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id) values
  ('f2000000-0000-4000-8000-000000000001', 'receipt', '2026-06-12', 'a2000000-0000-4000-8000-000000000002', 'cash', 16520, (select id from accounts where system_key = 'cash')),
  ('f2000000-0000-4000-8000-000000000002', 'receipt', '2026-06-12', 'a2000000-0000-4000-8000-000000000001', 'cash', 2000, (select id from accounts where system_key = 'cash'));

-- ============================================================
-- Post the June/July documents the notes correct
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000001')$$, 'post I1');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000002')$$, 'post I2');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000003')$$, 'post I3');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000001')$$, 'post PB1 (moves the cement average)');
reset role;
set local request.jwt.claims to '';

insert into payment_allocations (payment_id, invoice_type, invoice_id, amount) values
  ('f2000000-0000-4000-8000-000000000001', 'sales_invoice', 'd2000000-0000-4000-8000-000000000002', 16520),
  ('f2000000-0000-4000-8000-000000000002', 'sales_invoice', 'd2000000-0000-4000-8000-000000000003', 2000);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_payment('f2000000-0000-4000-8000-000000000001')$$, 'post R1 (I2 fully paid)');
select lives_ok($$select post_payment('f2000000-0000-4000-8000-000000000002')$$, 'post R2 (I3 part paid)');
reset role;
set local request.jwt.claims to '';

select is((select grand_total from sales_invoices where id = 'd2000000-0000-4000-8000-000000000001'), 13970.00::numeric,
  'I1 = 11,500 taxable + 2,470 GST = 13,970');
select is((select avg_rate from stock_on_hand('c2000000-0000-4000-8000-000000000001', (select id from _wh))), 309.2166::numeric,
  'after PB1 the cement average (309.2166) is no longer the 300 I1 was costed at');

-- ============================================================
-- Gates: counter staff and aal1 admin cannot draft or post notes; anon cannot execute
-- ============================================================
select is(has_function_privilege('anon', 'public.post_credit_note(uuid)', 'EXECUTE'), false, 'anon cannot execute post_credit_note');
select is(has_function_privilege('anon', 'public.post_debit_note(uuid)', 'EXECUTE'), false, 'anon cannot execute post_debit_note');
select is(has_function_privilege('authenticated', 'public.post_credit_note(uuid)', 'EXECUTE'), true, 'authenticated may call post_credit_note (the role is checked inside)');
select is(has_function_privilege('authenticated', 'public.post_debit_note(uuid)', 'EXECUTE'), true, 'authenticated may call post_debit_note');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into credit_notes (note_date, party_id, place_of_supply, against_invoice_id, reason)
    values ('2026-06-15', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'x')$$,
  '42501', null, 'counter staff cannot create a credit note draft');
select throws_ok(
  $$insert into debit_notes (note_date, party_id, place_of_supply, reason)
    values ('2026-07-10', 'a2000000-0000-4000-8000-000000000005', '37', 'x')$$,
  '42501', null, 'counter staff cannot create a debit note draft');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into credit_notes (note_date, party_id, place_of_supply, reason)
    values ('2026-06-15', 'a2000000-0000-4000-8000-000000000001', '37', 'x')$$,
  '42501', null, 'an admin below aal2 cannot create a credit note draft');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
-- The owner at aal2 drafts CN1 through the API path (RLS insert), returning 3 cement + 33 steel from I1.
-- The client-writable columns are deliberately wrong: rate 1, taxable 1, GST 0, a foreign place of
-- supply. The posting function must ignore every one of them.
select lives_ok(
  $$insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, grand_total)
    values ('0c000000-0000-4000-8000-000000000001', '2026-06-15', 'a2000000-0000-4000-8000-000000000001', '29',
            'd2000000-0000-4000-8000-000000000001', 'Damaged bags and bent bars', 1)$$,
  'the owner at aal2 creates a credit note draft');
select lives_ok(
  $$insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
    ('0c000000-0000-4000-8000-000000000001', 1, 'c2000000-0000-4000-8000-000000000001', 'bogus', '0000', 'kg', 3, 1, 1, 0, 'd3000000-0000-4000-8000-000000000101'),
    ('0c000000-0000-4000-8000-000000000001', 2, 'c2000000-0000-4000-8000-000000000002', 'bogus', '0000', 'kg', 33, 1, 1, 0, 'd3000000-0000-4000-8000-000000000102')$$,
  'and its lines');
reset role;
set local request.jwt.claims to '';

select is((select created_by from credit_notes where id = '0c000000-0000-4000-8000-000000000001'),
  '33333333-3333-3333-3333-333333333333'::uuid, 'created_by is stamped from the session');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
update credit_notes set reason = 'edited by counter' where id = '0c000000-0000-4000-8000-000000000001';
delete from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000001';
select throws_ok(
  $$insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
    values ('0c000000-0000-4000-8000-000000000001', 9, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 1, 1, 1, 0)$$,
  '42501', null, 'counter staff cannot add a line to an owner''s note draft');
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'counter staff cannot post a credit note');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'an admin below aal2 cannot post a credit note');
reset role;
set local request.jwt.claims to '';

select is((select reason from credit_notes where id = '0c000000-0000-4000-8000-000000000001'),
  'Damaged bags and bent bars', 'the counter''s UPDATE of a note draft touched nothing');
select is((select count(*)::int from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000001'),
  2, 'the counter''s DELETE of note lines touched nothing');

-- ============================================================
-- CN1: "credit note reverses revenue and GST proportionally"
-- 3 of 10 cement (taxable 4,000) -> 1,200 + CGST 168 + SGST 168
-- 33 of 100 steel (taxable 7,000) -> 2,310 + CGST 207.90 + SGST 207.90
-- raw 4,261.80 -> grand 4,262, round-off +0.20 (Dr, the note credits AR)
-- stock back at I1's own cost: cement 3 @ 300 (not today's 309.2166), steel 33 @ 50
-- ============================================================
create temp table _before_cn1 as select
  _gl('ar', 'a2000000-0000-4000-8000-000000000001') as ar,
  _gl('sales_cement') as sales_cement, _gl('sales_steel') as sales_steel,
  _gl('output_cgst') as out_cgst, _gl('output_sgst') as out_sgst,
  _gl('inventory') as inventory, _gl('cogs') as cogs;

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000001')$$, 'CN1 posts (owner, aal2)');
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_NOT_DRAFT', 'posting CN1 again is refused (idempotent)');
reset role;
set local request.jwt.claims to '';

select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000001')), 'CN1 entry: sum(debit) = sum(credit)');
select is((select note_no from credit_notes where id = '0c000000-0000-4000-8000-000000000001'), 'CN/26-27/0001', 'CN1 takes CN/26-27/0001');
select is((select place_of_supply::text from credit_notes where id = '0c000000-0000-4000-8000-000000000001'), '37',
  'place of supply is the invoice''s, not the draft''s 29');
select is((select buyer_gstin from credit_notes where id = '0c000000-0000-4000-8000-000000000001'), '37ABCDE1234F1ZZ',
  'buyer GSTIN is snapshotted when the note posts');
select results_eq(
  $$select taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total
    from credit_notes where id = '0c000000-0000-4000-8000-000000000001'$$,
  $$values (3510.00::numeric(14,2), 375.90::numeric(14,2), 375.90::numeric(14,2), 0::numeric(14,2), 0.20::numeric(6,2), 4262.00::numeric(14,2))$$,
  'CN1 header totals are the function''s own (client grand_total of 1 ignored)');
select results_eq(
  $$select item_name, hsn_code, uom, gst_rate, rate, taxable_value, cgst_amt, sgst_amt
    from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000001' order by line_no$$,
  $$values ('Cement 50kg', '2523', 'bag', 28.00::numeric(5,2), 400.0000::numeric(14,4), 1200.00::numeric(14,2), 168.00::numeric(14,2), 168.00::numeric(14,2)),
           ('TMT 12mm', '7214', 'kg', 18.00::numeric(5,2), 70.0000::numeric(14,4), 2310.00::numeric(14,2), 207.90::numeric(14,2), 207.90::numeric(14,2))$$,
  'CN1 lines carry the invoice lines'' snapshot and the proportional taxable/tax');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'sales_cement'), 1200.00::numeric, 'Dr Sales - Cement 1,200');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'sales_steel'), 2310.00::numeric, 'Dr Sales - Steel 2,310');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'output_cgst'), 375.90::numeric, 'Dr Output CGST 375.90');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'output_sgst'), 375.90::numeric, 'Dr Output SGST 375.90');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'output_igst'), 0::numeric, 'no IGST on an intra-state note');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'round_off'), 0.20::numeric, 'Dr Round Off 0.20');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'ar'), -4262.00::numeric, 'Cr AR 4,262');
select is((select party_id from journal_lines jl join accounts a on a.id = jl.account_id
           where jl.entry_id = _entry('0c000000-0000-4000-8000-000000000001') and a.system_key = 'ar'),
  'a2000000-0000-4000-8000-000000000001'::uuid, 'the AR line carries the customer');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'inventory'), 2550.00::numeric, 'Dr Inventory 2,550 (3 x 300 + 33 x 50)');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000001'), 'cogs'), -2550.00::numeric, 'Cr COGS 2,550');
select results_eq(
  $$select item_id, qty, rate, value from stock_movements
    where source_type = 'credit_note' and source_id = '0c000000-0000-4000-8000-000000000001' order by item_id$$,
  $$values ('c2000000-0000-4000-8000-000000000001'::uuid, 3.000::numeric(12,3), 300.0000::numeric(14,4), 900.00::numeric(14,2)),
           ('c2000000-0000-4000-8000-000000000002'::uuid, 33.000::numeric(12,3), 50.0000::numeric(14,4), 1650.00::numeric(14,2))$$,
  'goods return IN at the ORIGINAL COGS rate of the invoice, not the current average');
select is(_gl('sales_cement') - (select sales_cement from _before_cn1), 1200.00::numeric, 'cement revenue drops by exactly the note''s taxable');
select is(_gl('output_cgst') - (select out_cgst from _before_cn1), 375.90::numeric, 'output CGST drops by exactly the note''s CGST');
select is(_gl('ar', 'a2000000-0000-4000-8000-000000000001') - (select ar from _before_cn1), -4262.00::numeric, 'P1''s AR drops by the note''s grand total');
select is((select audit.actor from audit_log audit where audit.entity = 'credit_notes' and audit.entity_id = '0c000000-0000-4000-8000-000000000001' and audit.action = 'post'),
  '33333333-3333-3333-3333-333333333333'::uuid, 'the post writes an audit row with the session uid');

-- ============================================================
-- "note quantity cannot exceed what was invoiced"
-- ============================================================
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000002', '2026-06-20', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'Second return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000002', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 8, 0, 0, 0, 'd3000000-0000-4000-8000-000000000101');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000002')$$,
  'P0001', 'DN_VALIDATION:qty_exceeds_invoice', '3 already returned + 8 more > 10 invoiced is refused');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set qty = 7 where note_id = '0c000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000002')$$, 'the remaining 7 bags can be returned (second partial return counts the first)');
reset role;
set local request.jwt.claims to '';

select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000002')), 'CN2 entry balanced');
select is((select note_no from credit_notes where id = '0c000000-0000-4000-8000-000000000002'), 'CN/26-27/0002',
  'the refused attempt consumed no number: CN2 is 0002');
select is((select taxable_value from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000002'), 2800.00::numeric,
  'returns that reach the invoiced quantity credit exactly the invoiced value (1,200 + 2,800 = 4,000)');
select is((select grand_total from credit_notes where id = '0c000000-0000-4000-8000-000000000002'), 3584.00::numeric, 'CN2 grand total 3,584');

-- a third return on a fully returned line, and a value-only note on it, are both refused
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000003', '2026-06-21', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'Over-return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000003', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000000101');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:qty_exceeds_invoice', 'one more bag on a fully returned line is refused');
reset role;
set local request.jwt.claims to '';
update credit_notes set stock_effect = false where id = '0c000000-0000-4000-8000-000000000003';
update credit_note_lines set rate = 5 where note_id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:value_exceeds_invoice', 'a rate-difference note on a line already credited in full is refused');
reset role;
set local request.jwt.claims to '';

-- Validation codes on one reusable draft (CN3), each fixed after its assertion
update credit_note_lines set against_line_id = 'd3000000-0000-4000-8000-000000000201' where note_id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:line_not_on_invoice', 'a line pointing at another invoice''s line is refused');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set against_line_id = null where note_id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:line_not_on_invoice', 'a line with no invoice line on a linked note is refused');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set against_line_id = 'd3000000-0000-4000-8000-000000000102', item_id = 'c2000000-0000-4000-8000-000000000001'
 where note_id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:line_not_on_invoice', 'an item that is not the invoice line''s item is refused');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set item_id = 'c2000000-0000-4000-8000-000000000002' where note_id = '0c000000-0000-4000-8000-000000000003';
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000003', 2, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 1, 5, 0, 0, 'd3000000-0000-4000-8000-000000000102');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:duplicate_line', 'two note lines on one invoice line are refused');
reset role;
set local request.jwt.claims to '';
delete from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000003' and line_no = 2;
update credit_notes set party_id = 'a2000000-0000-4000-8000-000000000002' where id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:party_mismatch', 'a note for another party than the invoice''s is refused');
reset role;
set local request.jwt.claims to '';
update credit_notes set party_id = 'a2000000-0000-4000-8000-000000000001', reason = '  ' where id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:reason_required', 'a blank reason is refused');
reset role;
set local request.jwt.claims to '';
update credit_notes set reason = 'Rate difference', note_date = '2026-06-09' where id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:note_before_invoice', 'a note dated before its invoice is refused');
reset role;
set local request.jwt.claims to '';
update credit_notes set note_date = (now() at time zone 'Asia/Kolkata')::date + 1 where id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:future_date', 'a note dated in the future is refused');
reset role;
set local request.jwt.claims to '';
update credit_notes set note_date = '2026-06-21', against_invoice_id = 'd2000000-0000-4000-8000-000000000003' where id = '0c000000-0000-4000-8000-000000000003';
update sales_invoices set status = 'cancelled' where id = 'd2000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:invoice_not_posted', 'a note against an invoice that is not posted is refused');
reset role;
set local request.jwt.claims to '';
update sales_invoices set status = 'posted' where id = 'd2000000-0000-4000-8000-000000000003';
delete from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:no_lines', 'a note with no lines is refused');
reset role;
set local request.jwt.claims to '';

-- Over the open amount: I3 is 2,560 with 2,000 received (560 open); returning all 5 bags (2,560) is refused
update credit_notes set stock_effect = true where id = '0c000000-0000-4000-8000-000000000003';
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000003', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 5, 0, 0, 0, 'd3000000-0000-4000-8000-000000000301');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000003')$$,
  'P0001', 'DN_VALIDATION:exceeds_open_amount', 'a note larger than a part-paid invoice''s open amount is refused');
reset role;
set local request.jwt.claims to '';
delete from credit_notes where id = '0c000000-0000-4000-8000-000000000003';

-- Stand-alone notes: a return needs the invoice
insert into credit_notes (id, note_date, party_id, place_of_supply, reason) values
  ('0c000000-0000-4000-8000-000000000010', '2026-06-21', 'a2000000-0000-4000-8000-000000000001', '37', 'No invoice');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('0c000000-0000-4000-8000-000000000010', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 1, 400, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000010')$$,
  'P0001', 'DN_VALIDATION:note_needs_invoice', 'a goods return with no invoice is refused');
reset role;
set local request.jwt.claims to '';
delete from credit_notes where id = '0c000000-0000-4000-8000-000000000010';

-- ============================================================
-- CN4: value-only (rate difference) on I1's freight line: 1 x 100 -> 100 + 9 + 9 = 118
-- ============================================================
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0c000000-0000-4000-8000-000000000004', '2026-06-22', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'Freight overcharged', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000004', 1, 'c2000000-0000-4000-8000-000000000003', 'x', 'x', 'x', 1, 450, 0, 0, 'd3000000-0000-4000-8000-000000000103');
-- 100 now; a second note of 450 on the same 500 line must then be refused (cumulative cap)
update credit_note_lines set rate = 100 where note_id = '0c000000-0000-4000-8000-000000000004';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000004')$$, 'CN4 value-only note posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000004')), 'CN4 entry balanced');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000004'), 'freight_recovered'), 100.00::numeric, 'a non-stock line reverses Freight Recovered');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000004'), 'ar'), -118.00::numeric, 'Cr AR 118');
select is((select count(*)::int from stock_movements where source_id = '0c000000-0000-4000-8000-000000000004'), 0, 'a value-only note moves no stock');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000004'), 'inventory'), 0::numeric, 'and touches neither Inventory nor COGS');

insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0c000000-0000-4000-8000-000000000011', '2026-06-22', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'Too much', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000011', 1, 'c2000000-0000-4000-8000-000000000003', 'x', 'x', 'x', 1, 450, 0, 0, 'd3000000-0000-4000-8000-000000000103');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000011')$$,
  'P0001', 'DN_VALIDATION:value_exceeds_invoice', 'rate differences together cannot exceed the line''s taxable value (100 + 450 > 500)');
reset role;
set local request.jwt.claims to '';
delete from credit_notes where id = '0c000000-0000-4000-8000-000000000011';

-- ============================================================
-- CN5: inter-state return on the FULLY PAID I2 -> IGST, credit balance on P2
-- 50 of 200 kg (14,000) -> 3,500 + IGST 630 = 4,130
-- ============================================================
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000005', '2026-06-25', 'a2000000-0000-4000-8000-000000000002', '37', 'd2000000-0000-4000-8000-000000000002', 'Short length bars');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000005', 1, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 50, 0, 0, 0, 'd3000000-0000-4000-8000-000000000201');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000005')$$, 'a note on a fully paid invoice posts (becomes a credit balance)');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000005')), 'CN5 entry balanced');
select is((select place_of_supply::text from credit_notes where id = '0c000000-0000-4000-8000-000000000005'), '36', 'CN5 takes I2''s place of supply 36');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000005'), 'output_igst'), 630.00::numeric, 'Dr Output IGST 630');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000005'), 'output_cgst'), 0::numeric, 'no CGST on an inter-state note');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000005'), 'ar'), -4130.00::numeric, 'Cr AR 4,130');
select is((select balance from v_party_balances where party_id = 'a2000000-0000-4000-8000-000000000002'), -4130.00::numeric,
  'P2 now shows a credit balance of 4,130');
select results_eq(
  $$select open_total, other_ar, ar_balance from v_party_aging where party_id = 'a2000000-0000-4000-8000-000000000002'$$,
  $$values (0::numeric(14,2), -4130.00::numeric(14,2), -4130.00::numeric(14,2))$$,
  'ageing: nothing open in the buckets, the credit shows as other_ar and ties to the AR balance');

-- ============================================================
-- Invoices cannot be cancelled underneath a posted note
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select cancel_document('sales_invoice', 'd2000000-0000-4000-8000-000000000001', 'x')$$,
  'P0001', 'DN_VALIDATION:has_notes', 'cancelling an invoice with a posted credit note is refused');
-- CN1 cannot be cancelled while later notes on I1 stand (round-3 review: last-posted-first)
select throws_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000001', 'x')$$,
  'P0001', 'DN_VALIDATION:later_notes', 'a credit note with later notes on the same invoice cannot be cancelled');
reset role;
set local request.jwt.claims to '';

-- ============================================================
-- June: open amounts, GSTR-1 CDNR, GSTR-3B netting
-- ============================================================
select is((select credit_noted from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000001'), 7964.00::numeric,
  'I1 credit_noted = 4,262 + 3,584 + 118');
select is((select open_amount from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000001'), 6006.00::numeric,
  'I1 open amount = 13,970 - 7,964');
select is((select count(*)::int from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000002'), 0,
  'I2 (paid, then credited) is not an open invoice');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _g1 as select gstr1_data('2026-06-01') as j;
create temp table _g3 as select * from gstr3b_summary('2026-06-01');
reset role;
set local request.jwt.claims to '';
select is((select jsonb_array_length(j -> 'cdnr') from _g1), 2, 'GSTR-1 June CDNR has both registered buyers');
select is((select (j -> 'summary' -> 'cdnr' ->> 'count')::int from _g1), 4, 'CDNR counts the four June notes');
select is((select (j -> 'summary' -> 'cdnr' ->> 'txval')::numeric from _g1), 9910.00::numeric, 'CDNR taxable 3,510 + 2,800 + 100 + 3,500');
select is((select (j -> 'summary' -> 'cdnr' ->> 'iamt')::numeric from _g1), 630.00::numeric, 'CDNR IGST is CN5''s 630');
select is(
  (select n ->> 'nt_num' from _g1, jsonb_array_elements(j -> 'cdnr') c, jsonb_array_elements(c -> 'nt') n
   where c ->> 'ctin' = '36ABCDE1234F1Z1'),
  'CN/26-27/0004', 'the inter-state buyer''s CDNR entry is CN5');
select is(
  (select (h ->> 'qty')::numeric from _g1, jsonb_array_elements(j -> 'hsn' -> 'hsn_b2b') h where h ->> 'hsn_sc' = '9965'),
  1::numeric, 'HSN summary: a value-only note lowers the value but not the quantity');
select is(
  (select (h ->> 'txval')::numeric from _g1, jsonb_array_elements(j -> 'hsn' -> 'hsn_b2b') h where h ->> 'hsn_sc' = '9965'),
  400.00::numeric, 'HSN summary: freight value is 500 - 100');
select is(
  (select (h ->> 'qty')::numeric from _g1, jsonb_array_elements(j -> 'hsn' -> 'hsn_b2b') h where h ->> 'hsn_sc' = '2523'),
  5::numeric, 'HSN summary: cement quantity 10 + 5 sold - 10 returned');
select is((select taxable from _g3 where row_key = '3.1a'), 17590.00::numeric, 'GSTR-3B 3.1a = 27,500 invoiced - 9,910 credited');
select is((select igst from _g3 where row_key = '3.1a'), 1890.00::numeric, '3.1a IGST = 2,520 - 630');
select results_eq(
  $$select igst, cgst, sgst from _g3 where row_key = 'recon_output'$$,
  $$values (0::numeric, 0::numeric, 0::numeric)$$,
  'June output tax: the return and the ledger agree once credit notes post');
select results_eq(
  $$select igst, cgst, sgst from _g3 where row_key = 'recon_input'$$,
  $$values (0::numeric, 0::numeric, 0::numeric)$$,
  'June input tax reconciles');

-- ============================================================
-- Locked period: no posting and no cancelling in a locked month
-- ============================================================
update fiscal_periods set is_locked = true where month = '2026-06-01';
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0c000000-0000-4000-8000-000000000012', '2026-06-26', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000001', 'Locked', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000012', 1, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 1, 1, 0, 0, 'd3000000-0000-4000-8000-000000000102');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000012')$$,
  'P0001', 'DN_PERIOD_LOCKED', 'a note dated in a locked month is refused');
select throws_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000005', 'x')$$,
  'P0001', 'DN_PERIOD_LOCKED', 'cancelling a note dated in a locked month is refused');
reset role;
set local request.jwt.claims to '';
select is((select status::text from credit_notes where id = '0c000000-0000-4000-8000-000000000005'), 'posted', 'CN5 is still posted');
update fiscal_periods set is_locked = false where month = '2026-06-01';
delete from credit_notes where id = '0c000000-0000-4000-8000-000000000012';

-- ============================================================
-- July: "debit note is the remedy when a purchase cannot be cancelled"
-- PB2: 100 RET @ 200 (20,000 + 1,800 + 1,800 = 23,600); I4 sells 70; 30 left
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000002')$$, 'post PB2');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000003')$$, 'post PB3 (no ITC, 555.50 + 50 + 50)');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000004')$$, 'post I4 (sells 70 of the 100)');
select throws_ok($$select cancel_document('purchase_invoice', 'e2000000-0000-4000-8000-000000000002', 'x')$$,
  'P0001', 'DN_NEGATIVE_STOCK', 'PB2 cannot be cancelled: its stock has been sold');
reset role;
set local request.jwt.claims to '';

insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0d000000-0000-4000-8000-000000000001', '2026-07-10', 'a2000000-0000-4000-8000-000000000005', '29', 'e2000000-0000-4000-8000-000000000002', 'Return unsold stock');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000001', 1, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 40, 1, 1, 0, 'e3000000-0000-4000-8000-000000000201');
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'counter staff cannot post a debit note');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_FORBIDDEN', 'an admin below aal2 cannot post a debit note');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_NEGATIVE_STOCK', 'returning 40 when 30 are on hand is refused');
reset role;
set local request.jwt.claims to '';
update debit_note_lines set qty = 30 where note_id = '0d000000-0000-4000-8000-000000000001';

create temp table _before_dn1 as select
  _gl('ap', 'a2000000-0000-4000-8000-000000000005') as ap, _gl('input_cgst') as in_cgst,
  _gl('input_sgst') as in_sgst, _gl('inventory') as inventory;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000001')$$, 'DN1 posts for the 30 still on hand');
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000001')$$,
  'P0001', 'DN_NOT_DRAFT', 'posting DN1 again is refused');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000001')), 'DN1 entry balanced');
select is((select note_no from debit_notes where id = '0d000000-0000-4000-8000-000000000001'), 'DB/26-27/0001', 'DN1 takes DB/26-27/0001 (spec series DB)');
select is((select place_of_supply::text from debit_notes where id = '0d000000-0000-4000-8000-000000000001'), '37', 'a debit note''s place of supply is our own state, not the draft''s 29');
select results_eq(
  $$select taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total from debit_notes where id = '0d000000-0000-4000-8000-000000000001'$$,
  $$values (6000.00::numeric(14,2), 540.00::numeric(14,2), 540.00::numeric(14,2), 0::numeric(14,2), 0::numeric(6,2), 7080.00::numeric(14,2))$$,
  'DN1 = 30/100 of PB2''s line: 6,000 + 540 + 540 = 7,080');
select is((select gst_rate from debit_note_lines where note_id = '0d000000-0000-4000-8000-000000000001'), 18.00::numeric, 'DN1 line GST rate is the bill line''s (the draft''s 0 ignored)');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000001'), 'ap'), 7080.00::numeric, 'Dr AP 7,080');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000001'), 'inventory'), -6000.00::numeric, 'Cr Inventory 6,000');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000001'), 'input_cgst'), -540.00::numeric, 'Cr Input CGST 540 (ITC reversed)');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000001'), 'input_sgst'), -540.00::numeric, 'Cr Input SGST 540 (ITC reversed)');
select is(_gl('input_cgst') - (select in_cgst from _before_dn1), -540.00::numeric, 'input CGST balance drops by exactly the note''s CGST');
select results_eq(
  $$select qty, rate, value from stock_movements where source_type = 'debit_note' and source_id = '0d000000-0000-4000-8000-000000000001'$$,
  $$values (-30.000::numeric(12,3), 200.0000::numeric(14,4), -6000.00::numeric(14,2))$$,
  'goods leave at the purchase''s own rate');
select results_eq(
  $$select * from _soh('c2000000-0000-4000-8000-000000000004')$$,
  $$values (0::numeric, 0::numeric)$$,
  'RET on hand: 0 units, 0 value');
select throws_ok($$select cancel_document('purchase_invoice', 'e2000000-0000-4000-8000-000000000002', 'x')$$,
  'P0001', 'DN_FORBIDDEN', 'cancel_document refuses a session with no admin claims');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select cancel_document('purchase_invoice', 'e2000000-0000-4000-8000-000000000002', 'x')$$,
  'P0001', 'DN_VALIDATION:has_notes', 'a bill with a posted debit note cannot be cancelled underneath it');
reset role;
set local request.jwt.claims to '';

-- DN2: return on the NO-ITC bill PB3 with round-off. 4 of 10 kg (555.50) -> 222.20 + 20.00 + 20.00 = 262.20 -> 262, round-off -0.20
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0d000000-0000-4000-8000-000000000002', '2026-07-12', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000003', 'Rusted bars');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000002', 1, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 4, 0, 0, 0, 'e3000000-0000-4000-8000-000000000301');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000002')$$, 'DN2 (no-ITC bill) posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000002')), 'DN2 entry balanced');
select results_eq(
  $$select taxable_total, cgst_total, sgst_total, round_off, grand_total from debit_notes where id = '0d000000-0000-4000-8000-000000000002'$$,
  $$values (222.20::numeric(14,2), 20.00::numeric(14,2), 20.00::numeric(14,2), -0.20::numeric(6,2), 262.00::numeric(14,2))$$,
  'DN2 totals and round-off like the bill');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000002'), 'input_cgst'), 0::numeric, 'no ITC to reverse on a no-ITC bill');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000002'), 'inventory'), -262.20::numeric, 'Cr Inventory with the tax-inclusive cost the bill capitalised');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000002'), 'round_off'), 0.20::numeric, 'negative round-off is a debit when AP carries the rounded total');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000002'), 'ap'), 262.00::numeric, 'Dr AP 262');
select is((select rate from stock_movements where source_type = 'debit_note' and source_id = '0d000000-0000-4000-8000-000000000002'), 65.5500::numeric,
  'steel leaves at the bill''s landed rate 65.55, not the 50-ish average');

-- DN3: value-only rate difference on PB2 (70 x 10 = 700 + 63 + 63 = 826) -> Discount Received
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0d000000-0000-4000-8000-000000000003', '2026-07-15', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000002', 'Rate difference', false);
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000003', 1, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 70, 10, 0, 0, 'e3000000-0000-4000-8000-000000000201');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000003')$$, 'DN3 value-only posts even with no stock on hand');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000003')), 'DN3 entry balanced');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000003'), 'discount_received'), -700.00::numeric, 'Cr Discount Received 700');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000003'), 'input_cgst'), -63.00::numeric, 'Cr Input CGST 63');
select is((select count(*)::int from stock_movements where source_id = '0d000000-0000-4000-8000-000000000003'), 0, 'DN3 moves no stock');

-- over the line's value, and a stand-alone return, are refused
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0d000000-0000-4000-8000-000000000010', '2026-07-15', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000002', 'Too much', false);
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000010', 1, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 1, 13300.01, 0, 0, 'e3000000-0000-4000-8000-000000000201');
insert into debit_notes (id, note_date, party_id, place_of_supply, reason) values
  ('0d000000-0000-4000-8000-000000000011', '2026-07-15', 'a2000000-0000-4000-8000-000000000005', '37', 'Return without bill');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('0d000000-0000-4000-8000-000000000011', 1, 'c2000000-0000-4000-8000-000000000002', 'x', 'x', 'x', 1, 50, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000010')$$,
  'P0001', 'DN_VALIDATION:value_exceeds_invoice', 'debit notes together cannot exceed the bill line (6,000 + 700 + 13,300.01 > 20,000)');
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000011')$$,
  'P0001', 'DN_VALIDATION:note_needs_invoice', 'a stand-alone debit note cannot return goods');
reset role;
set local request.jwt.claims to '';
delete from debit_notes where id = '0d000000-0000-4000-8000-000000000010';

-- DN4: stand-alone value-only (1 x 100 + 9 + 9 = 118): ITC treated as claimed and reversed
update debit_notes set stock_effect = false where id = '0d000000-0000-4000-8000-000000000011';
update debit_note_lines set item_id = 'c2000000-0000-4000-8000-000000000004', rate = 100 where note_id = '0d000000-0000-4000-8000-000000000011';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000011')$$, 'DN4 stand-alone value-only posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000011')), 'DN4 entry balanced');
select results_eq(
  $$select note_no, grand_total, cgst_total from debit_notes where id = '0d000000-0000-4000-8000-000000000011'$$,
  $$values ('DB/26-27/0004'::text, 118.00::numeric(14,2), 9.00::numeric(14,2))$$,
  'DN4 is DB/26-27/0004 for 118, tax from the item master');

-- DN5: inter-state return on PB1 (10 of 100 cement @ 400 -> 4,000 + IGST 1,120 = 5,120), then cancelled
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0d000000-0000-4000-8000-000000000005', '2026-07-20', 'a2000000-0000-4000-8000-000000000006', '37', 'e2000000-0000-4000-8000-000000000001', 'Wrong grade');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000005', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 10, 0, 0, 0, 'e3000000-0000-4000-8000-000000000101');
create temp table _before_dn5 as select
  _gl('ap', 'a2000000-0000-4000-8000-000000000006') as ap, _gl('input_igst') as in_igst, _gl('inventory') as inventory,
  (select qty from _soh('c2000000-0000-4000-8000-000000000001')) as qty,
  (select value from _soh('c2000000-0000-4000-8000-000000000001')) as value;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000005')$$, 'DN5 posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000005')), 'DN5 entry balanced');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000005'), 'input_igst'), -1120.00::numeric, 'Cr Input IGST 1,120 (the bill was IGST)');
select is((select value from stock_movements where source_type = 'debit_note' and source_id = '0d000000-0000-4000-8000-000000000005'), -4000.00::numeric,
  'cement leaves at PB1''s 400, not the blended average');

set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000005', 'x')$$,
  'P0001', 'DN_FORBIDDEN', 'counter staff cannot cancel a note');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000005', 'Supplier took it back')$$, 'DN5 cancels');
select throws_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000005', 'x')$$,
  'P0001', 'DN_NOT_POSTED', 'cancelling DN5 twice is refused');
reset role;
set local request.jwt.claims to '';
select is((select status::text from debit_notes where id = '0d000000-0000-4000-8000-000000000005'), 'cancelled', 'DN5 is cancelled, keeping its number');
select is((select note_no from debit_notes where id = '0d000000-0000-4000-8000-000000000005'), 'DB/26-27/0005', 'DN5 keeps DB/26-27/0005');
select ok((select reversed_by is not null from journal_entries where id = _entry('0d000000-0000-4000-8000-000000000005')), 'DN5 entry is linked to its reversal');
select is((select entry_date from journal_entries where id = (select reversed_by from journal_entries where id = _entry('0d000000-0000-4000-8000-000000000005'))),
  '2026-07-20'::date, 'the reversal is dated on the note''s own date');
select ok(_balanced((select reversed_by from journal_entries where id = _entry('0d000000-0000-4000-8000-000000000005'))), 'the reversal entry is balanced');
select results_eq(
  $$select _gl('ap', 'a2000000-0000-4000-8000-000000000006'), _gl('input_igst'), _gl('inventory'),
           (select qty from _soh('c2000000-0000-4000-8000-000000000001')), (select value from _soh('c2000000-0000-4000-8000-000000000001'))$$,
  $$select ap, in_igst, inventory, qty, value from _before_dn5$$,
  'cancelling DN5 restores AP, input IGST, Inventory and the cement stock exactly');

-- ============================================================
-- July: open purchase amounts, AP tie, GSTR-3B input netting
-- ============================================================
select results_eq(
  $$select debit_noted, open_amount from v_open_purchase_invoices where invoice_id = 'e2000000-0000-4000-8000-000000000002'$$,
  $$values (7906.00::numeric(14,2), 15694.00::numeric(14,2))$$,
  'PB2: debit_noted 7,080 + 826, open 23,600 - 7,906');
select is((select open_amount from v_open_purchase_invoices where invoice_id = 'e2000000-0000-4000-8000-000000000003'), 394.00::numeric,
  'PB3 open = 656 - 262');
select is((select open_amount from v_open_purchase_invoices where invoice_id = 'e2000000-0000-4000-8000-000000000001'), 51200.00::numeric,
  'PB1 open is whole again after DN5 was cancelled');
select is((select balance from v_party_balances where party_id = 'a2000000-0000-4000-8000-000000000005'), 15970.00::numeric,
  'S1 AP = 23,600 + 656 - 7,080 - 262 - 826 - 118');
select is(
  (select balance from v_party_balances where party_id = 'a2000000-0000-4000-8000-000000000005')
    - (select sum(open_amount) from v_open_purchase_invoices where party_id = 'a2000000-0000-4000-8000-000000000005'),
  -118.00::numeric, 'S1 AP ties to open bills less the stand-alone debit note');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _g3j as select * from gstr3b_summary('2026-07-01');
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select taxable, igst, cgst, sgst from _g3j where row_key = '4A5'$$,
  $$values (13200.00::numeric, 0::numeric, 1188.00::numeric, 1188.00::numeric)$$,
  'GSTR-3B July 4A5 = PB2 less DN1, DN3, DN4 (cancelled DN5 excluded)');
select results_eq(
  $$select taxable, cgst, sgst from _g3j where row_key = '4D'$$,
  $$values (333.30::numeric, 30.00::numeric, 30.00::numeric)$$,
  '4D = PB3 less DN2');
select results_eq(
  $$select igst, cgst, sgst from _g3j where row_key = 'recon_input'$$,
  $$values (0::numeric, 0::numeric, 0::numeric)$$,
  'July input tax: the return and the ledger agree after debit notes and a cancelled one');

-- ============================================================
-- August: cancel restores every figure; numbering stays gap-free across the cancel
-- I5: 10 CAN @ 150 (cost 100). CN7 returns 4 (600 + 54 + 54 = 708), then is cancelled.
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000005')$$, 'post I5');
reset role;
set local request.jwt.claims to '';

create temp table _before_cn7 as select
  _gl('ar', 'a2000000-0000-4000-8000-000000000001') as ar, _gl('sales_other') as sales_other,
  _gl('output_cgst') as out_cgst, _gl('output_sgst') as out_sgst, _gl('inventory') as inventory, _gl('cogs') as cogs,
  (select qty from _soh('c2000000-0000-4000-8000-000000000006')) as qty,
  (select value from _soh('c2000000-0000-4000-8000-000000000006')) as value,
  (select open_amount from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000005') as open_amount;

insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000007', '2026-08-05', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000005', 'Returned');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000007', 1, 'c2000000-0000-4000-8000-000000000006', 'x', 'x', 'x', 4, 0, 0, 0, 'd3000000-0000-4000-8000-000000000501');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000007')$$, 'CN7 posts');
reset role;
set local request.jwt.claims to '';
select is((select note_no from credit_notes where id = '0c000000-0000-4000-8000-000000000007'), 'CN/26-27/0005', 'CN7 is CN/26-27/0005');
select is((select open_amount from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000005'), 1062.00::numeric, 'I5 open = 1,770 - 708');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000006')$$, $$values (44::numeric, 4400.00::numeric)$$, 'CAN stock 40 + 4 back at 100');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000007', 'Entered in error')$$, 'CN7 cancels');
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select _gl('ar', 'a2000000-0000-4000-8000-000000000001'), _gl('sales_other'), _gl('output_cgst'), _gl('output_sgst'),
           _gl('inventory'), _gl('cogs'),
           (select qty from _soh('c2000000-0000-4000-8000-000000000006')), (select value from _soh('c2000000-0000-4000-8000-000000000006')),
           (select open_amount from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000005')$$,
  $$select ar, sales_other, out_cgst, out_sgst, inventory, cogs, qty, value, open_amount from _before_cn7$$,
  'cancelling CN7 restores AR, revenue, output GST, Inventory, COGS, stock and the invoice''s open amount exactly');
select results_eq(
  $$select qty, rate, value, movement_date from stock_movements
    where source_type = 'credit_note' and source_id = '0c000000-0000-4000-8000-000000000007' and reversal_of is not null$$,
  $$values (-4.000::numeric(12,3), 100.0000::numeric(14,4), -400.00::numeric(14,2), '2026-08-05'::date)$$,
  'the stock reversal mirrors the return on the note''s date');
select is((select count(*)::int from audit_log where entity = 'credit_notes' and entity_id = '0c000000-0000-4000-8000-000000000007' and action = 'post'), 1,
  'the post wrote one audit row');
select is((select count(*)::int from audit_log where entity = 'credit_notes' and entity_id = '0c000000-0000-4000-8000-000000000007' and action = 'cancel'), 1,
  'the cancel writes one audit row');

-- CN8: stand-alone value-only to P1 (cement 1 x 50 = 50 + 7 + 7 = 64) takes the next number: no gap after the cancel
insert into credit_notes (id, note_date, party_id, place_of_supply, reason, stock_effect) values
  ('0c000000-0000-4000-8000-000000000008', '2026-08-06', 'a2000000-0000-4000-8000-000000000001', '29', 'Goodwill discount', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('0c000000-0000-4000-8000-000000000008', 1, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 1, 50, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000008')$$, 'CN8 stand-alone value-only posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000008')), 'CN8 entry balanced');
select results_eq(
  $$select note_no, place_of_supply::text, gst_rate, grand_total from credit_notes n join credit_note_lines l on l.note_id = n.id
    where n.id = '0c000000-0000-4000-8000-000000000008'$$,
  $$values ('CN/26-27/0006'::text, '37'::text, 28.00::numeric(5,2), 64.00::numeric(14,2))$$,
  'CN8: next number, party-rule place of supply (not the draft''s 29), master GST rate');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000008'), 'sales_cement'), 50.00::numeric, 'CN8 Dr Sales - Cement 50');

-- CN9: return on a challan-converted invoice comes back at the challan's cost
insert into delivery_challans (id, challan_date, party_id, warehouse_id) values
  ('b2000000-0000-4000-8000-000000000001', '2026-08-10', 'a2000000-0000-4000-8000-000000000001', (select id from _wh));
insert into delivery_challan_lines (challan_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, gst_rate) values
  ('b2000000-0000-4000-8000-000000000001', 1, 'c2000000-0000-4000-8000-000000000007', 'x', 'x', 'x', 5, 120, 18);
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, challan_id) values
  ('d2000000-0000-4000-8000-000000000006', '2026-08-11', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh), 'b2000000-0000-4000-8000-000000000001');
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('d3000000-0000-4000-8000-000000000601', 'd2000000-0000-4000-8000-000000000006', 1, 'c2000000-0000-4000-8000-000000000007', 'x', 'x', 'x', 5, 120, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_delivery_challan('b2000000-0000-4000-8000-000000000001')$$, 'post DC1');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000006')$$, 'post I6 from DC1');
reset role;
set local request.jwt.claims to '';
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000009', '2026-08-12', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000006', 'Two returned');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000009', 1, 'c2000000-0000-4000-8000-000000000007', 'x', 'x', 'x', 2, 0, 0, 0, 'd3000000-0000-4000-8000-000000000601');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000009')$$, 'CN9 posts against the challan-converted invoice');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000009')), 'CN9 entry balanced');
select results_eq(
  $$select qty, rate, value from stock_movements where source_type = 'credit_note' and source_id = '0c000000-0000-4000-8000-000000000009'$$,
  $$values (2.000::numeric(12,3), 80.0000::numeric(14,4), 160.00::numeric(14,2))$$,
  'goods come back at the cost the challan carried out (80)');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000009'), 'ar'), -283.00::numeric, 'CN9 Cr AR 283 (240 + 21.60 + 21.60 = 283.20, rounded)');
select is(_jl(_entry('0c000000-0000-4000-8000-000000000009'), 'round_off'), -0.20::numeric, 'negative round-off is a credit when AR carries the rounded total');

-- ============================================================
-- Whole-book invariants once notes exist
-- ============================================================
select is((select count(*)::int from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x), 0,
  'every entry in the book is balanced');
select is(_gl('inventory'),
  (select coalesce(sum(value), 0) from stock_movements where source_type <> 'opening'),
  'Inventory GL moves by exactly the value of every non-opening stock movement (valuation agrees)');
select is((select array_agg(note_no order by note_no) from credit_notes where note_no is not null),
  array['CN/26-27/0001', 'CN/26-27/0002', 'CN/26-27/0003', 'CN/26-27/0004', 'CN/26-27/0005', 'CN/26-27/0006', 'CN/26-27/0007'],
  'credit note numbers are gap-free across refusals and a cancel');
select is((select array_agg(note_no order by note_no) from debit_notes where note_no is not null),
  array['DB/26-27/0001', 'DB/26-27/0002', 'DB/26-27/0003', 'DB/26-27/0004', 'DB/26-27/0005'],
  'debit note numbers are gap-free');
select results_eq(
  $$select open_total, other_ar, ar_balance from v_party_aging where party_id = 'a2000000-0000-4000-8000-000000000001'$$,
  $$values (29411.00::numeric(14,2), -64.00::numeric(14,2), 29347.00::numeric(14,2))$$,
  'P1 ageing: open invoices 6,006 + 560 + 20,650 + 1,770 + 425; the stand-alone CN8 is the only other_ar; ties to AR');
select is((select ar_balance from v_party_balances where party_id = 'a2000000-0000-4000-8000-000000000001'), 29347.00::numeric,
  'P1 AR balance in v_party_balances agrees');
select is(
  (select running_balance from v_party_ledger where party_id = 'a2000000-0000-4000-8000-000000000001'
   order by entry_date desc, entry_no desc, line_no desc limit 1),
  29347.00::numeric, 'P1 party ledger closes at the same balance');
select is((select doc_no from v_party_ledger where source_type = 'credit_note' and source_id = '0c000000-0000-4000-8000-000000000001' limit 1),
  'CN/26-27/0001', 'the party ledger names the note');
select is(_gl('ar'), (select sum(ar_balance) from v_party_balances), 'AR control = sum of party AR balances');
select is(-_gl('ap'), (select sum(ap_balance) from v_party_balances), 'AP control = sum of party AP balances');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
create temp table _g1a as select gstr1_data('2026-08-01') as j;
create temp table _g3a as select * from gstr3b_summary('2026-08-01');
reset role;
set local request.jwt.claims to '';
select is((select (j -> 'summary' -> 'cdnr' ->> 'count')::int from _g1a), 2, 'August CDNR: CN8 and CN9 (cancelled CN7 is not reported)');
select is(
  (select d -> 'docs' -> 0 ->> 'cancel' from _g1a, jsonb_array_elements(j -> 'doc_issue' -> 'doc_det') d where (d ->> 'doc_num')::int = 5),
  '1', 'doc_issue still counts CN7 as a cancelled credit note');
select results_eq(
  $$select igst, cgst, sgst from _g3a where row_key = 'recon_output'$$,
  $$values (0::numeric, 0::numeric, 0::numeric)$$,
  'August output tax reconciles after a note and its same-dated reversal');

-- The existing payment cap still sees notes: I1 has 6,006 open, so a 6,007 allocation is refused
insert into payments (id, direction, payment_date, party_id, mode, amount, account_id) values
  ('f2000000-0000-4000-8000-000000000003', 'receipt', '2026-08-20', 'a2000000-0000-4000-8000-000000000001', 'cash', 7000, (select id from accounts where system_key = 'cash'));
select throws_ok(
  $$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
    values ('f2000000-0000-4000-8000-000000000003', 'sales_invoice', 'd2000000-0000-4000-8000-000000000001', 6007)$$,
  'P0001', 'DN_VALIDATION:allocation_exceeds_invoice', 'allocation cap is net of posted credit notes');
select lives_ok(
  $$insert into payment_allocations (payment_id, invoice_type, invoice_id, amount)
    values ('f2000000-0000-4000-8000-000000000003', 'sales_invoice', 'd2000000-0000-4000-8000-000000000001', 6006)$$,
  'exactly the open amount can be allocated');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_payment('f2000000-0000-4000-8000-000000000003')$$, 'post_payment re-validates the cap (net of notes) and posts');
reset role;
set local request.jwt.claims to '';

-- Catalog guards for the objects this change touches
select is((select count(*)::int from pg_policies where tablename in ('credit_notes', 'debit_notes', 'credit_note_lines', 'debit_note_lines')
           and cmd in ('INSERT', 'UPDATE', 'DELETE') and coalesce(qual, '') || coalesce(with_check, '') not like '%current_app_role()%admin%'), 0,
  'every write policy on the note tables requires the owner role');
select ok((select bool_and(relrowsecurity) from pg_class where relname in ('credit_notes', 'debit_notes', 'credit_note_lines', 'debit_note_lines')),
  'RLS stays on for the note tables');
select ok(exists (select 1 from pg_trigger where tgname = 'refuse_cancel_in_locked_period' and tgrelid = 'public.debit_notes'::regclass),
  'debit notes get the locked-period cancel trigger');

-- ============================================================
-- Review round 1 (2026-09-29). September timeline, fresh items so nothing above moves.
-- ============================================================
insert into parties (id, name, type, state_code, gstin) values
  ('a2000000-0000-4000-8000-000000000007', 'P3 B2C (registers later)', 'customer', '37', null);
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock) values
  ('c2000000-0000-4000-8000-000000000011', 'Thirds sale item', 'other', '7311', 18, 'pcs', 34, true),
  ('c2000000-0000-4000-8000-000000000012', 'Thirds ITC item', 'other', '7312', 18, 'pcs', 34, true),
  ('c2000000-0000-4000-8000-000000000013', 'Thirds no-ITC item', 'other', '7313', 18, 'pcs', 34, true),
  ('c2000000-0000-4000-8000-000000000014', 'Two-lot item', 'other', '7314', 18, 'pcs', 400, true),
  ('c2000000-0000-4000-8000-000000000015', 'B2C item', 'other', '7315', 18, 'pcs', 100, true);
-- T1: 3 units costing 100.00 in all (rate 33.3333), so a per-unit cost does not divide evenly
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type) values
  ('c2000000-0000-4000-8000-000000000011', (select id from _wh), '2026-04-05', 3, 33.3333, 100.00, 'opening'),
  ('c2000000-0000-4000-8000-000000000015', (select id from _wh), '2026-04-05', 10, 10, 100.00, 'opening');

insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id) values
  ('d2000000-0000-4000-8000-000000000007', '2026-09-01', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000008', '2026-09-10', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000009', '2026-09-12', 'a2000000-0000-4000-8000-000000000007', '37', 'draft', (select id from _wh));
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('d3000000-0000-4000-8000-000000000701', 'd2000000-0000-4000-8000-000000000007', 1, 'c2000000-0000-4000-8000-000000000011', 'x', 'x', 'x', 3, 33.39, 0, 0),
  ('d3000000-0000-4000-8000-000000000801', 'd2000000-0000-4000-8000-000000000008', 1, 'c2000000-0000-4000-8000-000000000014', 'x', 'x', 'x', 100, 400, 0, 0),
  ('d3000000-0000-4000-8000-000000000901', 'd2000000-0000-4000-8000-000000000009', 1, 'c2000000-0000-4000-8000-000000000015', 'x', 'x', 'x', 2, 100, 0, 0),
  ('d3000000-0000-4000-8000-000000000902', 'd2000000-0000-4000-8000-000000000009', 2, 'c2000000-0000-4000-8000-000000000003', 'x', 'x', 'x', 1, 100, 0, 0);
insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible) values
  ('e2000000-0000-4000-8000-000000000004', '2026-09-01', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true),
  ('e2000000-0000-4000-8000-000000000005', '2026-09-01', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), false),
  ('e2000000-0000-4000-8000-000000000006', '2026-09-08', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true),
  ('e2000000-0000-4000-8000-000000000007', '2026-09-09', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true);
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e3000000-0000-4000-8000-000000000401', 'e2000000-0000-4000-8000-000000000004', 1, 'c2000000-0000-4000-8000-000000000012', 'x', 'x', 'x', 3, 33.39, 0, 0),
  ('e3000000-0000-4000-8000-000000000501', 'e2000000-0000-4000-8000-000000000005', 1, 'c2000000-0000-4000-8000-000000000013', 'x', 'x', 'x', 3, 33.39, 0, 0),
  ('e3000000-0000-4000-8000-000000000601', 'e2000000-0000-4000-8000-000000000006', 1, 'c2000000-0000-4000-8000-000000000014', 'x', 'x', 'x', 100, 300, 0, 0),
  ('e3000000-0000-4000-8000-000000000701', 'e2000000-0000-4000-8000-000000000007', 1, 'c2000000-0000-4000-8000-000000000014', 'x', 'x', 'x', 100, 320, 0, 0);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000007')$$, 'post I7 (3 x 33.39: taxable 100.17, CGST 9.02, SGST 9.02)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000004')$$, 'post PB4 (ITC bill, 3 x 33.39)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000005')$$, 'post PB5 (no-ITC bill, 3 x 33.39, capitalised 118.21)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000006')$$, 'post PB6 (100 @ 300)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000007')$$, 'post PB7 (100 @ 320)');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000008')$$, 'post I8 (sells 100 of the two lots at the 310 average)');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000009')$$, 'post I9 to the unregistered P3 (B2C)');
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select taxable_value, cgst_amt, sgst_amt from sales_invoice_lines where id = 'd3000000-0000-4000-8000-000000000701'$$,
  $$values (100.17::numeric(14,2), 9.02::numeric(14,2), 9.02::numeric(14,2))$$, 'I7 line as the reviewer''s probe');

-- Fix 1a: sales return in thirds (1 + 1 + 1). Per-note rounding reversed 3.01 x 3 = 9.03 CGST.
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason)
select ('0c000000-0000-4000-8000-00000000010' || n)::uuid, ('2026-09-0' || (n + 1))::date,
       'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000007', 'Third ' || n
from generate_series(1, 3) n;
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id)
select ('0c000000-0000-4000-8000-00000000010' || n)::uuid, 1, 'c2000000-0000-4000-8000-000000000011', 'x', 'x', 'x', 1, 0, 0, 0,
       'd3000000-0000-4000-8000-000000000701'
from generate_series(1, 3) n;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000101')$$, 'first third returned');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000102')$$, 'second third returned');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000103')$$, 'last third returned');
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select taxable_value, cgst_amt, sgst_amt from credit_note_lines
    where note_id in ('0c000000-0000-4000-8000-000000000101', '0c000000-0000-4000-8000-000000000102', '0c000000-0000-4000-8000-000000000103')
    order by note_id$$,
  $$values (33.39::numeric(14,2), 3.01::numeric(14,2), 3.01::numeric(14,2)),
           (33.39::numeric(14,2), 3.00::numeric(14,2), 3.00::numeric(14,2)),
           (33.39::numeric(14,2), 3.01::numeric(14,2), 3.01::numeric(14,2))$$,
  'each third reverses the cumulative tax less what earlier thirds reversed');
select results_eq(
  $$select sum(taxable_value), sum(cgst_amt), sum(sgst_amt) from credit_note_lines
    where note_id in ('0c000000-0000-4000-8000-000000000101', '0c000000-0000-4000-8000-000000000102', '0c000000-0000-4000-8000-000000000103')$$,
  $$values (100.17::numeric, 9.02::numeric, 9.02::numeric)$$,
  'returning all three reverses exactly the 100.17 / 9.02 / 9.02 the invoice charged');
select results_eq(
  $$select value from stock_movements where source_type = 'credit_note'
    and source_id in ('0c000000-0000-4000-8000-000000000101', '0c000000-0000-4000-8000-000000000102', '0c000000-0000-4000-8000-000000000103')
    order by source_id$$,
  $$values (33.33::numeric(14,2)), (33.34::numeric(14,2)), (33.33::numeric(14,2))$$,
  'the cost comes back cumulatively too (33.33 + 33.34 + 33.33)');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000011')$$, $$values (3::numeric, 100.00::numeric)$$,
  'all three back: 3 units carrying exactly the 100.00 that left, not 99.99');

-- Fix 1b: ITC bill returned in thirds reverses 9.02 ITC, not 9.03
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason)
select ('0d000000-0000-4000-8000-00000000010' || n)::uuid, ('2026-09-0' || (n + 4))::date,
       'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000004', 'ITC third ' || n
from generate_series(1, 3) n;
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id)
select ('0d000000-0000-4000-8000-00000000010' || n)::uuid, 1, 'c2000000-0000-4000-8000-000000000012', 'x', 'x', 'x', 1, 0, 0, 0,
       'e3000000-0000-4000-8000-000000000401'
from generate_series(1, 3) n;
-- Fix 1c: no-ITC bill returned in thirds: cost 39.41 + 39.39 + 39.41 = 118.21, the last one no longer strands a unit
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason)
select ('0d000000-0000-4000-8000-00000000020' || n)::uuid, ('2026-09-0' || (n + 4))::date,
       'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000005', 'No-ITC third ' || n
from generate_series(1, 3) n;
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id)
select ('0d000000-0000-4000-8000-00000000020' || n)::uuid, 1, 'c2000000-0000-4000-8000-000000000013', 'x', 'x', 'x', 1, 0, 0, 0,
       'e3000000-0000-4000-8000-000000000501'
from generate_series(1, 3) n;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_debit_note(%L)$$, ('0d000000-0000-4000-8000-00000000010' || n)), 'ITC bill third ' || n || ' returned')
from generate_series(1, 3) n order by n;
select lives_ok(format($$select post_debit_note(%L)$$, ('0d000000-0000-4000-8000-00000000020' || n)), 'no-ITC bill third ' || n || ' returned (no DN_NEGATIVE_STOCK on the last)')
from generate_series(1, 3) n order by n;
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select sum(l.taxable_value), sum(l.cgst_amt), sum(l.sgst_amt) from debit_note_lines l
    where l.against_line_id = 'e3000000-0000-4000-8000-000000000401'$$,
  $$values (100.17::numeric, 9.02::numeric, 9.02::numeric)$$,
  'ITC bill: the three debit notes reverse exactly the 9.02 + 9.02 ITC claimed');
select is(
  (select sum(_jl(_entry(('0d000000-0000-4000-8000-00000000010' || n)::uuid), 'input_cgst')) from generate_series(1, 3) n),
  -9.02::numeric, 'and the ledger''s input CGST reversal is 9.02');
select results_eq(
  $$select -value from stock_movements where source_type = 'debit_note'
    and source_id in ('0d000000-0000-4000-8000-000000000201', '0d000000-0000-4000-8000-000000000202', '0d000000-0000-4000-8000-000000000203')
    order by source_id$$,
  $$values (39.41::numeric), (39.39::numeric), (39.41::numeric)$$,
  'no-ITC bill: capitalised cost leaves as 39.41 + 39.39 + 39.41 = 118.21');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000013')$$, $$values (0::numeric, 0::numeric)$$,
  'no-ITC item: zero units, zero value (nothing stranded)');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000012')$$, $$values (0::numeric, 0::numeric)$$,
  'ITC item: zero units, zero value');

-- Fix 2: 100 @ 300 + 100 @ 320, sell 100 at 310, return the first bill's 100 -> nothing may stay in stock
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0d000000-0000-4000-8000-000000000301', '2026-09-11', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000006', 'Return lot 1');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000301', 1, 'c2000000-0000-4000-8000-000000000014', 'x', 'x', 'x', 100, 0, 0, 0, 'e3000000-0000-4000-8000-000000000601');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000301')$$, 'the return that empties the godown posts');
reset role;
set local request.jwt.claims to '';
select ok(_balanced(_entry('0d000000-0000-4000-8000-000000000301')), 'its entry is balanced');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000014')$$, $$values (0::numeric, 0::numeric)$$,
  'zero quantity leaves zero value (not 1,000 for goods that do not exist)');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000301'), 'inventory'), -31000.00::numeric, 'Cr Inventory 31,000 (everything that remained)');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000301'), 'cogs'), 1000.00::numeric, 'Dr COGS 1,000 (the average-cost true-up)');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000301'), 'ap'), 35400.00::numeric, 'Dr AP 35,400 = the bill''s own value');
select is(_jl(_entry('0d000000-0000-4000-8000-000000000301'), 'input_cgst'), -2700.00::numeric, 'Cr Input CGST 2,700');

-- Fix 3: a credit note inherits the invoice's buyer GSTIN, not today's master
update parties set gstin = '37PQRST5678K1Z1' where id = 'a2000000-0000-4000-8000-000000000007';
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0c000000-0000-4000-8000-000000000301', '2026-09-13', 'a2000000-0000-4000-8000-000000000007', '37', 'd2000000-0000-4000-8000-000000000009', 'One back');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c000000-0000-4000-8000-000000000301', 1, 'c2000000-0000-4000-8000-000000000015', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000000901');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000301')$$, 'credit note to P3 after P3 registered');
create temp table _g1s as select gstr1_data('2026-09-01') as j;
reset role;
set local request.jwt.claims to '';
select is((select buyer_gstin from credit_notes where id = '0c000000-0000-4000-8000-000000000301'), null,
  'the note carries the invoice''s (empty) buyer GSTIN, not the new one');
select is(
  (select count(*)::int from _g1s, jsonb_array_elements(j -> 'cdnr') c, jsonb_array_elements(c -> 'nt') n
   where n ->> 'nt_num' = (select note_no from credit_notes where id = '0c000000-0000-4000-8000-000000000301')),
  0, 'so it stays out of CDNR');
select is(
  (select (b ->> 'txval')::numeric from _g1s, jsonb_array_elements(j -> 'b2cs') b where b ->> 'pos' = '37' and (b ->> 'rt')::numeric = 18),
  200.00::numeric, 'and nets inside B2CS with its invoice (200 + 100 freight - 100 returned)');

-- Fix 4: note lines are frozen once the note is posted, for every writer (here: the table owner)
select throws_ok($$insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values ('0c000000-0000-4000-8000-000000000001', 9, 'c2000000-0000-4000-8000-000000000001', 'x', 'x', 'x', 1, 1, 1, 0)$$,
  'P0001', 'DN_NOT_DRAFT', 'no line can be added to a posted credit note');
select throws_ok($$update credit_note_lines set qty = 1 where note_id = '0c000000-0000-4000-8000-000000000001'$$,
  'P0001', 'DN_NOT_DRAFT', 'no line of a posted credit note can be changed');
select throws_ok($$delete from credit_note_lines where note_id = '0c000000-0000-4000-8000-000000000001'$$,
  'P0001', 'DN_NOT_DRAFT', 'no line of a posted credit note can be deleted');
select throws_ok($$insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
  values ('0d000000-0000-4000-8000-000000000001', 9, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 1, 1, 1, 0)$$,
  'P0001', 'DN_NOT_DRAFT', 'no line can be added to a posted debit note');
select throws_ok($$update debit_note_lines set qty = 1 where note_id = '0d000000-0000-4000-8000-000000000001'$$,
  'P0001', 'DN_NOT_DRAFT', 'no line of a posted debit note can be changed');
select throws_ok($$delete from debit_note_lines where note_id = '0d000000-0000-4000-8000-000000000001'$$,
  'P0001', 'DN_NOT_DRAFT', 'no line of a posted debit note can be deleted');
select throws_ok($$update credit_note_lines set note_id = '0c000000-0000-4000-8000-000000000001' where note_id = '0c000000-0000-4000-8000-000000000301'$$,
  'P0001', 'DN_NOT_DRAFT', 'a line cannot be moved between notes once either is posted');
select throws_ok($$delete from sales_invoice_lines where id = 'd3000000-0000-4000-8000-000000000101'$$,
  '23503', null, 'an invoice line a note points at cannot be deleted (ON DELETE RESTRICT)');

-- Remaining validation codes, on one draft against I9 (P3)
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values
  ('0c000000-0000-4000-8000-000000000302', '2026-09-14', 'a2000000-0000-4000-8000-000000000007', '37', 'd2000000-0000-4000-8000-000000000009', 'Checks', false);
insert into credit_note_lines (id, note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0c100000-0000-4000-8000-000000000001', '0c000000-0000-4000-8000-000000000302', 1, 'c2000000-0000-4000-8000-000000000015', 'x', 'x', 'x', 0, 1, 0, 0, 'd3000000-0000-4000-8000-000000000902');
select lives_ok($$update credit_note_lines set item_id = 'c2000000-0000-4000-8000-000000000003' where id = '0c100000-0000-4000-8000-000000000001'$$,
  'a draft note''s lines stay editable');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:invalid_qty', 'qty 0 is refused');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set qty = 1, rate = 0 where id = '0c100000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:invalid_rate', 'a value-only line needs a rate above 0');
reset role;
set local request.jwt.claims to '';
update credit_note_lines set rate = 0.001 where id = '0c100000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:zero_total', 'a note that rounds to nothing is refused');
reset role;
set local request.jwt.claims to '';
-- no_cost_basis: a line whose goods never left stock with a cost. Reachable only if an item's
-- is_stock changed after the sale, which items_guard forbids, so the guard is lifted for this one test.
alter table items disable trigger items_guard;
update items set is_stock = true where id = 'c2000000-0000-4000-8000-000000000003';
update credit_notes set stock_effect = true where id = '0c000000-0000-4000-8000-000000000302';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:no_cost_basis', 'a return with no recorded cost is refused');
reset role;
set local request.jwt.claims to '';
update items set is_stock = false where id = 'c2000000-0000-4000-8000-000000000003';
-- non_stock_line: same lifted guard, a debit-note return of an item that is no longer stock
update items set is_stock = false where id = 'c2000000-0000-4000-8000-000000000004';
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values
  ('0d000000-0000-4000-8000-000000000302', '2026-09-14', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000002', 'Checks');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values
  ('0d000000-0000-4000-8000-000000000302', 1, 'c2000000-0000-4000-8000-000000000004', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000201');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:non_stock_line', 'a debit-note return of a non-stock item is refused');
reset role;
set local request.jwt.claims to '';
update items set is_stock = true where id = 'c2000000-0000-4000-8000-000000000004';
alter table items enable trigger items_guard;
-- invalid_party: an inactive customer (parties_guard, which refuses disabling a party with a balance, lifted for this test)
alter table parties disable trigger parties_guard;
update parties set is_active = false where id = 'a2000000-0000-4000-8000-000000000007';
update credit_notes set stock_effect = false where id = '0c000000-0000-4000-8000-000000000302';
update credit_note_lines set rate = 10 where id = '0c100000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000302')$$, 'P0001', 'DN_VALIDATION:invalid_party', 'a note to an inactive party is refused');
reset role;
set local request.jwt.claims to '';
update parties set is_active = true where id = 'a2000000-0000-4000-8000-000000000007';
alter table parties enable trigger parties_guard;
select lives_ok($$delete from credit_notes where id = '0c000000-0000-4000-8000-000000000302'$$, 'deleting a draft note takes its lines with it');

select is((select count(*)::int from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x), 0,
  'every entry is still balanced after the review-round notes');
select is(_gl('inventory'), (select coalesce(sum(value), 0) from stock_movements where source_type <> 'opening'),
  'Inventory GL still equals the value of every non-opening stock movement');

-- ============================================================
-- Review round 2 (2026-09-29)
-- F1: the notes on one invoice round their grand totals cumulatively, so the last return always fits.
-- F2: cases that fail if the taxable value or the "prior" sums stop being cumulative / posted-only.
-- ============================================================
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock) values
  ('c2000000-0000-4000-8000-000000000021', 'R2 three-by-42', 'other', '7321', 18, 'pcs', 42, true),
  ('c2000000-0000-4000-8000-000000000022', 'R2 sale 100.00', 'other', '7322', 18, 'pcs', 34, true),
  ('c2000000-0000-4000-8000-000000000023', 'R2 bill 100.00', 'other', '7323', 18, 'pcs', 34, true),
  ('c2000000-0000-4000-8000-000000000024', 'R2 bill Y', 'other', '7324', 18, 'pcs', 42, true),
  ('c2000000-0000-4000-8000-000000000025', 'R2 bill W (nil)', 'other', '7325', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000026', 'R2 full return', 'other', '7326', 18, 'pcs', 42, true),
  ('c2000000-0000-4000-8000-000000000027', 'R2 cancel then return (sale)', 'other', '7327', 18, 'pcs', 42, true),
  ('c2000000-0000-4000-8000-000000000028', 'R2 cancel then return (bill)', 'other', '7328', 18, 'pcs', 42, true);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type) values
  ('c2000000-0000-4000-8000-000000000021', (select id from _wh), '2026-04-05', 20, 10, 200.00, 'opening'),
  ('c2000000-0000-4000-8000-000000000022', (select id from _wh), '2026-04-05', 3, 33.3333, 100.00, 'opening'),
  ('c2000000-0000-4000-8000-000000000026', (select id from _wh), '2026-04-05', 10, 10, 100.00, 'opening'),
  ('c2000000-0000-4000-8000-000000000027', (select id from _wh), '2026-04-05', 3, 33.3333, 100.00, 'opening');
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select ('d2000000-0000-4000-8000-0000000000' || n)::uuid, '2026-09-15', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)
from unnest(array[10, 11, 12, 13, 14]) n;
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('d3000000-0000-4000-8000-000000001001', 'd2000000-0000-4000-8000-000000000010', 1, 'c2000000-0000-4000-8000-000000000021', 'x', 'x', 'x', 3, 42, 0, 0),
  ('d3000000-0000-4000-8000-000000001101', 'd2000000-0000-4000-8000-000000000011', 1, 'c2000000-0000-4000-8000-000000000022', 'x', 'x', 'x', 3, 33.3333, 0, 0),
  ('d3000000-0000-4000-8000-000000001201', 'd2000000-0000-4000-8000-000000000012', 1, 'c2000000-0000-4000-8000-000000000026', 'x', 'x', 'x', 3, 42, 0, 0),
  ('d3000000-0000-4000-8000-000000001301', 'd2000000-0000-4000-8000-000000000013', 1, 'c2000000-0000-4000-8000-000000000026', 'x', 'x', 'x', 3, 42, 0, 0),
  ('d3000000-0000-4000-8000-000000001401', 'd2000000-0000-4000-8000-000000000014', 1, 'c2000000-0000-4000-8000-000000000027', 'x', 'x', 'x', 3, 42, 0, 0);
insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible) values
  ('e2000000-0000-4000-8000-000000000008', '2026-09-15', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true),
  ('e2000000-0000-4000-8000-000000000009', '2026-09-15', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), false),
  ('e2000000-0000-4000-8000-000000000010', '2026-09-15', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true);
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e3000000-0000-4000-8000-000000000801', 'e2000000-0000-4000-8000-000000000008', 1, 'c2000000-0000-4000-8000-000000000023', 'x', 'x', 'x', 3, 33.3333, 0, 0),
  ('e3000000-0000-4000-8000-000000000901', 'e2000000-0000-4000-8000-000000000009', 1, 'c2000000-0000-4000-8000-000000000024', 'x', 'x', 'x', 3, 42, 0, 0),
  ('e3000000-0000-4000-8000-000000000902', 'e2000000-0000-4000-8000-000000000009', 2, 'c2000000-0000-4000-8000-000000000025', 'x', 'x', 'x', 3, 10, 0, 0),
  ('e3000000-0000-4000-8000-000000001001', 'e2000000-0000-4000-8000-000000000010', 1, 'c2000000-0000-4000-8000-000000000028', 'x', 'x', 'x', 3, 42, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_sales_invoice(%L)$$, ('d2000000-0000-4000-8000-0000000000' || n)), 'post I' || n)
from unnest(array[10, 11, 12, 13, 14]) n order by n;
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000008')$$, 'post PB8 (ITC, 3 x 33.3333 = 100.00)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000009')$$, 'post PB9 (no ITC, Y 3 x 42 @ 18% + W 3 x 10 @ 0%)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000010')$$, 'post PB10 (ITC, 3 x 42)');
reset role;
set local request.jwt.claims to '';
select results_eq($$select grand_total from sales_invoices where id = 'd2000000-0000-4000-8000-000000000010'$$, $$values (149.00::numeric(14,2))$$, 'I10 = 126 + 11.34 + 11.34 = 148.68 -> 149');
select results_eq($$select grand_total from purchase_invoices where id = 'e2000000-0000-4000-8000-000000000009'$$, $$values (179.00::numeric(14,2))$$, 'PB9 = 148.68 + 30 = 178.68 -> 179');
select results_eq($$select taxable_value from sales_invoice_lines where id = 'd3000000-0000-4000-8000-000000001101'$$, $$values (100.00::numeric(14,2))$$, 'I11 taxable 100.00 (does not divide by 3)');

-- F1 credit side: 3 x 42 returned in thirds -> 50 + 49 + 50 = 149, the last one is not refused
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000401', '2026-09-16', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000010', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000401', 1, 'c2000000-0000-4000-8000-000000000021', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001001');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000402', '2026-09-17', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000010', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000402', 1, 'c2000000-0000-4000-8000-000000000021', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001001');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000403', '2026-09-18', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000010', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000403', 1, 'c2000000-0000-4000-8000-000000000021', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001001');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_credit_note(%L)$$, id), 'I10 third ' || n) from (values (1, '0c000000-0000-4000-8000-000000000401'), (2, '0c000000-0000-4000-8000-000000000402'), (3, '0c000000-0000-4000-8000-000000000403')) v(n, id) order by n;
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select grand_total, round_off from credit_notes where against_invoice_id = 'd2000000-0000-4000-8000-000000000010' order by note_date$$,
  $$values (50.00::numeric(14,2), 0.44::numeric(6,2)), (49.00::numeric(14,2), -0.56::numeric(6,2)), (50.00::numeric(14,2), 0.44::numeric(6,2))$$,
  'grand totals are rounded cumulatively across the invoice''s notes');
select is((select sum(grand_total) from credit_notes where against_invoice_id = 'd2000000-0000-4000-8000-000000000010'), 149.00::numeric, 'the three notes credit exactly the invoice''s 149');
select ok((select bool_and(_balanced(journal_entry_id)) from credit_notes where against_invoice_id = 'd2000000-0000-4000-8000-000000000010'), 'and every one of their entries is balanced');
select is((select count(*)::int from v_open_sales_invoices where invoice_id = 'd2000000-0000-4000-8000-000000000010'), 0, 'I10 is fully closed, no rupee left open');

-- F1 debit side: the no-ITC bill (Y + W) returned in thirds -> 60 + 59 + 60 = 179
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000401', '2026-09-16', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000009', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000401', 1, 'c2000000-0000-4000-8000-000000000024', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000901');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000401', 2, 'c2000000-0000-4000-8000-000000000025', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000902');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000402', '2026-09-17', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000009', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000402', 1, 'c2000000-0000-4000-8000-000000000024', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000901');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000402', 2, 'c2000000-0000-4000-8000-000000000025', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000902');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000403', '2026-09-18', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000009', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000403', 1, 'c2000000-0000-4000-8000-000000000024', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000901');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000403', 2, 'c2000000-0000-4000-8000-000000000025', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000902');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_debit_note(%L)$$, id), 'PB9 third ' || n) from (values (1, '0d000000-0000-4000-8000-000000000401'), (2, '0d000000-0000-4000-8000-000000000402'), (3, '0d000000-0000-4000-8000-000000000403')) v(n, id) order by n;
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select grand_total from debit_notes where against_invoice_id = 'e2000000-0000-4000-8000-000000000009' order by note_date$$,
  $$values (60.00::numeric(14,2)), (59.00::numeric(14,2)), (60.00::numeric(14,2))$$,
  'debit notes round cumulatively too (the third is no longer 78-over-77 style refused)');
select is((select sum(grand_total) from debit_notes where against_invoice_id = 'e2000000-0000-4000-8000-000000000009'), 179.00::numeric, 'the three debit notes equal the bill''s 179');
select ok((select bool_and(_balanced(journal_entry_id)) from debit_notes where against_invoice_id = 'e2000000-0000-4000-8000-000000000009'), 'their entries are balanced');
select results_eq($$select (select value from _soh('c2000000-0000-4000-8000-000000000024')), (select value from _soh('c2000000-0000-4000-8000-000000000025'))$$, $$values (0::numeric, 0::numeric)$$,
  'both bill items leave stock at exactly the capitalised cost (148.68 and 30.00)');

-- Full return in one note, and in two notes: the notes equal the invoice exactly
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000404', '2026-09-16', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000012', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000404', 1, 'c2000000-0000-4000-8000-000000000026', 'x', 'x', 'x', 3, 0, 0, 0, 'd3000000-0000-4000-8000-000000001201');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000405', '2026-09-16', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000013', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000405', 1, 'c2000000-0000-4000-8000-000000000026', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001301');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000406', '2026-09-17', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000013', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000406', 1, 'c2000000-0000-4000-8000-000000000026', 'x', 'x', 'x', 2, 0, 0, 0, 'd3000000-0000-4000-8000-000000001301');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000404')$$, 'full return of I12 in one note');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000405')$$, 'I13 first note (1 unit)');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000406')$$, 'I13 second note (the other 2)');
reset role;
set local request.jwt.claims to '';
select is((select grand_total from credit_notes where id = '0c000000-0000-4000-8000-000000000404'), 149.00::numeric, 'one-note full return = 149');
select results_eq($$select grand_total from credit_notes where against_invoice_id = 'd2000000-0000-4000-8000-000000000013' order by grand_total$$,
  $$values (50.00::numeric(14,2)), (99.00::numeric(14,2))$$, 'two-note full return = 50 + 99 = 149');

-- F2: thirds on a taxable of 100.00 (sales line and purchase line): 33.33 + 33.34 + 33.33
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000407', '2026-09-16', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000011', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000407', 1, 'c2000000-0000-4000-8000-000000000022', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001101');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000408', '2026-09-17', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000011', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000408', 1, 'c2000000-0000-4000-8000-000000000022', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001101');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000409', '2026-09-18', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000011', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000409', 1, 'c2000000-0000-4000-8000-000000000022', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001101');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000404', '2026-09-16', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000008', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000404', 1, 'c2000000-0000-4000-8000-000000000023', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000801');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000405', '2026-09-17', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000008', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000405', 1, 'c2000000-0000-4000-8000-000000000023', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000801');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000406', '2026-09-18', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000008', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000406', 1, 'c2000000-0000-4000-8000-000000000023', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000000801');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_credit_note(%L)$$, id), 'I11 third ' || n) from (values (1, '0c000000-0000-4000-8000-000000000407'), (2, '0c000000-0000-4000-8000-000000000408'), (3, '0c000000-0000-4000-8000-000000000409')) v(n, id) order by n;
select lives_ok(format($$select post_debit_note(%L)$$, id), 'PB8 third ' || n) from (values (1, '0d000000-0000-4000-8000-000000000404'), (2, '0d000000-0000-4000-8000-000000000405'), (3, '0d000000-0000-4000-8000-000000000406')) v(n, id) order by n;
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select l.taxable_value from credit_note_lines l join credit_notes n on n.id = l.note_id where n.against_invoice_id = 'd2000000-0000-4000-8000-000000000011' order by n.note_date$$,
  $$values (33.33::numeric(14,2)), (33.34::numeric(14,2)), (33.33::numeric(14,2))$$,
  'sales thirds of 100.00 are 33.33 + 33.34 + 33.33 (cumulative, not 3 x 33.33)');
select results_eq(
  $$select sum(l.taxable_value), sum(l.cgst_amt), sum(l.sgst_amt) from credit_note_lines l join credit_notes n on n.id = l.note_id where n.against_invoice_id = 'd2000000-0000-4000-8000-000000000011'$$,
  $$values (100.00::numeric, 9.00::numeric, 9.00::numeric)$$, 'and reverse exactly 100.00 / 9.00 / 9.00');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000022')$$, $$values (3::numeric, 100.00::numeric)$$, 'the cost of all three comes back as exactly 100.00');
select results_eq(
  $$select l.taxable_value from debit_note_lines l join debit_notes n on n.id = l.note_id where n.against_invoice_id = 'e2000000-0000-4000-8000-000000000008' order by n.note_date$$,
  $$values (33.33::numeric(14,2)), (33.34::numeric(14,2)), (33.33::numeric(14,2))$$,
  'purchase thirds of 100.00 are 33.33 + 33.34 + 33.33');
select results_eq(
  $$select sum(l.taxable_value), sum(l.cgst_amt) from debit_note_lines l join debit_notes n on n.id = l.note_id where n.against_invoice_id = 'e2000000-0000-4000-8000-000000000008'$$,
  $$values (100.00::numeric, 9.00::numeric)$$, 'and reverse exactly the 100.00 / 9.00 ITC');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000023')$$, $$values (0::numeric, 0::numeric)$$, 'PB8''s item leaves stock with zero value');

-- F2: post note 1, cancel it, then return the full quantity: a cancelled note counts for nothing
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000410', '2026-09-16', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000014', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000410', 1, 'c2000000-0000-4000-8000-000000000027', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001401');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0c000000-0000-4000-8000-000000000411', '2026-09-17', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000014', 'Return');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000411', 1, 'c2000000-0000-4000-8000-000000000027', 'x', 'x', 'x', 3, 0, 0, 0, 'd3000000-0000-4000-8000-000000001401');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000407', '2026-09-16', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000010', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000407', 1, 'c2000000-0000-4000-8000-000000000028', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001001');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000408', '2026-09-17', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000010', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000408', 1, 'c2000000-0000-4000-8000-000000000028', 'x', 'x', 'x', 3, 0, 0, 0, 'e3000000-0000-4000-8000-000000001001');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000410')$$, 'I14: 1 unit returned');
select lives_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000410', 'wrong')$$, 'and that note cancelled');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000411')$$, 'the full 3 can then be returned');
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000407')$$, 'PB10: 1 unit returned');
select lives_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000407', 'wrong')$$, 'and that debit note cancelled');
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000408')$$, 'the full 3 can then go back');
reset role;
set local request.jwt.claims to '';
select results_eq(
  $$select taxable_total, cgst_total, sgst_total, grand_total from credit_notes where id = '0c000000-0000-4000-8000-000000000411'$$,
  $$values (126.00::numeric(14,2), 11.34::numeric(14,2), 11.34::numeric(14,2), 149.00::numeric(14,2))$$,
  'the full return after a cancelled note reverses the whole invoice exactly');
select results_eq($$select value from stock_movements where source_type = 'credit_note' and source_id = '0c000000-0000-4000-8000-000000000411'$$,
  $$values (100.00::numeric(14,2))$$, 'and brings back the whole 100.00 of cost');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000027')$$, $$values (3::numeric, 100.00::numeric)$$, 'stock is exactly as before the sale');
select results_eq(
  $$select taxable_total, cgst_total, sgst_total, grand_total from debit_notes where id = '0d000000-0000-4000-8000-000000000408'$$,
  $$values (126.00::numeric(14,2), 11.34::numeric(14,2), 11.34::numeric(14,2), 149.00::numeric(14,2))$$,
  'the full debit note after a cancelled one reverses the whole bill exactly');
select results_eq($$select * from _soh('c2000000-0000-4000-8000-000000000028')$$, $$values (0::numeric, 0::numeric)$$, 'PB10''s item leaves stock with zero value');

select is((select count(*)::int from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x), 0,
  'every entry is still balanced after round 2');
select is(_gl('inventory'), (select coalesce(sum(value), 0) from stock_movements where source_type <> 'opening'),
  'Inventory GL still equals the value of every non-opening stock movement');

-- ============================================================
-- Review round 3 (2026-10-01)
-- ============================================================
-- The later-movement rule on a note cancel, now that CN1's case is caught by later_notes first:
-- C404 (I12) cannot be cancelled because I13's notes have since moved the same item.
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000404', 'x')$$,
  'P0001', 'DN_NEGATIVE_STOCK', 'a credit note whose item has moved again since (another invoice''s notes) cannot be cancelled');
reset role;
set local request.jwt.claims to '';

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, is_stock) values
  ('c2000000-0000-4000-8000-000000000031', 'R3 A', 'other', '7331', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000032', 'R3 B', 'other', '7332', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000033', 'R3 C', 'other', '7333', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000034', 'R3 bill A', 'other', '7334', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000035', 'R3 bill B', 'other', '7335', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000036', 'R3 bill C', 'other', '7336', 0, 'pcs', 10, true),
  ('c2000000-0000-4000-8000-000000000037', 'R3 invoice cap', 'other', '7337', 18, 'pcs', 101, true);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select i, (select id from _wh), '2026-04-05', 10, 5, 50.00, 'opening'
from unnest(array['c2000000-0000-4000-8000-000000000031', 'c2000000-0000-4000-8000-000000000032', 'c2000000-0000-4000-8000-000000000033', 'c2000000-0000-4000-8000-000000000037']::uuid[]) i;
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id) values
  ('d2000000-0000-4000-8000-000000000015', '2026-09-20', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh)),
  ('d2000000-0000-4000-8000-000000000016', '2026-09-20', 'a2000000-0000-4000-8000-000000000001', '37', 'draft', (select id from _wh));
insert into sales_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('d3000000-0000-4000-8000-000000001501', 'd2000000-0000-4000-8000-000000000015', 1, 'c2000000-0000-4000-8000-000000000031', 'x', 'x', 'x', 1, 10.49, 0, 0),
  ('d3000000-0000-4000-8000-000000001502', 'd2000000-0000-4000-8000-000000000015', 2, 'c2000000-0000-4000-8000-000000000032', 'x', 'x', 'x', 1, 10.01, 0, 0),
  ('d3000000-0000-4000-8000-000000001503', 'd2000000-0000-4000-8000-000000000015', 3, 'c2000000-0000-4000-8000-000000000033', 'x', 'x', 'x', 1, 10.48, 0, 0),
  ('d3000000-0000-4000-8000-000000001601', 'd2000000-0000-4000-8000-000000000016', 1, 'c2000000-0000-4000-8000-000000000037', 'x', 'x', 'x', 1, 101.26, 0, 0);
insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible) values
  ('e2000000-0000-4000-8000-000000000011', '2026-09-20', 'a2000000-0000-4000-8000-000000000005', '37', 'draft', (select id from _wh), true);
insert into purchase_invoice_lines (id, invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e3000000-0000-4000-8000-000000001101', 'e2000000-0000-4000-8000-000000000011', 1, 'c2000000-0000-4000-8000-000000000034', 'x', 'x', 'x', 1, 10.49, 0, 0),
  ('e3000000-0000-4000-8000-000000001102', 'e2000000-0000-4000-8000-000000000011', 2, 'c2000000-0000-4000-8000-000000000035', 'x', 'x', 'x', 1, 10.01, 0, 0),
  ('e3000000-0000-4000-8000-000000001103', 'e2000000-0000-4000-8000-000000000011', 3, 'c2000000-0000-4000-8000-000000000036', 'x', 'x', 'x', 1, 10.48, 0, 0);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000015')$$, 'post I15 (0%: 10.49 + 10.01 + 10.48 = 30.98 -> 31)');
select lives_ok($$select post_sales_invoice('d2000000-0000-4000-8000-000000000016')$$, 'post I16 (101.26 + 9.11 + 9.11 = 119.48 -> 119)');
select lives_ok($$select post_purchase_invoice('e2000000-0000-4000-8000-000000000011')$$, 'post PB11 (the same three 0% lines, 31)');
reset role;
set local request.jwt.claims to '';

-- 1. Notes on one invoice are cancelled last-posted-first
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values ('0c000000-0000-4000-8000-000000000501', '2026-09-21', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000015', 'Return', true);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000501', 1, 'c2000000-0000-4000-8000-000000000031', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001501');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values ('0c000000-0000-4000-8000-000000000502', '2026-09-22', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000015', 'Return', true);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000502', 1, 'c2000000-0000-4000-8000-000000000032', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001502');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values ('0c000000-0000-4000-8000-000000000503', '2026-09-23', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000015', 'Return', true);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000503', 1, 'c2000000-0000-4000-8000-000000000031', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001501');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000503', 2, 'c2000000-0000-4000-8000-000000000032', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001502');
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000503', 3, 'c2000000-0000-4000-8000-000000000033', 'x', 'x', 'x', 1, 0, 0, 0, 'd3000000-0000-4000-8000-000000001503');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000501')$$, 'n1 returns A (10.49 -> 10, round-off -0.49)');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000502')$$, 'n2 returns B (cumulative 20.50 -> 21, so 11, round-off +0.99)');
select throws_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000501', 'x')$$,
  'P0001', 'DN_VALIDATION:later_notes', 'n1 cannot be cancelled while the later n2 stands');
select lives_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000502', 'x')$$, 'n2 (the last) cancels');
select lives_ok($$select cancel_document('credit_note', '0c000000-0000-4000-8000-000000000501', 'x')$$, 'then n1 cancels');
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000503')$$, 'a fresh full return of all three lines posts');
reset role;
set local request.jwt.claims to '';
select results_eq($$select grand_total from credit_notes where id in ('0c000000-0000-4000-8000-000000000501', '0c000000-0000-4000-8000-000000000502') order by id$$,
  $$values (10.00::numeric(14,2)), (11.00::numeric(14,2))$$, 'the cancelled notes keep their stored totals');
select is((select grand_total from credit_notes where id = '0c000000-0000-4000-8000-000000000503'), 31.00::numeric, 'the full return credits exactly the invoice''s 31');
select is((select coalesce(sum(grand_total), 0) from credit_notes where against_invoice_id = 'd2000000-0000-4000-8000-000000000015' and status = 'posted'),
  (select grand_total from sales_invoices where id = 'd2000000-0000-4000-8000-000000000015'), 'posted notes on I15 tie to the invoice exactly');
select ok(_balanced(_entry('0c000000-0000-4000-8000-000000000503')), 'its entry is balanced');

insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000501', '2026-09-21', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000011', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000501', 1, 'c2000000-0000-4000-8000-000000000034', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001101');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000502', '2026-09-22', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000011', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000502', 1, 'c2000000-0000-4000-8000-000000000035', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001102');
insert into debit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason) values ('0d000000-0000-4000-8000-000000000503', '2026-09-23', 'a2000000-0000-4000-8000-000000000005', '37', 'e2000000-0000-4000-8000-000000000011', 'Return');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000503', 1, 'c2000000-0000-4000-8000-000000000034', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001101');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000503', 2, 'c2000000-0000-4000-8000-000000000035', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001102');
insert into debit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0d000000-0000-4000-8000-000000000503', 3, 'c2000000-0000-4000-8000-000000000036', 'x', 'x', 'x', 1, 0, 0, 0, 'e3000000-0000-4000-8000-000000001103');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000501')$$, 'd1 returns bill line A (10)');
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000502')$$, 'd2 returns bill line B (11)');
select throws_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000501', 'x')$$,
  'P0001', 'DN_VALIDATION:later_notes', 'd1 cannot be cancelled while the later d2 stands');
select lives_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000502', 'x')$$, 'd2 (the last) cancels');
select lives_ok($$select cancel_document('debit_note', '0d000000-0000-4000-8000-000000000501', 'x')$$, 'then d1 cancels');
select lives_ok($$select post_debit_note('0d000000-0000-4000-8000-000000000503')$$, 'a fresh full return of the bill posts');
reset role;
set local request.jwt.claims to '';
select results_eq($$select grand_total from debit_notes where id in ('0d000000-0000-4000-8000-000000000501', '0d000000-0000-4000-8000-000000000502') order by id$$,
  $$values (10.00::numeric(14,2)), (11.00::numeric(14,2))$$, 'cancelled debit notes keep their stored totals');
select is((select coalesce(sum(grand_total), 0) from debit_notes where against_invoice_id = 'e2000000-0000-4000-8000-000000000011' and status = 'posted'),
  (select grand_total from purchase_invoices where id = 'e2000000-0000-4000-8000-000000000011'), 'posted debit notes on PB11 tie to the bill exactly (31)');
select results_eq($$select (select value from _soh('c2000000-0000-4000-8000-000000000034')), (select value from _soh('c2000000-0000-4000-8000-000000000035')), (select value from _soh('c2000000-0000-4000-8000-000000000036'))$$,
  $$values (0::numeric, 0::numeric, 0::numeric)$$, 'the bill''s three items leave stock with zero value');

-- 2. The invoice-level cap fires on its own: both line caps pass (101.20 + 0.06 = 101.26), but the
--    two value-only notes' tax rounds up per note (9.11 + 0.01 per component against 9.11 invoiced),
--    so their cumulative total would round to 120 against an invoice of 119.
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values ('0c000000-0000-4000-8000-000000000504', '2026-09-21', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000016', 'Return', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000504', 1, 'c2000000-0000-4000-8000-000000000037', 'x', 'x', 'x', 1, 101.2, 0, 0, 'd3000000-0000-4000-8000-000000001601');
insert into credit_notes (id, note_date, party_id, place_of_supply, against_invoice_id, reason, stock_effect) values ('0c000000-0000-4000-8000-000000000505', '2026-09-22', 'a2000000-0000-4000-8000-000000000001', '37', 'd2000000-0000-4000-8000-000000000016', 'Return', false);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, against_line_id) values ('0c000000-0000-4000-8000-000000000505', 1, 'c2000000-0000-4000-8000-000000000037', 'x', 'x', 'x', 1, 0.06, 0, 0, 'd3000000-0000-4000-8000-000000001601');
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000504')$$, 'a rate difference of 101.20 posts (119)');
select throws_ok($$select post_credit_note('0c000000-0000-4000-8000-000000000505')$$,
  'P0001', 'DN_VALIDATION:value_exceeds_invoice', 'notes together may not exceed the invoice''s grand total, even when every line cap passes');
reset role;
set local request.jwt.claims to '';

-- 3. Grants: post functions are for signed-in sessions only
select is(has_function_privilege('service_role', 'public.post_credit_note(uuid)', 'EXECUTE'), false, 'service_role cannot execute post_credit_note');
select is(has_function_privilege('service_role', 'public.post_debit_note(uuid)', 'EXECUTE'), false, 'service_role cannot execute post_debit_note');

select is((select count(*)::int from (select entry_id from journal_lines group by entry_id having sum(debit) <> sum(credit)) x), 0,
  'every entry is still balanced after round 3');

select * from finish();
rollback;
