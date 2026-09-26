-- Change 18 (self-audit-and-gst): GSTR-1 data in the portal's JSON shape, a GSTR-3B summary,
-- period locking as a function, and an audit trail for master edits.
--
-- Shape of the GSTR-1 output: docs/research/gstr1-schema.md (India Compliance key names; the
-- portal itself is the final check). Every figure is built here from posted documents' line
-- snapshots; TypeScript only wraps the envelope (gstin, fp, version) and lays out Excel.
-- Sales invoices do not snapshot the buyer's GSTIN, so `ctin` is read from the party master at
-- export time (logged as a conservative default in the change's notes).

-- ============================================================
-- 1. Audit trail for master edits (owner decision 4)
-- ============================================================
-- Changed columns only, before and after. A party's pay columns never enter the log (owner decision 2:
-- salary and wages are owner-only, and audit_log is readable by every member).
create or replace function public.audit_master_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_skip   text[] := array['created_at', 'updated_at', 'monthly_salary', 'daily_wage'];
  v_new    jsonb := to_jsonb(new) - v_skip;
  v_old    jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
  v_key    text;
begin
  if tg_op = 'INSERT' then
    insert into audit_log (actor, action, entity, entity_id, after)
    values (auth.uid(), 'insert', tg_table_name, new.id, v_new);
    return new;
  end if;

  v_old := to_jsonb(old) - v_skip;
  for v_key in select key from jsonb_each(v_new) loop
    if v_new -> v_key is distinct from v_old -> v_key then
      v_before := v_before || jsonb_build_object(v_key, v_old -> v_key);
      v_after  := v_after  || jsonb_build_object(v_key, v_new -> v_key);
    end if;
  end loop;

  -- Only the pay columns (or nothing) changed: nothing to record.
  if v_after = '{}'::jsonb then
    return new;
  end if;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (auth.uid(), 'update', tg_table_name, new.id, v_before, v_after);
  return new;
end;
$$;

revoke all on function public.audit_master_change() from public, anon, authenticated, service_role;

create trigger audit_master_parties after insert or update on parties
  for each row execute function public.audit_master_change();
create trigger audit_master_party_addresses after insert or update on party_addresses
  for each row execute function public.audit_master_change();
create trigger audit_master_items after insert or update on items
  for each row execute function public.audit_master_change();
create trigger audit_master_organization after insert or update on organization
  for each row execute function public.audit_master_change();
create trigger audit_master_accounts after insert or update on accounts
  for each row execute function public.audit_master_change();

-- Master-edit and period-lock rows are for owners; the payroll rule from change 13 stays.
drop policy select_active_members on public.audit_log;
create policy select_active_members on public.audit_log for select
  using (is_active_member()
         and (entity <> 'expense_vouchers' or entity_id is null
              or entity_id not in (select public.hidden_payroll_voucher_ids()))
         and (entity not in ('parties', 'party_addresses', 'items', 'organization', 'accounts', 'fiscal_periods')
              or current_app_role() = 'admin'));

