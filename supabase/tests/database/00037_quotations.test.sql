-- Change 24a (quotations), DB half: quotations + quotation_lines, v_quotations / v_quotation_lines,
-- save_quotation, mark_quotation, convert_quotation_to_invoice.
--
-- Must pass:
--  * a counter user creates a quote; name / HSN / UOM / GST are snapshotted from items (client
--    values ignored); the QT number is assigned at first save, per FY
--  * quote totals equal what post_sales_invoice computes for the same lines, intra- and
--    inter-state (header totals, round-off and every line)
--  * a counter user converts; the draft invoice carries the quoted lines/rates and the derived
--    place of supply; a repeat convert returns the same invoice and creates nothing
--  * a converted quote is immutable; an expired quote cannot convert or be accepted
--  * inactive item / party refused (at save and at convert); stale write refused (DN_CONFLICT)
--  * non-member and owner below aal2 see nothing and can do nothing; no direct DML; anon has no
--    EXECUTE; no journal entry or stock movement is ever written by a quote
--  * deleting the draft invoice re-opens the quote as accepted
begin;

create extension if not exists pgtap with schema extensions;

select plan(178);

-- ============================================================
-- Fixtures (database owner)
-- ============================================================
insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'staff@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'stranger@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'former@example.test');
insert into app_users (user_id, role, name, is_active, email) values
  ('33333333-3333-3333-3333-333333333333', 'admin', 'Test Admin', true, 'admin@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'user', 'Test Staff', true, 'staff@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'user', 'Former Staff', false, 'former@example.test');

insert into items (id, name, category, hsn_code, gst_rate, base_uom, sale_rate, alt_uom, conversion_factor, is_active) values
  ('10000000-0000-0000-0000-0000000000c1', 'UltraTech Cement 50kg', 'cement', '2523', 28, 'bag', 360, null, null, true),
  ('10000000-0000-0000-0000-0000000000c2', '12mm TMT Bar', 'steel', '7214', 18, 'kg', 58, 'pc', 10.5, true),
  ('10000000-0000-0000-0000-0000000000c3', 'Old Cement', 'cement', '2523', 28, 'bag', 300, null, null, false),
  ('10000000-0000-0000-0000-0000000000c4', 'Binding Wire', 'steel', '7217', 18, 'kg', 80, null, null, true),
  ('10000000-0000-0000-0000-0000000000c5', 'River Sand', 'other', '2505', 0, 'cft', 1, null, null, true);

insert into parties (id, name, type, state_code, credit_limit)
select 'a0000000-0000-0000-0000-000000000001', 'Local Builder', 'customer', state_code, null from organization;
insert into parties (id, name, type, state_code, credit_limit) values
  ('a0000000-0000-0000-0000-000000000002', 'Telangana Builder', 'customer', '36', null),
  ('a0000000-0000-0000-0000-000000000003', 'Cement Supplier', 'supplier', '37', null),
  ('a0000000-0000-0000-0000-000000000004', 'Gone Customer', 'customer', '37', null);
update parties set is_active = false where id = 'a0000000-0000-0000-0000-000000000004';
insert into party_addresses (party_id, label, address, state_code, is_default) values
  ('a0000000-0000-0000-0000-000000000002', 'Office',
   '{"line1":"1 Main Road","city":"Hyderabad","pincode":"500001"}', '36', true);
-- A party billed in the organisation's state whose default delivery site is in Telangana, and a
-- party with no addresses (its place of supply changes later).
insert into parties (id, name, type, state_code, credit_limit)
select 'a0000000-0000-0000-0000-000000000005', 'Site Builder', 'customer', state_code, null from organization;
insert into parties (id, name, type, state_code, credit_limit)
select 'a0000000-0000-0000-0000-000000000006', 'Moving Builder', 'customer', state_code, null from organization;
insert into party_addresses (id, party_id, label, address, state_code, is_default)
select 'ad000000-0000-0000-0000-000000000051', 'a0000000-0000-0000-0000-000000000005', 'Head office',
       '{"line1":"2 Ring Road","city":"Vijayawada","pincode":"520001"}', state_code, true from organization;
insert into party_addresses (id, party_id, label, address, state_code, is_default) values
  ('ad000000-0000-0000-0000-000000000052', 'a0000000-0000-0000-0000-000000000005', 'Hyderabad site',
   '{"line1":"Plot 9","city":"Hyderabad","pincode":"500081"}', '36', false);
update parties set default_site_id = 'ad000000-0000-0000-0000-000000000052' where id = 'a0000000-0000-0000-0000-000000000005';

-- Opening stock so the converted invoices can be posted (cost basis present).
insert into stock_movements (item_id, warehouse_id, movement_date, qty, rate, value, source_type)
select i, (select id from warehouses where is_default and not is_transit), '2026-04-05', q, r, q * r, 'opening'
from (values ('10000000-0000-0000-0000-0000000000c1'::uuid, 1000, 300),
             ('10000000-0000-0000-0000-0000000000c2'::uuid, 5000, 45)) v(i, q, r);

