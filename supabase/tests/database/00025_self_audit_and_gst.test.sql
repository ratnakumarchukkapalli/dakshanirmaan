-- Change 18 (self-audit-and-gst): gstr1_data, gstr3b_summary, set_period_lock, the master-edit audit trail.
--
-- One month (Sept 2026) of real posted documents, built through the posting functions, with the
-- expected GSTR-1 spelled out section by section (the golden shape of docs/research/gstr1-schema.md):
--   I1 B2B intra (P1, 37ABCDE1234F1ZZ): 10 bags cement 4,000 + CGST 560 + SGST 560 = 5,120
--   I2 B2B inter (P2, 36ABCDE1234F1Z1): 100 kg TMT 7,000 + IGST 1,260 = 8,260
--   I3 B2C intra (P3): 5 bags 2,000 + 280 + 280
--   I4 B2C inter small (P4, state 36): 20 bags 8,000 + IGST 2,240 = 10,240   -> b2cs
--   I5 B2C inter large (P4): 2,000 kg TMT 140,000 + IGST 25,200 = 165,200    -> b2cl (> 1,00,000)
--   I6 nil-rated (P3): 100 kg at 0% = 5,000                                  -> nil
--   I7 a cancelled invoice (numbers issued, never reported); I8 an August invoice (outside the month)
--   CN1 credit note to P1 (B2B): 1 bag 400 + 56 + 56 -> cdnr;  CN2 to P3 (B2C): same -> nets off b2cs;  CN3 cancelled
--   Two challans; a posted ITC-eligible purchase, an ineligible one, and a GTA freight voucher (RCM).
begin;

create extension if not exists pgtap with schema extensions;

select plan(122);

-- ============================================================
-- Fixtures
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test');
update organization set gstin = '37AAPFU0939F1ZU', address = '{"line1":"Main Road","city":"Guntur","pincode":"522001"}'::jsonb;

insert into parties (id, name, type, state_code, gstin) values
  ('a0000000-0000-4000-8000-000000000001', 'P1 B2B intra', 'customer', '37', '37ABCDE1234F1ZZ'),
  ('a0000000-0000-4000-8000-000000000002', 'P2 B2B inter', 'customer', '36', '36ABCDE1234F1Z1'),
  ('a0000000-0000-4000-8000-000000000003', 'P3 B2C intra', 'customer', '37', null),
  ('a0000000-0000-4000-8000-000000000004', 'P4 B2C inter', 'customer', '36', null),
  ('a0000000-0000-4000-8000-000000000005', 'S1 supplier', 'supplier', '37', null),
  ('a0000000-0000-4000-8000-000000000006', 'Lorry Owner (GTA)', 'supplier', '37', null);
insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate) values
  ('c0000000-0000-4000-8000-000000000001', 'Cement 50kg', 'cement', '2523', 28, 'bag', 400),
  ('c0000000-0000-4000-8000-000000000002', 'TMT 12mm', 'steel', '7214', 18, 'kg', 70),
  ('c0000000-0000-4000-8000-000000000003', 'Nil Grain', 'other', '1006', 0, 'kg', 50);
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select i.id, w.id, '2026-04-05', 10000, 50, 500000, 'opening'
from items i, warehouses w where w.is_default and not w.is_transit;

