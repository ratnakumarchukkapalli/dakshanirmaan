-- db-architecture spec: "Seed data"
-- CoA per DESIGN.md §2.2, including every system_key named in "Core tables" (15) and in
-- "Schema extensions for prototype-v2 features" → "New system_key accounts" (10) — see
-- proposal.md scope decisions for why the extension system_keys are seeded here even though
-- their tables land later. 'cheques_in_hand' (mentioned only inline under the payments-columns
-- paragraph, not in that bulleted list) is deliberately deferred to change 04, which owns the
-- cheque lifecycle columns it belongs with.

insert into organization (legal_name, trade_name, state_code, fy_start_month)
values ('Daksha Nirmaan Traders', 'Daksha Nirmaan Traders', '37', 4);

insert into warehouses (name, is_default) values ('Head Godown', true);

-- Assets
insert into accounts (code, name, type, is_group) values ('1000', 'Assets', 'asset', true);
insert into accounts (code, name, type, is_group, parent_id)
  values ('1100', 'Current Assets', 'asset', true, (select id from accounts where code = '1000'));
insert into accounts (code, name, type, parent_id, system_key) values
  ('1110', 'Cash', 'asset', (select id from accounts where code = '1100'), 'cash'),
  ('1120', 'Bank', 'asset', (select id from accounts where code = '1100'), 'bank');
insert into accounts (code, name, type, parent_id, is_control, system_key)
  values ('1200', 'Accounts Receivable', 'asset', (select id from accounts where code = '1000'), true, 'ar');
insert into accounts (code, name, type, parent_id, system_key) values
  ('1300', 'Inventory', 'asset', (select id from accounts where code = '1000'), 'inventory'),
  ('1310', 'Goods in Transit', 'asset', (select id from accounts where code = '1000'), 'goods_in_transit');
insert into accounts (code, name, type, is_group, parent_id)
  values ('1400', 'GST Input Credit', 'asset', true, (select id from accounts where code = '1000'));
insert into accounts (code, name, type, parent_id, system_key) values
  ('1410', 'Input CGST', 'asset', (select id from accounts where code = '1400'), 'input_cgst'),
  ('1420', 'Input SGST', 'asset', (select id from accounts where code = '1400'), 'input_sgst'),
  ('1430', 'Input IGST', 'asset', (select id from accounts where code = '1400'), 'input_igst');
insert into accounts (code, name, type, parent_id, is_control, system_key) values
  ('1500', 'Employee Advances', 'asset', (select id from accounts where code = '1000'), true, 'employee_advance'),
  ('1600', 'Rebate Receivable', 'asset', (select id from accounts where code = '1000'), true, 'rebate_receivable');

-- Liabilities
insert into accounts (code, name, type, is_group) values ('2000', 'Liabilities', 'liability', true);
insert into accounts (code, name, type, parent_id, is_control, system_key)
  values ('2100', 'Accounts Payable', 'liability', (select id from accounts where code = '2000'), true, 'ap');
insert into accounts (code, name, type, is_group, parent_id)
  values ('2200', 'GST Output Payable', 'liability', true, (select id from accounts where code = '2000'));
insert into accounts (code, name, type, parent_id, system_key) values
  ('2210', 'Output CGST', 'liability', (select id from accounts where code = '2200'), 'output_cgst'),
  ('2220', 'Output SGST', 'liability', (select id from accounts where code = '2200'), 'output_sgst'),
  ('2230', 'Output IGST', 'liability', (select id from accounts where code = '2200'), 'output_igst');
insert into accounts (code, name, type, parent_id, system_key)
  values ('2300', 'RCM Payable', 'liability', (select id from accounts where code = '2000'), 'rcm_payable');
insert into accounts (code, name, type, parent_id, is_control, system_key)
  values ('2400', 'Salary Payable', 'liability', (select id from accounts where code = '2000'), true, 'salary_payable');