create function _as_counter() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal2"}', true) $$;
create function _as_owner_aal1() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_stranger() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated","aal":"aal1"}', true) $$;
create function _as_former() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated","aal":"aal1"}', true) $$;
create function _today() returns date language sql as $$
  select (now() at time zone (select timezone from organization limit 1))::date $$;
-- The latest 1 April on or before today, and the day before it (both within the last 365 days).
create function _d_apr() returns date language sql as $$
  select make_date(extract(year from _today())::int - case when extract(month from _today()) < 4 then 1 else 0 end, 4, 1) $$;
create function _d_mar() returns date language sql as $$ select _d_apr() - 1 $$;
create function _fy_prefix(d date) returns text language sql as $$
  select 'QT/' || lpad((y % 100)::text, 2, '0') || '-' || lpad(((y + 1) % 100)::text, 2, '0') || '/'
  from (select extract(year from d)::int - case when extract(month from d) < 4 then 1 else 0 end as y) s $$;
-- The two-line quote used throughout (client junk in name / gst_rate must be ignored).
create function _lines() returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c1', 'qty', 100, 'rate', 360,
                       'item_name', 'HACKED', 'gst_rate', 0, 'hsn_code', '0000'),
    jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c2', 'qty', '500.5', 'rate', '58.25',
                       'discount_pct', 2.5, 'alt_qty', 48)) $$;
create function _one_line(p_item text, p_qty text, p_rate text, p_disc text default '0') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('item_id', p_item, 'qty', p_qty, 'rate', p_rate, 'discount_pct', p_disc)) $$;
grant execute on function _as_counter(), _as_owner(), _as_owner_aal1(), _as_stranger(), _as_former(),
  _today(), _d_apr(), _d_mar(), _fy_prefix(date), _lines(), _one_line(text, text, text, text) to authenticated;

create temp table _k (k text primary key, v text);
grant select, insert, update on _k to authenticated;
create function _id(p text) returns uuid language sql as $$ select (v->>'id')::uuid from (select v::jsonb from _k where k = p) s $$;
create function _upd(p text) returns timestamptz language sql as $$ select (v::jsonb->>'updated_at')::timestamptz from _k where k = p $$;
grant execute on function _id(text), _upd(text) to authenticated;

create temp table _base as
select (select count(*) from journal_entries) as je, (select count(*) from stock_movements) as sm,
       (select count(*) from sales_invoices) as si;
grant select on _base to authenticated;

-- ============================================================
-- Shape and privileges
-- ============================================================
select has_table('public', 'quotations', 'quotations exists');
select has_table('public', 'quotation_lines', 'quotation_lines exists');
select has_view('public', 'v_quotations', 'v_quotations exists');
select has_view('public', 'v_quotation_lines', 'v_quotation_lines exists');
select ok((select relrowsecurity from pg_class where oid = 'public.quotations'::regclass), 'RLS on quotations');
select ok((select relrowsecurity from pg_class where oid = 'public.quotation_lines'::regclass), 'RLS on quotation_lines');
select has_trigger('public', 'quotations', 'set_created_by', 'quotations stamps created_by');
select ok(not has_function_privilege('anon', 'public.save_quotation(uuid, timestamptz, uuid, date, date, text, jsonb)', 'EXECUTE'),
          'anon cannot execute save_quotation');
select ok(not has_function_privilege('anon', 'public.mark_quotation(uuid, text)', 'EXECUTE'), 'anon cannot execute mark_quotation');
select ok(not has_function_privilege('anon', 'public.convert_quotation_to_invoice(uuid)', 'EXECUTE'),
          'anon cannot execute convert_quotation_to_invoice');
select ok(has_function_privilege('authenticated', 'public.convert_quotation_to_invoice(uuid)', 'EXECUTE'),
          'authenticated can execute convert_quotation_to_invoice');