-- Draft invoices (posting re-snapshots the lines and computes every figure)
create temp table _inv (n int, id uuid, party uuid, pos text, dt date);
insert into _inv values
  (1, 'd0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '37', '2026-09-05'),
  (2, 'd0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', '36', '2026-09-06'),
  (3, 'd0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', '37', '2026-09-07'),
  (4, 'd0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004', '36', '2026-09-08'),
  (5, 'd0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000004', '36', '2026-09-09'),
  (6, 'd0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000003', '37', '2026-09-10'),
  (8, 'd0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', '37', '2026-08-31');
grant select on _inv to authenticated;
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
select id, dt, party, pos, 'draft', (select id from warehouses where is_default and not is_transit) from _inv;
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
select d.id, 1, i.id, i.name, i.hsn_code, i.base_uom, d.q, d.r, 0, i.gst_rate
from (values
  ('d0000000-0000-4000-8000-000000000001'::uuid, 'c0000000-0000-4000-8000-000000000001'::uuid, 10, 400),
  ('d0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 100, 70),
  ('d0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000001', 5, 400),
  ('d0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000001', 20, 400),
  ('d0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000002', 2000, 70),
  ('d0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000003', 100, 50),
  ('d0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000001', 1, 400)
) as d(id, item, q, r) join items i on i.id = d.item;

-- Purchases: one ITC-eligible (30,000 + 4,200 + 4,200) and one not (6,000 + 540 + 540)
insert into purchase_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id, itc_eligible) values
  ('e0000000-0000-4000-8000-000000000001', '2026-09-03', 'a0000000-0000-4000-8000-000000000005', '37', 'draft', (select id from warehouses where is_default and not is_transit), true),
  ('e0000000-0000-4000-8000-000000000002', '2026-09-04', 'a0000000-0000-4000-8000-000000000005', '37', 'draft', (select id from warehouses where is_default and not is_transit), false);
insert into purchase_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate) values
  ('e0000000-0000-4000-8000-000000000001', 1, 'c0000000-0000-4000-8000-000000000001', 'Cement 50kg', '2523', 'bag', 100, 300, 0, 28),
  ('e0000000-0000-4000-8000-000000000002', 1, 'c0000000-0000-4000-8000-000000000002', 'TMT 12mm', '7214', 'kg', 100, 60, 0, 18);
-- GTA freight 2,000 with reverse charge: tax 100 (50 + 50)
insert into expense_vouchers (id, voucher_date, party_id, status, voucher_type, pay_account_id)
values ('b0000000-0000-4000-8000-000000000001', '2026-09-12', 'a0000000-0000-4000-8000-000000000006', 'draft', 'expense', (select id from accounts where system_key = 'cash'));
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration, rcm)
values ('b0000000-0000-4000-8000-000000000001', 1, (select id from accounts where system_key = 'freight_inward'), 2000, 'GTA freight', true);
-- and a plain expense line posted straight to an input-tax account on the same voucher: NOT reverse-charge tax
insert into expense_voucher_lines (voucher_id, line_no, account_id, amount, narration, rcm)
values ('b0000000-0000-4000-8000-000000000001', 2, (select id from accounts where system_key = 'input_cgst'), 300, 'adjustment', false);

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select lives_ok(format($$select post_sales_invoice(%L)$$, id), 'post I' || n) from _inv where n <= 6 order by n;
select lives_ok($$select post_sales_invoice('d0000000-0000-4000-8000-000000000008')$$, 'post I8 (August)');
select lives_ok($$select post_purchase_invoice('e0000000-0000-4000-8000-000000000001')$$, 'post the ITC-eligible purchase');
select lives_ok($$select post_purchase_invoice('e0000000-0000-4000-8000-000000000002')$$, 'post the ineligible purchase');
select lives_ok($$select post_expense_voucher('b0000000-0000-4000-8000-000000000001')$$, 'post the RCM freight voucher');
reset role;