-- ============================================================
-- 2. Period locks as a function (audited; unlocking needs a reason)
-- ============================================================
create or replace function public.set_period_lock(p_month date, p_locked boolean, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_period record;
begin
  if v_actor is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_month is null or p_locked is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  if not p_locked and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'DN_VALIDATION:reason_required';
  end if;

  select * into v_period from fiscal_periods where month = p_month for update;
  if not found then
    raise exception 'DN_NO_PERIOD';
  end if;
  if v_period.is_locked = p_locked then
    return false;   -- already in that state: nothing to change, nothing to audit
  end if;

  update fiscal_periods set is_locked = p_locked where id = v_period.id;

  insert into audit_log (actor, action, entity, entity_id, before, after)
  values (v_actor, case when p_locked then 'lock' else 'unlock' end, 'fiscal_periods', v_period.id,
          jsonb_build_object('month', p_month, 'is_locked', v_period.is_locked),
          jsonb_build_object('month', p_month, 'is_locked', p_locked, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return true;
end;
$$;

revoke all on function public.set_period_lock(date, boolean, text) from public, anon;
grant execute on function public.set_period_lock(date, boolean, text) to authenticated;

-- ============================================================
-- 2b. A filed month stays as filed
-- ============================================================
-- (a) Buyer GSTIN snapshot. Whether a sale is B2B or B2C, and to whom, is decided by the buyer's GSTIN
-- *when the document was posted*; a later edit of the party master must not move an old invoice
-- between sections of a return that is already filed. Set by trigger at the moment a document
-- becomes posted, so the posting functions are untouched.
alter table sales_invoices add column buyer_gstin text;
alter table credit_notes add column buyer_gstin text;

create or replace function public.snapshot_buyer_gstin()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'posted' and (tg_op = 'INSERT' or old.status is distinct from 'posted') then
    select nullif(btrim(gstin), '') into new.buyer_gstin from parties where id = new.party_id;
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_buyer_gstin() from public, anon, authenticated, service_role;

-- Documents posted before this change: their buyer as the master holds it today (the best there is).
update sales_invoices si set buyer_gstin = nullif(btrim(p.gstin), '') from parties p where p.id = si.party_id and si.status in ('posted', 'cancelled');
update credit_notes cn set buyer_gstin = nullif(btrim(p.gstin), '') from parties p where p.id = cn.party_id and cn.status in ('posted', 'cancelled');

create trigger snapshot_buyer_gstin before insert or update of status on sales_invoices
  for each row execute function public.snapshot_buyer_gstin();
create trigger snapshot_buyer_gstin before insert or update of status on credit_notes
  for each row execute function public.snapshot_buyer_gstin();

-- (b) Nothing dated in a locked month can be cancelled. The cancel functions only check the period of
-- the day the reversal is posted (today); a filed month's documents would otherwise silently drop out
-- of a return that can then no longer be reproduced. The correction for a locked month is a credit
-- note (change 20) dated in an open month. A month with no period row does not block (posting into it
-- is already refused).
create or replace function public.refuse_cancel_in_locked_period()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_date date;
begin
  if old.status = 'posted' and new.status = 'cancelled' then
    -- (the record's shape differs per table, so its date column is read by name)
    v_date := (to_jsonb(new) ->> case tg_table_name
      when 'sales_invoices' then 'invoice_date'
      when 'purchase_invoices' then 'invoice_date'
      when 'credit_notes' then 'note_date'
      when 'delivery_challans' then 'challan_date'
      when 'expense_vouchers' then 'voucher_date'
    end)::date;
    if exists (select 1 from fiscal_periods where month = date_trunc('month', v_date)::date and is_locked) then
      raise exception 'DN_PERIOD_LOCKED';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.refuse_cancel_in_locked_period() from public, anon, authenticated, service_role;

create trigger refuse_cancel_in_locked_period before update of status on sales_invoices
  for each row execute function public.refuse_cancel_in_locked_period();
create trigger refuse_cancel_in_locked_period before update of status on purchase_invoices
  for each row execute function public.refuse_cancel_in_locked_period();
create trigger refuse_cancel_in_locked_period before update of status on credit_notes
  for each row execute function public.refuse_cancel_in_locked_period();
create trigger refuse_cancel_in_locked_period before update of status on delivery_challans
  for each row execute function public.refuse_cancel_in_locked_period();
create trigger refuse_cancel_in_locked_period before update of status on expense_vouchers
  for each row execute function public.refuse_cancel_in_locked_period();

-- ============================================================
-- 3. GST helpers
-- ============================================================
-- GST unit quantity codes for the units this business uses; NULL for anything else (the exporter
-- warns instead of guessing).
create or replace function public.gst_uqc(p_uom text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case lower(btrim(coalesce(p_uom, '')))
    when 'bag' then 'BAG' when 'bags' then 'BAG'
    when 'kg' then 'KGS' when 'kgs' then 'KGS' when 'kilogram' then 'KGS'
    when 'tonne' then 'TON' when 'tonnes' then 'TON' when 'ton' then 'TON' when 'mt' then 'TON'
    when 'nos' then 'NOS' when 'no' then 'NOS' when 'pcs' then 'NOS' when 'pc' then 'NOS'
      when 'piece' then 'NOS' when 'pieces' then 'NOS'
    when 'bundle' then 'BDL' when 'bundles' then 'BDL' when 'bdl' then 'BDL'
    when 'm' then 'MTR' when 'mtr' then 'MTR' when 'meter' then 'MTR' when 'metre' then 'MTR'
    when 'sqm' then 'SQM'
  end;
$$;
revoke all on function public.gst_uqc(text) from public, anon;
grant execute on function public.gst_uqc(text) to authenticated;

-- Every posted sales invoice and credit note line dated in [p_from, p_to). `sgn` is +1 for an invoice,
-- -1 for a credit note (amounts stay unsigned). Internal: the two report functions call it.
create or replace function public._gst_out_lines(p_from date, p_to date)
returns table (
  kind text, sgn int, doc_id uuid, doc_no text, doc_date date, doc_value numeric, pos text, ctin text,
  inter boolean, hsn text, item_name text, uom text, qty numeric, rt numeric,
  txval numeric, iamt numeric, camt numeric, samt numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with org as (select state_code from organization limit 1)
  select 'inv', 1, si.id, si.invoice_no, si.invoice_date, si.grand_total, si.place_of_supply::text,
         si.buyer_gstin, si.place_of_supply <> org.state_code,
         l.hsn_code, l.item_name, l.uom, l.qty, l.gst_rate,
         l.taxable_value, l.igst_amt, l.cgst_amt, l.sgst_amt
  from sales_invoices si
  join sales_invoice_lines l on l.invoice_id = si.id
  cross join org
  where si.status = 'posted' and si.invoice_date >= p_from and si.invoice_date < p_to
  union all
  select 'cn', -1, cn.id, cn.note_no, cn.note_date, cn.grand_total, cn.place_of_supply::text,
         cn.buyer_gstin, cn.place_of_supply <> org.state_code,
         l.hsn_code, l.item_name, l.uom, l.qty, l.gst_rate,
         l.taxable_value, l.igst_amt, l.cgst_amt, l.sgst_amt
  from credit_notes cn
  join credit_note_lines l on l.note_id = cn.id
  cross join org
  where cn.status = 'posted' and cn.note_date >= p_from and cn.note_date < p_to;
$$;
revoke all on function public._gst_out_lines(date, date) from public, anon, authenticated, service_role;

-- ============================================================
-- 4. gstr1_data
-- ============================================================
create or replace function public.gstr1_data(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from   date;
  v_to     date;
  v_org    record;
  v_result jsonb;
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_month is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  v_from := date_trunc('month', p_month)::date;
  v_to := (v_from + interval '1 month')::date;
  select state_code, gstin into v_org from organization limit 1;

  with
  ln as (select * from _gst_out_lines(v_from, v_to)),
  rate_rows as (
    select kind, sgn, doc_id, doc_no, doc_date, doc_value, pos, ctin, inter, rt,
           sum(txval) as txval, sum(iamt) as iamt, sum(camt) as camt, sum(samt) as samt
    from ln where rt > 0
    group by kind, sgn, doc_id, doc_no, doc_date, doc_value, pos, ctin, inter, rt
  ),
  numbered as (
    select r.*, row_number() over (partition by kind, doc_id order by rt) as rn from rate_rows r
  ),
  doc_items as (
    select kind, doc_id, doc_no, doc_date, doc_value, pos, ctin, inter,
      jsonb_agg(jsonb_build_object('num', rn, 'itm_det',
        jsonb_build_object('rt', rt, 'txval', txval, 'iamt', iamt, 'camt', camt, 'samt', samt, 'csamt', 0))
        order by rn) as itms,
      jsonb_agg(jsonb_build_object('num', rn, 'itm_det',
        jsonb_build_object('rt', rt, 'txval', txval, 'iamt', iamt, 'csamt', 0))
        order by rn) as itms_large
    from numbered
    group by kind, doc_id, doc_no, doc_date, doc_value, pos, ctin, inter
  ),
  b2b as (
    select coalesce(jsonb_agg(jsonb_build_object('ctin', g.ctin, 'inv', g.invs) order by g.ctin), '[]'::jsonb) as j
    from (
      select ctin, jsonb_agg(jsonb_build_object(
               'inum', doc_no, 'idt', to_char(doc_date, 'DD-MM-YYYY'), 'val', doc_value, 'pos', pos,
               'rchrg', 'N', 'inv_typ', 'R', 'itms', itms) order by doc_date, doc_no) as invs
      from doc_items where kind = 'inv' and ctin is not null
      group by ctin
    ) g
  ),
  b2cl as (
    select coalesce(jsonb_agg(jsonb_build_object('pos', g.pos, 'inv', g.invs) order by g.pos), '[]'::jsonb) as j
    from (
      select pos, jsonb_agg(jsonb_build_object(
               'inum', doc_no, 'idt', to_char(doc_date, 'DD-MM-YYYY'), 'val', doc_value, 'itms', itms_large)
               order by doc_date, doc_no) as invs
      from doc_items where kind = 'inv' and ctin is null and inter and doc_value > 100000
      group by pos
    ) g
  ),
  b2cs as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'sply_ty', g.sply_ty, 'pos', g.pos, 'typ', 'OE', 'rt', g.rt, 'txval', g.txval,
             'iamt', g.iamt, 'camt', g.camt, 'samt', g.samt, 'csamt', 0) order by g.pos, g.rt, g.sply_ty), '[]'::jsonb) as j
    from (
      select case when inter then 'INTER' else 'INTRA' end as sply_ty, pos, rt,
             sum(sgn * txval) as txval, sum(sgn * iamt) as iamt, sum(sgn * camt) as camt, sum(sgn * samt) as samt
      from rate_rows
      where ctin is null and not (kind = 'inv' and inter and doc_value > 100000)
      group by 1, pos, rt
      having sum(sgn * txval) <> 0 or sum(sgn * iamt) <> 0 or sum(sgn * camt) <> 0 or sum(sgn * samt) <> 0
    ) g
  ),
  cdnr as (
    select coalesce(jsonb_agg(jsonb_build_object('ctin', g.ctin, 'nt', g.nts) order by g.ctin), '[]'::jsonb) as j
    from (
      select ctin, jsonb_agg(jsonb_build_object(
               'ntty', 'C', 'nt_num', doc_no, 'nt_dt', to_char(doc_date, 'DD-MM-YYYY'), 'val', doc_value,
               'pos', pos, 'rchrg', 'N', 'inv_typ', 'R', 'itms', itms) order by doc_date, doc_no) as nts
      from doc_items where kind = 'cn' and ctin is not null
      group by ctin
    ) g
  ),
  nil as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'sply_ty', g.sply_ty, 'expt_amt', 0, 'nil_amt', g.nil_amt, 'ngsup_amt', 0) order by g.sply_ty), '[]'::jsonb) as j
    from (
      select case when inter and ctin is not null then 'INTRB2B'
                  when inter then 'INTRB2C'
                  when ctin is not null then 'INTRAB2B'
                  else 'INTRAB2C' end as sply_ty,
             sum(sgn * txval) as nil_amt
      from ln where rt = 0
      group by 1
      having sum(sgn * txval) <> 0
    ) g
  ),
  hsn_rows as (
    select (ctin is not null) as is_b2b, hsn, coalesce(gst_uqc(uom), 'OTH') as uqc, rt,
           left(min(item_name), 30) as descr,
           sum(sgn * qty) as qty, sum(sgn * txval) as txval,
           sum(sgn * iamt) as iamt, sum(sgn * camt) as camt, sum(sgn * samt) as samt
    from ln
    group by 1, hsn, 3, rt
  ),
  hsn_numbered as (
    select h.*, row_number() over (partition by is_b2b order by hsn, uqc, rt) as num from hsn_rows h
  ),
  hsn_b2b as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'num', num, 'hsn_sc', hsn, 'desc', descr, 'uqc', uqc, 'qty', qty, 'rt', rt,
             'txval', txval, 'iamt', iamt, 'camt', camt, 'samt', samt, 'csamt', 0) order by num), '[]'::jsonb) as j
    from hsn_numbered where is_b2b
  ),
  hsn_b2c as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'num', num, 'hsn_sc', hsn, 'desc', descr, 'uqc', uqc, 'qty', qty, 'rt', rt,
             'txval', txval, 'iamt', iamt, 'camt', camt, 'samt', samt, 'csamt', 0) order by num), '[]'::jsonb) as j
    from hsn_numbered where not is_b2b
  ),
  issued as (
    select 1 as nature, invoice_no as no, status::text as status from sales_invoices
     where status in ('posted', 'cancelled') and invoice_no is not null and invoice_date >= v_from and invoice_date < v_to
    union all
    select 5, note_no, status::text from credit_notes
     where status in ('posted', 'cancelled') and note_no is not null and note_date >= v_from and note_date < v_to
    union all
    select 12, challan_no, status::text from delivery_challans
     where status in ('posted', 'cancelled') and challan_no is not null and challan_date >= v_from and challan_date < v_to
  ),
  issued_ranges as (
    select nature, regexp_replace(no, '[0-9]+$', '') as series,
           (array_agg(no order by substring(no from '([0-9]+)$')::bigint))[1] as first_no,
           (array_agg(no order by substring(no from '([0-9]+)$')::bigint desc))[1] as last_no,
           count(*) as totnum,
           count(*) filter (where status = 'cancelled') as cancelled
    from issued
    group by nature, regexp_replace(no, '[0-9]+$', '')
  ),
  issued_numbered as (
    select r.*, row_number() over (partition by nature order by series) as num from issued_ranges r
  ),
  docs as (
    select coalesce(jsonb_agg(jsonb_build_object('doc_num', g.nature, 'docs', g.docs) order by g.nature), '[]'::jsonb) as j
    from (
      select nature, jsonb_agg(jsonb_build_object(
               'num', num, 'from', first_no, 'to', last_no, 'totnum', totnum,
               'cancel', cancelled, 'net_issue', totnum - cancelled) order by num) as docs
      from issued_numbered group by nature
    ) g
  ),
  totals as (
    select jsonb_build_object(
      'invoices', count(distinct doc_id) filter (where kind = 'inv'),
      'notes', count(distinct doc_id) filter (where kind = 'cn'),
      'taxable', coalesce(sum(sgn * txval), 0),
      'igst', coalesce(sum(sgn * iamt), 0),
      'cgst', coalesce(sum(sgn * camt), 0),
      'sgst', coalesce(sum(sgn * samt), 0)) as j
    from ln
  ),
  -- What each section adds up to, for the screen (so no arithmetic is done in TypeScript).
  -- b2cs is net of credit notes to consumers; cdnr counts notes; nil is the nil-rated taxable value.
  summary as (
    select jsonb_build_object(
      'b2b', (select jsonb_build_object('count', count(distinct doc_id), 'txval', coalesce(sum(txval), 0),
                'iamt', coalesce(sum(iamt), 0), 'camt', coalesce(sum(camt), 0), 'samt', coalesce(sum(samt), 0))
              from rate_rows where kind = 'inv' and ctin is not null),
      'b2cl', (select jsonb_build_object('count', count(distinct doc_id), 'txval', coalesce(sum(txval), 0),
                'iamt', coalesce(sum(iamt), 0), 'camt', coalesce(sum(camt), 0), 'samt', coalesce(sum(samt), 0))
              from rate_rows where kind = 'inv' and ctin is null and inter and doc_value > 100000),
      'b2cs', (select jsonb_build_object('count', count(distinct doc_id) filter (where kind = 'inv'),
                'txval', coalesce(sum(sgn * txval), 0), 'iamt', coalesce(sum(sgn * iamt), 0),
                'camt', coalesce(sum(sgn * camt), 0), 'samt', coalesce(sum(sgn * samt), 0))
              from rate_rows where ctin is null and not (kind = 'inv' and inter and doc_value > 100000)),
      'cdnr', (select jsonb_build_object('count', count(distinct doc_id), 'txval', coalesce(sum(txval), 0),
                'iamt', coalesce(sum(iamt), 0), 'camt', coalesce(sum(camt), 0), 'samt', coalesce(sum(samt), 0))
              from rate_rows where kind = 'cn' and ctin is not null),
      'nil', (select jsonb_build_object('count', count(distinct doc_id) filter (where kind = 'inv'),
                'txval', coalesce(sum(sgn * txval), 0), 'iamt', 0, 'camt', 0, 'samt', 0)
              from ln where rt = 0),
      'hsn', (select jsonb_build_object('count', (select count(*) from hsn_numbered)))
    ) as j
  ),
  warns as (
    select coalesce(jsonb_agg(jsonb_build_object('key', w.key, 'count', w.n) order by w.key), '[]'::jsonb) as j
    from (
      select 'no_hsn' as key, count(*) as n from ln where btrim(coalesce(hsn, '')) = ''
      union all
      select 'hsn_short', count(*) from ln where btrim(coalesce(hsn, '')) <> '' and length(btrim(hsn)) < 4
      union all
      select 'unmapped_uom', count(distinct uom) from ln where gst_uqc(uom) is null
      union all
      select 'export_not_supported', count(distinct doc_id) from ln where pos = '96'
      union all
      -- A credit note to an unregistered buyer, inter-state, against an invoice over the B2CL threshold, belongs
      -- in CDNUR, which is not built; netting it into b2cs would be wrong.
      select 'cdnur_not_supported', count(*)
        from credit_notes cn left join sales_invoices si on si.id = cn.against_invoice_id
       where cn.status = 'posted' and cn.note_date >= v_from and cn.note_date < v_to
         and cn.buyer_gstin is null and cn.place_of_supply <> v_org.state_code
         and coalesce(si.grand_total, cn.grand_total) > 100000
      union all
      select 'org_gstin_missing', case when nullif(btrim(coalesce(v_org.gstin, '')), '') is null then 1 else 0 end
    ) w where w.n > 0
  )
  select jsonb_build_object(
    'period', to_char(v_from, 'YYYY-MM'),
    'fp', to_char(v_from, 'MMYYYY'),
    'gstin', v_org.gstin,
    'b2b', b2b.j, 'b2cl', b2cl.j, 'b2cs', b2cs.j, 'cdnr', cdnr.j,
    'nil', jsonb_build_object('inv', nil.j),
    'hsn', jsonb_build_object('hsn_b2b', hsn_b2b.j, 'hsn_b2c', hsn_b2c.j),
    'doc_issue', jsonb_build_object('doc_det', docs.j),
    'totals', totals.j,
    'summary', summary.j,
    'warnings', warns.j)
  into v_result
  from b2b, b2cl, b2cs, cdnr, nil, hsn_b2b, hsn_b2c, docs, totals, summary, warns;

  return v_result;
