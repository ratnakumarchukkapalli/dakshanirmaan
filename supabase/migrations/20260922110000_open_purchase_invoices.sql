-- Change 12 (payments-ui): the allocation grid needs a source of open invoices to allocate
-- against for BOTH payment directions. `v_open_sales_invoices` (change 06) only ever covered
-- receipts; nothing mirrors it for outgoing payments against purchase invoices, because
-- purchase-invoice creation itself has no UI until change 21. `post_payment` already supports
-- `direction = 'payment'` against `purchase_invoices` (change 04), so the gap is only on the read
-- side. This view is an exact mirror of `v_open_sales_invoices`'s own definition (same
-- `open_amount` formula, same `WHERE open_amount > 0`), swapping `sales_invoices` for
-- `purchase_invoices` and `credit_notes` for `debit_notes`.
--
-- No interest/ageing-rate column: `v_party_interest` (change 06) is customer-side only -- nothing
-- in the spec charges the business interest on its own payables, so there is nothing to carry here
-- that `v_open_sales_invoices` carries for the other direction.
create view v_open_purchase_invoices with (security_invoker = true) as
select
  x.invoice_id, x.party_id, x.invoice_no, x.invoice_date, x.credit_days,
  x.due_date, x.grand_total, x.allocated, x.debit_noted, x.open_amount,
  x.as_of,
  (x.as_of - x.invoice_date) as age_days,
  greatest(x.as_of - x.due_date, 0) as overdue_days
from (
  select
    pi.id as invoice_id,
    pi.party_id,
    pi.invoice_no,
    pi.invoice_date,
    p.credit_days,
    (pi.invoice_date + p.credit_days) as due_date,
    pi.grand_total,
    coalesce(al.amount, 0)::numeric(14,2) as allocated,
    coalesce(dn.amount, 0)::numeric(14,2) as debit_noted,
    (pi.grand_total - coalesce(al.amount, 0) - coalesce(dn.amount, 0))::numeric(14,2) as open_amount,
    (now() at time zone (select o.timezone from organization o limit 1))::date as as_of
  from purchase_invoices pi
  join parties p on p.id = pi.party_id
  left join (
    select pa.invoice_id, sum(pa.amount) as amount
    from payment_allocations pa
    join payments pay on pay.id = pa.payment_id and pay.status = 'posted'
    where pa.invoice_type = 'purchase_invoice'
    group by pa.invoice_id
  ) al on al.invoice_id = pi.id
  left join (
    select d.against_invoice_id, sum(d.grand_total) as amount
    from debit_notes d
    where d.status = 'posted' and d.against_invoice_id is not null
    group by d.against_invoice_id
  ) dn on dn.against_invoice_id = pi.id
  where pi.status = 'posted'
) x
where x.open_amount > 0;

revoke all on public.v_open_purchase_invoices from public, anon, authenticated, service_role;
grant select on public.v_open_purchase_invoices to authenticated;