-- A cancelled invoice (number issued, later cancelled), credit notes (nothing posts them until change 20, so fixtures),
-- and two posted challans
insert into sales_invoices (invoice_no, invoice_date, party_id, place_of_supply, status, warehouse_id)
values ('DN/26-27/0008', '2026-09-11', 'a0000000-0000-4000-8000-000000000003', '37', 'cancelled', (select id from warehouses where is_default and not is_transit));
insert into credit_notes (id, note_no, note_date, party_id, place_of_supply, status, taxable_total, cgst_total, sgst_total, grand_total) values
  ('f0000000-0000-4000-8000-000000000001', 'CN/26-27/0001', '2026-09-15', 'a0000000-0000-4000-8000-000000000001', '37', 'posted', 400, 56, 56, 512),
  ('f0000000-0000-4000-8000-000000000002', 'CN/26-27/0002', '2026-09-16', 'a0000000-0000-4000-8000-000000000003', '37', 'posted', 400, 56, 56, 512),
  ('f0000000-0000-4000-8000-000000000003', 'CN/26-27/0003', '2026-09-17', 'a0000000-0000-4000-8000-000000000003', '37', 'cancelled', 400, 56, 56, 512),
  ('f0000000-0000-4000-8000-000000000004', 'CN/26-27/0004', '2026-10-02', 'a0000000-0000-4000-8000-000000000003', '37', 'posted', 100, 0, 0, 100);
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate, cgst_amt, sgst_amt)
select n, 1, 'c0000000-0000-4000-8000-000000000001', 'Cement 50kg', '2523', 'bag', 1, 400, 400, 28, 56, 56
from unnest(array['f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003']::uuid[]) n;
-- October: a credit note line with no HSN and a unit the portal list does not cover (for the warnings)
insert into credit_note_lines (note_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('f0000000-0000-4000-8000-000000000004', 1, 'c0000000-0000-4000-8000-000000000001', 'Odd service', '', 'trip', 1, 100, 100, 0);
insert into delivery_challans (challan_no, challan_date, party_id, warehouse_id, status) values
  ('DC/26-27/0001', '2026-09-08', 'a0000000-0000-4000-8000-000000000001', (select id from warehouses where is_default and not is_transit), 'posted'),
  ('DC/26-27/0002', '2026-09-09', 'a0000000-0000-4000-8000-000000000001', (select id from warehouses where is_default and not is_transit), 'posted');

select is((select invoice_no from sales_invoices where id = 'd0000000-0000-4000-8000-000000000001'), 'DN/26-27/0001', 'I1 is DN/26-27/0001');
select is((select invoice_no from sales_invoices where id = 'd0000000-0000-4000-8000-000000000008'), 'DN/26-27/0007', 'I8 (posted last) is DN/26-27/0007');

-- ============================================================
-- Who may ask
-- ============================================================
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select throws_ok($$select gstr1_data('2026-09-01')$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot build GSTR-1');
select throws_ok($$select * from gstr3b_summary('2026-09-01')$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot build GSTR-3B');
select throws_ok($$select set_period_lock('2026-09-01', true)$$, 'P0001', 'DN_FORBIDDEN', 'counter staff cannot lock a period');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}';
select throws_ok($$select gstr1_data('2026-09-01')$$, 'P0001', 'DN_FORBIDDEN', 'an owner at step 1 cannot build GSTR-1');
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select throws_ok($$select gstr1_data(null)$$, 'P0001', 'DN_VALIDATION:invalid_date', 'a null month is refused');

create temp table _g as select gstr1_data('2026-09-15') as g;
grant select on _g to authenticated;
create temp table _t as select * from gstr3b_summary('2026-09-01');
grant select on _t to authenticated;

-- ============================================================
-- GSTR-1 September 2026
-- ============================================================
select is((select g ->> 'period' from _g), '2026-09', 'period (any date in the month works)');
select is((select g ->> 'fp' from _g), '092026', 'fp is MMYYYY');
select is((select g ->> 'gstin' from _g), '37AAPFU0939F1ZU', 'the organisation GSTIN');

-- B2B
select is((select jsonb_array_length(g -> 'b2b') from _g), 2, 'b2b: two buyers');
select is((select g -> 'b2b' -> 0 ->> 'ctin' from _g), '36ABCDE1234F1Z1', 'b2b ordered by GSTIN: the inter-state buyer first');
select is((select g -> 'b2b' -> 1 ->> 'ctin' from _g), '37ABCDE1234F1ZZ', 'b2b: the intra-state buyer');
select is((select jsonb_array_length(g -> 'b2b' -> 1 -> 'inv') from _g), 1, 'the August invoice is not in September');
select is((select g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'inum' from _g), 'DN/26-27/0001', 'b2b: inum');
select is((select g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'idt' from _g), '05-09-2026', 'b2b: idt is DD-MM-YYYY');
select is((select (g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'val')::numeric from _g), 5120.00, 'b2b: val is the grand total');
select is((select g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'pos' from _g), '37', 'b2b: pos');
select is((select (g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'rchrg') || (g -> 'b2b' -> 1 -> 'inv' -> 0 ->> 'inv_typ') from _g), 'NR', 'b2b: rchrg N, inv_typ R');
select is((select g -> 'b2b' -> 1 -> 'inv' -> 0 -> 'itms' -> 0 ->> 'num' from _g), '1', 'b2b: item num 1');
select is((select (g -> 'b2b' -> 1 -> 'inv' -> 0 -> 'itms' -> 0 -> 'itm_det') from _g),
  '{"rt": 28, "camt": 560.00, "iamt": 0, "samt": 560.00, "csamt": 0, "txval": 4000.00}'::jsonb, 'b2b: itm_det at 28% (CGST + SGST)');
select is((select g -> 'b2b' -> 0 -> 'inv' -> 0 -> 'itms' -> 0 -> 'itm_det' from _g),
  '{"rt": 18, "camt": 0, "iamt": 1260.00, "samt": 0, "csamt": 0, "txval": 7000.00}'::jsonb, 'b2b inter-state: IGST only');

-- B2CL
select is((select jsonb_array_length(g -> 'b2cl') from _g), 1, 'b2cl: one place of supply');
select is((select g -> 'b2cl' -> 0 ->> 'pos' from _g), '36', 'b2cl: pos 36');
select is((select g -> 'b2cl' -> 0 -> 'inv' -> 0 ->> 'inum' from _g), 'DN/26-27/0005', 'b2cl: only the invoice above 1,00,000');
select is((select (g -> 'b2cl' -> 0 -> 'inv' -> 0 ->> 'val')::numeric from _g), 165200.00, 'b2cl: val');
select is((select g -> 'b2cl' -> 0 -> 'inv' -> 0 -> 'itms' -> 0 -> 'itm_det' from _g),
  '{"rt": 18, "iamt": 25200.00, "csamt": 0, "txval": 140000.00}'::jsonb, 'b2cl: itm_det has no CGST/SGST keys');

-- B2CS: the small inter-state sale, and the intra-state sale net of its credit note
select is((select jsonb_array_length(g -> 'b2cs') from _g), 2, 'b2cs: two rows');
select is((select g -> 'b2cs' -> 0 from _g),
  '{"rt": 28, "typ": "OE", "pos": "36", "camt": 0, "iamt": 2240.00, "samt": 0, "csamt": 0, "txval": 8000.00, "sply_ty": "INTER"}'::jsonb, 'b2cs: INTER 36 at 28%');
select is((select g -> 'b2cs' -> 1 from _g),
  '{"rt": 28, "typ": "OE", "pos": "37", "camt": 224.00, "iamt": 0, "samt": 224.00, "csamt": 0, "txval": 1600.00, "sply_ty": "INTRA"}'::jsonb, 'b2cs: INTRA 37 at 28%, 2,000 less the 400 credit note');

-- CDNR
select is((select jsonb_array_length(g -> 'cdnr') from _g), 1, 'cdnr: one buyer (the B2C note is not here)');
select is((select g -> 'cdnr' -> 0 ->> 'ctin' from _g), '37ABCDE1234F1ZZ', 'cdnr: ctin');
select is((select jsonb_array_length(g -> 'cdnr' -> 0 -> 'nt') from _g), 1, 'cdnr: the cancelled note is not reported');
select is((select (g -> 'cdnr' -> 0 -> 'nt' -> 0 ->> 'nt_num') || '|' || (g -> 'cdnr' -> 0 -> 'nt' -> 0 ->> 'ntty') || '|' || (g -> 'cdnr' -> 0 -> 'nt' -> 0 ->> 'nt_dt') from _g),
  'CN/26-27/0001|C|15-09-2026', 'cdnr: number, type C, date');
select is((select g -> 'cdnr' -> 0 -> 'nt' -> 0 -> 'itms' -> 0 -> 'itm_det' from _g),
  '{"rt": 28, "camt": 56.00, "iamt": 0, "samt": 56.00, "csamt": 0, "txval": 400.00}'::jsonb, 'cdnr: itm_det');

-- NIL
select is((select g -> 'nil' -> 'inv' from _g),
  '[{"sply_ty": "INTRAB2C", "nil_amt": 5000.00, "expt_amt": 0, "ngsup_amt": 0}]'::jsonb, 'nil: the 0% sale, intra-state to a consumer');

-- HSN: b2b and b2c tables, net of credit notes
select is((select jsonb_array_length(g -> 'hsn' -> 'hsn_b2b') from _g), 2, 'hsn_b2b: two lines');
select is((select g -> 'hsn' -> 'hsn_b2b' -> 0 from _g),
  '{"num": 1, "qty": 9.000, "rt": 28, "desc": "Cement 50kg", "uqc": "BAG", "camt": 504.00, "iamt": 0, "samt": 504.00, "csamt": 0, "hsn_sc": "2523", "txval": 3600.00}'::jsonb, 'hsn_b2b: cement, 10 bags less the credit note bag, UQC BAG');
select is((select g -> 'hsn' -> 'hsn_b2b' -> 1 ->> 'uqc' from _g), 'KGS', 'hsn_b2b: TMT in KGS');
select is((select jsonb_array_length(g -> 'hsn' -> 'hsn_b2c') from _g), 3, 'hsn_b2c: nil grain, cement, TMT');
select is((select (g -> 'hsn' -> 'hsn_b2c' -> 0 ->> 'hsn_sc') || '|' || (g -> 'hsn' -> 'hsn_b2c' -> 0 ->> 'rt') from _g), '1006|0.00', 'hsn_b2c: the nil-rated line is listed at rate 0');
select is((select (g -> 'hsn' -> 'hsn_b2c' -> 1 ->> 'qty')::numeric from _g), 24.000, 'hsn_b2c: cement 5 + 20 less the credit note bag');

-- DOCUMENTS ISSUED
select is((select jsonb_array_length(g -> 'doc_issue' -> 'doc_det') from _g), 3, 'doc_issue: invoices, credit notes, challans');
select is((select g -> 'doc_issue' -> 'doc_det' -> 0 ->> 'doc_num' from _g), '1', 'doc_issue nature 1 = invoices for outward supply');
select is((select g -> 'doc_issue' -> 'doc_det' -> 0 -> 'docs' -> 0 from _g),
  '{"num": 1, "to": "DN/26-27/0008", "from": "DN/26-27/0001", "cancel": 1, "totnum": 7, "net_issue": 6}'::jsonb, 'invoices: 0001 to 0008, 7 issued in September (0007 is August), 1 cancelled');
select is((select g -> 'doc_issue' -> 'doc_det' -> 1 ->> 'doc_num' from _g), '5', 'nature 5 = credit notes');
select is((select g -> 'doc_issue' -> 'doc_det' -> 1 -> 'docs' -> 0 from _g),
  '{"num": 1, "to": "CN/26-27/0003", "from": "CN/26-27/0001", "cancel": 1, "totnum": 3, "net_issue": 2}'::jsonb, 'credit notes: 3 issued, 1 cancelled');
select is((select g -> 'doc_issue' -> 'doc_det' -> 2 ->> 'doc_num' from _g), '12', 'nature 12 = delivery challans (other purposes)');
select is((select g -> 'doc_issue' -> 'doc_det' -> 2 -> 'docs' -> 0 ->> 'totnum' from _g), '2', 'two challans');

-- Totals and the sections add up to the documents
select is((select g -> 'totals' from _g),
  '{"igst": 28700.00, "cgst": 728.00, "sgst": 728.00, "notes": 2, "taxable": 165200.00, "invoices": 6}'::jsonb, 'totals: 6 invoices, 2 notes, taxable 165,200 (166,000 less 800)');
select is(
  (select coalesce(sum((it -> 'itm_det' ->> 'txval')::numeric), 0)
     from _g, jsonb_array_elements(g -> 'b2b') c, jsonb_array_elements(c -> 'inv') i, jsonb_array_elements(i -> 'itms') it)
  + (select coalesce(sum((it -> 'itm_det' ->> 'txval')::numeric), 0)
     from _g, jsonb_array_elements(g -> 'b2cl') c, jsonb_array_elements(c -> 'inv') i, jsonb_array_elements(i -> 'itms') it)
  + (select coalesce(sum((r ->> 'txval')::numeric), 0) from _g, jsonb_array_elements(g -> 'b2cs') r)
  - (select coalesce(sum((it -> 'itm_det' ->> 'txval')::numeric), 0)
     from _g, jsonb_array_elements(g -> 'cdnr') c, jsonb_array_elements(c -> 'nt') n, jsonb_array_elements(n -> 'itms') it)
  + (select coalesce(sum((r ->> 'nil_amt')::numeric), 0) from _g, jsonb_array_elements(g -> 'nil' -> 'inv') r),
  (select (g -> 'totals' ->> 'taxable')::numeric from _g),
  'b2b + b2cl + b2cs - cdnr + nil = the documents'' taxable total: nothing lost or counted twice');
select is((select g -> 'summary' -> 'b2b' from _g),
  '{"count": 2, "txval": 11000.00, "iamt": 1260.00, "camt": 560.00, "samt": 560.00}'::jsonb, 'summary b2b: 2 invoices, 11,000');
select is((select g -> 'summary' -> 'b2cl' from _g),
  '{"count": 1, "txval": 140000.00, "iamt": 25200.00, "camt": 0, "samt": 0}'::jsonb, 'summary b2cl');
select is((select g -> 'summary' -> 'b2cs' from _g),
  '{"count": 2, "txval": 9600.00, "iamt": 2240.00, "camt": 224.00, "samt": 224.00}'::jsonb, 'summary b2cs: net of the consumer credit note');
select is((select g -> 'summary' -> 'cdnr' from _g),
  '{"count": 1, "txval": 400.00, "iamt": 0, "camt": 56.00, "samt": 56.00}'::jsonb, 'summary cdnr');
select is((select (g -> 'summary' -> 'nil' ->> 'txval')::numeric from _g), 5000.00, 'summary nil');
select is((select g -> 'warnings' from _g), '[]'::jsonb, 'a clean month has no warnings');
select is((select gstr1_data('2026-10-01') -> 'warnings'),
  '[{"key": "no_hsn", "count": 1}, {"key": "unmapped_uom", "count": 1}]'::jsonb, 'October: a line with no HSN and an unmapped unit is flagged, not guessed');
select is((select gstr1_data('2026-11-01') -> 'b2b'), '[]'::jsonb, 'an empty month has empty sections');

-- ============================================================
-- GSTR-3B summary
-- ============================================================
-- one line per row: taxable/igst/cgst/sgst
create temp table _tt as
select row_key, taxable::numeric(14,2)::text || '/' || igst::numeric(14,2)::text || '/' || cgst::numeric(14,2)::text || '/' || sgst::numeric(14,2)::text as f from _t;
grant select on _tt to authenticated;
select is((select f from _tt where row_key = '3.1a'), '160200.00/28700.00/728.00/728.00', '3.1a outward taxable: 160,200 (invoices less credit notes, rate above zero)');
select is((select f from _tt where row_key = '3.1c'), '5000.00/0.00/0.00/0.00', '3.1c nil-rated: 5,000');
select is((select f from _tt where row_key = '3.1d'), '2000.00/0.00/50.00/50.00', '3.1d reverse charge: the 2,000 freight and its 100 tax (the 300 input-tax line on the voucher is not counted)');
select is((select count(*)::int from _tt where row_key like '3.2:%'), 1, '3.2: one place of supply');
select is((select f from _tt where row_key = '3.2:36'), '148000.00/27440.00/0.00/0.00', '3.2:36 inter-state to consumers: 8,000 + 140,000');
select is((select f from _tt where row_key = '4A3'), '2000.00/0.00/50.00/50.00', '4A3 ITC on reverse charge = 3.1d tax');
select is((select f from _tt where row_key = '4A5'), '30000.00/0.00/4200.00/4200.00', '4A5 other ITC: the eligible purchase');
select is((select f from _tt where row_key = '4D'), '6000.00/0.00/540.00/540.00', '4D ineligible: the other purchase');
select is((select f from _tt where row_key = 'books_output'), '0.00/28700.00/840.00/840.00', 'the ledger holds the output tax of the six invoices');
select is((select f from _tt where row_key = 'recon_output'), '0.00/0.00/-112.00/-112.00', 'documents less ledger = the credit notes, which no journal carries (fixtures)');
select is((select f from _tt where row_key = 'books_input'), '0.00/0.00/4550.00/4250.00', 'the ledger input tax: purchase 4,200 + RCM 50 + the 300 adjustment line');
select is((select f from _tt where row_key = 'recon_input'), '0.00/0.00/-300.00/0.00', 'ITC differs from the ledger by exactly the 300 adjustment (visible, not folded into RCM)');
select is((select count(*)::int from gstr3b_summary('2026-11-01') where row_key like '3.2:%'), 0, 'an empty month has no 3.2 rows');

-- ============================================================
-- The buyer's GSTIN is a snapshot taken when the document was posted
-- ============================================================
select is((select buyer_gstin from sales_invoices where id = 'd0000000-0000-4000-8000-000000000001'), '37ABCDE1234F1ZZ', 'the posted invoice carries the buyer GSTIN of that moment');
select is((select buyer_gstin from sales_invoices where id = 'd0000000-0000-4000-8000-000000000003'), null, 'a consumer sale carries none');
reset role;
update parties set gstin = null where id = 'a0000000-0000-4000-8000-000000000001';
update parties set gstin = '36ABCDE1234F1Z1' where id = 'a0000000-0000-4000-8000-000000000003' and false;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select jsonb_array_length(gstr1_data('2026-09-01') -> 'b2b') from (select 1) x), 2, 'removing the buyer''s GSTIN from the master later does not move the invoice out of b2b');
select is((select gstr1_data('2026-09-01') -> 'b2b' -> 1 ->> 'ctin' from (select 1) x), '37ABCDE1234F1ZZ', 'the filed return still shows the GSTIN it was posted with');
reset role;
-- a credit note to a consumer in another state, against a bill over the B2CL threshold, cannot be filed yet
insert into credit_notes (note_no, note_date, party_id, place_of_supply, status, against_invoice_id, taxable_total, igst_total, grand_total)
values ('CN/26-27/0005', '2026-12-05', 'a0000000-0000-4000-8000-000000000004', '36', 'posted', 'd0000000-0000-4000-8000-000000000005', 100000, 18000, 118000);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
select is((select gstr1_data('2026-12-01') -> 'warnings' from (select 1) x), '[{"key": "cdnur_not_supported", "count": 1}]'::jsonb, 'a credit note against a B2CL invoice is flagged as CDNUR, not netted into b2cs silently');