end;
$$;

revoke all on function public.gstr1_data(date) from public, anon;
grant execute on function public.gstr1_data(date) to authenticated;

-- ============================================================
-- 5. gstr3b_summary
-- ============================================================
-- Rows to key into the GSTR-3B form. Taxable values and tax come from documents; the last rows
-- compare them with what the ledger holds for the same month (a cancellation dated in a later month
-- is the usual, legitimate reason for a difference).
--   3.1a   outward taxable supplies (invoices less credit notes, rate above zero)
--   3.1c   nil-rated / exempt outward supplies (rate zero)
--   3.1d   inward supplies liable to reverse charge (posted expense-voucher lines flagged rcm; tax = the input tax
--          the voucher's entry debits)
--   3.2:NN inter-state supplies to unregistered buyers, by place of supply
--   4A3    ITC on reverse charge (equals 3.1d tax: the entry debits input tax as it credits RCM payable)
--   4A5    all other ITC (posted purchase invoices marked ITC-eligible)
--   4D     ineligible ITC (posted purchase invoices not ITC-eligible)
--   books_output / books_input  the ledger's net output-tax credit / input-tax debit dated in the month
--   recon_output / recon_input  document figure minus ledger figure (0 = the return agrees with the books)
create or replace function public.gstr3b_summary(p_month date)
returns table (row_key text, taxable numeric, igst numeric, cgst numeric, sgst numeric, cess numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_to   date;
  v_o    record;   -- 3.1a
  v_n    record;   -- 3.1c
  v_r    record;   -- 3.1d
  v_i5   record;   -- 4A5
  v_id   record;   -- 4D
  v_bo   record;   -- books output
  v_bi   record;   -- books input
begin
  if auth.uid() is null or current_app_role() is distinct from 'admin' then
    raise exception 'DN_FORBIDDEN';
  end if;
  if p_month is null then
    raise exception 'DN_VALIDATION:invalid_date';
  end if;
  v_from := date_trunc('month', p_month)::date;
  v_to := (v_from + interval '1 month')::date;

  select coalesce(sum(sgn * txval), 0) t, coalesce(sum(sgn * iamt), 0) i, coalesce(sum(sgn * camt), 0) c, coalesce(sum(sgn * samt), 0) s
    into v_o from _gst_out_lines(v_from, v_to) where rt > 0;
  select coalesce(sum(sgn * txval), 0) t into v_n from _gst_out_lines(v_from, v_to) where rt = 0;

  select coalesce(sum(vl.amount), 0) as t into v_r
  from expense_vouchers v join expense_voucher_lines vl on vl.voucher_id = v.id
  where v.status = 'posted' and vl.rcm and v.voucher_date >= v_from and v.voucher_date < v_to;
  -- The tax on reverse-charge freight is what its entry credits to RCM payable (an expense line posted straight
  -- to an input-tax account on the same voucher is not RCM tax). Phase 1 refuses inter-state RCM, so it is
  -- always CGST + SGST, split half and half.
  select v_r.t as t,
         0::numeric as i,
         round(x.tax / 2, 2) as c,
         x.tax - round(x.tax / 2, 2) as s
    into v_r
  from (
    select coalesce(sum(jl.credit), 0) as tax
    from journal_lines jl
    join accounts a on a.id = jl.account_id and a.system_key = 'rcm_payable'
    where jl.entry_id in (
      select v.journal_entry_id from expense_vouchers v
      where v.status = 'posted' and v.voucher_date >= v_from and v.voucher_date < v_to
        and exists (select 1 from expense_voucher_lines vl where vl.voucher_id = v.id and vl.rcm))
  ) x;

  select coalesce(sum(l.taxable_value), 0) t, coalesce(sum(l.igst_amt), 0) i, coalesce(sum(l.cgst_amt), 0) c, coalesce(sum(l.sgst_amt), 0) s
    into v_i5
  from purchase_invoices pi join purchase_invoice_lines l on l.invoice_id = pi.id
  where pi.status = 'posted' and pi.itc_eligible and pi.invoice_date >= v_from and pi.invoice_date < v_to;
  select coalesce(sum(l.taxable_value), 0) t, coalesce(sum(l.igst_amt), 0) i, coalesce(sum(l.cgst_amt), 0) c, coalesce(sum(l.sgst_amt), 0) s
    into v_id
  from purchase_invoices pi join purchase_invoice_lines l on l.invoice_id = pi.id
  where pi.status = 'posted' and not pi.itc_eligible and pi.invoice_date >= v_from and pi.invoice_date < v_to;

  select coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_igst'), 0) i,
         coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_cgst'), 0) c,
         coalesce(sum(jl.credit - jl.debit) filter (where a.system_key = 'output_sgst'), 0) s
    into v_bo
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where je.source_type in ('sales_invoice', 'credit_note') and je.entry_date >= v_from and je.entry_date < v_to;

  select coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_igst'), 0) i,
         coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_cgst'), 0) c,
         coalesce(sum(jl.debit - jl.credit) filter (where a.system_key = 'input_sgst'), 0) s
    into v_bi
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  join accounts a on a.id = jl.account_id
  where je.source_type in ('purchase_invoice', 'debit_note', 'expense_voucher') and je.entry_date >= v_from and je.entry_date < v_to;

  return query select '3.1a', v_o.t, v_o.i, v_o.c, v_o.s, 0::numeric;
  return query select '3.1c', v_n.t, 0::numeric, 0::numeric, 0::numeric, 0::numeric;
  return query select '3.1d', v_r.t, v_r.i, v_r.c, v_r.s, 0::numeric;
  return query
    select '3.2:' || x.pos, sum(x.sgn * x.txval), sum(x.sgn * x.iamt), 0::numeric, 0::numeric, 0::numeric
    from _gst_out_lines(v_from, v_to) x
    where x.ctin is null and x.inter and x.rt > 0
    group by x.pos
    having sum(x.sgn * x.txval) <> 0 or sum(x.sgn * x.iamt) <> 0
    order by x.pos;
  return query select '4A3', v_r.t, v_r.i, v_r.c, v_r.s, 0::numeric;
  return query select '4A5', v_i5.t, v_i5.i, v_i5.c, v_i5.s, 0::numeric;
  return query select '4D', v_id.t, v_id.i, v_id.c, v_id.s, 0::numeric;
  return query select 'books_output', 0::numeric, v_bo.i, v_bo.c, v_bo.s, 0::numeric;
  return query select 'books_input', 0::numeric, v_bi.i, v_bi.c, v_bi.s, 0::numeric;
  return query select 'recon_output', 0::numeric, v_o.i - v_bo.i, v_o.c - v_bo.c, v_o.s - v_bo.s, 0::numeric;
  return query select 'recon_input', 0::numeric,
    (v_i5.i + v_r.i) - v_bi.i, (v_i5.c + v_r.c) - v_bi.c, (v_i5.s + v_r.s) - v_bi.s, 0::numeric;
end;
$$;

revoke all on function public.gstr3b_summary(date) from public, anon;
grant execute on function public.gstr3b_summary(date) to authenticated;

-- ============================================================
-- 6. Statements as at a date / over a range (owner only, security invoker like the views)
-- ============================================================
-- The views expose one row per account per day; a year of those is past the API's row cap, so the
-- screens ask for the already-summed figures instead.

-- Trial balance as at a date: every leaf account with movement, closing = debit - credit.
create or replace function public.trial_balance_asat(p_date date)
returns table (account_id uuid, code text, name text, account_type text, total_debit numeric, total_credit numeric, closing numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select a.id, a.code, a.name, a.type::text,
         sum(jl.debit)::numeric(14,2), sum(jl.credit)::numeric(14,2),
         (sum(jl.debit) - sum(jl.credit))::numeric(14,2)
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted' and je.entry_date <= p_date
  join accounts a on a.id = jl.account_id
  where not a.is_group and current_app_role() = 'admin'
  group by a.id, a.code, a.name, a.type
  having sum(jl.debit) <> 0 or sum(jl.credit) <> 0
  order by a.code;
$$;

-- Profit and loss over a date range (from v_pnl): per account, the amount on its natural side.
create or replace function public.pnl_range(p_from date, p_to date)
returns table (account_id uuid, code text, name text, account_type text, amount numeric, profit_effect numeric)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.account_id, p.code, p.name, p.account_type::text,
         sum(p.amount)::numeric(14,2), sum(p.profit_effect)::numeric(14,2)
  from v_pnl p
  where p.entry_date >= p_from and p.entry_date <= p_to
  group by p.account_id, p.code, p.name, p.account_type
  having sum(p.amount) <> 0
  order by p.account_type desc, p.code;
$$;

-- Balance sheet as at a date (from v_balance_sheet): per account plus the not-yet-closed profit row.
create or replace function public.balance_sheet_asat(p_date date)
returns table (section text, account_id uuid, code text, name text, amount numeric, is_current_profit boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select b.section, b.account_id, b.code, b.name, sum(b.amount)::numeric(14,2), b.is_current_profit
  from v_balance_sheet b
  where b.entry_date <= p_date
  group by b.section, b.account_id, b.code, b.name, b.is_current_profit
  having sum(b.amount) <> 0
  order by b.section, b.code nulls last;
$$;

revoke all on function public.trial_balance_asat(date), public.pnl_range(date, date), public.balance_sheet_asat(date) from public, anon;
grant execute on function public.trial_balance_asat(date), public.pnl_range(date, date), public.balance_sheet_asat(date) to authenticated;
