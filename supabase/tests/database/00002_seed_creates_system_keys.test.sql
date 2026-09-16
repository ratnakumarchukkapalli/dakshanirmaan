-- Must pass (change 01, foundation-schema): "seed creates all system_key rows"
-- Every system_key named in db-architecture spec's "Core tables" (15) and "Schema extensions
-- for prototype-v2 features" -> "New system_key accounts" (10) exists exactly once.
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

select is(
  (select count(*)::int from accounts where system_key is not null),
  25,
  'exactly 25 system_key accounts are seeded'
);

select set_eq(
  $$ select system_key from accounts where system_key is not null $$,
  ARRAY[
    -- Core tables (15)
    'ar', 'ap', 'inventory', 'cogs', 'output_cgst', 'output_sgst', 'output_igst',
    'input_cgst', 'input_sgst', 'input_igst', 'round_off', 'salary_payable',
    'employee_advance', 'cash', 'rcm_payable',
    -- Schema extensions "New system_key accounts" (10)
    'bank', 'cash_over_short', 'rebate_income', 'rebate_receivable', 'stock_loss',
    'freight_inward', 'loading_unloading', 'discount_allowed', 'interest_income',
    'goods_in_transit'
  ],
  'every spec-named system_key exists as exactly one accounts row'
);

select * from finish();

rollback;