-- ============================================================
-- Statements as at a date / over a range
-- ============================================================
select is((select sum(total_debit) from trial_balance_asat('2026-12-31')), (select sum(total_credit) from trial_balance_asat('2026-12-31')), 'trial balance: total debits = total credits');
select is((select sum(closing) from trial_balance_asat('2026-12-31')), 0.00::numeric, 'and the closings net to zero');
select is((select closing from trial_balance_asat('2026-12-31') where code = (select code from accounts where system_key = 'ar')), (select sum(debit - credit) from journal_lines where account_id = (select id from accounts where system_key = 'ar')), 'AR closing = its ledger');
select is((select count(*)::int from trial_balance_asat('2026-08-30')), 0, 'as at a date before the first entry (31 August): no rows');
select cmp_ok((select count(*)::int from trial_balance_asat('2026-08-31')), '>', 0, 'the 31 August invoice shows on that date');
select is((select sum(p.amount) from pnl_range('2026-09-01', '2026-09-30') p where p.account_type = 'income') - (select coalesce(sum(p.amount), 0) from pnl_range('2026-09-01', '2026-09-30') p where p.account_type = 'expense'),
  (select sum(p.profit_effect) from pnl_range('2026-09-01', '2026-09-30') p), 'P&L: income - expense = the sum of profit effects');
