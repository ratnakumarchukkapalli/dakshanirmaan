-- Change 14 (dashboard): read views for the sales tile and chart, and the cash + bank tile.
--
-- Everything else on the dashboard reads views that already exist (v_attention, v_party_balances,
-- v_stock_summary(_all), v_trial_balance). Sales-by-day and money-account balances had no view, and
-- the dashboard may not add them up in TypeScript, so they are views here. All security_invoker
-- (base-table RLS applies), SELECT to authenticated only, like every other v_* view.

-- ============================================================
-- Sales by day. Posted invoices only (a cancelled invoice is status 'cancelled'; its reversal is
-- in the ledger, not here). billed_total = grand_total (what the customer is billed, incl. GST and
-- round-off). Not net of credit notes: none exist until change 20. Cash sales are ordinary
-- invoices (post_cash_sale), so they are in.
-- ============================================================
create view v_sales_daily with (security_invoker = true) as
select
  si.invoice_date as sale_date,
  count(*)::int as invoice_count,
  sum(si.grand_total)::numeric(14,2) as billed_total,
  sum(si.round_off)::numeric(14,2) as round_off
from sales_invoices si
where si.status = 'posted'
group by si.invoice_date;

-- The same, split by item category (cement / steel / other). amount = taxable value + GST of the
-- lines, so sum(amount) + round_off = billed_total for a day. The category is read from `items` at
-- query time: invoice lines carry no category snapshot, so recategorising an item re-colours its
-- history in the chart (the invoice documents themselves are unaffected).
create view v_sales_daily_category with (security_invoker = true) as
select
  si.invoice_date as sale_date,
  i.category,
  sum(l.taxable_value + l.cgst_amt + l.sgst_amt + l.igst_amt)::numeric(14,2) as amount
from sales_invoices si
join sales_invoice_lines l on l.invoice_id = si.id
join items i on i.id = l.item_id
where si.status = 'posted'
group by si.invoice_date, i.category;

-- ============================================================
-- Cash and bank balances: one row per real money account (is_money, not a group), from posted
-- journal lines. Admin-only like the bank reconciliation: a counter cannot see the payroll cash
-- entries (change 13), so any sum it could make would be wrong as well as private.
-- ============================================================
create view v_money_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.code,
  a.name,
  a.system_key,
  coalesce(b.balance, 0)::numeric(14,2) as balance
from accounts a
left join (
  select jl.account_id, sum(jl.debit - jl.credit) as balance
  from journal_lines jl
  join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
  group by jl.account_id
) b on b.account_id = a.id
where a.is_money and not a.is_group
  and (select current_app_role()) = 'admin';

do $$
declare
  v text;
begin
  foreach v in array array['v_sales_daily', 'v_sales_daily_category', 'v_money_balances'] loop
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v);
    execute format('grant select on public.%I to authenticated', v);
  end loop;
end
$$;