select ok(not has_table_privilege('authenticated', 'public.quotations', 'INSERT')
          and not has_table_privilege('authenticated', 'public.quotations', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.quotations', 'DELETE'),
          'the app has no direct write on quotations');
select ok(not has_table_privilege('authenticated', 'public.quotation_lines', 'INSERT')
          and not has_table_privilege('authenticated', 'public.quotation_lines', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.quotation_lines', 'DELETE'),
          'the app has no direct write on quotation_lines');
select is((select count(*)::int from doc_sequences where fy_label = '2026-27'), 10,
          'no QT row is seeded (the series is created at the first save of each FY)');

-- ============================================================
-- Create (counter user, intra-state)
-- ============================================================
set local role authenticated;
select _as_counter();
select lives_ok(
  $$insert into _k values ('q1', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(),
       _today() + 10, '  Rates for 100 bags + TMT  ', _lines())::text)$$,
  'a counter user creates a quote');
select is((select quote_no from quotations where id = _id('q1')), _fy_prefix(_today()) || '0001',
          'the first quote of the FY is QT/yy-yy/0001, assigned at the first save');
select is((select v::jsonb->>'quote_no' from _k where k = 'q1'), _fy_prefix(_today()) || '0001',
          'save_quotation returns the number');
select is((select updated_at from quotations where id = _id('q1')), _upd('q1'), 'and the updated_at to send back on the next edit');
select is((select status from quotations where id = _id('q1')), 'open', 'a new quote is open');
select is((select created_by from quotations where id = _id('q1')), '44444444-4444-4444-4444-444444444444'::uuid,
          'created_by is the counter user');
select is((select note from quotations where id = _id('q1')), 'Rates for 100 bags + TMT', 'the note is trimmed');
select is((select place_of_supply::text from quotations where id = _id('q1')), (select state_code::text from organization),
          'place of supply: the party''s own state (no default address)');
select is((select warehouse_id from quotations where id = _id('q1')),
          (select id from warehouses where is_default and not is_transit), 'the default sales warehouse');
select is((select item_name || '|' || hsn_code || '|' || uom || '|' || gst_rate from quotation_lines where quote_id = _id('q1') and line_no = 1),
          'UltraTech Cement 50kg|2523|bag|28.00', 'line 1 snapshots name / HSN / UOM / GST from items, not the client''s');
select is((select qty || '|' || alt_qty || '|' || rate || '|' || discount_pct from quotation_lines where quote_id = _id('q1') and line_no = 2),
          '500.500|48.000|58.2500|2.50', 'line 2 keeps qty, pieces, rate and discount as quoted');
select is((select alt_qty from quotation_lines where quote_id = _id('q1') and line_no = 1), null,
          'pieces are dropped for an item without an alternate unit');
select is((select count(*)::int from v_quotations where id = _id('q1')), 1, 'the counter user reads the quote in v_quotations');

-- Worked totals: cement 100 x 360 = 36,000 @28%; TMT 500.5 x 58.25 x 0.975 = 28,425.27 @18%.
select is((select taxable_total from v_quotations where id = _id('q1')), 64425.27::numeric, 'taxable 64,425.27');
select is((select cgst_total from v_quotations where id = _id('q1')), 7598.27::numeric, 'CGST 5,040 + 2,558.27');
select is((select sgst_total from v_quotations where id = _id('q1')), 7598.27::numeric, 'SGST equals CGST');
select is((select igst_total from v_quotations where id = _id('q1')), 0.00::numeric, 'no IGST intra-state');
select is((select round_off from v_quotations where id = _id('q1')), 0.19::numeric, 'round-off +0.19 (79,621.81 -> 79,622)');
select is((select grand_total from v_quotations where id = _id('q1')), 79622.00::numeric, 'grand total rounded to the rupee');
select ok((select is_intra from v_quotations where id = _id('q1')), 'is_intra');
select is((select effective_status from v_quotations where id = _id('q1')), 'open', 'effective status open');

-- ============================================================
-- Inter-state quote (owner); default address in Telangana
-- ============================================================
select _as_owner();
select lives_ok(
  $$insert into _k values ('q2', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000002', _today(),
       _today() + 5, null, _lines())::text)$$,
  'the owner creates an inter-state quote');
select is((select quote_no from quotations where id = _id('q2')), _fy_prefix(_today()) || '0002', 'numbers run on: 0002');
select is((select place_of_supply::text from quotations where id = _id('q2')), '36', 'place of supply: the default address''s state');
select is((select igst_total from v_quotations where id = _id('q2')), 15196.55::numeric, 'IGST 10,080 + 5,116.55 (rounded per line)');
select is((select cgst_total + sgst_total from v_quotations where id = _id('q2')), 0.00::numeric, 'no CGST/SGST inter-state');
select ok(not (select is_intra from v_quotations where id = _id('q2')), 'not intra');

-- ============================================================
-- Refusals on save
-- ============================================================
select _as_counter();
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000003', _today(), null, null, _lines())$$,
  'P0001', 'DN_VALIDATION:invalid_party', 'a supplier cannot be quoted');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000004', _today(), null, null, _lines())$$,
  'P0001', 'DN_VALIDATION:invalid_party', 'an inactive customer cannot be quoted');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c3', '1', '300'))$$,
  'P0001', 'DN_VALIDATION:item_inactive', 'an inactive item is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000ff', '1', '300'))$$,
  'P0001', 'DN_VALIDATION:no_such_item', 'an unknown item is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today() + 1, null, null, _lines())$$,
  'P0001', 'DN_VALIDATION:future_date', 'a future quote date is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), _today() - 1, null, _lines())$$,
  'P0001', 'DN_VALIDATION:valid_until_before_date', 'valid until before the quote date is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), _today() + 400, null, _lines())$$,
  'P0001', 'DN_VALIDATION:valid_until_too_far', 'validity over a year is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, repeat('x', 501), _lines())$$,
  'P0001', 'DN_VALIDATION:note_too_long', 'a note over 500 characters is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null, '[]')$$,
  'P0001', 'DN_VALIDATION:no_lines', 'no lines is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '-1', '300'))$$,
  'P0001', 'DN_VALIDATION:invalid_qty', 'a negative qty is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '1.2345', '300'))$$,
  'P0001', 'DN_VALIDATION:invalid_qty', 'a qty with four decimals is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '1', '1.23456'))$$,
  'P0001', 'DN_VALIDATION:invalid_rate', 'a rate with five decimals is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '1', '300', '101'))$$,
  'P0001', 'DN_VALIDATION:invalid_discount', 'a discount over 100% is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '1', '0'))$$,
  'P0001', 'DN_VALIDATION:zero_total', 'a zero-value quote is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c5', '0.4', '1'))$$,
  'P0001', 'DN_VALIDATION:zero_total', 'a grand total that rounds to zero (0.4 x 1 at 0%) is refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c1', '999999999.999', '9999999999.9999'))$$,
  'P0001', 'DN_VALIDATION:amount_too_large', 'the largest qty x the largest rate is refused (no overflow)');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    jsonb_build_array(
      jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c4', 'qty', '500000000', 'rate', '1000'),
      jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c4', 'qty', '500000000', 'rate', '1000')))$$,
  'P0001', 'DN_VALIDATION:amount_too_large', 'lines each under the cap whose grand total reaches 10^12 are refused');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today() - 366, _today(), null, _lines())$$,
  'P0001', 'DN_VALIDATION:invalid_date', 'a quote dated more than a year back is refused');