select is((select sum(amount) from balance_sheet_asat('2026-12-31') where section = 'asset'),
  (select sum(amount) from balance_sheet_asat('2026-12-31') where section in ('liability', 'equity')), 'balance sheet: assets = liabilities + equity (including the profit row)');
select is((select count(*)::int from balance_sheet_asat('2026-12-31') where is_current_profit), 1, 'one not-yet-closed profit row');

-- ============================================================
-- Period locks
-- ============================================================
select throws_ok($$select set_period_lock('2026-09-15', true)$$, 'P0001', 'DN_VALIDATION:invalid_date', 'the month must be the first of the month');
select throws_ok($$select set_period_lock('2035-01-01', true)$$, 'P0001', 'DN_NO_PERIOD', 'a month with no period row is refused');
select is(set_period_lock('2026-09-01', true), true, 'the owner locks September');
select is(set_period_lock('2026-09-01', true), false, 'locking a locked month changes nothing');
select is((select count(*)::int from audit_log where entity = 'fiscal_periods' and action = 'lock'), 1, 'the lock is audited once');
insert into sales_invoices (id, invoice_date, party_id, place_of_supply, status, warehouse_id)
values ('d0000000-0000-4000-8000-000000000009', '2026-09-20', 'a0000000-0000-4000-8000-000000000003', '37', 'draft', (select id from warehouses where is_default and not is_transit));
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, qty, rate, taxable_value, gst_rate)
values ('d0000000-0000-4000-8000-000000000009', 1, 'c0000000-0000-4000-8000-000000000001', 'Cement 50kg', '2523', 'bag', 1, 400, 0, 28);
select throws_ok($$select post_sales_invoice('d0000000-0000-4000-8000-000000000009')$$, 'P0001', null, 'a locked month refuses posting');
select throws_ok($$select set_period_lock('2026-09-01', false)$$, 'P0001', 'DN_VALIDATION:reason_required', 'unlocking needs a reason');
select is(set_period_lock('2026-09-01', false, 'Filed the wrong month'), true, 'the owner unlocks with a reason');
select is((select after ->> 'reason' from audit_log where entity = 'fiscal_periods' and action = 'unlock'), 'Filed the wrong month', 'the reason is in the audit trail');
select is((select (before ->> 'is_locked')::bool from audit_log where entity = 'fiscal_periods' and action = 'unlock'), true, 'with the state before');
-- A filed (locked) month's documents cannot be cancelled later, even though the reversal would be dated in an open month
select is(set_period_lock('2026-08-01', true), true, 'the owner locks August');
select throws_ok($$select cancel_document('sales_invoice', 'd0000000-0000-4000-8000-000000000008', 'too late')$$, 'P0001', 'DN_PERIOD_LOCKED', 'the August invoice cannot be cancelled once August is locked');
select is((select status::text from sales_invoices where id = 'd0000000-0000-4000-8000-000000000008'), 'posted', 'and it is still posted');
select is(set_period_lock('2026-08-01', false, 'test done'), true, 'August unlocked again');
reset role;