insert into accounts (code, name, type, parent_id) values
  ('2500', 'TDS Payable', 'liability', (select id from accounts where code = '2000')),
  ('2600', 'Loans', 'liability', (select id from accounts where code = '2000'));

-- Equity
insert into accounts (code, name, type, is_group) values ('3000', 'Equity', 'equity', true);
insert into accounts (code, name, type, parent_id) values
  ('3100', 'Capital - Dad', 'equity', (select id from accounts where code = '3000')),
  ('3200', 'Capital - Babai', 'equity', (select id from accounts where code = '3000')),
  ('3300', 'Drawings - Dad', 'equity', (select id from accounts where code = '3000')),
  ('3400', 'Drawings - Babai', 'equity', (select id from accounts where code = '3000'));

-- Income
insert into accounts (code, name, type, is_group) values ('4000', 'Income', 'income', true);
insert into accounts (code, name, type, parent_id) values
  ('4100', 'Sales - Cement', 'income', (select id from accounts where code = '4000')),
  ('4200', 'Sales - Steel', 'income', (select id from accounts where code = '4000')),
  ('4300', 'Sales - Other', 'income', (select id from accounts where code = '4000')),
  ('4400', 'Freight Recovered', 'income', (select id from accounts where code = '4000')),
  ('4500', 'Discount Received', 'income', (select id from accounts where code = '4000'));
insert into accounts (code, name, type, parent_id, system_key) values
  ('4600', 'Rebate Income', 'income', (select id from accounts where code = '4000'), 'rebate_income'),
  ('4700', 'Interest Income', 'income', (select id from accounts where code = '4000'), 'interest_income');

-- Expense
insert into accounts (code, name, type, is_group) values ('5000', 'Expenses', 'expense', true);
insert into accounts (code, name, type, parent_id, system_key) values
  ('5100', 'Cost of Goods Sold', 'expense', (select id from accounts where code = '5000'), 'cogs'),
  ('5200', 'Freight Inward', 'expense', (select id from accounts where code = '5000'), 'freight_inward'),
  ('5300', 'Loading & Unloading', 'expense', (select id from accounts where code = '5000'), 'loading_unloading');
insert into accounts (code, name, type, parent_id) values
  ('5400', 'Godown Rent', 'expense', (select id from accounts where code = '5000')),
  ('5500', 'Salaries', 'expense', (select id from accounts where code = '5000'));
insert into accounts (code, name, type, parent_id, system_key) values
  ('5600', 'Discount Allowed', 'expense', (select id from accounts where code = '5000'), 'discount_allowed'),
  ('5700', 'Round Off', 'expense', (select id from accounts where code = '5000'), 'round_off'),
  ('5800', 'Stock Loss', 'expense', (select id from accounts where code = '5000'), 'stock_loss'),
  ('5900', 'Cash Over/Short', 'expense', (select id from accounts where code = '5000'), 'cash_over_short');

-- Fiscal periods, FY 2026-27 (April 2026 - March 2027)
insert into fiscal_periods (year_label, month)
select '2026-27', d::date
from generate_series('2026-04-01'::date, '2027-03-01'::date, interval '1 month') as d;

-- doc_sequences. Keyed by series (not doc_type) so 'payment' can have two independently
-- numbered series — RCPT for receipts, PAY for outgoing payments — in the same FY.
insert into doc_sequences (series, doc_type, fy_label, prefix, next_no) values
  ('DN', 'sales_invoice', '2026-27', 'DN/26-27/', 1),
  ('PB', 'purchase_invoice', '2026-27', 'PB/26-27/', 1),
  ('CN', 'credit_note', '2026-27', 'CN/26-27/', 1),
  ('DB', 'debit_note', '2026-27', 'DB/26-27/', 1),
  ('RCPT', 'payment', '2026-27', 'RCPT/26-27/', 1),
  ('PAY', 'payment', '2026-27', 'PAY/26-27/', 1),
  ('EXP', 'expense_voucher', '2026-27', 'EXP/26-27/', 1);