select is((select count(*)::int from quotations), 2, 'no refused save left a row behind');

-- Default validity: a week.
select lives_ok(
  $$insert into _k values ('q3', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
       _one_line('10000000-0000-0000-0000-0000000000c4', '10', '80'))::text)$$,
  'a quote without a validity date saves');
select is((select valid_until - quote_date from quotations where id = _id('q3')), 7, 'and is valid for 7 days');

-- ============================================================
-- Edit and stale write
-- ============================================================
select throws_ok($$select save_quotation(_id('q3'), _upd('q3') - interval '1 second', 'a0000000-0000-0000-0000-000000000001',
    _today(), null, null, _one_line('10000000-0000-0000-0000-0000000000c4', '12', '80'))$$,
  'P0001', 'DN_CONFLICT', 'an edit carrying an old updated_at is refused');
select throws_ok($$select save_quotation(_id('q3'), null, 'a0000000-0000-0000-0000-000000000001',
    _today(), null, null, _one_line('10000000-0000-0000-0000-0000000000c4', '12', '80'))$$,
  'P0001', 'DN_CONFLICT', 'an edit without updated_at is refused');
select lives_ok(
  $$update _k set v = save_quotation(_id('q3'), _upd('q3'), 'a0000000-0000-0000-0000-000000000001', _today(), _today() + 3,
       'second', jsonb_build_array(
         jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c4', 'qty', 12, 'rate', 79.5),
         jsonb_build_object('item_id', '10000000-0000-0000-0000-0000000000c1', 'qty', 5, 'rate', 355)))::text
     where k = 'q3'$$,
  'an edit with the current updated_at saves');
select is((select count(*)::int from quotation_lines where quote_id = _id('q3')), 2, 'the lines were replaced (now two)');
select is((select quote_no from quotations where id = _id('q3')), _fy_prefix(_today()) || '0003', 'the number did not change on edit');
select is((select updated_at from quotations where id = _id('q3')), _upd('q3'), 'the new updated_at is returned');
select throws_ok($$select save_quotation(_id('q3'), _upd('q3'), 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
    _one_line('10000000-0000-0000-0000-0000000000c3', '1', '300'))$$,
  'P0001', 'DN_VALIDATION:item_inactive', 'an edit adding an inactive item is refused');
select is((select count(*)::int from quotation_lines where quote_id = _id('q3')), 2, 'and the refused edit changed nothing');

-- ============================================================
-- Numbering per FY
-- ============================================================
select lives_ok(
  $$insert into _k values ('qold', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _d_mar(), _d_mar(), null,
       _one_line('10000000-0000-0000-0000-0000000000c4', '1', '80'))::text)$$,
  'a quote dated 31 March (previous FY) saves');
select is((select quote_no from quotations where id = _id('qold')), _fy_prefix(_d_mar()) || '0001',
          '31 March opens the previous FY''s QT series at 0001');
select lives_ok(
  $$insert into _k values ('qapr', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _d_apr(), _d_apr(), null,
       _one_line('10000000-0000-0000-0000-0000000000c4', '1', '80'))::text)$$,
  'a quote dated 1 April saves');
select is((select quote_no from quotations where id = _id('qapr')), _fy_prefix(_today()) || '0004',
          '1 April continues the current FY''s series (0004 after three quotes)');
select isnt(_fy_prefix(_d_mar()), _fy_prefix(_d_apr()), 'sanity: 31 March and 1 April are in different FYs');
select is((select count(*)::int from doc_sequences where series = 'QT'), 2, 'one QT row per FY used');
select is((select doc_type::text from doc_sequences where series = 'QT' and prefix = _fy_prefix(_d_mar())), 'quotation',
          'with doc_type quotation');