-- ============================================================
-- Audit trail of master edits
-- ============================================================
select is((select count(*)::int from audit_log where entity = 'parties' and action = 'insert'), 6, 'the six parties inserted above were recorded');
create temp table _n as select count(*)::int as n from audit_log where entity = 'parties';
grant select on _n to authenticated;
insert into parties (id, name, type, state_code, monthly_salary) values ('a0000000-0000-4000-8000-000000000007', 'Test Employee', 'employee', '37', 12000);
select is((select after ? 'monthly_salary' from audit_log where entity = 'parties' and entity_id = 'a0000000-0000-4000-8000-000000000007'), false, 'an inserted employee''s pay is not in the audit row');
update parties set monthly_salary = 15000 where id = 'a0000000-0000-4000-8000-000000000007';
select is((select count(*)::int from audit_log where entity = 'parties'), (select n + 1 from _n), 'a pay-only change writes no audit row (only the insert above)');
update parties set name = 'P3 renamed', monthly_salary = 16000 where id = 'a0000000-0000-4000-8000-000000000007';
select is((select before from audit_log where entity = 'parties' and action = 'update' and entity_id = 'a0000000-0000-4000-8000-000000000007'), '{"name": "Test Employee"}'::jsonb, 'an update records only the changed column, before...');
select is((select after from audit_log where entity = 'parties' and action = 'update' and entity_id = 'a0000000-0000-4000-8000-000000000007'), '{"name": "P3 renamed"}'::jsonb, '...and after, never the pay columns');
select is((select count(*)::int from audit_log where (before ? 'monthly_salary' or after ? 'monthly_salary' or before ? 'daily_wage' or after ? 'daily_wage')), 0, 'no audit row anywhere carries a pay column');

set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}';
update items set sale_rate = 410 where id = 'c0000000-0000-4000-8000-000000000001';
select is((select actor from audit_log where entity = 'items' and action = 'update'), '33333333-3333-3333-3333-333333333333'::uuid, 'an item edit by the owner records who did it');
select is((select before || after from audit_log where entity = 'items' and action = 'update'), '{"sale_rate": 400.0000}'::jsonb || '{"sale_rate": 410.0000}'::jsonb, 'with the old and new rate');
select cmp_ok((select count(*)::int from audit_log where entity in ('parties', 'items')), '>', 0, 'the owner reads the master-edit rows');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from audit_log where entity in ('parties', 'party_addresses', 'items', 'organization', 'accounts', 'fiscal_periods')), 0, 'counter staff read none of the master-edit or period-lock rows');
select cmp_ok((select count(*)::int from audit_log), '>', 0, 'but still read the ordinary posting rows');
select is((select count(*)::int from trial_balance_asat('2026-12-31')), 0, 'counter staff get no trial balance rows');
select is((select count(*)::int from balance_sheet_asat('2026-12-31')), 0, 'nor balance sheet rows');
reset role;

select * from finish();
rollback;