select throws_ok($$select save_quotation(_id('qold'), (select updated_at from quotations where id = _id('qold')),
    'a0000000-0000-0000-0000-000000000001', _d_apr(), _d_apr(), null,
    _one_line('10000000-0000-0000-0000-0000000000c4', '1', '80'))$$,
  'P0001', 'DN_VALIDATION:quote_fy_change', 'an edit moving 31 March to 1 April is refused');
select throws_ok($$select save_quotation(_id('qapr'), (select updated_at from quotations where id = _id('qapr')),
    'a0000000-0000-0000-0000-000000000001', _d_mar(), _d_mar(), null,
    _one_line('10000000-0000-0000-0000-0000000000c4', '1', '80'))$$,
  'P0001', 'DN_VALIDATION:quote_fy_change', 'an edit moving 1 April to 31 March is refused');
select is((select effective_status from v_quotations where id = _id('qold')), 'expired',
          'a quote whose validity has passed reads as expired');
select is((select status from quotations where id = _id('qold')), 'open', 'while its stored status is still open (no job)');

-- ============================================================
-- Non-members
-- ============================================================
select _as_stranger();
select is((select count(*)::int from quotations), 0, 'a non-member reads no quotations');
select is((select count(*)::int from quotation_lines), 0, 'a non-member reads no quote lines');
select is((select count(*)::int from v_quotations), 0, 'a non-member reads nothing from v_quotations');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null, _lines())$$,
  'P0001', 'DN_FORBIDDEN', 'a non-member cannot save');
select throws_ok($$select convert_quotation_to_invoice(_id('q1'))$$, 'P0001', 'DN_FORBIDDEN', 'a non-member cannot convert');
select throws_ok($$select mark_quotation(_id('q1'), 'accepted')$$, 'P0001', 'DN_FORBIDDEN', 'a non-member cannot mark');
select _as_former();
select is((select count(*)::int from quotations), 0, 'a deactivated user reads nothing');
select throws_ok($$select save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null, _lines())$$,
  'P0001', 'DN_FORBIDDEN', 'a deactivated user cannot save');
select _as_owner_aal1();
select is((select count(*)::int from quotations), 0, 'an owner below aal2 reads nothing');
select throws_ok($$select convert_quotation_to_invoice(_id('q1'))$$, 'P0001', 'DN_FORBIDDEN', 'an owner below aal2 cannot convert');

-- Direct DML refused even for a member.
select _as_counter();
select throws_ok($$insert into quotations (quote_no, quote_date, party_id, warehouse_id, place_of_supply, valid_until)
    values ('QT/X/1', current_date, 'a0000000-0000-0000-0000-000000000001', (select warehouse_id from quotations limit 1), '37', current_date)$$,
  '42501', null, 'a member cannot insert a quote directly');
select throws_ok($$update quotations set note = 'x' where id = _id('q1')$$, '42501', null, 'a member cannot update a quote directly');
select throws_ok($$update quotation_lines set rate = 1 where quote_id = _id('q1')$$, '42501', null, 'a member cannot change a quoted rate directly');
select throws_ok($$delete from quotations where id = _id('q1')$$, '42501', null, 'a member cannot delete a quote');

-- ============================================================
-- Mark
-- ============================================================
select throws_ok($$select mark_quotation(_id('q2'), 'converted')$$, 'P0001', 'DN_VALIDATION:invalid_status', 'nobody marks converted by hand');
select throws_ok($$select mark_quotation(_id('q2'), 'bogus')$$, 'P0001', 'DN_VALIDATION:invalid_status', 'an unknown status is refused');
select lives_ok($$select mark_quotation(_id('q2'), 'accepted')$$, 'open -> accepted');
select is((select status from quotations where id = _id('q2')), 'accepted', 'the quote is accepted');
select lives_ok($$select mark_quotation(_id('q2'), 'accepted')$$, 'the same status again is a no-op');
select lives_ok($$select mark_quotation(_id('q2'), 'open')$$, 'accepted -> open');
select lives_ok($$select mark_quotation(_id('q2'), 'accepted')$$, 'open -> accepted again');
select throws_ok($$select save_quotation(_id('q2'), (select updated_at from quotations where id = _id('q2')),
    'a0000000-0000-0000-0000-000000000002', _today(), null, null, _lines())$$,
  'P0001', 'DN_VALIDATION:quote_not_open', 'an accepted quote is not edited (re-open it first)');
select throws_ok($$select mark_quotation(_id('qold'), 'accepted')$$, 'P0001', 'DN_VALIDATION:quote_expired',
  'a quote past its validity cannot be accepted');
select lives_ok($$select mark_quotation(_id('qold'), 'expired')$$, 'but it can be marked expired');
select throws_ok($$select mark_quotation(_id('qold'), 'open')$$, 'P0001', 'DN_VALIDATION:invalid_transition', 'expired is final');
select is((select count(*)::int from audit_log where entity = 'quotations' and entity_id = _id('q2') and action = 'mark'), 3,
          'each real status change is audited (the no-op is not)');
select lives_ok(
  $$insert into _k values ('q7', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
       _one_line('10000000-0000-0000-0000-0000000000c4', '2', '80'))::text)$$,
  'q7 saves');
select lives_ok($$select mark_quotation(_id('q7'), 'accepted')$$, 'q7 accepted');
reset role;
select _as_owner();
update quotations set quote_date = _today() - 10, valid_until = _today() - 5 where id = _id('q7');
set local role authenticated;
select _as_counter();
select lives_ok($$select mark_quotation(_id('q7'), 'open')$$, 'accepted -> open is allowed after the validity passed');
select throws_ok($$select mark_quotation(_id('q7'), 'accepted')$$, 'P0001', 'DN_VALIDATION:quote_expired',
  'but accepting it again is not');
select lives_ok($$select save_quotation(_id('q7'), (select updated_at from quotations where id = _id('q7')),
    'a0000000-0000-0000-0000-000000000001', _today(), _today() + 5, null, _one_line('10000000-0000-0000-0000-0000000000c4', '2', '80'))$$,
  'the re-opened quote is renewed by an edit');
select lives_ok($$select mark_quotation(_id('q7'), 'accepted')$$, 'and can then be accepted');

-- ============================================================
-- Convert (counter user, intra-state) and idempotency
-- ============================================================
select lives_ok($$insert into _k values ('inv1', jsonb_build_object('id', convert_quotation_to_invoice(_id('q1')))::text)$$,
  'a counter user converts an open quote');
select is((select status from quotations where id = _id('q1')), 'converted', 'the quote is converted');
select is((select converted_invoice_id from quotations where id = _id('q1')), _id('inv1'), 'and points at the new invoice');
select is((select status::text from sales_invoices where id = _id('inv1')), 'draft', 'the invoice is a draft');
select is((select invoice_no from sales_invoices where id = _id('inv1')), null, 'with no GST invoice number yet');
select is((select invoice_date from sales_invoices where id = _id('inv1')), _today(), 'dated today');
select is((select created_by from sales_invoices where id = _id('inv1')), '44444444-4444-4444-4444-444444444444'::uuid,
          'created by the converting user');
select is((select party_id from sales_invoices where id = _id('inv1')), 'a0000000-0000-0000-0000-000000000001'::uuid, 'for the quoted party');
select is((select place_of_supply::text from sales_invoices where id = _id('inv1')), (select state_code::text from organization),
          'place of supply derived (party state)');
select is((select warehouse_id from sales_invoices where id = _id('inv1')), (select warehouse_id from quotations where id = _id('q1')),
          'from the quote''s warehouse');
select results_eq(
  $$select line_no, item_id, qty, alt_qty, rate, discount_pct from sales_invoice_lines where invoice_id = _id('inv1') order by line_no$$,
  $$select line_no, item_id, qty, alt_qty, rate, discount_pct from quotation_lines where quote_id = _id('q1') order by line_no$$,
  'the invoice lines are the quoted lines: qty, pieces, rate, discount');
select is((select string_agg(item_name || '|' || uom || '|' || gst_rate, ',' order by line_no) from sales_invoice_lines where invoice_id = _id('inv1')),
          'UltraTech Cement 50kg|bag|28.00,12mm TMT Bar|kg|18.00', 'the invoice lines carry the item snapshot');
select is(convert_quotation_to_invoice(_id('q1')), _id('inv1'), 'a second convert returns the same invoice');
select is((select count(*)::int from sales_invoices), (select si::int + 1 from _base), 'and exactly one invoice exists');

-- Converted quote is immutable.
select throws_ok($$select save_quotation(_id('q1'), (select updated_at from quotations where id = _id('q1')),
    'a0000000-0000-0000-0000-000000000001', _today(), null, null, _lines())$$,
  'P0001', 'DN_VALIDATION:quote_not_open', 'a converted quote cannot be edited');
select throws_ok($$select mark_quotation(_id('q1'), 'open')$$, 'P0001', 'DN_VALIDATION:quote_converted', 'nor re-opened by hand');
select throws_ok($$select mark_quotation(_id('q1'), 'expired')$$, 'P0001', 'DN_VALIDATION:quote_converted', 'nor expired');
reset role;
select throws_ok($$update quotations set note = 'x' where id = _id('q1')$$, 'P0001', 'DN_VALIDATION:quote_converted',
  'even the database owner cannot change a converted quote');
select throws_ok($$update quotation_lines set rate = 1 where quote_id = _id('q1')$$, 'P0001', 'DN_VALIDATION:quote_not_open',
  'nor its lines');
select throws_ok($$delete from quotations where id = _id('qold')$$, 'P0001', 'DN_VALIDATION:quote_no_delete',
  'no quote is ever deleted, even by the database owner');

-- ============================================================
-- Expired and inactive at convert
-- ============================================================
set local role authenticated;
select _as_counter();
select throws_ok($$select convert_quotation_to_invoice(_id('qold'))$$, 'P0001', 'DN_VALIDATION:quote_expired',
  'an expired quote cannot convert');
reset role;
-- A quote stored open whose validity passed: date-expired, not marked.
select lives_ok($$update quotations set quote_date = '2026-05-01', valid_until = '2026-05-03' where id = _id('q3')$$,
  'fixture: back-date q3 so it is past its validity');
set local role authenticated;
select _as_counter();
select is((select effective_status from v_quotations where id = _id('q3')), 'expired', 'q3 reads as expired');
select throws_ok($$select convert_quotation_to_invoice(_id('q3'))$$, 'P0001', 'DN_VALIDATION:quote_expired',
  'a quote past its validity cannot convert even while stored open');
select lives_ok(
  $$insert into _k values ('q4', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000001', _today(), null, null,
       _one_line('10000000-0000-0000-0000-0000000000c4', '3', '80'))::text)$$,
  'another quote for binding wire');
reset role;
update items set is_active = false where id = '10000000-0000-0000-0000-0000000000c4';
set local role authenticated;
select _as_counter();
select throws_ok($$select convert_quotation_to_invoice(_id('q4'))$$, 'P0001', 'DN_VALIDATION:item_inactive',
  'an item deactivated since the quote is refused at convert');
reset role;
select _as_owner();
update items set is_active = true where id = '10000000-0000-0000-0000-0000000000c4';
update parties set is_active = false where id = 'a0000000-0000-0000-0000-000000000001';
set local role authenticated;
select _as_counter();
select throws_ok($$select convert_quotation_to_invoice(_id('q4'))$$, 'P0001', 'DN_VALIDATION:invalid_party',
  'a party deactivated since the quote is refused at convert');
select is((select status from quotations where id = _id('q4')), 'open', 'the refused convert left the quote open');
reset role;
select _as_owner();
update parties set is_active = true where id = 'a0000000-0000-0000-0000-000000000001';

-- ============================================================
-- Convert the inter-state (accepted) quote as the owner
-- ============================================================
set local role authenticated;
select _as_owner();
select lives_ok($$insert into _k values ('inv2', jsonb_build_object('id', convert_quotation_to_invoice(_id('q2')))::text)$$,
  'the owner converts an accepted quote');
select is((select place_of_supply::text from sales_invoices where id = _id('inv2')), '36', 'inter-state place of supply on the draft');
select is((select billing_address->>'state_code' || '|' || (billing_address->>'city') || '|' || (shipping_address = billing_address)::text
           from sales_invoices where id = _id('inv2')),
          '36|Hyderabad|true', 'billing = shipping = the default address snapshot');
select is((select billing_address from sales_invoices where id = _id('inv1')), null, 'no default address: no billing snapshot');

-- Nothing posted by any quote operation.
select is((select count(*) from journal_entries), (select je from _base), 'no journal entry was written by quotes');
select is((select count(*) from stock_movements), (select sm from _base), 'no stock movement was written by quotes');

-- ============================================================
-- Totals: the posted invoice equals the quote (intra and inter)
-- ============================================================
reset role;
-- Date the drafts into an open period that has the opening stock (the draft is client-editable).
update sales_invoices set invoice_date = '2026-06-10' where id in (_id('inv1'), _id('inv2'));
set local role authenticated;
select _as_owner();
select lives_ok($$select post_sales_invoice(_id('inv1'))$$, 'the converted intra-state invoice posts through the normal flow');
select lives_ok($$select post_sales_invoice(_id('inv2'))$$, 'the converted inter-state invoice posts');
select is(
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from sales_invoices where id = _id('inv1')),
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from v_quotations where id = _id('q1')),
  'intra-state: posted totals = quote totals (taxable, CGST, SGST, IGST, round-off, grand)');
select is(
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from sales_invoices where id = _id('inv2')),
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from v_quotations where id = _id('q2')),
  'inter-state: posted totals = quote totals');
select results_eq(
  $$select line_no, taxable_value, cgst_amt, sgst_amt, igst_amt from sales_invoice_lines where invoice_id = _id('inv1') order by line_no$$,
  $$select line_no, taxable_value, cgst_amt, sgst_amt, igst_amt from v_quotation_lines where quote_id = _id('q1') order by line_no$$,
  'intra-state: every line''s amounts match');
select results_eq(
  $$select line_no, taxable_value, cgst_amt, sgst_amt, igst_amt from sales_invoice_lines where invoice_id = _id('inv2') order by line_no$$,
  $$select line_no, taxable_value, cgst_amt, sgst_amt, igst_amt from v_quotation_lines where quote_id = _id('q2') order by line_no$$,
  'inter-state: every line''s amounts match');
select is((select converted_invoice_no from v_quotations where id = _id('q1')),
          (select invoice_no from sales_invoices where id = _id('inv1')), 'the quote shows the posted invoice number');
select is((select status from quotations where id = _id('q1')), 'converted', 'the quote stays converted after posting');
select is((select count(*)::int from journal_entries where source_type = 'quotation'), 0, 'no entry is ever sourced from a quotation');

-- ============================================================
-- Deleting the draft re-opens the quote
-- ============================================================
select _as_counter();
select lives_ok($$insert into _k values ('inv4', jsonb_build_object('id', convert_quotation_to_invoice(_id('q4')))::text)$$,
  'q4 converts');
select lives_ok($$delete from sales_invoices where id = _id('inv4')$$, 'the counter user deletes the draft invoice');
select is((select status || '|' || coalesce(converted_invoice_id::text, '-') from quotations where id = _id('q4')), 'accepted|-',
          'the quote is accepted again with no invoice');
reset role;
select is((select count(*)::int from audit_log where entity = 'quotations' and entity_id = _id('q4') and action = 'reopen'), 1,
          'the re-open is audited');
set local role authenticated;
select _as_counter();
select isnt(convert_quotation_to_invoice(_id('q4')), _id('inv4'), 'and it converts again into a new draft');


-- ============================================================
-- Default delivery site decides the place of supply (review fix 1)
-- ============================================================
select lives_ok(
  $$insert into _k values ('q5', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000005', _today(), null, null, _lines())::text)$$,
  'a quote for a party billed at home with a Telangana delivery site saves');
select is((select place_of_supply::text from quotations where id = _id('q5')), '36', 'place of supply is the default site''s state');
select ok(not (select is_intra from v_quotations where id = _id('q5')), 'so the quote is inter-state');
select is((select igst_total from v_quotations where id = _id('q5')), 15196.55::numeric, 'and charges IGST');
select lives_ok($$insert into _k values ('inv5', jsonb_build_object('id', convert_quotation_to_invoice(_id('q5')))::text)$$,
  'it converts');
select is((select place_of_supply || '|' || (billing_address->>'state_code') || '|' || (shipping_address->>'state_code')
             || '|' || (shipping_address->>'label') from sales_invoices where id = _id('inv5')),
          '36|' || (select state_code from organization) || '|36|Hyderabad site',
          'the draft: place of supply 36, billing = head office, shipping = the default site');
reset role;
select _as_owner();
-- The same invoice made by hand the way the invoice form would (site chosen), as a control.
insert into sales_invoices (id, invoice_date, party_id, warehouse_id, place_of_supply, billing_address, shipping_address, status)
select 'd0000000-0000-0000-0000-0000000000a5', '2026-06-10', party_id, warehouse_id, place_of_supply, billing_address,
       shipping_address, 'draft'
from sales_invoices where id = _id('inv5');
insert into sales_invoice_lines (invoice_id, line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct)
select 'd0000000-0000-0000-0000-0000000000a5', line_no, item_id, item_name, hsn_code, uom, gst_rate, qty, alt_qty, rate, discount_pct
from quotation_lines where quote_id = _id('q5');
update sales_invoices set invoice_date = '2026-06-10' where id = _id('inv5');
set local role authenticated;
select _as_owner();
select lives_ok($$select post_sales_invoice(_id('inv5'))$$, 'the converted site invoice posts');
select lives_ok($$select post_sales_invoice('d0000000-0000-0000-0000-0000000000a5')$$, 'the hand-made control posts');
select is(
  (select (place_of_supply, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from sales_invoices where id = _id('inv5')),
  (select (place_of_supply, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from sales_invoices where id = 'd0000000-0000-0000-0000-0000000000a5'),
  'converted invoice = hand-made invoice (place of supply and every total)');
select is(
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from sales_invoices where id = _id('inv5')),
  (select (taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total)::text from v_quotations where id = _id('q5')),
  'and = the quote''s totals');

-- ============================================================
-- Stale place of supply is refused at convert (review fix 4)
-- ============================================================
select _as_counter();
select lives_ok(
  $$insert into _k values ('q6', save_quotation(null, null, 'a0000000-0000-0000-0000-000000000006', _today(), null, null, _lines())::text)$$,
  'q6 saves intra-state');
reset role;
select _as_owner();
insert into party_addresses (party_id, label, address, state_code, is_default) values
  ('a0000000-0000-0000-0000-000000000006', 'New office', '{"line1":"3 Lake Road","city":"Hyderabad","pincode":"500032"}', '36', true);
set local role authenticated;
select _as_counter();
select throws_ok($$select convert_quotation_to_invoice(_id('q6'))$$, 'P0001', 'DN_VALIDATION:quote_pos_changed',
  'the party moved state since the quote: convert is refused');
select is((select status from quotations where id = _id('q6')), 'open', 'and the quote stays open');
select lives_ok($$select save_quotation(_id('q6'), (select updated_at from quotations where id = _id('q6')),
    'a0000000-0000-0000-0000-000000000006', _today(), null, null, _lines())$$, 're-saving the quote re-derives it');
select is((select place_of_supply::text from quotations where id = _id('q6')), '36', 'now inter-state');
select lives_ok($$select convert_quotation_to_invoice(_id('q6'))$$, 'and it converts');

-- ============================================================
-- The DB owner cannot detach a converted quote from a live invoice
-- ============================================================
reset role;
select throws_ok($$update quotations set converted_invoice_id = null, converted_at = null where id = _id('q1')$$,
  'P0001', 'DN_VALIDATION:quote_converted', 'clearing converted_invoice_id while the invoice exists is refused');

select * from finish();
rollback;
